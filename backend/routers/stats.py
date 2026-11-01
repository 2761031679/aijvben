"""用户数据统计 / 个人主页 / 成就 / 关注 API（v4.6c 新增）"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.security import get_current_user, get_optional_user, require_admin_or_station_master
from ..models.user import User
from ..models.script import Script, REVIEW_APPROVED
from ..models.stats import UserStats, Achievement, UserAchievement, Follow
from ..models.user_data import UserProfile, Subscription
from ..services import stats_service

router = APIRouter(prefix="/api", tags=["stats"])


# ============ 自己的统计 ============

@router.get("/user/stats")
def my_stats(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """自己的完整统计（含 token 消耗等隐私数据，仅本人可见）+ 已获得成就"""
    # 顺手把上传数对齐到 Script 行数（自愈）：计数器是缓存，脏了就在这里修好，
    # 免得「个人中心 0 / 后台 4」一直挂着（用户实测）。
    stats = stats_service.sync_scripts_uploaded(db, str(user.id))
    db.commit()
    return {
        "username": user.username,
        "stats": stats_service.stats_to_dict(stats),
        "achievements": stats_service.get_user_achievements(db, str(user.id)),
    }


@router.post("/user/stats/usage")
def report_usage(payload: dict, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    """前端直连 AI 后的 token 消耗上报（fire-and-forget，只发数字不发内容）。
    诚实性说明：直连上报理论上可被篡改，但 token 统计仅作成就/展示、不涉及计费，风险可接受。"""
    total = int(payload.get("total_tokens") or 0)
    if total <= 0:
        p = int(payload.get("prompt_tokens") or 0)
        c = int(payload.get("completion_tokens") or 0)
        total = p + c
    stats_service.add_tokens(db, str(user.id), total)
    return {"ok": True}


# ============ 个人主页（公开） ============

@router.get("/users/{user_id}/profile")
def public_profile(user_id: str, db: Session = Depends(get_db),
                   viewer: User = Depends(get_optional_user)):
    """个人主页公开数据：等级/成就分/关注数/上传的剧本/订阅的剧本（可隐藏）/展示的成就"""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")

    stats = db.query(UserStats).filter(UserStats.user_id == user_id).first()
    stats_dict = stats_service.stats_to_dict(stats) if stats else stats_service.stats_to_dict(UserStats(user_id=user_id))
    # 公开页不暴露 token 消耗等隐私数据
    public_stats = {k: v for k, v in stats_dict.items()
                    if k in ("scripts_completed", "scripts_uploaded", "likes_received",
                             "subs_received", "achievement_points", "level",
                             "following_count", "follower_count")}
    # 上传数按 Script 行数现算覆盖：这台计数器对存量用户从来没回填过（个人中心长期 0）。
    # 这里是**读**侧重算 —— 匿名 GET 不该顺手写库，公开页尤其不该。
    public_stats["scripts_uploaded"] = stats_service.count_uploaded(db, user_id)

    # 上传的剧本（仅已上架）
    works = db.query(Script).filter(
        Script.user_id == user_id, Script.review_status == REVIEW_APPROVED
    ).order_by(Script.created_at.desc()).limit(50).all()
    works_list = [{"id": s.id, "title": s.title, "category": s.category,
                   "synopsis": s.synopsis or "", "likes": s.likes or 0} for s in works]

    # 订阅的剧本（用户可选择隐藏：settings_json.hide_subscriptions）
    profile = db.query(UserProfile).filter(UserProfile.user_id == user_id).first()
    settings = (profile.settings_json if profile and profile.settings_json else {}) or {}
    hide_subs = bool(settings.get("hide_subscriptions"))
    is_self = bool(viewer and str(viewer.id) == user_id)
    subs_list = None
    if is_self or not hide_subs:
        subs = db.query(Subscription).filter(Subscription.user_id == user_id) \
            .order_by(Subscription.subscribed_at.desc()).limit(50).all()
        subs_list = [{"id": s.script.id, "title": s.script.title, "category": s.script.category}
                     for s in subs if s.script]

    # 展示的成就：settings.showcase_achievements（id 列表）优先，否则展示全部已获得
    earned = stats_service.get_user_achievements(db, user_id)
    showcase_ids = settings.get("showcase_achievements") or []
    if showcase_ids:
        order = {aid: i for i, aid in enumerate(showcase_ids)}
        shown = sorted([a for a in earned if a["id"] in order], key=lambda a: order[a["id"]])
    else:
        shown = earned

    # 关注关系（游客/他人视角）
    is_following = False
    if viewer and not is_self:
        is_following = bool(db.query(Follow).filter(
            Follow.follower_id == str(viewer.id), Follow.followee_id == user_id).first())

    return {
        "user": {"id": user_id, "username": target.username,
                 "realname_verified": bool(target.realname_verified),
                 "created_at": target.created_at.isoformat() if target.created_at else None},
        "stats": public_stats,
        "works": works_list,
        "subscriptions": subs_list,          # None = 对方已隐藏
        "subscriptions_hidden": hide_subs and not is_self,
        "achievements": shown,
        "is_self": is_self,
        "is_following": is_following,
    }


# ============ 关注 ============

@router.post("/users/{user_id}/follow")
def follow_user(user_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if str(user.id) == user_id:
        raise HTTPException(status_code=400, detail="不能关注自己")
    if not db.query(User).filter(User.id == user_id).first():
        raise HTTPException(status_code=404, detail="用户不存在")
    exists = db.query(Follow).filter(
        Follow.follower_id == str(user.id), Follow.followee_id == user_id).first()
    if not exists:
        db.add(Follow(follower_id=str(user.id), followee_id=user_id))
        db.commit()
        stats_service.on_follow(db, str(user.id), user_id)
    return {"following": True}


@router.delete("/users/{user_id}/follow")
def unfollow_user(user_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    row = db.query(Follow).filter(
        Follow.follower_id == str(user.id), Follow.followee_id == user_id).first()
    if row:
        db.delete(row)
        db.commit()
        stats_service.on_unfollow(db, str(user.id), user_id)
    return {"following": False}


@router.get("/users/{user_id}/followers")
def followers(user_id: str, db: Session = Depends(get_db)):
    rows = db.query(Follow).filter(Follow.followee_id == user_id).limit(200).all()
    ids = [r.follower_id for r in rows]
    users = {str(u.id): u.username for u in db.query(User).filter(User.id.in_(ids)).all()} if ids else {}
    return {"users": [{"id": i, "username": users.get(i, "未知用户")} for i in ids]}


@router.get("/users/{user_id}/following")
def following(user_id: str, db: Session = Depends(get_db)):
    rows = db.query(Follow).filter(Follow.follower_id == user_id).limit(200).all()
    ids = [r.followee_id for r in rows]
    users = {str(u.id): u.username for u in db.query(User).filter(User.id.in_(ids)).all()} if ids else {}
    return {"users": [{"id": i, "username": users.get(i, "未知用户")} for i in ids]}


# ============ 成就（公开列表 + 站长管理） ============

@router.get("/achievements")
def list_achievements(db: Session = Depends(get_db)):
    """已启用的成就列表（公开）"""
    rows = db.query(Achievement).filter(Achievement.enabled == True).all()  # noqa: E712
    return {"achievements": [a.to_dict() for a in rows]}


@router.get("/admin/achievements")
def admin_list_achievements(db: Session = Depends(get_db),
                            admin: User = Depends(require_admin_or_station_master)):
    rows = db.query(Achievement).order_by(Achievement.created_at.desc()).all()
    return {"achievements": [a.to_dict() for a in rows]}


@router.post("/admin/achievements")
def admin_create_achievement(payload: dict, db: Session = Depends(get_db),
                             admin: User = Depends(require_admin_or_station_master)):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="成就名称不能为空")
    trigger_type = payload.get("trigger_type") or "manual"
    if trigger_type == "auto":
        rule_key = (payload.get("rule_key") or "").strip()
        valid_keys = {"tokens_used", "scripts_completed", "scripts_uploaded", "likes_received",
                      "dislikes_received", "subs_received", "coins", "coins_spent",
                      "achievement_points", "exp", "level", "following_count", "follower_count"}
        if rule_key not in valid_keys:
            raise HTTPException(status_code=400, detail=f"无效的监控字段，可选：{'、'.join(sorted(valid_keys))}")
    ach = Achievement(
        id=(payload.get("id") or "").strip() or None,
        name=name,
        icon=(payload.get("icon") or "🏅").strip(),
        description=payload.get("description") or "",
        points=int(payload.get("points") or 10),
        trigger_type=trigger_type,
        rule_key=(payload.get("rule_key") or "").strip() or None,
        threshold=max(1, int(payload.get("threshold") or 1)),
        enabled=bool(payload.get("enabled", True)),
    )
    if not ach.id:
        import uuid
        ach.id = uuid.uuid4().hex[:12]
    if db.query(Achievement).filter(Achievement.id == ach.id).first():
        raise HTTPException(status_code=400, detail="成就 ID 已存在")
    db.add(ach)
    db.commit()
    return ach.to_dict()


@router.put("/admin/achievements/{achievement_id}")
def admin_update_achievement(achievement_id: str, payload: dict, db: Session = Depends(get_db),
                             admin: User = Depends(require_admin_or_station_master)):
    ach = db.query(Achievement).filter(Achievement.id == achievement_id).first()
    if not ach:
        raise HTTPException(status_code=404, detail="成就不存在")
    for field in ("name", "icon", "description", "trigger_type", "rule_key"):
        if field in payload:
            setattr(ach, field, payload[field])
    for field in ("points", "threshold"):
        if field in payload:
            setattr(ach, field, int(payload[field]))
    if "enabled" in payload:
        ach.enabled = bool(payload["enabled"])
    db.commit()
    return ach.to_dict()


@router.delete("/admin/achievements/{achievement_id}")
def admin_delete_achievement(achievement_id: str, db: Session = Depends(get_db),
                             admin: User = Depends(require_admin_or_station_master)):
    ach = db.query(Achievement).filter(Achievement.id == achievement_id).first()
    if not ach:
        raise HTTPException(status_code=404, detail="成就不存在")
    db.query(UserAchievement).filter(UserAchievement.achievement_id == achievement_id).delete()
    db.delete(ach)
    db.commit()
    return {"ok": True}


@router.post("/admin/achievements/{achievement_id}/grant")
def admin_grant_achievement(achievement_id: str, payload: dict, db: Session = Depends(get_db),
                            admin: User = Depends(require_admin_or_station_master)):
    """站长手动颁发成就给用户（按用户名或用户 ID）"""
    identifier = (payload.get("user") or "").strip()
    if not identifier:
        raise HTTPException(status_code=400, detail="请提供用户名或用户 ID")
    target = db.query(User).filter(
        (User.username == identifier) | (User.id == identifier)).first()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    ok = stats_service.grant_manual(db, str(target.id), achievement_id)
    if not ok:
        raise HTTPException(status_code=400, detail="颁发失败：成就不存在或用户已拥有该成就")
    return {"ok": True, "user": target.username}
