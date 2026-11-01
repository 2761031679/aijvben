"""用户数据统计 / 通关记录 / 成就 / 关注 数据模型（v4.6c 新增）

设计要点：
- UserStats：每用户一行计数器，事件点同事务 ±1（无定时聚合，写入开销 O(1)）；
- Completion：通关记录（每用户每剧本一行，仅记录胜利，供个人主页展示与通关数统计）；
- Achievement：站长制作的成就（auto=系统按 rule_key 监控数据自动发放 / manual=站长手动颁发）；
- Follow：关注关系，计数冗余到 UserStats.following_count / follower_count。
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean, ForeignKey, UniqueConstraint
from datetime import datetime, timezone
import uuid
from ..core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


def _gen_id():
    return uuid.uuid4().hex[:12]


class UserStats(Base):
    """每用户一行统计计数器"""
    __tablename__ = "user_stats"

    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    tokens_used = Column(Integer, default=0)        # AI 调用累计 token 消耗
    scripts_completed = Column(Integer, default=0)  # 通关剧本数（按剧本去重）
    scripts_uploaded = Column(Integer, default=0)   # 上传剧本数
    likes_received = Column(Integer, default=0)     # 获得点赞（作品被赞累计）
    dislikes_received = Column(Integer, default=0)  # 获得点踩
    subs_received = Column(Integer, default=0)      # 获得收藏/订阅数（作品被收藏累计）
    coins = Column(Integer, default=0)              # 金币数
    coins_spent = Column(Integer, default=0)        # 消耗金币数（消费功能预留）
    achievement_points = Column(Integer, default=0) # 成就分
    exp = Column(Integer, default=0)                # 经验
    level = Column(Integer, default=1)              # 等级（由经验换算，写入时重算）
    following_count = Column(Integer, default=0)    # 关注数
    follower_count = Column(Integer, default=0)     # 被关注数
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class Completion(Base):
    """通关记录：每用户每剧本一行（仅胜利结算写入），首次通关时间 + 达成的结局"""
    __tablename__ = "completions"
    __table_args__ = (
        UniqueConstraint("user_id", "script_id", name="uq_completion_user_script"),
    )

    id = Column(String, primary_key=True, default=_gen_id)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    script_id = Column(String, ForeignKey("scripts.id"), nullable=False)
    ending_id = Column(String(64), default="")
    ending_name = Column(String(200), default="")
    created_at = Column(DateTime, default=_utcnow)


class Achievement(Base):
    """成就定义（站长制作）"""
    __tablename__ = "achievements"

    id = Column(String, primary_key=True, default=_gen_id)   # 站长可自定义 slug
    name = Column(String(100), nullable=False)
    icon = Column(String(16), default="🏅")                  # emoji 图标
    description = Column(Text, default="")
    points = Column(Integer, default=10)                     # 成就分
    trigger_type = Column(String(10), default="manual")      # auto=系统监控自动发放 / manual=站长手动颁发
    rule_key = Column(String(50), nullable=True)             # auto：监控的 user_stats 字段名
    threshold = Column(Integer, default=1)                   # auto：达到该值即发放
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=_utcnow)

    def to_dict(self):
        return {
            "id": self.id, "name": self.name, "icon": self.icon,
            "description": self.description or "", "points": self.points or 0,
            "trigger_type": self.trigger_type, "rule_key": self.rule_key,
            "threshold": self.threshold or 1, "enabled": bool(self.enabled),
        }


class UserAchievement(Base):
    """成就发放记录（自动达成 / 站长颁发）"""
    __tablename__ = "user_achievements"
    __table_args__ = (
        UniqueConstraint("user_id", "achievement_id", name="uq_user_achievement"),
    )

    id = Column(String, primary_key=True, default=_gen_id)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    achievement_id = Column(String, ForeignKey("achievements.id"), nullable=False)
    source = Column(String(10), default="auto")   # auto / manual
    created_at = Column(DateTime, default=_utcnow)


class Follow(Base):
    """关注关系"""
    __tablename__ = "follows"
    __table_args__ = (
        UniqueConstraint("follower_id", "followee_id", name="uq_follow_pair"),
    )

    id = Column(String, primary_key=True, default=_gen_id)
    follower_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    followee_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=_utcnow)
