"""NPC 相关模型"""
from sqlalchemy import Column, String, Text, DateTime, ForeignKey, JSON, Integer, Boolean
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
import uuid
from ..core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)

def _gen_id():
    return uuid.uuid4().hex[:12]


class NpcPrompt(Base):
    """NPC 提示词模板（站长可在线编辑）"""
    __tablename__ = "npc_prompts"

    id = Column(String, primary_key=True, default=_gen_id)
    npc_id = Column(String(50), nullable=False)
    personality_id = Column(String(20), default="")
    prompt_type = Column(String(30), nullable=False)
    category = Column(String(20), default="")
    content = Column(Text, nullable=False)
    updated_by = Column(String, ForeignKey("users.id"), nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    editor = relationship("User")


class NpcRefusalReport(Base):
    """NPC 拒绝服务报告（需要站长审核）"""
    __tablename__ = "npc_refusal_reports"

    id = Column(String, primary_key=True, default=_gen_id)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    npc_id = Column(String(50), nullable=False)
    reason = Column(Text, nullable=False, default="")
    chat_log = Column(JSON, default=[])
    status = Column(String(20), default="pending")
    admin_note = Column(Text, default="")
    ban_until = Column(DateTime, nullable=False)
    reviewed_by = Column(String, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    reviewed_at = Column(DateTime, nullable=True)

    user = relationship("User", foreign_keys=[user_id])
    reviewer = relationship("User", foreign_keys=[reviewed_by])


class NpcReviewLog(Base):
    """审核 NPC 打回记录（站长排查 bug 用）。

    网页 NPC 每条回复被审核 NPC 驳回时，前端把「对话上下文 + 待审回复 + 修改建议」落库，
    供站长在管理面板查看/删除。"""
    __tablename__ = "npc_review_logs"

    id = Column(String, primary_key=True, default=_gen_id)
    npc_id = Column(String(50), default="")
    user_id = Column(String, ForeignKey("users.id"), nullable=True, index=True)
    transcript = Column(Text, default="")     # 对话转录（上下文，未解码原文）
    raw_reply = Column(Text, default="")      # 待审回复（未解码原文）
    suggestion = Column(Text, default="")     # 审核 NPC 的修改建议
    round = Column(Integer, default=1)        # 本条回复第几轮被驳回
    created_at = Column(DateTime, default=_utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "npc_id": self.npc_id,
            "user_id": self.user_id or "",
            "transcript": self.transcript,
            "raw_reply": self.raw_reply,
            "suggestion": self.suggestion,
            "round": self.round,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
        }


class NpcIssueReport(Base):
    """NPC 问题反馈（经用户同意后落库，站长在管理面板查看/删除）。

    触发源：① 审核 NPC 驳回网页 NPC 回复时自动上报；② NPC 主动调用
    [sys:report_issue:reason=xxx]。前端先征求玩家同意，同意后才落库。"""
    __tablename__ = "npc_issue_reports"

    id = Column(String, primary_key=True, default=_gen_id)
    npc_id = Column(String(50), default="")
    user_id = Column(String, ForeignKey("users.id"), nullable=True, index=True)
    reason = Column(Text, default="")         # 反馈理由（审核建议 / NPC 自述）
    transcript = Column(Text, default="")     # 对话上下文（未解码原文）
    source = Column(String(20), default="npc_report")  # review=审核驳回 / npc_report=NPC主动上报
    created_at = Column(DateTime, default=_utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "npc_id": self.npc_id,
            "user_id": self.user_id or "",
            "reason": self.reason,
            "transcript": self.transcript,
            "source": self.source,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
        }


class AiErrorReport(Base):
    """AI 对话报错书（站长排查 AI 调用故障用）。

    前端各 AI API 调用环节（网页 NPC 对话 / 审核 NPC / 举报 AI 审核 / 免费接口）出错、
    重试无效后，fire-and-forget 落库一条报错书（静默降级，不阻断对话）。"""
    __tablename__ = "ai_error_reports"

    id = Column(String, primary_key=True, default=_gen_id)
    npc_id = Column(String(50), default="")
    user_id = Column(String, ForeignKey("users.id"), nullable=True, index=True)
    error_type = Column(String(20), default="empty_content")  # empty_content/timeout/network/api_error
    provider = Column(String(20), default="")
    model = Column(String(50), default="")
    message = Column(Text, default="")      # 错误信息（截断）
    kind = Column(String(30), default="")   # 调用用途标注（初始生成/工具结果回灌/审核/举报/免费等）
    created_at = Column(DateTime, default=_utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "npc_id": self.npc_id,
            "user_id": self.user_id or "",
            "error_type": self.error_type,
            "provider": self.provider,
            "model": self.model,
            "message": self.message,
            "kind": self.kind,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
        }


class TrendItem(Base):
    """热梗/问好资源库条目（NPC 按需查询，改善回复鲜活度）。

    站长在管理面板维护；NPC 判断「需要流行说法/热梗/问好方式」时通过
    [tool:get_trend:keyword=xxx] 按需查询（RAG 式，不打包进提示词，避免 token 浪费）。"""
    __tablename__ = "trend_items"

    id = Column(String, primary_key=True, default=_gen_id)
    keyword = Column(String(100), nullable=False, index=True)   # 关键词（用于匹配查询）
    content = Column(Text, nullable=False, default="")          # 内容（热梗解释/用法/示例）
    category = Column(String(30), default="trend")              # greeting/meme/trend
    enabled = Column(Boolean, default=True)                     # 是否启用
    updated_by = Column(String, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "keyword": self.keyword,
            "content": self.content,
            "category": self.category,
            "enabled": self.enabled,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
            "updated_at": self.updated_at.strftime("%Y-%m-%d %H:%M:%S") if self.updated_at else "",
        }
