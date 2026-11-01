"""会话引擎：建会话、签/验主持证、心跳续期、安静超时回收、并发锁。

契约出处：docs/CONTEXT_CONTRACT.md §7.3（时序铁律）、§7.4（主持证生命周期）、§9.3（错误码）。

这一层只做「会话状态」，不碰提示词、不碰 AI、不解析标记。
它要保证的只有一件事：**任何时刻，服务端对「这场说到哪了」有一份权威记录**，
而不是像现在这样，状态散在浏览器内存里，刷新一下就没了。
"""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from ..models.host_session import (
    HostSession, PHASE_HOSTING, PHASE_SETTLING, PHASE_ENDED, empty_payload,
)

# §7.3：连续 300 秒没有任何请求才算超时。不用固定秒数掐解说——解说本身就在流里。
SESSION_IDLE_SECONDS = 300
# §7.4：主持证签发时 4 小时封顶
TOKEN_MAX_HOURS = 4
# §7.4：单轮并发锁的默认租期。拿不到心跳的客户端不会永久占锁。
TURN_LOCK_SECONDS = 120
# 锁必须明显短于闲置超时：一场主持里连续两轮之间不会超过两分钟，
# 而「安静 300 秒」才是真的关网页了。
# 反过来（锁比闲置还长）会出现「人早走了、锁还占着」——第二路永远 409。
# 长解说（一轮 > 2 分钟）必须由调用方 renew_turn_lock 续，不要靠加大这个数。
assert TURN_LOCK_SECONDS * 2 <= SESSION_IDLE_SECONDS

MODE_BY_CATEGORY = {
    "hai-gui-tang": "turtle_soup",
    "dnd": "dnd",
    "coc": "coc",
    "ju-ben-ban-yan": "script_acting",
}


def _now():
    return datetime.now(timezone.utc)


def _hash(raw):
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def raw_from_headers(authorization=None, x_host_token=None):
    """从请求头取主持证原文。

    两个位置都认，因为「谁在拿钥匙」有两种情形：

      - **玩家自己的浏览器**：既登录了（Authorization 放长期钥匙）、又在主持这一场
        （手里有主持证）。一个头装不下两个身份，所以主持证走 `X-Host-Token`。
      - **纯第三方主持人**（没有玩家身份，只有主持证）：直接放 Authorization。
    """
    if x_host_token:
        return x_host_token.strip()
    if authorization:
        parts = authorization.split(" ", 1)
        raw = (parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else parts[0]).strip()
        # 登录用户的浏览器每个请求都带长期钥匙（JWT，形如 aaa.bbb.ccc）。
        # 主持证是不透明随机串（token_urlsafe(32)，43 个字符、不含点）。
        # 这里必须把两者分开，否则「不需要凭证」的 default/browsing 态对**所有登录用户**会 401
        # —— 那条最常用的路径就只剩游客能走（审计 M4）。
        # MCP 门票（`mcp_` + 43 位、无点）形状上与主持证完全一样，必须显式排掉：
        # 否则「只带 AI 门票、不带 X-Host-Token」的请求会拿到一张查不到的证，
        # 连不需要凭证的 default/browsing 态都会被判成 401（P4 联调时发现）。
        if not raw or "." in raw or len(raw) < 40 or raw.startswith("mcp_"):
            return None
        return raw
    return None


def _fail(status, code, message):
    """按契约 §9.3 抛错。detail 是 {code, message}，新接口专用，老接口没受影响。"""
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


def mode_for_category(category):
    return MODE_BY_CATEGORY.get(category or "", "")


# ---------------------------------------------------------------- 建会话

