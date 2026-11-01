"""用户业务逻辑"""
from sqlalchemy.orm import Session
from fastapi import HTTPException

from ..models.user import User
from ..models.user_data import UserProfile, Subscription, PlaySession
from ..models.script import Script
from ..models.system import CloudSyncData, StatusBarSave, GameDataSave
from datetime import datetime, timedelta, timezone


def get_profile(db: Session, user: User) -> dict:
    """获取用户配置档案"""
    profile = db.query(UserProfile).filter(UserProfile.user_id == user.id).first()
    return {
        "username": user.username,
        "email": user.email,
        "role": user.role,
        "created_at": user.created_at.strftime("%Y-%m-%d %H:%M:%S") if user.created_at else "",
        "scripts_count": db.query(Script).filter(Script.user_id == user.id, Script.is_deleted == False).count(),
        "comments_count": 0,
        "email_verified": user.email_verified,
        "settings": profile.settings_json if profile else {},
    }


def save_settings(db: Session, user: User, settings: dict) -> dict:
    """保存用户配置"""
    profile = db.query(UserProfile).filter(UserProfile.user_id == user.id).first()
    if not profile:
        profile = UserProfile(user_id=user.id, settings_json={})
        db.add(profile)
    profile.settings_json = settings
    profile.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "配置已保存"}


def subscribe(db: Session, user: User, script_id: str) -> dict:
    """订阅剧本"""
    script = db.query(Script).filter(Script.id == script_id, Script.is_deleted == False).first()
    if not script:
        raise HTTPException(404, "剧本不存在")

    exists = db.query(Subscription).filter(
        Subscription.user_id == user.id, Subscription.script_id == script_id
    ).first()
    if exists:
        raise HTTPException(400, "已订阅")

    db.add(Subscription(user_id=user.id, script_id=script_id))
    db.commit()
    # 统计：作者获得收藏/订阅（v4.6c；不计自收藏）
    if str(script.user_id) != str(user.id):
        from . import stats_service
        stats_service.on_sub_changed(db, str(script.user_id), +1)
    return {"message": "订阅成功"}


def unsubscribe(db: Session, user: User, script_id: str) -> dict:
    """取消订阅"""
    sub = db.query(Subscription).filter(
        Subscription.user_id == user.id, Subscription.script_id == script_id
    ).first()
    if not sub:
        raise HTTPException(404, "未订阅")
    db.delete(sub)
    db.commit()
    # 统计：作者收藏数 -1（v4.6c；不计自收藏）
    script = db.query(Script).filter(Script.id == script_id).first()
    if script and str(script.user_id) != str(user.id):
        from . import stats_service
        stats_service.on_sub_changed(db, str(script.user_id), -1)
    return {"message": "已取消"}


def list_subscriptions(db: Session, user: User) -> list[dict]:
    """订阅列表"""
    subs = db.query(Subscription).filter(Subscription.user_id == user.id).all()
    return [
        {
            "script_id": s.script_id,
            "title": s.script.title if s.script else "",
            "subscribed_at": s.subscribed_at.strftime("%Y-%m-%d %H:%M:%S") if s.subscribed_at else "",
        }
        for s in subs
    ]


def get_play_data(db: Session, user: User, script_id: str) -> dict | None:
    """获取游玩数据"""
    session = db.query(PlaySession).filter(
        PlaySession.user_id == user.id, PlaySession.script_id == script_id
    ).first()
    if not session:
        return None
    script = db.query(Script).filter(Script.id == script_id).first()
    return {
        "script_id": script_id,
        "title": script.title if script else "",
        "session_data": session.session_data or {},
        "updated_at": session.updated_at.strftime("%Y-%m-%d %H:%M:%S") if session.updated_at else "",
    }


def list_play_sessions(db: Session, user: User) -> list[dict]:
    """列出用户【未完成】的游玩会话（session_data.completed != True），按最近更新倒序。
    供 NPC 开场时判断是否有「进行中的剧本」可询问玩家是否继续。
    只返回【未删除】剧本：已删除剧本（Script.is_deleted）的残留 PlaySession 记录不返回，
    否则会把很早以前玩过、现已删除的剧本当作「未完成」报给 NPC。"""
    sessions = db.query(PlaySession).filter(PlaySession.user_id == user.id).all()
    result = []
    for s in sessions:
        if not s.script or s.script.is_deleted:
            continue
        data = s.session_data or {}
        if data.get("completed"):
            continue
        result.append({
            "script_id": s.script_id,
            "title": s.script.title or "",
            "updated_at": s.updated_at.strftime("%Y-%m-%d %H:%M:%S") if s.updated_at else "",
        })
    result.sort(key=lambda x: x["updated_at"], reverse=True)
    return result


