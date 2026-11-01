"""剧本、评分、评论模型"""
from sqlalchemy import Column, String, Integer, Float, Text, DateTime, ForeignKey, JSON, Boolean, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
import uuid
from ..core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)

def _gen_id():
    return uuid.uuid4().hex[:12]


# ============================================================
# 常量：剧本分类 & 审核状态
# ============================================================
CATEGORY_HAIGUITANG = "hai-gui-tang"
CATEGORY_DND = "dnd"
CATEGORY_COC = "coc"
CATEGORY_JUBENSHA = "ju-ben-ban-yan"
VALID_CATEGORIES = [CATEGORY_HAIGUITANG, CATEGORY_DND, CATEGORY_COC, CATEGORY_JUBENSHA]

REVIEW_DRAFT = "draft"
REVIEW_SYSTEM_FLAGGED = "system_flagged"
REVIEW_PENDING_ADMIN = "pending_admin"
REVIEW_PENDING_API = "pending_api"
REVIEW_PENDING_COMMUNITY = "pending_community"
REVIEW_APPROVED = "approved"
REVIEW_REJECTED = "rejected"

REVIEW_SOURCE_ADMIN = "admin"
REVIEW_SOURCE_API = "api"
REVIEW_SOURCE_BOTH = "both"


class Script(Base):
    __tablename__ = "scripts"

    id = Column(String, primary_key=True, default=_gen_id)
    title = Column(String(200), nullable=False)
    story = Column(Text, nullable=False)
    explanation = Column(Text, nullable=False)
    ending_condition = Column(Text, default="")  # 结束条件（旧版自由文本，保留兼容）；与汤底同级保密
    endings = Column(Text, default="")  # 胜利/失败条件表（JSON 字符串，结构见下）；与汤底同级保密
    # endings JSON 结构：
    # {"endings": [{"id","name","type":"win|lose","note",
    #   "conditions": [{"id","name","rule","threshold":1,"hidden":false}]}]}
    # 由前端条件系统计数：NPC 发 [cond:结局ID.条件ID] 标记 +1，达阈值视为满足；
    # 某结局全部条件满足即结算（胜利优先于失败）。
    tasks = Column(Text, default="")  # 任务条件表（JSON 字符串，结构见下）；与汤底同级保密
    # tasks JSON 结构：
    # {"tasks": [{"id","name","note",
    #   "conditions": [{"id","name","rule","threshold":1,"hidden":false}],
    #   "effect": {"type":"reveal_clue|give_item|npc_message","payload":"..."}}]}
    # 与胜利/失败条件同理：NPC 发 [task:任务ID.条件ID] 标记计数；某任务全部条件
    # 满足即视为完成，系统自动执行 effect（揭示线索/给予道具/给 NPC 发消息）。
    host_guide = Column(Text, default="")  # 主持指导词（作者可选填写，注入 NPC 主持提示词）；与汤底同级保密
    author = Column(String(100), default="")
    tags = Column(JSON, default=[])
    difficulty = Column(Integer, default=3)  # 1-5
    version = Column(Integer, default=1)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    category = Column(String(20), default="hai-gui-tang", nullable=False)
    review_status = Column(String(20), default="draft", nullable=False)
    reviewed_by = Column(String(50), default="")
    review_reason = Column(Text, default="")
    published_at = Column(DateTime, nullable=True)

    likes = Column(Integer, default=0)
    dislikes = Column(Integer, default=0)
    synopsis = Column(Text, default="")
    difficulty_votes = Column(JSON, default=[])

    is_deleted = Column(Boolean, default=False, nullable=False)
    deleted_at = Column(DateTime, nullable=True)
    deleted_by = Column(String(50), default="")

    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    owner = relationship("User", back_populates="scripts")

    downloads_count = Column(Integer, default=0)
    rating_count = Column(Integer, default=0)
    avg_rating = Column(Float, default=0.0)

    ratings = relationship("Rating", back_populates="script", cascade="all, delete-orphan")
    comments = relationship("Comment", back_populates="script", cascade="all, delete-orphan")
    likes_records = relationship("LikesRecord", back_populates="script", cascade="all, delete-orphan")
    review_votes = relationship("ReviewVote", back_populates="script", cascade="all, delete-orphan")

    def to_dict(self, include_full: bool = False, include_synopsis: bool = False,
                include_conditions: bool = False) -> dict:
        d = {
            "id": self.id,
            "title": self.title,
            "author": self.author or (self.owner.username if self.owner else ""),
            "tags": self.tags or [],
            "difficulty": self.difficulty,
            "version": self.version,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
            "updated_at": self.updated_at.strftime("%Y-%m-%d %H:%M:%S") if self.updated_at else "",
            "downloads_count": self.downloads_count,
            "rating_count": self.rating_count,
            "avg_rating": round(self.avg_rating, 1) if self.avg_rating else 0.0,
            "category": self.category,
            "review_status": self.review_status,
            "reviewed_by": self.reviewed_by,
            "review_reason": self.review_reason,
            "likes": self.likes,
            "dislikes": self.dislikes,
            "published_at": self.published_at.strftime("%Y-%m-%d %H:%M:%S") if self.published_at else "",
            "difficulty_votes": self.difficulty_votes or [],
            "is_deleted": self.is_deleted,
            "deleted_at": self.deleted_at.strftime("%Y-%m-%d %H:%M:%S") if self.deleted_at else "",
            "deleted_by": self.deleted_by or "",
            "story": self.story,
        }
        # 三档，不是两档：
        #   include_conditions —— 只给**条件表**（胜利/失败条件、任务表）。
        #       浏览器要靠它判定「识破了没有」，但它不是汤底。
        #   include_full —— 再加上**汤底正文**与主持指导。
        #       汤底从此只在服务端组装提示词时用到，不再下发到浏览器。
        if include_conditions or include_full:
            d["ending_condition"] = getattr(self, "ending_condition", "") or ""
            d["endings"] = getattr(self, "endings", "") or ""
            d["tasks"] = getattr(self, "tasks", "") or ""
        if include_full:
            d["explanation"] = self.explanation
            d["host_guide"] = getattr(self, "host_guide", "") or ""
        d["synopsis"] = self.synopsis if include_synopsis and self.synopsis else ""
        return d


