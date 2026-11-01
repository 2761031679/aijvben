"""剧本业务逻辑"""
import json
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_
from fastapi import HTTPException

from ..models.user import User
from ..models.script import Script, Rating, Comment, VALID_CATEGORIES, REVIEW_APPROVED
from ..models.system import LikesRecord
from ..models.review import AiReview
from ..core.permission import can_view_full_script, can_edit_script
from ..services import search_service, tag_service, notification_service, ai_review_service


def list_scripts(
    db: Session, page: int = 1, category: str | None = None,
    tag: str = "", sort: str = "newest", review_status: str | None = None,
    page_size: int = 20, keyword: str = "", tags: list | None = None,
    min_likes: int = 0, max_likes: int = None,
    min_dislikes: int = 0, max_dislikes: int = None,
) -> dict:
    """获取剧本列表（公开）。统一走 search_service 以支持搜索/筛选/排序。"""
    tag_list = tags if tags else ([tag] if tag else [])
    return search_service.search(
        db, keyword=keyword, category=category or "", tags=tag_list,
        review_status=review_status or "approved", min_likes=min_likes,
        max_likes=max_likes, min_dislikes=min_dislikes, max_dislikes=max_dislikes,
        sort=sort, page=page, page_size=page_size,
    )


def search_scripts(
    db: Session, keyword: str = "", category: str = "", sort: str = "popular",
    tags: list | None = None, min_likes: int = 0, min_dislikes: int = 0,
    limit: int = 5, max_likes: int = None, max_dislikes: int = None,
) -> dict:
    """搜索剧本（供 NPC / 前端复用），返回 {"scripts": [...]}。"""
    result = search_service.search(
        db, keyword=keyword, category=category, tags=tags or [],
        review_status="approved", min_likes=min_likes, max_likes=max_likes,
        min_dislikes=min_dislikes, max_dislikes=max_dislikes,
        sort=sort or "popular", page=1, page_size=limit,
    )
    return {"scripts": result["scripts"]}


def get_script_detail(db: Session, script_id: str, user: User | None = None) -> dict:
    """获取剧本详情"""
    script = db.query(Script).filter(Script.id == script_id).first()
    if not script or script.is_deleted:
        raise HTTPException(404, "剧本不存在")

    # 未过审的剧本只有作者本人与管理员/站长能看到（契约 §10.1）。
    # 原来这里只判 is_deleted，于是「知道 ID 就能看别人还在审核的稿子」，连汤底一起。
    if script.review_status != REVIEW_APPROVED:
        is_author = user is not None and str(script.user_id) == str(user.id)
        is_admin = user is not None and user.role in ("admin", "owner", "station_master")
        if not (is_author or is_admin):
            raise HTTPException(404, "剧本不存在")

    include_full = can_view_full_script(user, script, db)
    is_subscribed = False
    if user:
        from ..models.user_data import Subscription
        is_subscribed = db.query(Subscription).filter(
            Subscription.user_id == user.id,
            Subscription.script_id == script_id,
        ).first() is not None

    # 简介属公开信息（相当于图书封底介绍），所有人可见；汤底/结束条件仍按权限控制
    d = script.to_dict(include_full=include_full, include_synopsis=True)
    d["is_full"] = include_full  # 显式下发权限判定，供前端决定汤底/结束条件是否可解锁
    d["is_subscribed"] = is_subscribed
    # 管理权限（编辑/删除）：原作者或站长。显式下发，前端据此显示删除按钮
    d["can_manage"] = can_edit_script(user, script) if user else False
    # 标签点赞与排序（点赞最高的排最前）
    d["tags"] = tag_service.get_tags_with_likes(db, script.id)
    # AI 初审结果（供审核员/详情展示）
    ai = ai_review_service.get_latest_ai_review(db, script.id)
    d["ai_review"] = ai.to_dict() if ai else None
    return d