def create_session(db, script, owner_user_id=None, npc_id=""):
    """开一场新会话，返回 (session, 明文主持证)。明文只在这一刻存在，库里只有哈希。"""
    raw_token = secrets.token_urlsafe(32)
    session = HostSession(
        script_id=script.id,
        npc_id=npc_id or "",
        mode=mode_for_category(getattr(script, "category", "")),
        owner_user_id=owner_user_id,
        phase=PHASE_HOSTING,
        payload=empty_payload(owner_user_id, script.id, npc_id or "",
                              mode_for_category(getattr(script, "category", ""))),
        token_hash=_hash(raw_token),
        token_issued_at=_now(),
        last_active_at=_now(),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session, raw_token


# ---------------------------------------------------------------- 验主持证

def find_by_token(db, raw_token):
    if not raw_token:
        return None
    return db.query(HostSession).filter(HostSession.token_hash == _hash(raw_token)).first()


def token_state(session):
    """主持证现在处于什么状态：ok / last_words（遗言证）/ expired / revoked。"""
    if session.revoked_at is not None:
        return "revoked"
    if int((session.payload or {}).get("last_words_used") or 0) >= 1:
        # 遗言轮用尽即撤销；这里兜一层，防止 revoked_at 没写进去
        return "revoked"
    issued = session.token_issued_at
    if issued:
        if issued.tzinfo is None:
            issued = issued.replace(tzinfo=timezone.utc)
        if _now() - issued > timedelta(hours=TOKEN_MAX_HOURS):
            return "expired"
    if session.phase == PHASE_ENDED:
        return "last_words"
    return "ok"


def require_token(db, raw_token):
    """解析主持证并做有效性检查。任何不通过都按 §9.3 抛 410。"""
    session = find_by_token(db, raw_token)
    if not session:
        _fail(401, "no_actor", "没有有效的主持证")
    state = token_state(session)
    if state == "revoked":
        _fail(410, "host_token_expired", "主持证已失效（遗言轮已用尽或已被撤销）")
    if state == "expired":
        _fail(410, "host_token_expired", "主持证已超过 4 小时有效期")
    return session


def require_session_owner_or_token(db, session_id, raw_token, user):
    """GET 会话快照：该会话的主持证，或会话主人自己的长期钥匙。"""
    session = db.query(HostSession).filter(HostSession.id == session_id).first()
    if not session:
        _fail(404, "session_not_found", "会话不存在")
    probe = find_by_token(db, raw_token) if raw_token else None
    if probe and probe.id == session.id:
        if token_state(session) == "revoked":
            _fail(410, "host_token_expired", "主持证已失效")
        return session
    if user and session.owner_user_id and session.owner_user_id == user.id:
        return session
    # 401 与 403 要分清：401 是「你根本没拿出有效凭证」，403 是「凭证是真的，但不是这一场的」。
    # 混成一个会让客户端不知道该重新登录还是该换个会话。
    if probe:
        _fail(403, "capability_denied", "这张主持证属于别的会话")
    if raw_token:
        # 给了凭证但验不出来 → 401：客户端应当重新开一场，而不是换个身份重试
        _fail(401, "no_actor", "主持证无效")
    if user:
        _fail(403, "capability_denied", "登录了，但这场不是你开的")
    _fail(401, "no_actor", "没有有效凭证")


# ---------------------------------------------------------------- 心跳与超时

def touch(db, session, commit=True):
    """把 last_active_at 推到此刻。只要还在出字就不算超时。"""
    session.last_active_at = _now()
    if commit:
        db.commit()


def sweep_if_idle(db, session):
    """安静超时回收：一直在出字的会话不会被回收，只是网页关掉也不会立刻死。

    §7.3：超时后转 ended，主持证**不撤销**，降级成「只许用一次」的遗言证。
    这样最坏情况下 AI 还能把最后一句讲完，而不是重演「说到一半被切断」。
    """
    if session.phase == PHASE_ENDED:
        return session
    last = session.last_active_at
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    if last is not None and (_now() - last).total_seconds() > SESSION_IDLE_SECONDS:
        session.phase = PHASE_ENDED
        # 必须记下原因：遗言轮（把最后一句讲完）是靠 end_reason == "timeout" 放行的。
        # 清扫不写这一笔，就等于「客户端没主动收场时遗言轮永远不生效」，而且静默失败（审计 M3）。
        payload = dict(session.payload or {})
        payload["end_reason"] = "timeout"
        session.payload = payload
        db.commit()
        db.refresh(session)
        # 注：这里本该「补做一次幂等落库」（评审 A7）。落库要先有结算计算，
        # 而结算计算在下一步（标记解析）里才落地。等它到位后挂在这里，位置就是这儿。
    return session


# ---------------------------------------------------------------- 并发锁
#
# ⚠ 状态：**未接入**。acquire_turn_lock / release_turn_lock / renew_turn_lock 三个函数
# 全仓零调用点（`grep -rn "acquire_turn_lock" backend/` 只有定义），是给 P3「多端同场」
# 预留的。tools/host/test_session_engine.py 第 5 组直接调函数，证明的是「函数能工作」，
# 不是「能力存在」——审计 必改-6 指出过这一点，别再把它当已交付能力写进文档。
#
# 现在为什么暂时不需要它：同一账号在同一剧本上再开一场，会先把旧场 abort 掉
# （routers/host.py start 里的清理），也就是用粗粒度互斥挡住了「两个端同时主持」。
# ⚠ 但这只对**已登录用户**成立：start 里那段 stale 清理整段包在 `if user is not None:` 里，
#   游客侧完全没有互斥——同一个 IP 可以同时持有多张有效证，只受「每日开房额度」约束（审计 H2）。
# 真要接的话，粒度应该是「一次解说」，而不是「一次取上下文」——后者会让每轮第二
# 个请求直接 409，把正常游玩打死。

def acquire_turn_lock(db, session, holder):
    """同一张主持证同一时刻只允许 1 个 turn 在处理中（§7.4）。锁落库，进程崩了会自己过期。"""
    payload = dict(session.payload or {})
    lock = dict(payload.get("turn_lock") or {})
    now = _now()
    exp = lock.get("expires_at")
    if lock.get("holder") and exp:
        try:
            exp_dt = datetime.fromisoformat(exp)
            if exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)
        except ValueError:
            exp_dt = None
        if exp_dt and exp_dt > now and lock.get("holder") != holder:
            _fail(409, "session_busy", "上一轮还没处理完，稍后再试")
    lock["holder"] = holder
    lock["expires_at"] = (now + timedelta(seconds=TURN_LOCK_SECONDS)).isoformat()
    payload["turn_lock"] = lock
    session.payload = payload
    db.commit()
    return lock


