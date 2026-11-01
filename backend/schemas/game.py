"""游戏和云同步相关 Pydantic 模型"""
from pydantic import BaseModel, Field


class GameCompletionRequest(BaseModel):
    game_completed: bool = True


class CloudSyncUploadRequest(BaseModel):
    settings: dict = Field(default_factory=dict)
    user_profile: dict = Field(default_factory=dict)
    chat_messages: list = Field(default_factory=list)
    device_id: str = Field(default="")


class CloudSyncDownloadResponse(BaseModel):
    data: dict = Field(default_factory=dict)
    has_conflict: bool = False
    local_timestamp: str = ""
    cloud_timestamp: str = ""
    message: str = ""