def normalize_endings(raw) -> str:
    """校验并规范化胜利/失败条件表（JSON 字符串），返回规范后的 JSON 字符串。

    结构：{"endings": [{"id","name","type":"win|lose","note",
            "conditions": [{"id","name","rule","threshold":1,"hidden":false}]}]}
    空输入返回 ""；结构非法抛 400（键名/类型在此统一收口，前端条件系统依赖此结构）。
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return ""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(400, "胜利/失败条件不是合法 JSON")
    endings = data.get("endings") if isinstance(data, dict) else None
    if not isinstance(endings, list):
        raise HTTPException(400, "胜利/失败条件格式错误：顶层缺少 endings 数组")

    norm = []
    seen_ids = set()
    for e in endings:
        if not isinstance(e, dict):
            raise HTTPException(400, "结局格式错误：每个结局必须是对象")
        eid = str(e.get("id") or "").strip()
        name = str(e.get("name") or "").strip()
        etype = e.get("type")
        if not eid or not name or etype not in ("win", "lose"):
            raise HTTPException(400, "每个结局需要 id、name 和 type（win 或 lose）")
        if eid in seen_ids:
            raise HTTPException(400, f"结局 id 重复：{eid}")
        seen_ids.add(eid)

        conds = []
        seen_cids = set()
        for c in (e.get("conditions") or []):
            if not isinstance(c, dict):
                raise HTTPException(400, f"结局「{name}」的条件格式错误")
            cid = str(c.get("id") or "").strip()
            rule = str(c.get("rule") or "").strip()
            if not cid or not rule:
                raise HTTPException(400, f"结局「{name}」的每个条件需要 id 和 rule")
            if cid in seen_cids:
                raise HTTPException(400, f"结局「{name}」的条件 id 重复：{cid}")
            seen_cids.add(cid)
            try:
                threshold = int(c.get("threshold", 1))
            except (TypeError, ValueError):
                threshold = 1
            conds.append({
                "id": cid,
                "name": str(c.get("name") or "").strip() or cid,
                "rule": rule,
                "threshold": max(1, threshold),
                "hidden": bool(c.get("hidden", False)),
            })
        norm.append({
            "id": eid, "name": name, "type": etype,
            "note": str(e.get("note") or "").strip(),
            "conditions": conds,
        })
    return json.dumps({"endings": norm}, ensure_ascii=False)


# 任务效果类型：揭示线索 / 给予道具 / 给 NPC 发消息
TASK_EFFECT_TYPES = ("reveal_clue", "give_item", "npc_message")


def normalize_tasks(raw) -> str:
    """校验并规范化任务条件表（JSON 字符串），返回规范后的 JSON 字符串。

    结构：{"tasks": [{"id","name","note",
            "conditions": [{"id","name","rule","threshold":1,"hidden":false}],
            "effect": {"type":"reveal_clue|give_item|npc_message","payload":"..."}}]}
    空输入返回 ""（任务可选）；结构非法抛 400（键名/类型在此统一收口）。
    原理与胜利/失败条件一致：NPC 发 [task:任务ID.条件ID] 标记计数，
    某任务全部条件满足即完成，系统自动执行 effect。
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return ""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(400, "任务条件不是合法 JSON")
    tasks = data.get("tasks") if isinstance(data, dict) else None
    if not isinstance(tasks, list):
        raise HTTPException(400, "任务条件格式错误：顶层缺少 tasks 数组")

    norm = []
    seen_ids = set()
    for t in tasks:
        if not isinstance(t, dict):
            raise HTTPException(400, "任务格式错误：每个任务必须是对象")
        tid = str(t.get("id") or "").strip()
        name = str(t.get("name") or "").strip()
        if not tid or not name:
            raise HTTPException(400, "每个任务需要 id 和 name")
        if tid in seen_ids:
            raise HTTPException(400, f"任务 id 重复：{tid}")
        seen_ids.add(tid)

        conds = []
        seen_cids = set()
        for c in (t.get("conditions") or []):
            if not isinstance(c, dict):
                raise HTTPException(400, f"任务「{name}」的条件格式错误")
            cid = str(c.get("id") or "").strip()
            rule = str(c.get("rule") or "").strip()
            if not cid or not rule:
                raise HTTPException(400, f"任务「{name}」的每个条件需要 id 和 rule")
            if cid in seen_cids:
                raise HTTPException(400, f"任务「{name}」的条件 id 重复：{cid}")
            seen_cids.add(cid)
            try:
                threshold = int(c.get("threshold", 1))
            except (TypeError, ValueError):
                threshold = 1
            conds.append({
                "id": cid,
                "name": str(c.get("name") or "").strip() or cid,
                "rule": rule,
                "threshold": max(1, threshold),
                "hidden": bool(c.get("hidden", False)),
            })
        if not conds:
            raise HTTPException(400, f"任务「{name}」至少需要一个条件")

        effect = t.get("effect")
        if not isinstance(effect, dict):
            raise HTTPException(400, f"任务「{name}」需要完成效果 effect")
        etype = effect.get("type")
        payload = str(effect.get("payload") or "").strip()
        if etype not in TASK_EFFECT_TYPES:
            raise HTTPException(400, f"任务「{name}」的效果类型必须是 reveal_clue / give_item / npc_message")
        if not payload:
            raise HTTPException(400, f"任务「{name}」的效果内容不能为空")

        norm.append({
            "id": tid, "name": name,
            "note": str(t.get("note") or "").strip(),
            "conditions": conds,
            "effect": {"type": etype, "payload": payload},
        })
    return json.dumps({"tasks": norm}, ensure_ascii=False)


