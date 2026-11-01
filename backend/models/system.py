"""系统相关模型：验证码、公告、点赞记录、站长日志、站点设置、云端同步"""
from sqlalchemy import Column, String, Text, DateTime, ForeignKey, JSON, Boolean, Integer, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
import uuid
from ..core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)

def _gen_id():
    return uuid.uuid4().hex[:12]


class VerificationCode(Base):
    __tablename__ = "verification_codes"

    id = Column(String, primary_key=True, default=_gen_id)
    email = Column(String(120), nullable=False, index=True)
    code = Column(String(6), nullable=False)
    purpose = Column(String(30), nullable=False)  # register, change_password, reset_password, set_owner
    expires_at = Column(DateTime, nullable=False)
    used = Column(Boolean, default=False)
    created_at = Column(DateTime, default=_utcnow)


class Announcement(Base):
    """站长公告"""
    __tablename__ = "announcements"

    id = Column(String, primary_key=True, default=_gen_id)
    title = Column(String(200), nullable=False)
    content = Column(Text, nullable=False)
    author_id = Column(String, ForeignKey("users.id"), nullable=False)
    is_pinned = Column(Boolean, default=False)
    is_deleted = Column(Boolean, default=False)
    deleted_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    author = relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "content": self.content,
            "author": self.author.username if self.author else "",
            "is_pinned": self.is_pinned,
            "is_deleted": self.is_deleted,
            "deleted_at": self.deleted_at.strftime("%Y-%m-%d %H:%M:%S") if self.deleted_at else "",
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
            "updated_at": self.updated_at.strftime("%Y-%m-%d %H:%M:%S") if self.updated_at else "",
        }


class LikesRecord(Base):
    """点赞/点踩记录"""
    __tablename__ = "likes_records"

    id = Column(String, primary_key=True, default=_gen_id)
    script_id = Column(String, ForeignKey("scripts.id"), nullable=False)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    like_type = Column(String(10), nullable=False)  # "like" 或 "dislike"
    created_at = Column(DateTime, default=_utcnow)

    script = relationship("Script", back_populates="likes_records")
    user = relationship("User", back_populates="likes_records")


class OwnerChangeLog(Base):
    """站长变更日志"""
    __tablename__ = "owner_change_log"

    id = Column(String, primary_key=True, default=_gen_id)
    old_owner_id = Column(String, nullable=True)
    new_owner_id = Column(String, nullable=False)
    changed_by = Column(String, nullable=False)
    created_at = Column(DateTime, default=_utcnow)


class SiteSettings(Base):
    """站点全局设置"""
    __tablename__ = "site_settings"

    key = Column(String(100), primary_key=True)
    value = Column(JSON, default={})
    updated_by = Column(String, ForeignKey("users.id"), nullable=True)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    editor = relationship("User")


class CloudSyncData(Base):
    """云端同步临时存储（24小时TTL）"""
    __tablename__ = "cloud_sync_data"

    id = Column(String, primary_key=True, default=_gen_id)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    payload = Column(JSON, default={})
    created_at = Column(DateTime, default=_utcnow)
    expires_at = Column(DateTime, nullable=False)

    user = relationship("User")


class StatusBarSave(Base):
    """状态栏 UI 存档（每用户一份，云端长期保存）。
    前端状态栏 UI 状态变化时实时同步到云端，与本地 Store 各存一份（双份一致）。"""
    __tablename__ = "status_bar_saves"

    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    payload = Column(JSON, default={})
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    user = relationship("User")


class GameDataSave(Base):
    """游戏数据存档（每用户一份，云端长期保存）。
    存放各剧本的条件进度（cond_<scriptId>）与线索/道具（inv_<scriptId>）等本地
    游戏数据，与本地 Store 双份同步，实现换设备/清缓存后可续玩。"""
    __tablename__ = "game_data_saves"

    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    payload = Column(JSON, default={})
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    user = relationship("User")


class Notification(Base):
    """站内通知。用户触发事件（审核结果、评论、订阅更新等）时由服务端推送。"""
    __tablename__ = "notifications"

    id = Column(String, primary_key=True, default=_gen_id)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    type = Column(String(30), default="system")  # review / comment / system / subscription
    title = Column(String(200), default="")
    body = Column(Text, default="")
    link = Column(String(300), default="")       # 点击跳转路径
    is_read = Column(Boolean, default=False)
    created_at = Column(DateTime, default=_utcnow)

    user = relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "type": self.type,
            "title": self.title,
            "body": self.body,
            "link": self.link,
            "is_read": self.is_read,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
        }


class GuestCounter(Base):
    """轻量计数器：给「游客也要计数」的场景用（提示次数等）。

    为什么单独一张表而不是存进用户档案：游客没有用户档案，而「游客可无限次把汤底
    一句一句拉出来」正是靠这个漏洞成立的。计数必须落在库里——生产是 2 个 worker，
    放内存等于两个进程各数一份。
    """
    __tablename__ = "guest_counters"
    __table_args__ = (
        UniqueConstraint("scope", "subject", "script_id", name="uq_guest_counter"),
    )

    id = Column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex[:12])
    scope = Column(String(32), nullable=False, index=True)
    subject = Column(String(120), nullable=False)
    script_id = Column(String(32), nullable=False, default="")
    counter = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
