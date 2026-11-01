"""管理相关 Pydantic 模型"""
from pydantic import BaseModel, Field
from typing import Optional


class ApiPromptUpdateRequest(BaseModel):
    prompt_template: str = Field(..., min_length=1, max_length=5000)


class LikesRecordResponse(BaseModel):
    likes_users: list[str]
    dislikes_users: list[str]


class AnnouncementCreateRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    content: str = Field(..., min_length=1, max_length=10000)
    is_pinned: bool = Field(default=False)


class AnnouncementUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    content: Optional[str] = Field(default=None, max_length=10000)
    is_pinned: Optional[bool] = None


class SiteSettingSaveRequest(BaseModel):
    value: dict | list | str = Field(default_factory=dict)


class SiteSettingResponse(BaseModel):
    key: str
    value: dict
    updated_at: str
