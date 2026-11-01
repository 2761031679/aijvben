"""游戏路由"""
from fastapi import APIRouter, Depends, Query, Body, Request
from sqlalchemy.orm import Session
from ..core.database import get_db
from ..core.security import get_current_user, get_optional_user
from ..models.user import User
from ..models.script import Script
from ..services import user_service

router = APIRouter(prefix="/api/game", tags=["游戏"])

HINT_LIMIT = 5
ASK_LIMIT = 30   # 提问次数上限：修好匹配后它就是有区分度的 oracle，必须封顶

# 提示模板：**刻意不含任何汤底内容**。
# 原来这里是「把汤底按句拆开，一次吐一句」，游客还不计数——等于五步走完汤底全文。
# 现在只给通用的盘问方法；剧本专属提示要等主持人通道（服务端组上下文）接上，
# 由 AI 带着汤底生成，而不是从接口里漏出去。
HINT_TEMPLATES = [
    "先找出谜面里最反常的那一件事。它通常就写在那儿，只是你没当回事。",
    "把牵涉到的人一个个列出来：谁清楚真相、谁被蒙在鼓里、谁在撒谎。",
    "留意环境细节——声音、气味、时间点。汤底里往往有一个细节能一次解释全部。",
    "别只问「是不是」。试着问「为什么」和「如果……会怎样」，动机比事实更接近答案。",
    "还没想通的话，可以直接要求主持人揭晓答案。",
]


def _require_playable(script, user):
    """能玩的剧本：存在、没删、已过审。未过审只给作者本人与管理员/站长试。

    原来这三个入口只判 is_deleted——知道 ID 就能玩别人还在审核的稿子，
    问一句答一句照样能把内容套出来。"""
    from fastapi import HTTPException
    if not script or script.is_deleted:
        raise HTTPException(404, "剧本不存在")
    if script.review_status != "approved":
        is_author = user is not None and str(script.user_id) == str(user.id)
        is_admin = user is not None and user.role in ("admin", "owner", "station_master")
        if not (is_author or is_admin):
            raise HTTPException(status_code=423, detail={"code": "script_not_approved",
                                                        "message": "剧本还没过审，暂时不能体验"})
    return script


@router.post("/free-chat")
def free_chat(payload: dict = Body(...), request: Request = None,
              user: User | None = Depends(get_optional_user), db: Session = Depends(get_db)):
    """免费海龟汤 AI 调用：用站长在「模型管理」配置的服务器密钥，供离线用户免费体验海龟汤。
    额度：未登录按 IP 限 1 次，已登录按账号限 3 次（见 site_service.check_free_quota）。"""
    import json as _json
    import urllib.request as _req
    import urllib.error as _err
    from fastapi import HTTPException
    from ..services import site_service
    from .ai_proxy import PROVIDER_URLS

    ip = request.client.host if (request and request.client) else ""
    ok, msg = site_service.check_free_quota(db, user, ip)
    if not ok:
        raise HTTPException(429, msg)

    cfg = site_service.get_free_ai_secret(db)
    api_key = cfg.get("api_key") or ""
    if not api_key:
        raise HTTPException(503, "免费体验未配置：站长需在「模型管理」填写 API Key")
    url = cfg.get("base_url") or PROVIDER_URLS.get(cfg.get("provider") or "deepseek")
    if not url:
        raise HTTPException(400, "免费模型端点未配置")
    model = cfg.get("model") or ""
    messages = payload.get("messages") or []
    if not messages:
        raise HTTPException(400, "缺少对话消息")

    body = _json.dumps({
        "model": model, "messages": messages,
        "max_tokens": 1024, "temperature": 0.8,
    }, ensure_ascii=False).encode("utf-8")
    rq = _req.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {api_key}",
    })
    try:
        with _req.urlopen(rq, timeout=120) as resp:
            data = _json.loads(resp.read().decode("utf-8"))
    except _err.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", errors="ignore")[:800]
        except Exception:
            pass
        raise HTTPException(status_code=e.code, detail=f"上游 AI 错误: {detail or e.reason}")
    except Exception as e:
        raise HTTPException(502, f"免费调用失败: {e}")

    content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    site_service.record_free_quota(db, user, ip)
    # 累计免费活动 token 消耗（上游 usage.total_tokens，缺失则跳过）
    usage = data.get("usage") or {}
    prompt_tokens = int(usage.get("prompt_tokens") or 0)
    completion_tokens = int(usage.get("completion_tokens") or 0)
    total_tokens = usage.get("total_tokens") or (prompt_tokens + completion_tokens)
    # 金额账本：按「缓存命中 / 未命中 / 输出」三段折算成元，落在 free_trial_cost 里。
    # 必须传明细（不能只传 total）：缓存命中价通常是未命中的四分之一，
    # 只按 total 记会把免费额度高估好几倍，玩家明明没花到 10 元就被拦下。
    # DeepSeek 的 OpenAI 兼容接口会回 prompt_cache_hit_tokens；别的厂商不回就当 0（宁可高估）。
    cache_hit = int(usage.get("prompt_cache_hit_tokens") or 0)
    if prompt_tokens or completion_tokens:
        site_service.record_free_usage_detail(db, user, ip, prompt_tokens, completion_tokens, cache_hit)
    elif total_tokens:
        # 上游只回了 total、没有明细：按「全未命中」保守记，至少不让额度被白刷
        site_service.record_free_usage_detail(db, user, ip, int(total_tokens), 0, 0)
    return {"content": content}


