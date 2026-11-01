"""剧本权限判断工具"""
from sqlalchemy.orm import Session
from ..models.user import User
from ..models.script import Script
from ..models.stats import Completion


def can_view_full_script(user: User | None, script: Script, db: Session) -> bool:
    """判断用户是否可以查看汤底（explanation）。

    **判据必须是「服务端自己写的通关记录」，不能是客户端自报的进度。**

    原来第三条判据读的是 `PlaySession.session_data["completed"]`，而这份数据经
    `POST /api/user/play-data` 由客户端直接写入——也就是说任何人「订阅 → 自己写个
    completed=true」就能看汤底，连玩都不用玩（审计 M3）。
    现在改读 `Completion` 表：全仓只有 `stats_service.on_script_completed` 会往里写，
    而那个入口挂在 `/api/game/{id}/complete` 上，那里已经要求「有服务端见证的会话」（见 game.py）。

    station_master 一并放进来：审核通道要能看汤底，否则和 `get_script_detail`
    的未过审口径对不上（审计 S2）。
    """
    if user is None:
        return False
    if user.role in ("admin", "owner", "station_master"):
        return True
    if script.user_id == user.id:
        return True
    return db.query(Completion).filter(
        Completion.user_id == str(user.id),
        Completion.script_id == script.id,
    ).first() is not None


def can_edit_script(user: User, script: Script) -> bool:
    """判断用户是否可以编辑/删除剧本"""
    if user.role in ("admin", "owner"):
        return True
    return script.user_id == user.id
