"""Pydantic 请求/响应模型"""
from .auth import (
    SendCodeRequest, RegisterRequest, LoginRequest,
    ChangePasswordRequest, ForgotPasswordRequest,
    AuthResponse, GuestTokenResponse,
)
from .script import (
    ScriptCreateRequest, ScriptUpdateRequest, RatingRequest,
    CommentRequest, ScriptListResponse, ScriptListQuery, LikeRequest,
)
from .review import (
    AdminReviewRequest, ApiReviewRequest, CommunityVoteRequest,
)
from .admin import (
    ApiPromptUpdateRequest, LikesRecordResponse,
    AnnouncementCreateRequest, AnnouncementUpdateRequest,
    SiteSettingSaveRequest, SiteSettingResponse,
)
from .npc import (
    NpcPromptSaveRequest, NpcPromptItem, NpcPromptListResponse,
    ScriptSearchRequest,
)
from .user import (
    UserProfileResponse, UserSettingsRequest, UserSettingsResponse,
    SubscriptionItemResponse, SubscriptionListResponse,
    PlaySessionSaveRequest, PlaySessionDataResponse,
)
from .game import (
    GameCompletionRequest, CloudSyncUploadRequest, CloudSyncDownloadResponse,
)

__all__ = [
    "SendCodeRequest", "RegisterRequest", "LoginRequest",
    "ChangePasswordRequest", "ForgotPasswordRequest",
    "AuthResponse", "GuestTokenResponse",
    "ScriptCreateRequest", "ScriptUpdateRequest", "RatingRequest",
    "CommentRequest", "ScriptListResponse", "ScriptListQuery", "LikeRequest",
    "AdminReviewRequest", "ApiReviewRequest", "CommunityVoteRequest",
    "ApiPromptUpdateRequest", "LikesRecordResponse",
    "AnnouncementCreateRequest", "AnnouncementUpdateRequest",
    "SiteSettingSaveRequest", "SiteSettingResponse",
    "NpcPromptSaveRequest", "NpcPromptItem", "NpcPromptListResponse",
    "ScriptSearchRequest",
    "UserProfileResponse", "UserSettingsRequest", "UserSettingsResponse",
    "SubscriptionItemResponse", "SubscriptionListResponse",
    "PlaySessionSaveRequest", "PlaySessionDataResponse",
    "GameCompletionRequest", "CloudSyncUploadRequest", "CloudSyncDownloadResponse",
]
