"""前端可观测事件上报。

现在只有一个用途：把「M30b 降级」这类**只发生在浏览器里、服务端看不见**的事件
落到 `access_logs`，好让运营侧事后能查。

为什么必须有个真端点（审计 M3）：`window.__hostDegraded` 之前只写不读——玩家侧不静默
（会给系统消息、会把输入还回去），但**运营侧全静默**。那正是我们吃过两次亏的形态：
「看起来在监控，其实没人接线」。

安全口径：
- 匿名可写（游客也会降级，requiring 登录就永远收不到他们的数据）；
- 事件名走白名单，不做自由文本落库；
- 字段一律截断，长度和内容都控住，杜绝拿它当注入点；
- 走全局限流中间件（30 请求/10 秒），不额外加桶。
"""
from fastapi import APIRouter, Depends, Body
from sqlalchemy.orm import Session
from ..core.database import get_db
from ..models.access_log import AccessLog

router = APIRouter(prefix="/api/log", tags=["client-log"])

# 白名单：新增事件名要在这里显式加，不接受的直接静默吞掉（返回 204，不回错，
# 免得前端为一条日志打扰玩家）。
ALLOWED_EVENTS = {
    "host_degraded": "M30b降级",
}

_MAX_FIELD = 120


def _clip(value, limit: int = _MAX_FIELD) -> str:
    if value is None:
        return ""
    return str(value).replace("\n", " ").replace("\r", " ")[:limit]


@router.post("/client-event", status_code=204)
def client_event(payload: dict = Body(...), db: Session = Depends(get_db)):
    """收一条前端事件。永远 204，永不让上报失败影响玩家。"""
    name = _clip(payload.get("event"), 40)
    action = ALLOWED_EVENTS.get(name)
    if not action:
        return None
    detail = " ".join(
        "%s=%s" % (k, _clip(payload.get(k), 80))
        for k in ("reason", "count", "state", "npc", "script")
        if payload.get(k) is not None
    )
    try:
        db.add(AccessLog(action=action, path=_clip(payload.get("path"), 200),
                         method="POST", ip="", port="", user_agent="", detail=detail))
        db.commit()
    except Exception:                    # 记日志失败绝不能反过来打扰玩家
        db.rollback()
    return None