class Rating(Base):
    __tablename__ = "ratings"

    id = Column(String, primary_key=True, default=_gen_id)
    script_id = Column(String, ForeignKey("scripts.id"), nullable=False)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    rating = Column(Integer, nullable=False)  # 1-5
    created_at = Column(DateTime, default=_utcnow)

    script = relationship("Script", back_populates="ratings")
    user = relationship("User", back_populates="ratings")


class Comment(Base):
    __tablename__ = "comments"

    id = Column(String, primary_key=True, default=_gen_id)
    script_id = Column(String, ForeignKey("scripts.id"), nullable=False)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=_utcnow)

    script = relationship("Script", back_populates="comments")
    user = relationship("User", back_populates="comments")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "script_id": self.script_id,
            "username": self.user.username if self.user else "",
            "content": self.content,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
        }


class ScriptTag(Base):
    """剧本标签（用户自定义）。每个标签独立记录点赞数，点赞最高的排在作品最前。"""
    __tablename__ = "script_tags"

    id = Column(String, primary_key=True, default=_gen_id)
    script_id = Column(String, ForeignKey("scripts.id"), nullable=False, index=True)
    tag = Column(String(50), nullable=False)
    likes = Column(Integer, default=0)

    script = relationship("Script")

    __table_args__ = (
        # 同一剧本下标签唯一
        UniqueConstraint("script_id", "tag", name="uq_script_tag"),
    )

    def to_dict(self) -> dict:
        return {"tag": self.tag, "likes": self.likes}


class ScriptTagLike(Base):
    """标签点赞记录（按用户去重，支持点赞/取消点赞）"""
    __tablename__ = "script_tag_likes"

    id = Column(String, primary_key=True, default=_gen_id)
    script_id = Column(String, ForeignKey("scripts.id"), nullable=False, index=True)
    tag = Column(String(50), nullable=False)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)

    __table_args__ = (
        UniqueConstraint("script_id", "tag", "user_id", name="uq_script_tag_like"),
    )
