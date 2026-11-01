"""用户数据模型：配置、订阅、游玩进度"""
from sqlalchemy import Column, String, DateTime, ForeignKey, JSON, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
import uuid
from ..core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)

def _gen_id():
    return uuid.uuid4().hex[:12]


class UserProfile(Base):
    """用户配置档案"""
    __tablename__ = "user_profiles"

    id = Column(String, primary_key=True, default=_gen_id)
    user_id = Column(String, ForeignKey("users.id"), unique=True)
    settings_json = Column(JSON, default={})
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    user = relationship("User", back_populates="profile")


class Subscription(Base):
    """剧本订阅"""
    __tablename__ = "subscriptions"
    __table_args__ = (
        UniqueConstraint("user_id", "script_id", name="uq_user_script"),
    )

    id = Column(String, primary_key=True, default=_gen_id)
    user_id = Column(String, ForeignKey("users.id"))
    script_id = Column(String, ForeignKey("scripts.id"))
    subscribed_at = Column(DateTime, default=_utcnow)

    user = relationship("User", back_populates="subscriptions")
    script = relationship("Script")


class PlaySession(Base):
    """在线游玩数据"""
    __tablename__ = "play_sessions"
    __table_args__ = (
        UniqueConstraint("user_id", "script_id", name="uq_user_script_session"),
    )

    id = Column(String, primary_key=True, default=_gen_id)
    user_id = Column(String, ForeignKey("users.id"))
    script_id = Column(String, ForeignKey("scripts.id"))
    session_data = Column(JSON, default={})
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    user = relationship("User", back_populates="play_sessions")
    script = relationship("Script")