@router.get("/{script_id}/start")
def start_game(script_id: str, req: Request = None, user: User | None = Depends(get_optional_user),
               db: Session = Depends(get_db)):
    script = db.query(Script).filter(Script.id == script_id).first()
    _require_playable(script, user)

    play_data = None
    if user:
        data = user_service.get_play_data(db, user, script_id)
        if data:
            play_data = data.get("session_data", {})

    # 剩余提示次数必须读**真正在计数的那个地方**。
    # 这里以前读的是 play_data.session_data.hints_used，而实际限次记在
    # guest_counters 里（get_hint 用 guest_counter_service.bump 累加），
    # 两边从来不同步 → 界面上「剩余提示」永远是 5，用光了也不变，
    # 玩家会以为计数坏了（实测就是这么报上来的）。
    from ..services import guest_counter_service
    subject = guest_counter_service.subject_for(req, user)
    hints_used = guest_counter_service.peek(db, "hint", subject, script_id)

    return {
        "script_id": script.id,
        "title": script.title,
        "story": script.story,
        "tags": script.tags,
        "difficulty": script.difficulty,
        "category": script.category,
        "play_data": play_data,
        "hints_remaining": max(0, 5 - hints_used),
    }


@router.post("/{script_id}/ask")
def ask_question(script_id: str, req: dict, request: Request = None,
                 user: User | None = Depends(get_optional_user), db: Session = Depends(get_db)):
    script = db.query(Script).filter(Script.id == script_id).first()
    _require_playable(script, user)

    question = req.get("question", "").strip()
    if not question:
        return {"answer": "请提出一个问题", "type": "unknown"}

    # 提问也要计数（审计 M5）：原来是无限次的免费二值 oracle。
    # 以前它没区分度所以还不致命，但修好匹配之后就是「30 次把汤底问干净」。
    from ..services import guest_counter_service
    subject = guest_counter_service.subject_for(request, user)
    used, ok = guest_counter_service.bump(db, "ask", subject, script_id, limit=ASK_LIMIT)
    if not ok:
        return {"answer": "这一场问得够多了，凭现有线索推理吧", "type": "exhausted",
                "asks_used": used, "asks_remaining": 0}

    answer = _match_question(question, script.explanation)
    return {"answer": answer[0], "type": answer[1]}