def save_play_data(db: Session, user: User, script_id: str, data: dict) -> dict:
    """保存游玩数据"""
    session = db.query(PlaySession).filter(
        PlaySession.user_id == user.id, PlaySession.script_id == script_id
    ).first()
    if session:
        session.session_data = data
        session.updated_at = datetime.now(timezone.utc)
    else:
        session = PlaySession(user_id=user.id, script_id=script_id, session_data=data)
        db.add(session)
    db.commit()
    return {"message": "进度已保存"}


def mark_script_completed(db: Session, user: User, script_id: str) -> dict:
    """标记剧本通关：合并写入 session_data.completed=True（不覆盖 hints_used 等其他进度）。
    通关后 can_view_full_script 判定通过，该用户即可查看该剧本汤底。"""
    session = db.query(PlaySession).filter(
        PlaySession.user_id == user.id, PlaySession.script_id == script_id
    ).first()
    data = dict(session.session_data) if session and session.session_data else {}
    data["completed"] = True
    save_play_data(db, user, script_id, data)
    return {"message": "已标记通关", "script_id": script_id, "completed": True}


def cloud_sync_upload(db: Session, user: User, data: dict) -> dict:
    """上传云端同步数据"""
    # 清理旧数据
    db.query(CloudSyncData).filter(CloudSyncData.user_id == user.id).delete()
    sync = CloudSyncData(
        user_id=user.id,
        payload=data,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
    )
    db.add(sync)
    db.commit()
    return {"message": "同步成功", "expires_in": "24小时"}


def cloud_sync_download(db: Session, user: User) -> dict:
    """下载云端同步数据"""
    sync = db.query(CloudSyncData).filter(
        CloudSyncData.user_id == user.id,
        CloudSyncData.expires_at > datetime.now(timezone.utc),
    ).order_by(CloudSyncData.created_at.desc()).first()

    if not sync:
        return {"data": {}, "message": "云端暂无数据"}
    return {"data": sync.payload or {}, "message": ""}


def get_status_bar_save(db: Session, user: User) -> dict:
    """读取当前用户的状态栏 UI 存档（无存档返回空对象）。"""
    save = db.query(StatusBarSave).filter(StatusBarSave.user_id == user.id).first()
    if not save:
        return {"payload": {}}
    return {"payload": save.payload or {}}


def save_status_bar_save(db: Session, user: User, payload: dict) -> dict:
    """保存当前用户的状态栏 UI 存档（每用户一份，upsert）。"""
    if not isinstance(payload, dict):
        payload = {}
    save = db.query(StatusBarSave).filter(StatusBarSave.user_id == user.id).first()
    if save:
        save.payload = payload
        save.updated_at = datetime.now(timezone.utc)
    else:
        db.add(StatusBarSave(user_id=user.id, payload=payload))
    db.commit()
    return {"message": "状态栏存档已保存"}


def get_game_data_save(db: Session, user: User) -> dict:
    """读取当前用户的游戏数据存档（条件进度/线索道具等，无存档返回空对象）。"""
    save = db.query(GameDataSave).filter(GameDataSave.user_id == user.id).first()
    if not save:
        return {"payload": {}}
    return {"payload": save.payload or {}}


def save_game_data_save(db: Session, user: User, payload: dict) -> dict:
    """保存当前用户的游戏数据存档（每用户一份，upsert）。"""
    if not isinstance(payload, dict):
        payload = {}
    save = db.query(GameDataSave).filter(GameDataSave.user_id == user.id).first()
    if save:
        save.payload = payload
        save.updated_at = datetime.now(timezone.utc)
    else:
        db.add(GameDataSave(user_id=user.id, payload=payload))
    db.commit()
    return {"message": "游戏数据存档已保存"}