def create_script(db: Session, user: User, data: dict) -> dict:
    """上传新剧本"""
    if data.get("category") not in VALID_CATEGORIES:
        data["category"] = "hai-gui-tang"

    endings = normalize_endings(data.get("endings"))
    if not endings:
        raise HTTPException(400, "胜利/失败条件为必填项：请至少设置一个结局及其条件")

    script = Script(
        title=data["title"], story=data["story"],
        explanation=data["explanation"],
        ending_condition=data.get("ending_condition", ""),
        endings=endings,
        tasks=normalize_tasks(data.get("tasks")),
        host_guide=(data.get("host_guide") or "").strip(),
        synopsis=data.get("synopsis", ""),
        author=data.get("author", user.username),
        tags=data.get("tags", []),
        difficulty=data.get("difficulty", 3),
        category=data["category"],
        review_status="draft",
        user_id=user.id,
    )
    db.add(script)
    db.commit()
    db.refresh(script)
    tag_service.sync_tags(db, script)
    # 统计：上传剧本数 + 经验（v4.6c）
    from . import stats_service
    stats_service.on_script_uploaded(db, str(user.id))
    return script.to_dict(include_full=True)


def update_script(db: Session, user: User, script_id: str, data: dict) -> dict:
    """编辑剧本"""
    script = db.query(Script).filter(Script.id == script_id).first()
    if not script or script.is_deleted:
        raise HTTPException(404, "剧本不存在")
    if not can_edit_script(user, script):
        raise HTTPException(403, "无权编辑此剧本")

    for field in ("title", "story", "explanation", "ending_condition", "synopsis", "author", "tags", "difficulty", "category"):
        if field in data and data[field] is not None:
            setattr(script, field, data[field])
    if "endings" in data and data["endings"] is not None:
        # 胜利/失败条件为必填项：显式提交时不得清空
        endings = normalize_endings(data["endings"])
        if not endings:
            raise HTTPException(400, "胜利/失败条件为必填项：请至少设置一个结局及其条件")
        script.endings = endings
    if "tasks" in data and data["tasks"] is not None:
        script.tasks = normalize_tasks(data["tasks"])
    if "host_guide" in data and data["host_guide"] is not None:
        script.host_guide = (data["host_guide"] or "").strip()
    script.updated_at = datetime.now(timezone.utc)
    db.commit()
    tag_service.sync_tags(db, script)
    return script.to_dict(include_full=True)


def delete_script(db: Session, user: User, script_id: str) -> dict:
    """软删除剧本"""
    script = db.query(Script).filter(Script.id == script_id).first()
    if not script:
        raise HTTPException(404, "剧本不存在")
    if not can_edit_script(user, script):
        raise HTTPException(403, "无权删除此剧本")

    script.is_deleted = True
    script.deleted_at = datetime.now(timezone.utc)
    script.deleted_by = user.username
    db.commit()
    return {"message": "剧本已移入回收站"}