def release_turn_lock(db, session, holder=None):
    payload = dict(session.payload or {})
    lock = dict(payload.get("turn_lock") or {})
    if holder and lock.get("holder") and lock.get("holder") != holder:
        return
    payload["turn_lock"] = {"holder": None, "expires_at": None}
    session.payload = payload
    db.commit()


def renew_turn_lock(db, session, holder):
    """续锁。一轮里如果要出声很长的解说（TTS / 分段流式），调度方应在中途续一次，
    而不是让锁自己过期——锁过期就意味着第二路能挤进来，两条解说会交错。"""
    payload = dict(session.payload or {})
    lock = dict(payload.get("turn_lock") or {})
    if lock.get("holder") != holder:
        return None
    lock["expires_at"] = (_now() + timedelta(seconds=TURN_LOCK_SECONDS)).isoformat()
    payload["turn_lock"] = lock
    session.payload = payload
    db.commit()
    return lock


# ---------------------------------------------------------------- 结算相位

def begin_settling(db, session):
    """hosting → settling。条件系统判定结局成立时调用。

    以前没有任何代码会写这个相位，于是 `end_session(reason="settled")` 永远 409，
    「正常结算」那条路根本走不通（审计 S1）。幂等：已经在 settling 就直接返回。

    为什么必须单独有这一步：§7.3 的时序铁律是「先解说、后撤上下文」。相位是这条铁律的
    落点——没有 settling 这个中间态，就无法区分「还在主持」和「已经该讲结局了」，
    也就没法保证解说讲完之前不撤走剧本上下文（那正是「真相被切成半句」的成因）。
    """
    if session.phase == PHASE_ENDED:
        _fail(409, "session_phase_conflict", "这一场已经结束了，不能进入结算")
    if session.phase != PHASE_SETTLING:
        session.phase = PHASE_SETTLING
        touch(db, session, commit=False)
        db.commit()
        db.refresh(session)
    return session


def mark_narrated(db, session):
    """标记「结局解说已讲完」。讲完才允许 settled 收场（§7.3）。"""
    if session.phase != PHASE_SETTLING:
        _fail(409, "session_phase_conflict", "还没进入结算相位，没有解说可讲")
    payload = dict(session.payload or {})
    payload["narrated"] = True
    session.payload = payload
    touch(db, session, commit=False)
    db.commit()
    db.refresh(session)
    return session


# ---------------------------------------------------------------- 结束与撤销

