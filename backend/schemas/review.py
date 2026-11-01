"""审核相关 Pydantic 模型"""
from pydantic import BaseModel, Field
from typing import Literal


class AdminReviewRequest(BaseModel):
    action: Literal["approve", "reject"] = "approve"
    reason: str = Field(default="")


class ReportReviewRequest(BaseModel):
    """社区审核池判决：uphold=采纳举报(下架)，dismiss=驳回举报(恢复)。"""
    action: Literal["uphold", "dismiss"] = "uphold"
    reason: str = Field(default="")


class ApiReviewRequest(BaseModel):
    """用户发起 API 审核"""
    pass


class CommunityVoteRequest(BaseModel):
    vote: Literal["approve", "reject", "abstain"]
    comment: str = Field(default="", max_length=2000)


class ApiReviewPromptRequest(BaseModel):
    category: str = Field(default="", min_length=1, max_length=30)
    prompt_template: str = Field(default="", min_length=1, max_length=5000)


class AiReviewOut(BaseModel):
    id: str
    script_id: str
    decision: str
    score: float
    reasons: list
    flags: list
    suggestion: str
    model: str
    created_at: str
