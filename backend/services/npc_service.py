"""NPC 业务逻辑"""
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session
from fastapi import HTTPException

from ..models.user import User
from ..models.npc import NpcPrompt, NpcRefusalReport
from ..models.script import (
    Script, VALID_CATEGORIES, REVIEW_APPROVED,
    REVIEW_PENDING_API, REVIEW_PENDING_ADMIN, REVIEW_SYSTEM_FLAGGED, REVIEW_REJECTED,
)
from ..models.review import AiReview
from ..services import script_service, ai_review_service
from . import tag_service

#: 提示词写接口的统一口径。`npc_prompts` 表已废弃——提示词的唯一可信源是文件
#: （npc_configs/{npc_id}/prompts/ 与 npc_configs/shared/prompts/），写表不会生效。
#: 所以所有「写提示词」的入口都固定回 410，而不是让框架回 405：
#: 405 会被读成「接口拼错了、再翻翻文档」，410 才是「这东西已经没了，别再调」。
#: 两个前缀（/api/npc/prompts 与 /api/admin/npc-prompts）共用这一句，免得同一个废弃接口
#: 有两种说法。
DEPRECATED_PROMPT_HINT = (
    "提示词接口已废弃，请改用 "
    "PUT /api/admin/npc-configs/{npc_id}/prompts/{prompt_type}"
)


def get_prompts(db: Session, npc_id: str, personality_id: str = "") -> list[dict]:
    """获取 NPC 提示词。

    设计：以「文件系统」为唯一可信源（与站长管理面板读写同一份文件），
    避免 DB / 文件双轨不一致导致「后台改了但 NPC 读不到」的问题（见 #8 修复）。
    - 每 NPC 基础提示词：npc_configs/{npc_id}/prompts/*.txt
    - 共享提示词：        npc_configs/shared/prompts/*.txt
      （game_mode 以 game_mode_{category}.txt 命名，category 一并返回，供前端按剧本类型过滤）
    """
    try:
        from . import npc_file_service
        file_prompts = npc_file_service.get_npc_prompts(npc_id) or []
        shared = npc_file_service.get_shared_prompts() or []
    except Exception:
        return []

    out = []
    for p in file_prompts:
        out.append({
            "npc_id": npc_id, "personality_id": "",
            "prompt_type": p.get("prompt_type"), "category": "",
            "content": p.get("content", ""),
        })
    for p in shared:
        out.append({
            "npc_id": "shared", "personality_id": "",
            "prompt_type": p.get("prompt_type"), "category": p.get("category", ""),
            "content": p.get("content", ""),
        })
    return out


def upsert_npc_prompt(db: Session, user, npc_id: str, personality_id: str,
                     prompt_type: str, category: str, content: str):
    """插入或更新 NPC 提示词（供 npc_file_service 同步用）"""
    existing = db.query(NpcPrompt).filter(
        NpcPrompt.npc_id == npc_id,
        NpcPrompt.personality_id == personality_id,
        NpcPrompt.prompt_type == prompt_type,
        NpcPrompt.category == category,
    ).first()

    if existing:
        existing.content = content
        existing.updated_by = user.id
        existing.updated_at = datetime.now(timezone.utc)
    else:
        pt = NpcPrompt(
            npc_id=npc_id,
            personality_id=personality_id,
            prompt_type=prompt_type,
            category=category,
            content=content,
            updated_by=user.id,
        )
        db.add(pt)
    db.commit()


def save_prompt(db: Session, user: User, data: dict) -> dict:
    """保存 NPC 提示词"""
    if user.role not in ("admin", "owner"):
        raise HTTPException(403, "需要管理员权限")

    existing = db.query(NpcPrompt).filter(
        NpcPrompt.npc_id == data["npc_id"],
        NpcPrompt.personality_id == data.get("personality_id", ""),
        NpcPrompt.prompt_type == data["prompt_type"],
        NpcPrompt.category == data.get("category", ""),
    ).first()

    if existing:
        existing.content = data["content"]
        existing.updated_by = user.id
        existing.updated_at = datetime.now(timezone.utc)
    else:
        pt = NpcPrompt(
            npc_id=data["npc_id"],
            personality_id=data.get("personality_id", ""),
            prompt_type=data["prompt_type"],
            category=data.get("category", ""),
            content=data["content"],
            updated_by=user.id,
        )
        db.add(pt)
    db.commit()
    return {"message": "提示词已保存"}


def delete_prompt(db: Session, user: User, prompt_id: str) -> dict:
    """删除 NPC 提示词"""
    if user.role not in ("admin", "owner"):
        raise HTTPException(403, "需要管理员权限")
    prompt = db.query(NpcPrompt).filter(NpcPrompt.id == prompt_id).first()
    if not prompt:
        raise HTTPException(404, "提示词不存在")
    db.delete(prompt)
    db.commit()
    return {"message": "已删除"}


