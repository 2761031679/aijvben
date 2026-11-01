"""通知路由"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from ..core.database import get_db
from ..core.security import get_current_user
from ..models.user import User
from ..services import notification_service

router = APIRouter(prefix="/api/notifications", tags=["notification"])


@router.get("")
def list_notifications(
    page: int = 1, unread_only: bool = False,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    return notification_service.list_for_user(db, current_user, page=page, only_unread=unread_only)


@router.get("/unread-count")
def unread_count(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"count": notification_service.unread_count(db, current_user)}


@router.post("/read")
def mark_read(payload: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    notification_id = payload.get("notification_id", "")
    return notification_service.mark_read(db, current_user, notification_id)
