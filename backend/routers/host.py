"""主持通道（/api/host/*）。

这是「AI 在服务端主持一场剧本」的入口，契约见 docs/CONTEXT_CONTRACT.md §9.2。

本步只实现会话骨架：建会话、签/验主持证、心跳续期、安静超时、并发锁。
**不解析标记、不组装提示词、不调 AI** —— 那些各自有下一步，混在一起改会说不清是谁坏了。

一条硬规矩贯穿全文件：**汤底绝不从这里出去**。所有返回值都是相位与状态计数，
剧本正文只走 /api/host/context（下面那个端点）。

`/api/host/context` 是「提示词组装搬到后端」的落地：组装逻辑不再在浏览器里跑，
前端只拿到一段已经拼好的 system prompt，原样塞进 role:"system"。汤底的钥匙是
「正持着这一场的主持证」，不是「登录过」——所以匿名和旁观者拿到的资料库里没有剧本内容。
"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, Header, Request
from sqlalchemy.orm import Session as DbSession

from ..core.database import get_db
from ..core.security import get_optional_user
from ..models.access_log import AccessLog
from ..models.script import Script, REVIEW_APPROVED
from ..models.host_session import _iso_utc
from ..models.stats import UserStats
from ..models.user import User
from ..services import host_session_service as hs
from ..services import npc_file_service
from ..services import prompt_assembly_service as pas
from ..services import prompt_env_service as penv
from ..services import stats_service as sts
from ..services import token_service

router = APIRouter(prefix="/api/host", tags=["主持通道"])

_HOST_TOKEN_MAX_HOURS = hs.TOKEN_MAX_HOURS


def _host_raw(authorization: str | None, x_host_token: str | None):
    """取主持证原文 —— **先把 MCP 长期凭证摘出去**（M27）。

    `hs.raw_from_headers` 判「这是不是主持证」的口径是「不是 JWT（不含点）、且 >=40 位」；
    而 MCP 长期凭证恰好是 `mcp_` + 43 位无点串，会被它误当成主持证。后果很具体：
    「只带钥匙、不带 X-Host-Token」的请求在这里拿到一张查不到的证 → 401 no_actor，
    连 default 上下文都取不到（本该回一份没有汤底的公共上下文）。

    所以调它之前先把 mcp_ 前缀的 Authorization 清掉。根治办法是把这条判断下沉进
    `host_session_service.raw_from_headers` —— 那里才是唯一该认识凭证种类的地方；
    那个文件不归本轮改，先在调用侧收口（本文件 8 处都走这里，别绕过）。
    """
    if authorization:
        bearer = authorization.split(" ", 1)[-1].strip()
        if bearer.startswith(token_service.TOKEN_PREFIX):
            authorization = None
    return hs.raw_from_headers(authorization, x_host_token)


# 开体验会话的次数上限。这是个**抬高成本**的闸，不是根治：
# 真正的根治要么「登录后才能开体验会话」，要么「开体验会话就扣免费额度」——
# 两条都动产品规则，留给用户拍板（见 docs/phases/P1-BLOCKERS.md「待拍板」）。
#: 开体验会话的按天限额。默认值就是线上口径；
#: 可用环境变量临时放宽，专给「一批跑很多次的测试」用——不然闸门第二次跑就会撞限额红，
#: 而一个第二次跑必红的闸门，比没有闸门更糟（它会训练人去忽略红色）。
import os as _os
_START_LIMIT_MEMBER = int(_os.environ.get("HOST_START_LIMIT_MEMBER", "200"))
_START_LIMIT_GUEST = int(_os.environ.get("HOST_START_LIMIT_GUEST", "20"))


def _check_ticket_scope(db, authorization, *needed):
    """门票（`mcp_` 长期凭证）的能力校验；普通登录态与匿名直通。

    为什么不用 `Depends(require_scope(...))`：开房允许匿名游客，那个依赖会把没带
    Authorization 的请求直接 401。这里只在「作者是门票」时才管。
    """
    if not authorization:
        return
    parts = authorization.split(" ", 1)
    val = (parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else parts[0]).strip()
    if not val.startswith("mcp_"):
        return
    from ..services import token_service
    row = token_service.parse(db, val)
    if not row:                       # 无效门票交给 get_optional_user 侧判 401
        return
    caps = set(row.scope_list())
    lack = [x for x in needed if x not in caps]
    if lack:
        hs._fail(403, "capability_denied",
                 "这张 AI 门票没有 %s 能力" % "、".join(lack))


@router.post("/session/start")
def start_session(
    payload: dict = Body(...),
    request: Request = None,
    authorization: str | None = Header(None),
    x_host_token: str | None = Header(None),
    user=Depends(get_optional_user),
    db: DbSession = Depends(get_db),
):
    """开一场新会话，签发主持证。

    凭证：长期钥匙 或 游客（匿名）。**主持证本身不能开新场**（契约 §11.3）——
    否则一张证能无限繁殖会话，主持权就失去了「只对这一场有效」的含义。
    """
    _check_ticket_scope(db, authorization, "session:host")
    raw = _host_raw(authorization, x_host_token)
    if raw and hs.find_by_token(db, raw):
        hs._fail(403, "capability_denied", "主持证只能用在它绑定的那一场，不能开新场")

    # 带了 Authorization 却拿到 user=None：JWT 过期/伪造，`get_optional_user` 对无效 token
    # **直接返回 None 而不抛 401**，于是这里静默降级成游客开房（额度从会员 200/天 掉到游客 20/天、
    # 会话也不绑定账号，sweep 之外没人收）。审计 H4 报过。
    # 故意**不改成 401**：那样玩家会连主持证都拿不到，条件判定整场空转——比降级成游客更糟。
    # 折中：照旧降级，但不再静默，留一条日志让人查得到。
    if authorization and user is None:
        import logging
        logging.getLogger("uvicorn.error").warning(
            "开体验时 Authorization 无效（已过期或伪造），本次按游客处理：script_id=%s",
            (payload.get("script_id") or ""))

    script_id = (payload.get("script_id") or "").strip()
    npc_id = (payload.get("npc_id") or "").strip()
    if not script_id:
        hs._fail(400, "contract_mismatch", "缺少 script_id")

    script = db.query(Script).filter(Script.id == script_id).first()
    if not script:
        hs._fail(404, "script_not_found", "剧本不存在")
    if script.review_status != REVIEW_APPROVED:
        hs._fail(423, "script_not_approved", "剧本还没过审，不能开体验")

    # 同一主体在同一本剧本上重复开房：先把旧的收掉，别让会话无限繁殖
    # （每张证都是一把汤底的钥匙，不复用就等于「点一下换一把」——审计 M6）。
    from ..services import guest_counter_service
    # 只清「这一位登录用户自己」在同一本剧本上的旧场。
    # 游客**一律不清**：游客的 owner_user_id 都是 NULL，`== None` 在 SQL 里是 IS NULL，
    # 会把同一本剧本上所有游客的会话一起撤掉——两个人同时玩同一本热门剧本就是必现。
    # 游客的旧场交给 sweep_if_idle 自然过期。
    if user is not None:
        stale = db.query(hs.HostSession).filter(
            hs.HostSession.script_id == script_id,
            hs.HostSession.owner_user_id == user.id,
            hs.HostSession.phase.in_((hs.PHASE_HOSTING, hs.PHASE_SETTLING)),
        ).all()
        for old in stale:
            hs.end_session(db, old, reason="aborted")

    subject = guest_counter_service.subject_for(request, user)
    limit = _START_LIMIT_MEMBER if user is not None else _START_LIMIT_GUEST
    # 计数按「天」分窗：scope 里拼日期，等价于每天重开一次额度，
    # 不用改表。原来是永久累计，游客玩满 20 次之后**永远**开不了体验，
    # 而开不了体验就等于结局永不触发、结算永不发生 —— 界面上还看不出来。
    guest_counter_service.purge_old_scopes(db, "host_start")   # 旧日期窗口不定期清掉，否则表只涨不减
    used, ok = guest_counter_service.bump(
        db, "host_start:%s" % _today(), subject, "s", limit=limit)
    if not ok:
        hs._fail(429, "rate_limited",
                 "开体验会话的次数已用尽（%d/%d）。换个方式玩，或登录后再试" % (used, limit))

    # 注：免费额度不在这里扣。插件不负责取 AI/API（用户 D2 决策），
    # 本接口无法判断这一场会不会用到站长的密钥，扣在这里会误伤自带 key 的玩家。
    # 额度判定保持在真正发生 AI 调用的那一侧（site_service.check_free_quota）。
    session, raw_token = hs.create_session(
        db, script, owner_user_id=(user.id if user else None), npc_id=npc_id)
    issued = session.token_issued_at
    if issued.tzinfo is None:
        issued = issued.replace(tzinfo=timezone.utc)
    expires = issued + timedelta(hours=_HOST_TOKEN_MAX_HOURS)
    return {
        "session_id": session.id,
        "phase": session.phase,
        "host_token": raw_token,
        "expires_at": _iso_utc(expires),
    }


@router.get("/session/{session_id}")
def get_session(
    session_id: str,
    authorization: str | None = Header(None),
    x_host_token: str | None = Header(None),
    user=Depends(get_optional_user),
    db: DbSession = Depends(get_db),
):
    """会话快照：该会话的主持证，或会话主人自己的长期钥匙。"""
    raw = _host_raw(authorization, x_host_token)
    session = hs.require_session_owner_or_token(db, session_id, raw, user)
    hs.sweep_if_idle(db, session)
    return hs.snapshot(session)


@router.post("/session/{session_id}/heartbeat")
def heartbeat(
    session_id: str,
    payload: dict = Body(default={}),
    authorization: str | None = Header(None),
    x_host_token: str | None = Header(None),
    db: DbSession = Depends(get_db),
):
    """心跳续期。

    用途：AI 还在流式出字的时候，客户端每隔十几秒报一次，把 last_active_at 推走。
    超时判定看的是「安静了多久」，不是「一次请求持续了多久」——
    否则一段超过 5 分钟的解说会被自己的超时掐断，又变成切半句（§7.3）。
    """
    raw = _host_raw(authorization, x_host_token)
    session = hs.require_token(db, raw)
    if session.id != session_id:
        hs._fail(403, "capability_denied", "主持证不属于这一场")
    hs.sweep_if_idle(db, session)
    if session.phase == hs.PHASE_ENDED:
        # 已结束仍允许心跳：这一场还挂着遗言证，报活不消耗它
        pass
    hs.touch(db, session)
    return {
        "session_id": session.id,
        "phase": session.phase,
        "last_words_left": hs.snapshot(session)["last_words_left"],
    }


@router.post("/session/end")
def end_session(
    payload: dict = Body(...),
    authorization: str | None = Header(None),
    x_host_token: str | None = Header(None),
    db: DbSession = Depends(get_db),
):
    """结束会话。reason ∈ {settled, aborted, timeout}。

    `settled` 只有在解说真正讲完（narrated=true）后才被接受，
    这是「先解说、后撤上下文」那条时序铁律在接口上的落点（§7.3）。
    """
    raw = _host_raw(authorization, x_host_token)
    session = hs.require_token(db, raw)
    reason = (payload.get("reason") or "aborted").strip()
    if reason not in ("settled", "aborted", "timeout"):
        hs._fail(400, "contract_mismatch", "reason 只能是 settled / aborted / timeout")
    session_id = (payload.get("session_id") or "").strip()
    if session_id and session_id != session.id:
        hs._fail(403, "capability_denied", "主持证不属于这一场")
    hs.end_session(db, session, reason=reason)
    return {"session_id": session.id, "phase": session.phase,
            "revoked": session.revoked_at is not None}


@router.post("/session/{session_id}/settling")
def begin_settling(
    session_id: str,
    authorization: str | None = Header(None),
    x_host_token: str | None = Header(None),
    db: DbSession = Depends(get_db),
):
    """声明「结局成立了，进入结算相位」。

    调用方是条件系统：判定某个结局的条件满足那一刻调一次。此后再主持只做一件事——
    把结局讲完。这是 §7.3「先解说、后撤上下文」的前半截。

    以前没有任何代码会写这个相位，所以 `end` 的 settled 分支恒 409，
    「正常结算」在服务端根本走不通（审计 S1）。
    """
    _check_ticket_scope(db, authorization, "session:settle")
    raw = _host_raw(authorization, x_host_token)
    session = hs.require_token(db, raw)
    if session.id != session_id:
        hs._fail(403, "capability_denied", "主持证不属于这一场")
    hs.sweep_if_idle(db, session)
    hs.begin_settling(db, session)
    return {"session_id": session.id, "phase": session.phase,
            "narrated": bool((session.payload or {}).get("narrated"))}


@router.post("/session/{session_id}/narrated")
def mark_narrated(
    session_id: str,
    authorization: str | None = Header(None),
    x_host_token: str | None = Header(None),
    db: DbSession = Depends(get_db),
):
    """声明「结局解说说完了」。

    只在解说真正完成之后调。调早了就是「先撤上下文、后讲结局」，
    那正是真相被切成半句的成因（§7.3）。讲完才允许 settled 收场。
    """
    _check_ticket_scope(db, authorization, "session:settle")
    raw = _host_raw(authorization, x_host_token)
    session = hs.require_token(db, raw)
    if session.id != session_id:
        hs._fail(403, "capability_denied", "主持证不属于这一场")
    hs.mark_narrated(db, session)
    return {"session_id": session.id, "phase": session.phase, "narrated": True}


@router.get("/status")
def host_status(
    authorization: str | None = Header(None),
    x_host_token: str | None = Header(None),
    db: DbSession = Depends(get_db),
):
    """宿主状态通道：AI 在服务端主持时，网页端能看见它现在到哪一步了。

    带主持证 → 返回本场相位；不带 → 只回「服务活着」与时间。
    **不返回任何跨会话的聚合数字**：那种「当前在线几场」的接口是给运维看的，
    放在公开面上等于给爬虫一个探活指标。
    """
    raw = _host_raw(authorization, x_host_token)
    now = datetime.now(timezone.utc)
    base = {"alive": True, "server_time": now.isoformat()}
    if not raw:
        return base
    session = hs.find_by_token(db, raw)
    if not session:
        return base
    # 证被撤销 / 过期之后，这张证就是废纸：以前这里回 200 + phase="revoked"，
    # 等于告诉调用方「你还活着」，于是它继续把这张证当主持权用（用户实测：
    # 收场后再调 /host/status 仍 200）。与其它宿主端点统一成 410 host_token_expired：
    # 这一场结束了，要主持就重新开一场。
    # 不带证的那条路（上面的 base）**不受影响**——它是探活通道，永远 200。
    if hs.token_state(session) in ("revoked", "expired"):
        hs._fail(410, "host_token_expired",
                 "主持证已失效（这一场已结束，或已超过 %d 小时有效期）" % _HOST_TOKEN_MAX_HOURS)
    hs.sweep_if_idle(db, session)
    last = session.last_active_at
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return dict(base, **{
        "session_id": session.id,
        "phase": session.phase,
        "mode": session.mode,
        "narrated": bool((session.payload or {}).get("narrated")),
        "settled_ending": (session.payload or {}).get("settled_ending"),
        "idle_seconds": int((now - last).total_seconds()) if last else None,
        "last_words_left": hs.snapshot(session)["last_words_left"],
    })

# ============ 提示词组装（契约 §9.2 / §4）============

#: 契约版本。改了 bundle 结构就要一起改它（契约 §2 的版本纪律）。
CONTRACT_VERSION = "aijuben.context/1.3"


#: 站点时区偏移。按天重置要按玩家看的那个「今天」算，
#: 用 UTC 的话中国玩家会在早上 8 点突然回满，看着像 bug（审计 建议-3）。
_SITE_TZ_HOURS = 8


def _today() -> str:
    """站点日期串（北京时间）。用于把「按天重置」的计数分窗，不引入新表。"""
    import datetime as _dt
    return (_dt.datetime.utcnow() + _dt.timedelta(hours=_SITE_TZ_HOURS)).strftime("%Y-%m-%d")

#: 校验用的允许值
_VALID_STATES = ("default", "browsing", "experience")


def _npc_display_name(npc_id: str) -> str:
    for d in npc_file_service.NPC_DEFINITIONS:
        if d.get("npc_id") == npc_id and not d.get("personality_id"):
            return d.get("display_name") or npc_id
    return npc_id


def _audit_context_grant(db, request, user, session, script, npc_id):
    """拿主持专用内容要留痕（契约 §10「实现要点」第 4 条：返回主持专用字段必须写审计日志）。"""
    try:
        row = AccessLog(
            user_email=getattr(user, "email", "") or "" if user else "",
            user_id=getattr(user, "id", "") or "" if user else "",
            action="主持上下文下发",
            ip=(request.client.host if request and request.client else "") or "",
            port=str(request.client.port) if request and request.client else "",
            path="/api/host/context",
            method="POST",
            status=200,
            user_agent=((request.headers.get("user-agent") or "")[:255]) if request else "",
            script_id=str(getattr(script, "id", "") or ""),
            session_id=str(getattr(session, "id", "") or ""),
        )
        db.add(row)
        db.commit()
    except Exception as exc:
        # 审计写失败不能把正常请求带崩，但绝不能无声无息（审计 S2）：
        # 「返回主持专用字段必须写审计日志」是契约 §10 的硬要求，坏了要有人知道。
        db.rollback()
        try:
            import logging
            logging.getLogger("uvicorn.error").warning(
                "主持上下文审计写入失败 session=%s: %s",
                getattr(session, "id", "?"), exc)
        except Exception:
            pass


@router.post("/context")
def build_context(
    payload: dict = Body(...),
    request: Request = None,
    authorization: str | None = Header(None),
    x_host_token: str | None = Header(None),
    user=Depends(get_optional_user),
    db: DbSession = Depends(get_db),
):
    """组装并返回 PromptBundle（契约 §4）。

    凭证规则（契约 §3）：
      - `default` / `browsing`：不需要凭证，资料库里没有剧本内容；
      - `experience`：**必须有本场主持证**。没有证就 401 —— 拿不到汤底。
        证在主证里写的哪一场就是哪一场，客户端传别的 session_id 一律 403。
    """
    contract = payload.get("contract")
    if contract and contract != CONTRACT_VERSION:
        hs._fail(400, "contract_mismatch", "契约版本不匹配：服务端是 %s" % CONTRACT_VERSION)

    state = payload.get("state") or "default"
    if state not in _VALID_STATES:
        hs._fail(400, "contract_mismatch", "未知的 state：%s" % state)

    npc_id = payload.get("npc_id") or None
    session_id = payload.get("session_id") or None

    raw = _host_raw(authorization, x_host_token)
    session = None
    if raw:
        session = hs.find_by_token(db, raw)
        if session is None:
            # 证根本不存在（拼错/伪造/来自别的实例）：这条请求就是没带证。
            hs._fail(401, "no_actor", "没有有效的主持证")
        if hs.token_state(session) in ("revoked", "expired"):
            # 证失效 ≠ 身份失效。玩家刚打完一场、把游戏收起来，继续在 default/browsing 态里
            # 跟 NPC 说话时，请求头里可能还挂着那张已作废的证（前端只在吃到 410 之后才补证）。
            # 旧实现走 require_token，直接 410 把整条请求打死，连 Authorization 里的登录身份
            # 一起丢掉——前端拿不到 player_info，看起来就是「收场后我变成游客了，
            # scripts_completed 也变 0 了」（用户实测）。
            #
            # 现在的判据：
            #   · 证失效 → 这一场的主持权没了：session 置空，capabilities 里没有 script:host，
            #     汤底不下发，session_out 为 null；
            #   · 身份照旧由 Authorization 里的 JWT 认 —— 玩家还是那个玩家，只是不能主持这一场；
            #   · experience 是唯一例外：没有有效证就拿不到本场上下文，仍旧 410，
            #     让前端走它既有的「补一张证再重试」路径，不靠降级假装还在主持。
            if state == "experience":
                hs._fail(410, "host_token_expired",
                         "主持证已失效（这一场已结束，或已超过 %d 小时有效期）" % _HOST_TOKEN_MAX_HOURS)
            session = None
        elif session_id and session.id != session_id:
            hs._fail(403, "capability_denied", "这张主持证不是这一场的")
        else:
            session_id = session.id

    script = None
    if state == "experience":
        if session is None:
            hs._fail(401, "no_actor", "取主持上下文必须带本场主持证")
        # 遗言证只服务「安静超时」那种情况：让主持人把最后一句讲完。
        # 正常结算收场之后再要上下文一律拒——汤底没有第二次上台的理由。
        if hs.token_state(session) != "ok":
            if (session.payload or {}).get("end_reason") != "timeout":
                hs._fail(403, "capability_denied", "这一场已经结束，主持上下文不再下发")
            # 遗言轮只许用一次（§7.3）。以前 consume_last_words 一个调用方都没有，
            # 等于「只许用一次」这句话从来没被执行过（审计 M2）。
            if (session.payload or {}).get("last_words_used"):
                hs._fail(403, "capability_denied", "遗言轮已经用过了")
            hs.consume_last_words(db, session)
        script = db.query(Script).filter(Script.id == session.script_id).first()
        # 会话活着不代表剧本还该给：中途下架或退回审核之后，汤底不该继续下发（审计 S4）。
        if script is None or script.is_deleted or script.review_status != REVIEW_APPROVED:
            hs._fail(404, "script_not_found", "剧本不存在或已不可体验")
        hs.touch(db, session)

    # 「正在主持这一场」才有的东西，default/browsing 一律不给（审计 S3）。
    hosting = session is not None and state == "experience"

    # 提示词：NPC 私有 + 共享（文件系统是唯一可信源，与前端过渡期读的是同一批文件）
    prompts = []
    if npc_id:
        prompts += npc_file_service.get_npc_prompts(npc_id)
    prompts += npc_file_service.get_shared_prompts()

    # 玩家档案：主持时取「这一场属于的那个玩家」，否则取当前登录者，游客给最小档案。
    # 两个坑都是用户实测出来的「收场后我变成游客」：
    #   1. 会话主人那一行 User 可能已经查不到了（删号/历史数据），旧代码于是直接从
    #      「主持分支」掉进 else，把登录者当成游客（username="游客"、计数全 0）；
    #   2. UserStats 行可能还没建（只上传过剧本、没触发过任何计数事件的新号），
    #      build_player_info(user, None) 会给出 level=1、计数全 0 —— 名字是真名，数字像游客。
    # 判据：身份只认「谁来认领」——主持态认会话主人，其余认 JWT；档案数字一律从库里现取，
    # 行不存在就现建（ensure），上传数按 Script 行数对齐（sync），不再用「None 就是游客」糊过去。
    player_info = None
    owner = None
    if hosting and session.owner_user_id:
        owner = db.query(User).filter(User.id == session.owner_user_id).first()
    profile_user = owner or user
    if profile_user is not None:
        stats = sts.sync_scripts_uploaded(db, str(profile_user.id))
        db.commit()
        player_info = penv.build_player_info(profile_user, stats)
    else:
        player_info = penv.build_player_info(None, None)

    env = penv.build_env(npc_id=npc_id, script=script, session=session)
    bundle = pas.assemble(
        prompts=prompts,
        web_state=state,
        npc_id=npc_id,
        player_info=player_info,
        env=env,
    )

    capabilities = ["script:read"]
    if hosting:
        capabilities += ["script:host", "session:settle"]

    if hosting:
        session_out = {
            "id": session.id,
            "mode": session.mode,
            "script_id": session.script_id,
            "started_at": _iso_utc(session.created_at),
            "completed": session.phase == "ended",
            "phase": session.phase,
            "last_active_at": _iso_utc(session.last_active_at),
        }
    elif session is not None:
        # 带了证但不是在主持这一场（default/browsing）：只告诉它「有这么一个场」，
        # 不给剧本 id、不给结算权，免得第三方主持人以为自己能在旁观态结算。
        session_out = {"id": session.id, "phase": session.phase}
    else:
        session_out = None

    out = {
        "contract": CONTRACT_VERSION,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "state": bundle["debug"]["recipe"].split("/")[0],
        "capabilities": capabilities,
        "npc": {
            "id": npc_id,
            "display_name": _npc_display_name(npc_id) if npc_id else "",
            "config": (env.get("npc_configs") or {}).get(npc_id) or {},
        },
        "player": player_info,
        "session": session_out,
        # 只回 system_prompt。root 与 sections 里各有一份汤底原文，
        # 前端一个字都不读，留着就是白白多两个暴露面（审计 A1）。
        "system_prompt": bundle["system_prompt"],
        "prompt_hash": bundle["prompt_hash"],
        "stats": bundle["stats"],
        "debug": bundle["debug"],
    }

    if script is not None:
        _audit_context_grant(db, request, user, session, script, npc_id)

    return out


# ============ UI 元数据（M28）============

@router.get("/ui-meta")
def get_ui_meta():
    """全站 UI 元数据：引导高亮目标、状态栏三块卡、表情/动画清单。**公开，匿名也回**。

    为什么可以公开：这里没有一行用户数据，也没有汤底 —— 全是「界面叫什么、NPC 能调
    哪些命令」。而前端首屏和 MCP 插件都必须在**登录之前**就拿到它，加鉴权只会逼出
    「把这份清单硬编码进插件」这种更坏的副本。

    数据源只有一个：`prompt_env_service.ui_meta()`（与提示词组装的 STATUS_UIS 同一份
    字面量，只是键名换成对外的 snake_case）。契约版本在这里补上 —— 不让
    prompt_env_service 反向 import 路由层。
    """
    data = penv.ui_meta()
    data["contract"] = CONTRACT_VERSION
    return data
