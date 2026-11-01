"""NPC 相关 Pydantic 模型"""
from pydantic import BaseModel, Field


class NpcPromptSaveRequest(BaseModel):
    npc_id: str = Field(..., max_length=50)
    personality_id: str = Field(default="")
    prompt_type: str = Field(..., max_length=30)
    category: str = Field(default="")
    content: str = Field(..., min_length=1, max_length=50000)


class NpcPromptItem(BaseModel):
    id: str
    npc_id: str
    personality_id: str = ""
    prompt_type: str
    category: str
    content: str
    updated_by: str
    updated_at: str


class NpcPromptListResponse(BaseModel):
    prompts: list[NpcPromptItem]


class ScriptSearchRequest(BaseModel):
    keyword: str = Field(default="")
    category: str = Field(default="")
    tags: list[str] = []
    sort: str = Field(default="popular")
    min_likes: int = 0
    min_dislikes: int = 0
    limit: int = Field(default=5, ge=1, le=20)
