"""开发环境种子数据"""
import os
from sqlalchemy.orm import Session
from ..models.user import User
from ..core.security import hash_password, verify_password
from ..core.config import DEV_MODE


def seed_dev_data(db: Session):
    """本地开发时确保测试账号存在"""
    if DEV_MODE != "1":
        return

    DEV_USERNAME = "123456"
    DEV_PASSWORD = "123456"

    existing = db.query(User).filter(User.username == DEV_USERNAME).first()
    if existing:
        if verify_password(DEV_PASSWORD, existing.password_hash):
            return
        print("[DevSeed] 密码 hash 不一致，重建测试账号...")
        db.delete(existing)
        db.commit()

    user = User(
        username=DEV_USERNAME,
        password_hash=hash_password(DEV_PASSWORD),
        email="dev@localhost.local",
        role="admin",
        email_verified=True,
    )
    db.add(user)
    db.commit()
    print(f"[DevSeed] 测试账号就绪！用户名: {DEV_USERNAME}  密码: {DEV_PASSWORD}  角色: admin")


def seed_all(db: Session):
    """运行所有种子数据"""
    seed_dev_data(db)
    from .npc_prompts import seed_npc_prompts
    seed_npc_prompts(db)
