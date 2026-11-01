"""用户模型"""
from sqlalchemy import Column, String, Boolean, DateTime
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
import uuid
from ..core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)

def _gen_id():
    return uuid.uuid4().hex[:12]


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=_gen_id)
    username = Column(String(50), unique=True, nullable=False, index=True)
    email = Column(String(120), default="")
    password_hash = Column(String(128), nullable=False)
    role = Column(String(20), default="normal", nullable=False)
    email_verified = Column(Boolean, default=False)
    # 实名认证（国家网络身份认证公共服务 / 网号网证）：仅存核验结果，不留存身份证件信息
    realname_verified = Column(Boolean, default=False)      # 是否通过实名认证
    realname_adult = Column(Boolean, default=False)         # 是否满 18 周岁
    realname_verified_at = Column(DateTime, nullable=True)  # 认证时间
    is_deleted = Column(Boolean, default=False)  # 软删除（账号注销，个人信息删除权）
    created_at = Column(DateTime, default=_utcnow)

    scripts = relationship("Script", back_populates="owner", cascade="all, delete-orphan")
    ratings = relationship("Rating", back_populates="user", cascade="all, delete-orphan")
    comments = relationship("Comment", back_populates="user", cascade="all, delete-orphan")
    likes_records = relationship("LikesRecord", back_populates="user", cascade="all, delete-orphan")
    review_votes = relationship("ReviewVote", back_populates="user", cascade="all, delete-orphan")
    profile = relationship("UserProfile", back_populates="user", uselist=False, cascade="all, delete-orphan")
    subscriptions = relationship("Subscription", back_populates="user", cascade="all, delete-orphan")
    play_sessions = relationship("PlaySession", back_populates="user", cascade="all, delete-orphan")
