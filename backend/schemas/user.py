"""用户相关 Pydantic 模型"""
from pydantic import BaseModel, Field


class UserProfileResponse(BaseModel):
    username: str
    email: str
    role: str
    created_at: str
    scripts_count: int
    comments_count: int
    email_verified: bool


class UserSettingsRequest(BaseModel):
    settings_json: dict = Field(default_factory=dict)


class UserSettingsResponse(BaseModel):
    settings_json: dict


class SubscriptionItemResponse(BaseModel):
    script_id: str
    title: str
    subscribed_at: str


class SubscriptionListResponse(BaseModel):
    subscriptions: list[SubscriptionItemResponse]


class PlaySessionSaveRequest(BaseModel):
    session_data: dict = Field(default_factory=dict)


class PlaySessionDataResponse(BaseModel):
    script_id: str
    title: str
    session_data: dict
    updated_at: str
