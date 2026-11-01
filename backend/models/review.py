"""审核相关模型"""
from sqlalchemy import Column, String, Text, DateTime, ForeignKey, JSON, Float
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
import uuid
from ..core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)

def _gen_id():
    return uuid.uuid4().hex[:12]


class ReviewVote(Base):
    """用户审核投票（用户审核板块中用户对剧本的投票）"""
    __tablename__ = "review_votes"

    id = Column(String, primary_key=True, default=_gen_id)
    script_id = Column(String, ForeignKey("scripts.id"), nullable=False)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    vote = Column(String(10), nullable=False)  # "approve" / "reject" / "abstain"
    comment = Column(Text, default="")
    created_at = Column(DateTime, default=_utcnow)

    script = relationship("Script", back_populates="review_votes")
    user = relationship("User", back_populates="review_votes")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "script_id": self.script_id,
            "username": self.user.username if self.user else "",
            "vote": self.vote,
            "comment": self.comment,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
        }


class ApiReviewPrompt(Base):
    """各板块 API 审核提示词（站长可配置）"""
    __tablename__ = "api_review_prompts"

    id = Column(String, primary_key=True, default=_gen_id)
    category = Column(String(20), nullable=False, unique=True)
    prompt_template = Column(Text, nullable=False)
    updated_by = Column(String, ForeignKey("users.id"), nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    editor = relationship("User")


class CommunityReview(Base):
    """社区审核投票（发布后社区监督，不阻塞发布）"""
    __tablename__ = "community_reviews"

    id = Column(String, primary_key=True, default=_gen_id)
    script_id = Column(String, ForeignKey("scripts.id"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    vote = Column(String(20), default="approve")  # approve / reject / abstain
    comment = Column(Text, default="")
    created_at = Column(DateTime, default=_utcnow)

    script = relationship("Script")
    user = relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "script_id": self.script_id,
            "user_id": self.user_id,
            "vote": self.vote,
            "comment": self.comment,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
        }


class AiReview(Base):
    """AI 初审记录。AI 只做风险筛查与建议，不拥有最终否决权。"""
    __tablename__ = "ai_reviews"

    id = Column(String, primary_key=True, default=_gen_id)
    script_id = Column(String, ForeignKey("scripts.id"), nullable=False, index=True)
    decision = Column(String(20), default="need_human")  # recommend_approve / recommend_reject / need_human
    score = Column(Float, default=0.0)
    reasons = Column(JSON, default=list)
    flags = Column(JSON, default=list)
    suggestion = Column(Text, default="")
    raw_response = Column(Text, default="")
    model = Column(String(50), default="")
    created_at = Column(DateTime, default=_utcnow)

    script = relationship("Script")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "script_id": self.script_id,
            "decision": self.decision,
            "score": self.score,
            "reasons": self.reasons or [],
            "flags": self.flags or [],
            "suggestion": self.suggestion,
            "model": self.model,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
        }


class ScriptReport(Base):
    """剧本举报记录（用户举报，被举报作品进入待审核）"""
    __tablename__ = "script_reports"

    id = Column(String, primary_key=True, default=_gen_id)
    script_id = Column(String, ForeignKey("scripts.id"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    reason = Column(Text, default="")
    status = Column(String(20), default="pending")  # pending / handled / dismissed
    # 举报时由「举报人自己的 AI」判定剧本是否违规的结果（供站长参考，非服务器 AI）
    ai_decision = Column(String(30), default="")     # recommend_approve / recommend_reject / need_human
    ai_score = Column(Float, default=0.0)
    ai_flags = Column(JSON, default=list)
    ai_suggestion = Column(Text, default="")
    created_at = Column(DateTime, default=_utcnow)

    script = relationship("Script")
    user = relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "script_id": self.script_id,
            "user_id": self.user_id,
            "username": self.user.username if self.user else "",
            "reason": self.reason,
            "status": self.status,
            "ai_decision": self.ai_decision,
            "ai_score": self.ai_score,
            "ai_flags": self.ai_flags or [],
            "ai_suggestion": self.ai_suggestion,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
        }


class ReportVote(Base):
    """举报池封禁投票（同意封禁 / 不同意封禁 / 钝角中立）。"""
    __tablename__ = "report_votes"

    id = Column(String, primary_key=True, default=_gen_id)
    script_id = Column(String, ForeignKey("scripts.id"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    vote = Column(String(20), nullable=False)  # ban / keep / neutral
    created_at = Column(DateTime, default=_utcnow)

    script = relationship("Script")
    user = relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "script_id": self.script_id,
            "user_id": self.user_id,
            "username": self.user.username if self.user else "",
            "vote": self.vote,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
        }


# 审核来源常量（决定终审权归属）
REVIEW_SOURCE_AI = "ai"            # AI 初审（无最终权）
REVIEW_SOURCE_ADMIN = "admin"      # 站长/管理员 复审（最终裁定）
REVIEW_SOURCE_COMMUNITY = "community"  # 发布后社区监督（事后，不把关）
