"""剧本标签服务：标签同步、点赞/取消点赞、按点赞数排序。"""
from sqlalchemy.orm import Session

from ..models.script import Script, ScriptTag, ScriptTagLike
from ..models.user import User


def sync_tags(db: Session, script: Script):
    """将 Script.tags 同步到 ScriptTag 表，保留已有标签的点赞数。"""
    tags = script.tags or []
    existing = {t.tag: t for t in db.query(ScriptTag).filter(ScriptTag.script_id == script.id).all()}
    seen = set()
    for tag in tags:
        seen.add(tag)
        if tag not in existing:
            db.add(ScriptTag(script_id=script.id, tag=tag, likes=0))
    # 删除剧本已移除的标签（保留点赞记录的历史可另行保留，此处直接清理孤儿）
    for tag, row in existing.items():
        if tag not in seen:
            db.delete(row)
    db.commit()


def get_tags_with_likes(db: Session, script_id: str) -> list:
    """返回该作品标签（含点赞数），按点赞数降序——点赞最高的排最前。"""
    rows = db.query(ScriptTag).filter(ScriptTag.script_id == script_id).all()
    return [r.to_dict() for r in sorted(rows, key=lambda r: r.likes, reverse=True)]


def toggle_tag_like(db: Session, user: User, script_id: str, tag: str, like: bool) -> dict:
    """用户对某个作品的标签点赞/取消。返回最新点赞数与用户是否已赞。"""
    rec = db.query(ScriptTagLike).filter(
        ScriptTagLike.script_id == script_id,
        ScriptTagLike.tag == tag,
        ScriptTagLike.user_id == str(user.id),
    ).first()
    tag_row = db.query(ScriptTag).filter(
        ScriptTag.script_id == script_id, ScriptTag.tag == tag
    ).first()
    if not tag_row:
        # 标签不存在则补建
        tag_row = ScriptTag(script_id=script_id, tag=tag, likes=0)
        db.add(tag_row)
        db.flush()

    if like and not rec:
        db.add(ScriptTagLike(script_id=script_id, tag=tag, user_id=str(user.id)))
        tag_row.likes = (tag_row.likes or 0) + 1
    elif not like and rec:
        db.delete(rec)
        tag_row.likes = max(0, (tag_row.likes or 0) - 1)
    db.commit()
    liked_state = db.query(ScriptTagLike).filter(
        ScriptTagLike.script_id == script_id,
        ScriptTagLike.tag == tag,
        ScriptTagLike.user_id == str(user.id),
    ).first() is not None
    return {"tag": tag, "likes": tag_row.likes, "liked": liked_state}
