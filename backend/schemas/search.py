"""搜索 / 筛选请求参数校验。"""
from typing import Optional
from pydantic import BaseModel


class ScriptSearch(BaseModel):
    keyword: str = ""
    category: str = ""
    tags: list[str] = []
    sort: str = ""            # relevance|newest|oldest|popular|rating|hot_likes|comments_24h
    min_likes: int = 0
    min_dislikes: int = 0
    page: int = 1
    page_size: int = 12
