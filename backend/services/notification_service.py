"""站内通知业务逻辑。

触发场景（由其他 service 主动调用 create_notification）：
  - 审核结果（通过 / 驳回）：通知作者
  - 作品被评论：通知作者
  - 订阅的作品有新评论 / 状态变更：通知订阅者
  - 系统公告等
"""
from datetime import datetime, timezone
from sqlalchemy.orm import Session

from ..models.user import User
from ..models.system import Notification


def create_notification(
    db: Session, user_id: int, type_: str, title: str, body: str = "", link: str = ""
) -> Notification:
    n = Notification(
        user_id=user_id, type=type_, title=title, body=body, link=link, is_read=False,
        created_at=datetime.now(timezone.utc),
    )
    db.add(n)
    db.commit()
    db.refresh(n)
    return n


def notify_review_result(db: Session, script, action: str):
    """审核结果通知作者。"""
    if not script.user_id:
        return
    title = "作品审核通过" if action == "approve" else "作品审核未通过"
    create_notification(
        db, script.user_id, "review", title,
        body=script.review_reason or "", link=f"/script/{script.id}",
    )


def notify_new_comment(db: Session, script, commenter_name: str):
    """新评论通知作者与订阅者。"""
    notified = set()
    if script.user_id and script.user_id != commenter_name:
        create_notification(
            db, script.user_id, "comment", f"{commenter_name} 评论了你的作品《{script.title}》",
            link=f"/script/{script.id}",
        )
        notified.add(script.user_id)
    # 订阅者（排除作者本人）
    from ..models.user_data import Subscription
    subs = db.query(Subscription).filter(Subscription.script_id == script.id).all()
    for sub in subs:
        if sub.user_id in notified:
            continue
        create_notification(
            db, sub.user_id, "comment", f"你订阅的《{script.title}》有新评论",
            link=f"/script/{script.id}",
        )
        notified.add(sub.user_id)


def list_for_user(db: Session, user: User, page: int = 1, only_unread: bool = False) -> dict:
    q = db.query(Notification).filter(Notification.user_id == user.id)
    if only_unread:
        q = q.filter(Notification.is_read == False)
    total = q.count()
    items = q.order_by(Notification.created_at.desc()).offset((page - 1) * 20).limit(20).all()
    return {
        "notifications": [n.to_dict() for n in items],
        "page": page,
        "total_pages": max(1, (total + 19) // 20),
        "unread": db.query(Notification).filter(
            Notification.user_id == user.id, Notification.is_read == False
        ).count(),
    }


def mark_read(db: Session, user: User, notification_id: str = "") -> dict:
    if notification_id:
        n = db.query(Notification).filter(
            Notification.id == notification_id, Notification.user_id == user.id
        ).first()
        if n:
            n.is_read = True
    else:
        db.query(Notification).filter(Notification.user_id == user.id).update({"is_read": True})
    db.commit()
    return {"message": "已标记已读"}


def unread_count(db: Session, user: User) -> int:
    return db.query(Notification).filter(
        Notification.user_id == user.id, Notification.is_read == False
    ).count()
