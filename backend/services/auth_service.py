"""认证业务逻辑"""
import secrets
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session
from fastapi import HTTPException

from ..core.security import hash_password, verify_password, create_access_token, create_guest_token
from ..core.verification import send_verification_code, verify_code
from ..models.user import User
from ..models.user_data import UserProfile


def register(db: Session, username: str, email: str, password: str,
             confirm_password: str, code: str) -> dict:
    """注册新用户"""
    if password != confirm_password:
        raise HTTPException(400, "两次密码不一致")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(400, "用户名已存在")
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(400, "邮箱已注册")

    verify_code(db, email, code, "register")

    user = User(
        username=username, email=email,
        password_hash=hash_password(password),
        role="normal" if not _is_first_user(db) else "owner",
        email_verified=True,
    )
    db.add(user)
    db.flush()

    profile = UserProfile(user_id=user.id, settings_json={})
    db.add(profile)
    db.commit()

    token = create_access_token(user.id, user.role)
    return {"token": token, "user": _user_info(user)}


def login(db: Session, username: str, password: str) -> dict:
    """用户登录（支持邮箱或用户名，含防暴力破解）"""
    # 防暴力破解：检查失败次数
    _check_login_attempts(username)

    user = db.query(User).filter(
        (User.username == username) | (User.email == username)
    ).first()
    if not user or user.is_deleted or not verify_password(password, user.password_hash):
        _record_login_failure(username)
        raise HTTPException(400, "用户名或密码错误")
    _clear_login_failures(username)

    token = create_access_token(user.id, user.role)
    return {"token": token, "user": _user_info(user)}


def guest_login(db: Session, guest_id: str = "") -> dict:
    """游客登录"""
    token = create_guest_token(guest_id or "guest")
    return {"token": token, "guest_id": guest_id}


def get_me(db: Session, user: User) -> dict:
    """获取当前用户信息"""
    return _user_info(user)


def change_password(db: Session, user: User, email: str, code: str,
                    new_password: str, confirm_new_password: str) -> dict:
    """修改密码"""
    if new_password != confirm_new_password:
        raise HTTPException(400, "两次密码不一致")
    if user.email != email:
        raise HTTPException(400, "邮箱与当前账号不匹配")

    verify_code(db, email, code, "change_password")

    user.password_hash = hash_password(new_password)
    db.commit()
    return {"message": "密码修改成功"}


def forgot_password(db: Session, email: str, code: str,
                    new_password: str, confirm_new_password: str) -> dict:
    """找回密码"""
    if new_password != confirm_new_password:
        raise HTTPException(400, "两次密码不一致")

    verify_code(db, email, code, "reset_password")

    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(400, "用户不存在")
    user.password_hash = hash_password(new_password)
    db.commit()
    return {"message": "密码重置成功"}


def delete_account(db: Session, user: User, password: str) -> dict:
    """注销账号：软删除，清除个人身份信息（个人信息删除权，GB/T 35273）。

    采用软删除而非物理删除：清除邮箱/密码/用户名等个人身份信息，
    保留用户上传的剧本等社区内容（避免影响收藏、通关记录等其他用户的数据）。
    注销后该账号无法再登录。
    """
    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(400, "密码错误，无法注销")

    user.is_deleted = True
    user.email = f"deleted_{user.id}@invalid.local"
    user.password_hash = hash_password(secrets.token_urlsafe(32))  # 随机化，无法再登录
    user.username = f"已注销用户_{user.id[:6]}"
    db.commit()
    return {"message": "账号已注销"}


# --- 内部辅助 ---

# 简单内存存储（生产环境应换 Redis）
_login_failures: dict[str, list[datetime]] = {}
_MAX_FAILURES = 5
_FAILURE_WINDOW = timedelta(minutes=5)


def _check_login_attempts(key: str):
    failures = _login_failures.get(key, [])
    now = datetime.now(timezone.utc)
    recent = [t for t in failures if now - t < _FAILURE_WINDOW]
    if len(recent) >= _MAX_FAILURES:
        raise HTTPException(429, "登录尝试过于频繁，请5分钟后再试")


def _record_login_failure(key: str):
    _login_failures.setdefault(key, []).append(datetime.now(timezone.utc))


def _clear_login_failures(key: str):
    _login_failures.pop(key, None)


def _is_first_user(db: Session) -> bool:
    return db.query(User).count() == 0


def _user_info(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "role": user.role,
        "email_verified": user.email_verified,
        "realname_verified": bool(getattr(user, "realname_verified", False)),
        "realname_adult": bool(getattr(user, "realname_adult", False)),
        "created_at": user.created_at.strftime("%Y-%m-%d %H:%M:%S") if user.created_at else "",
    }