@router.post("/{script_id}/hint")
def get_hint(script_id: str, req: dict = Body(default={}), request: Request = None,
             user: User | None = Depends(get_optional_user), db: Session = Depends(get_db)):
    """给一条盘问方向的提示。

    两处改动（契约 §10.1）：
      ① **不再回吐汤底原句**。原来是按句拆汤底、一次给一句，五次就能把答案抄完。
      ② **游客也计数**。原来是 `if user:` 才累加，游客不带账号可无限次调用。
    """
    from ..services import guest_counter_service
    script = db.query(Script).filter(Script.id == script_id).first()
    _require_playable(script, user)

    subject = guest_counter_service.subject_for(request, user)
    used, ok = guest_counter_service.bump(db, "hint", subject, script_id, limit=HINT_LIMIT)
    if not ok:
        return {"hint": "提示次数已用完", "type": "exhausted",
                "hints_used": used, "hints_remaining": 0}

    level = min(used - 1, len(HINT_TEMPLATES) - 1)
    return {
        "hint": HINT_TEMPLATES[level],
        "type": "guidance",
        "hints_used": used,
        "hints_remaining": max(0, HINT_LIMIT - used),
    }


@router.post("/{script_id}/reveal")
def reveal_answer(script_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from ..core.permission import can_view_full_script
    script = db.query(Script).filter(Script.id == script_id, Script.is_deleted == False).first()
    if not script:
        from fastapi import HTTPException
        raise HTTPException(404, "剧本不存在")

    _require_playable(script, user)
    if not can_view_full_script(user, script, db):
        from fastapi import HTTPException
        raise HTTPException(403, "请先完成这一场游戏后再揭晓答案")

    return {"explanation": script.explanation}


@router.post("/{script_id}/complete")
def complete_script(script_id: str, payload: dict = Body(default={}),
                    user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """标记剧本通关（结算面板调用）+ 通关记录/统计结算（重复调用幂等）。
    合并写入 session_data.completed=True，通关后该用户即可查看汤底。
    payload 可选：{ending_id, ending_name}——记录达成的结局，供个人主页通关记录展示。
    返回附带 rewards：{first_time, exp_gained, coins_gained, level, new_achievements}。"""
    script = db.query(Script).filter(Script.id == script_id, Script.is_deleted == False).first()
    if not script:
        from fastapi import HTTPException
        raise HTTPException(404, "剧本不存在")
    _require_playable(script, user)

    # 结算必须由「服务端见证过的这一场」触发（审计 M3）。
    # 原来这里谁都能调：订阅 → POST /complete → 汤底到手，连玩都不用玩。
    # 现在要求本人此刻正在这一场里（有新式会话或主持证）；作者/管理员/站长不设此限。
    from ..services import host_session_service
    _privileged = user.role in ("admin", "owner", "station_master") or script.user_id == user.id
    if not _privileged and not host_session_service.has_script_access(db, script_id, user=user):
        from fastapi import HTTPException
        raise HTTPException(409, "这一场还没开始或已经结束，不能结算")

    result = user_service.mark_script_completed(db, user, script_id)
    from ..services import stats_service
    rewards = stats_service.on_script_completed(
        db, str(user.id), script_id,
        ending_id=(payload or {}).get("ending_id") or "",
        ending_name=(payload or {}).get("ending_name") or "")
    if isinstance(result, dict):
        result["rewards"] = rewards
        return result
    return {"completed": True, "rewards": rewards}


# --- 内部辅助 ---

def _match_question(question: str, explanation: str) -> tuple[str, str]:
    """按 2-gram 字面重叠回答问题。

    原来是 `words = [w for w in question_lower if len(w) > 1]`——对一个**字符串**逐字符迭代，
    每个元素长度恒为 1，条件恒 False，于是 `words` 恒空、`matched` 恒 0，
    **这个接口以前 100% 回答「无关」**（审计 M5）。

    改成中文更合适的 2-gram：去掉标点后取相邻两字，问句与汤底取交集。
    「他是不是自杀的」对「他是自杀，因为妻子出轨」能命中「自杀」。
    """
    import re

    def grams(text: str) -> set:
        t = re.sub(r"[\s，。！？、,.!?：:；;“”\"'（）()\-—…《》【】]", "", (text or "").lower())
        return {t[i:i + 2] for i in range(len(t) - 1)}

    qg, eg = grams(question), grams(explanation)
    if not qg or not eg:
        return "无关", "unknown"
    hit = len(qg & eg)
    if hit >= 2:
        return "是", "yes"
    if hit == 1:
        return "可能沾边", "unknown"
    return "无关", "unknown"