def end_session(db, session, reason="aborted"):
    """结束会话。

    reason:
      settled —— 结局已落库、解说讲完（narrated=true）才允许；主持证降级为遗言证
      aborted —— 玩家主动结束；主持证立刻撤销
      timeout —— 安静超时；主持证降级为遗言证
    """
    # 终态就是终态：已经收过场的会话，一句话都不能把它的收场原因改掉。
    # 少了这条，「settled 之后不再下发汤底」可以被一次 reason=timeout 覆写推翻（审计 M1）。
    if session.phase == PHASE_ENDED:
        return session
    if reason == "timeout":
        # 客户端不能自己宣布「我超时了」。不核对真的闲置过，就等于一句话把主持证
        # 降级成遗言证、顺便续命（审计 M6）。
        last = session.last_active_at
        if last is not None:
            idle = (_now() - (last if last.tzinfo else last.replace(tzinfo=timezone.utc))).total_seconds()
            if idle < SESSION_IDLE_SECONDS:
                _fail(409, "session_not_idle", "才安静了 %d 秒，没到 %d 秒，不能按超时结束"
                      % (int(idle), SESSION_IDLE_SECONDS))
    if reason == "settled":
        # §7.3 时序铁律：先解说、后撤上下文。
        # 只有「相位已在 settling」且「解说是讲完了」才允许以 settled 结束。
        # 少了相位这一条，主持中直接喊 settled 就能跳过整段解说。
        if session.phase != PHASE_SETTLING:
            _fail(409, "session_phase_conflict",
                  "还没进入结算相位（当前 %s），不能以 settled 结束" % session.phase)
        if not (session.payload or {}).get("narrated"):
            _fail(409, "session_phase_conflict", "结局解说还没讲完，不能结束（先讲完再结束）")
    session.phase = PHASE_ENDED
    # 记下收场原因：遗言证只该给「安静超时」那种情况——正常结算收场之后
    # 主持上下文不该再下发了（汤底没有第二次上台的理由）。
    payload = dict(session.payload or {})
    payload["end_reason"] = reason
    session.payload = payload
    if reason == "aborted":
        session.revoked_at = _now()
    db.commit()
    db.refresh(session)
    return session


def revoke(db, session):
    if session.revoked_at is None:
        session.revoked_at = _now()
        db.commit()
    return session


def consume_last_words(db, session):
    """遗言轮只能用一次（§7.3）。调用后立即撤销主持证，此后一切请求 410。"""
    payload = dict(session.payload or {})
    payload["last_words_used"] = int(payload.get("last_words_used") or 0) + 1
    session.payload = payload
    session.revoked_at = _now()
    db.commit()
    db.refresh(session)
    return session


# ---------------------------------------------------------------- 「正在主持这一场」的判定

def has_script_access(db, script_id, user=None, raw_token=None):
    """判断调用者此刻是否「正在主持 / 正在体验」这一个剧本。

    这是 §10.1 那句「拿汤底的钥匙是『正在主持这一场』，不是『登录过』」的落点。
    满足任一条就算：
      - 手上有一张这一场的有效主持证；
      - 登录了，且在这个剧本上有未结束的会话。

    注意这里**不看登录与否本身**——所以老接口上「游客不带凭证也能拿汤底」这条堵死了，
    而「按标题模糊搜剧本」完全不受影响（搜索只给公开字段）。"""
    if not script_id:
        return False
    if raw_token:
        session = find_by_token(db, raw_token)
        if session and str(session.script_id) == str(script_id):
            # 只认 "ok"。遗言证（last_words）是「把最后一句讲完」的许可，不是重新拿汤底的钥匙；
            # 原来放行 last_words，等于撤销之后权限还能续到 4 小时封顶（审计 M6）。
            if token_state(session) == "ok":
                return True
    if user is not None:
        q = db.query(HostSession).filter(
            HostSession.script_id == script_id,
            HostSession.owner_user_id == user.id,
            HostSession.revoked_at.is_(None),
            HostSession.phase.in_((PHASE_HOSTING, PHASE_SETTLING)),
        ).first()
        if q:
            return True
    return False


# ---------------------------------------------------------------- 对外快照

def snapshot(session):
    """给客户端看的会话快照。不含任何剧本内容——汤底绝不从这里出去。"""
    data = session.to_session_data()
    return {
        "session_id": session.id,
        "phase": data["phase"],
        "script_id": data["script_id"],
        "npc_id": data["npc_id"],
        "mode": data["mode"],
        "inventory": data["inventory"],
        "cond_counts": data["cond_counts"],
        "task_counts": data["task_counts"],
        "settled_ending": data["settled_ending"],
        "ending_type": data["ending_type"],
        "settlement": data["settlement"],
        "narrated": data["narrated"],
        "last_words_left": 0 if token_state(session) == "revoked" else (1 - data["last_words_used"]),
        "started_at": data["started_at"],
        "last_active_at": data["last_active_at"],
    }
