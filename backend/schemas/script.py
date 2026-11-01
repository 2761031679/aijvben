"""剧本相关 Pydantic 模型"""
from pydantic import BaseModel, Field
from typing import Optional, Literal


class ScriptCreateRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    story: str = Field(..., min_length=1)
    explanation: str = Field(..., min_length=1)
    ending_condition: str = Field(default="")  # 结束条件（旧版自由文本，保留兼容）
    endings: str = Field(default="")  # 胜利/失败条件表（JSON 字符串，见 models/script.py 注释）
    tasks: str = Field(default="")  # 任务条件表（JSON 字符串，见 models/script.py 注释）
    host_guide: str = Field(default="", max_length=2000)  # 主持指导词（可选）
    synopsis: str = Field(default="")
    author: str = Field(default="", max_length=100)
    tags: list[str] = Field(default_factory=list)
    difficulty: int = Field(default=3, ge=1, le=5)
    category: str = Field(default="hai-gui-tang")


class ScriptUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    story: Optional[str] = None
    explanation: Optional[str] = None
    ending_condition: Optional[str] = None
    endings: Optional[str] = None
    tasks: Optional[str] = None
    host_guide: Optional[str] = Field(default=None, max_length=2000)
    synopsis: Optional[str] = None
    author: Optional[str] = Field(default=None, max_length=100)
    tags: Optional[list[str]] = None
    difficulty: Optional[int] = Field(default=None, ge=1, le=5)
    category: Optional[str] = None


class RatingRequest(BaseModel):
    rating: int = Field(..., ge=1, le=5)


class CommentRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=2000)
    difficulty_rating: Optional[int] = Field(default=None, ge=1, le=5)


class ScriptListResponse(BaseModel):
    scripts: list[dict]
    page: int
    total_pages: int


class ScriptListQuery(BaseModel):
    page: int = Field(default=1, ge=1)
    category: Optional[str] = None
    tag: str = Field(default="")
    sort: str = Field(default="newest")
    review_status: Optional[str] = None


class LikeRequest(BaseModel):
    like_type: Literal["like", "dislike"]
