"""剧本路由"""
from typing import Optional
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from ..core.database import get_db
from ..core.security import get_current_user, get_optional_user
from ..models.user import User
from ..schemas.script import (
    ScriptCreateRequest, ScriptUpdateRequest, RatingRequest,
    CommentRequest, LikeRequest,
)
from ..services import script_service, search_service, tag_service

router = APIRouter(prefix="/api/scripts", tags=["剧本"])


@router.get("")
def list_scripts(
    page: int = Query(1, ge=1),
    category: Optional[str] = None,
    tag: str = "",
    sort: str = "newest",
    review_status: Optional[str] = None,
    keyword: str = "",
    tags: str = "",
    min_likes: int = 0,
    max_likes: Optional[int] = None,
    min_dislikes: int = 0,
    max_dislikes: Optional[int] = None,
    page_size: int = Query(12, ge=1, le=60),
    current_user: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
):
    # review_status 客户端可控曾经等于「所有人的草稿列表」（审计 M4）：
    # ?review_status=draft 能拿到别人未过审稿的标题/谜面/简介。只有审核角色能查非 approved。
    if review_status and review_status != "approved":
        if not (current_user and current_user.role in ("admin", "owner", "station_master")):
            review_status = None
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []
    return script_service.list_scripts(
        db, page, category, tag, sort, review_status, page_size,
        keyword=keyword, tags=tag_list, min_likes=min_likes, max_likes=max_likes,
        min_dislikes=min_dislikes, max_dislikes=max_dislikes,
    )


@router.get("/search")
def search(
    keyword: str = Query(""), category: str = "", tags: str = "",
    sort: str = "popular", min_likes: int = 0, max_likes: Optional[int] = None,
    min_dislikes: int = 0, max_dislikes: Optional[int] = None,
    limit: int = Query(20, ge=1, le=50), db: Session = Depends(get_db),
):
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []
    return script_service.search_scripts(
        db, keyword, category, sort, tag_list, min_likes, min_dislikes, limit,
        max_likes=max_likes, max_dislikes=max_dislikes,
    )


@router.get("/tags/all")
def all_tags(db: Session = Depends(get_db)):
    return {"tags": search_service.all_tags(db)}


@router.get("/tags/hot")
def hot_tags(days: int = Query(30, ge=1, le=365), db: Session = Depends(get_db)):
    """最近 days 天内最热门（使用次数最多）的标签，仅含站点已有的标签。"""
    return {"tags": search_service.get_hot_tags(db, days)}


@router.get("/range-stats")
def range_stats(db: Session = Depends(get_db)):
    """点赞 / 点踩数值区间（动态，随站点数据实时变化），供前端设置滑块上下限。"""
    return search_service.get_range_stats(db)


@router.get("/{script_id}")
def get_script(script_id: str, user: User | None = Depends(get_optional_user), db: Session = Depends(get_db)):
    return script_service.get_script_detail(db, script_id, user)


@router.post("/{script_id}/tags/{tag}/like")
def toggle_tag_like(
    script_id: str, tag: str, payload: dict,
    user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    """对某个作品的标签点赞 / 取消点赞。"""
    like = bool(payload.get("like", True))
    return tag_service.toggle_tag_like(db, user, script_id, tag, like)


@router.get("/{script_id}/download")
def download(script_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    detail = script_service.get_script_detail(db, script_id, user)
    from ..models.script import Script
    script = db.query(Script).filter(Script.id == script_id).first()
    if script:
        script.downloads_count += 1
        db.commit()
    return detail


@router.post("/upload")
def upload(req: ScriptCreateRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return script_service.create_script(db, user, req.model_dump())


@router.put("/{script_id}")
def update(script_id: str, req: ScriptUpdateRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return script_service.update_script(db, user, script_id, req.model_dump(exclude_none=True))


@router.delete("/{script_id}")
def delete(script_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return script_service.delete_script(db, user, script_id)


@router.post("/{script_id}/rate")
def rate(script_id: str, req: RatingRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return script_service.rate_script(db, user, script_id, req.rating)


@router.post("/{script_id}/like")
def toggle_like(script_id: str, req: LikeRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return script_service.toggle_like(db, user, script_id, req.like_type)


@router.get("/{script_id}/like-status")
def like_status(script_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from ..models.system import LikesRecord
    rec = db.query(LikesRecord).filter(
        LikesRecord.script_id == script_id, LikesRecord.user_id == user.id
    ).first()
    return {"type": rec.like_type if rec else None}


# 评论区已关闭（网站审核要求），接口下线；点赞/点踩/评分等其他互动保留。
@router.post("/{script_id}/comment")
def comment(script_id: str, req: CommentRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    raise HTTPException(status_code=403, detail="评论区已关闭")


@router.get("/{script_id}/comments")
def get_comments(script_id: str, user: User | None = Depends(get_optional_user), db: Session = Depends(get_db)):
    return []


@router.get("/mine/list")
def my_scripts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return script_service.get_my_scripts(db, user)