def rate_script(db: Session, user: User, script_id: str, rating: int) -> dict:
    """给剧本评分"""
    script = db.query(Script).filter(Script.id == script_id).first()
    if not script or script.is_deleted:
        raise HTTPException(404, "剧本不存在")

    existing = db.query(Rating).filter(
        Rating.script_id == script_id, Rating.user_id == user.id
    ).first()
    if existing:
        existing.rating = rating
    else:
        db.add(Rating(script_id=script_id, user_id=user.id, rating=rating))

    db.flush()
    votes = db.query(Rating).filter(Rating.script_id == script_id).all()
    script.rating_count = len(votes)
    script.avg_rating = sum(v.rating for v in votes) / len(votes) if votes else 0
    db.commit()
    return {"message": "评分成功", "avg_rating": script.avg_rating}


def toggle_like(db: Session, user: User, script_id: str, like_type: str) -> dict:
    """点赞/点踩"""
    script = db.query(Script).filter(Script.id == script_id).first()
    if not script or script.is_deleted:
        raise HTTPException(404, "剧本不存在")

    existing = db.query(LikesRecord).filter(
        LikesRecord.script_id == script_id, LikesRecord.user_id == user.id
    ).first()
    # 记录变更前后状态，用于作者统计（v4.6c）
    changes = []  # [(like_type, active)] active=True 新增 / False 取消
    if existing:
        if existing.like_type == like_type:
            # 取消
            db.delete(existing)
            changes.append((like_type, False))
            if like_type == "like":
                script.likes = max(0, script.likes - 1)
            else:
                script.dislikes = max(0, script.dislikes - 1)
        else:
            # 切换
            changes.append((existing.like_type, False))
            if existing.like_type == "like":
                script.likes = max(0, script.likes - 1)
            else:
                script.dislikes = max(0, script.dislikes - 1)
            existing.like_type = like_type
            changes.append((like_type, True))
            if like_type == "like":
                script.likes += 1
            else:
                script.dislikes += 1
    else:
        db.add(LikesRecord(script_id=script_id, user_id=user.id, like_type=like_type))
        changes.append((like_type, True))
        if like_type == "like":
            script.likes += 1
        else:
            script.dislikes += 1

    db.commit()
    # 统计：作者获得点赞/点踩（不计作者给自己投票）
    if changes and str(user.id) != str(script.user_id):
        from . import stats_service
        for lt, active in changes:
            stats_service.on_like_changed(db, str(script.user_id), lt, active)
    return {"likes": script.likes, "dislikes": script.dislikes}


def comment_script(db: Session, user: User, script_id: str,
                   content: str, difficulty_rating: int | None = None) -> dict:
    """评论剧本"""
    script = db.query(Script).filter(Script.id == script_id).first()
    if not script or script.is_deleted:
        raise HTTPException(404, "剧本不存在")

    comment = Comment(script_id=script_id, user_id=user.id, content=content)
    db.add(comment)
    db.flush()

    if difficulty_rating:
        votes = list(script.difficulty_votes or [])
        existing_idx = next((i for i, v in enumerate(votes) if v.get("user_id") == user.id), None)
        if existing_idx is not None:
            votes[existing_idx]["difficulty"] = difficulty_rating
        else:
            votes.append({"user_id": user.id, "difficulty": difficulty_rating})
        script.difficulty_votes = votes

    db.commit()
    # 通知作者与订阅者
    notification_service.notify_new_comment(db, script, user.username)
    return comment.to_dict()


def get_comments(db: Session, script_id: str, user: User | None = None) -> list[dict]:
    """获取剧本评论"""
    comments = db.query(Comment).filter(
        Comment.script_id == script_id
    ).order_by(Comment.created_at.desc()).all()
    return [c.to_dict() for c in comments]


def get_my_scripts(db: Session, user: User) -> list[dict]:
    """我的作品列表（含标签点赞信息，供前端搜索与筛选）"""
    scripts = db.query(Script).filter(
        Script.user_id == user.id, Script.is_deleted == False
    ).order_by(Script.created_at.desc()).all()
    result = []
    for s in scripts:
        d = s.to_dict(include_full=True)
        d["tags"] = tag_service.get_tags_with_likes(db, s.id)
        result.append(d)
    return result