def report_refusal(db: Session, user: User, npc_id: str, reason: str,
                   chat_log: list | None = None) -> dict:
    """NPC 拒绝服务上报"""
    ban_until = datetime.now(timezone.utc) + timedelta(hours=24)
    report = NpcRefusalReport(
        user_id=user.id, npc_id=npc_id,
        reason=reason, chat_log=chat_log or [],
        ban_until=ban_until,
    )
    db.add(report)
    db.commit()
    return {"message": "已上报，用户将在24小时内无法使用该NPC服务"}


def check_ban(db: Session, user: User) -> dict:
    """检查封禁状态"""
    now = datetime.now(timezone.utc)
    report = db.query(NpcRefusalReport).filter(
        NpcRefusalReport.user_id == user.id,
        NpcRefusalReport.ban_until > now,
    ).order_by(NpcRefusalReport.ban_until.desc()).first()

    if report:
        return {
            "banned": True,
            "ban_until": report.ban_until.strftime("%Y-%m-%d %H:%M:%S"),
            "reason": report.reason,
        }
    return {"banned": False}


def search_scripts(db: Session, keyword: str = "", category: str = "", sort: str = "popular",
                   tags: list | None = None, min_likes: int = 0, min_dislikes: int = 0,
                   limit: int = 5, max_likes: int = None, max_dislikes: int = None) -> list[dict]:
    """NPC 搜索剧本（复用统一搜索服务，支持标签/点赞区间筛选与排序）。

    容错：AI/NPC 常把题材或站点主题词（如 "海龟汤"）误传入 category，
    而 category 走的是精确匹配。若 category 不是合法分类值，则把它并入关键词再搜一次。

    注意：关键词现在是**真筛**（子串匹配，单字也认，见 search_service._match_keyword）。
    这句「只影响排序、不做硬过滤」的旧承诺已经不成立了，所以这里补一层兜底 ——
    并入后的关键词一条都没搜到时，丢掉这次「误用参数」再搜一次，
    让「AI 传错 category」退化成「按分类/热度给几个」，而不是让 NPC 对着空气讲话。
    兜底**只针对参数误用**；真实关键词搜不到就如实为空（那是搜索该有的回答）。
    """
    orig_keyword = keyword
    folded = ""
    if category and category not in VALID_CATEGORIES:
        folded = category
        keyword = (f"{keyword} {category}").strip() if keyword else category
        category = ""
    result = script_service.search_scripts(
        db, keyword=keyword, category=category, sort=sort, tags=tags,
        min_likes=min_likes, min_dislikes=min_dislikes, limit=limit,
        max_likes=max_likes, max_dislikes=max_dislikes,
    )
    items = result["scripts"]
    if not items and folded:
        items = script_service.search_scripts(
            db, keyword=orig_keyword, category="", sort=sort, tags=tags,
            min_likes=min_likes, min_dislikes=min_dislikes, limit=limit,
            max_likes=max_likes, max_dislikes=max_dislikes,
        )["scripts"]
    return items


# 已实现详情查询的剧本类型；其余类型暂只返回「制作中」提示
DETAIL_IMPLEMENTED_CATEGORIES = {"hai-gui-tang"}


