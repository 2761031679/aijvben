"""公告路由（公开）"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from ..core.database import get_db
from ..models.system import Announcement

router = APIRouter(prefix="/api/announcements", tags=["公告"])


@router.get("")
def list_announcements(page: int = Query(1, ge=1), db: Session = Depends(get_db)):
    q = db.query(Announcement).filter(Announcement.is_deleted == False)
    total = q.count()
    anns = q.order_by(Announcement.is_pinned.desc(), Announcement.created_at.desc())\
        .offset((page - 1) * 20).limit(20).all()
    return {
        "announcements": [a.to_dict() for a in anns],
        "page": page,
        "total_pages": max(1, (total + 19) // 20),
    }


@router.get("/{ann_id}")
def get_announcement(ann_id: str, db: Session = Depends(get_db)):
    ann = db.query(Announcement).filter(Announcement.id == ann_id, Announcement.is_deleted == False).first()
    if not ann:
        from fastapi import HTTPException
        raise HTTPException(404, "公告不存在")
    return ann.to_dict()