def get_script(db, script_id, user, can_full=None):
    """NPC 获取单个剧本内容，按剧本类型决定返回信息。

    `can_full(script)` 由调用方注入「这个调用者是否正在主持/体验这一场」的判定
    （见 host_session_service.has_script_access）。**服务端判权，客户端传什么都不算。**

    类型分工：
    - 海龟汤（hai-gui-tang）：返回完整详情（汤面 + 汤底 + 结束条件 + 简介）。
      NPC 是游戏主持人，必须掌握汤底以推进游戏；汤底对「用户直接查看剧本」的保密
      由网站权限系统（can_view_full_script）负责，而 NPC 作为被提示词约束的可信代理，
      始终拿到完整内容。NPC 不会主动泄露汤底，除非用户猜出（由提示词约束）。
    - DND / COC / 剧本扮演：详情功能尚未制作，仅返回基本信息 + 制作中提示。

    仅公开剧本或本人/管理员可见；其他人的草稿/待审不暴露给 NPC。"""
    script = db.query(Script).filter(
        Script.id == script_id, Script.is_deleted == False
    ).first()
    # 容错：NPC 常常拿不到剧本内部 ID，只知道标题（例如用户直接说「替罪」）。
    # 若按 ID 查不到，则回退为按标题精确 / 模糊匹配（仅在已过审剧本内），
    # 让 NPC 无需先搜索、仅凭标题也能正确调取剧本详情。
    if not script and script_id:
        kw = str(script_id).strip()
        base = db.query(Script).filter(
            Script.is_deleted == False,
            Script.review_status == REVIEW_APPROVED,
        )
        script = (base.filter(Script.title == kw).first()
                  or base.filter(Script.title.like(f"%{kw}%")).first())
    if not script:
        return None
    # 站长的口径要跟 permission.can_view_full_script 一致：
    # 那里把 station_master 算进特权，这里漏了，站长就成了「详情页能看汤底、
    # NPC 接口连条件表都拿不到」的二等公民（审计 B1）。
    is_owner_or_admin = user and (
        user.role in ("admin", "owner", "station_master") or str(script.user_id) == str(user.id)
    )
    if script.review_status != REVIEW_APPROVED and not is_owner_or_admin:
        return None

    # 未实现的类型：仅返回基本信息 + 制作中提示（不含汤底等保密字段）
    if script.category not in DETAIL_IMPLEMENTED_CATEGORIES:
        d = script.to_dict(include_full=False, include_synopsis=True)
        d["not_implemented"] = True
        d["detail_notice"] = f"「{script.category}」类型剧本的详情功能正在制作中，暂不支持查询完整内容。"
        return d

    # 海龟汤：只有「正在主持这一场」的调用者才拿得到汤底全套。
    # 这条原来是无条件的（注释理由是「NPC 是可信代理，保密交给提示词」），
    # 但接口是公开的、还支持标题模糊匹配，等于任何人都能按标题把汤底捞走。
    # 现在改成服务端判权：作者/管理员，或这一场的主持证持有者。
    # 三档，别写成一档：
    #   作者/管理员/站长 → 全套（他们本来就在编辑这个剧本）；
    #   正在主持这一场的人 → **只给条件表**，汤底正文一律不出服务端；
    #   其他人 → 只有公开字段。
    allow_full = bool(is_owner_or_admin)
    allow_conditions = allow_full or bool(can_full and can_full(script))
    d = script.to_dict(include_full=allow_full, include_synopsis=True,
                       include_conditions=allow_conditions)
    try:
        d["tags"] = tag_service.get_tags_with_likes(db, script.id)
    except Exception:
        d["tags"] = script.tags or []
    if not allow_conditions:
        # 公开字段照给（标题/类型/难度/标签/简介/谜面都在），只是不给汤底与条件表。
        # 前端与插件据此可以照常显示"搜到了这条剧本"，只是看不到答案。
        d["full_locked"] = True
        d["detail_notice"] = (
            "已找到这个剧本，但汤底与条件表只在你正在体验/主持这一场时才会下发。"
            "先开一场体验，再来取主持上下文。"
        )
    return d


def search_tags(db: Session, keyword: str = "") -> list[dict]:
    """NPC 获取剧本标签列表。

    - 无关键词：按热度（点赞数）排序返回前 20 条站点已有标签；
    - 有关键词：在全部标签中搜索筛选，返回前 10 条。
    """
    from . import search_service
    if keyword and keyword.strip():
        kw = keyword.strip().lower()
        all_t = search_service.all_tags(db, limit=500)
        return [t for t in all_t if kw in t["tag"].lower()][:10]
    return search_service.all_tags(db, limit=20)


def _attach_ai(db: Session, script: Script) -> dict:
    d = script.to_dict(include_full=True)
    ai = ai_review_service.get_latest_ai_review(db, script.id)
    d["ai_review"] = ai.to_dict() if ai else None
    return d


def user_works(db: Session, user_id) -> list[dict]:
    """读取某用户的全部作品（含未审核/驳回，供 NPC 了解创作者全貌）。"""
    scripts = db.query(Script).filter(
        Script.user_id == str(user_id), Script.is_deleted == False
    ).order_by(Script.created_at.desc()).all()
    return [s.to_dict(include_full=True) for s in scripts]


def user_subscriptions(db: Session, user_id) -> list[dict]:
    """读取某用户的订阅列表。"""
    from ..models.user_data import Subscription
    subs = db.query(Subscription).filter(Subscription.user_id == user_id).all()
    out = []
    for sub in subs:
        s = db.query(Script).filter(Script.id == sub.script_id, Script.is_deleted == False).first()
        if s:
            d = s.to_dict(include_synopsis=True)
            d["subscribed_at"] = sub.created_at.strftime("%Y-%m-%d %H:%M:%S") if sub.created_at else ""
            out.append(d)
    return out


def user_reviews(db: Session, user_id) -> list[dict]:
    """读取某用户正处审核流程中的作品（含 AI 初审结果）。"""
    statuses = [REVIEW_PENDING_API, REVIEW_PENDING_ADMIN, REVIEW_SYSTEM_FLAGGED, REVIEW_REJECTED]
    scripts = db.query(Script).filter(
        Script.user_id == str(user_id), Script.is_deleted == False,
        Script.review_status.in_(statuses),
    ).order_by(Script.created_at.desc()).all()
    return [_attach_ai(db, s) for s in scripts]


def review_pending(db: Session) -> list[dict]:
    """站长/管理员 NPC 读取待审核队列（AI 初审 + 站长复审 + 系统标记）。"""
    statuses = [REVIEW_PENDING_API, REVIEW_PENDING_ADMIN, REVIEW_SYSTEM_FLAGGED]
    scripts = db.query(Script).filter(
        Script.is_deleted == False, Script.review_status.in_(statuses)
    ).order_by(Script.created_at.desc()).all()
    return [_attach_ai(db, s) for s in scripts]
