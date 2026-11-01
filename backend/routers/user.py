"""用户路由"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from ..core.database import get_db
from ..core.security import get_current_user, require_login_not_token
from ..models.user import User
from ..schemas.user import UserSettingsRequest, PlaySessionSaveRequest
from ..schemas.game import CloudSyncUploadRequest
from ..services import token_service, user_service

router = APIRouter(prefix="/api/user", tags=["用户"])


@router.get("/profile")
def get_profile(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return user_service.get_profile(db, user)


@router.put("/profile")
def save_profile(req: UserSettingsRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return user_service.save_settings(db, user, req.settings_json)


@router.get("/subscriptions")
def list_subs(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return user_service.list_subscriptions(db, user)


@router.post("/subscriptions/{script_id}")
def subscribe(script_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return user_service.subscribe(db, user, script_id)


@router.delete("/subscriptions/{script_id}")
def unsubscribe(script_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return user_service.unsubscribe(db, user, script_id)


@router.get("/subscriptions/{script_id}/status")
def sub_status(script_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from ..models.user_data import Subscription
    exists = db.query(Subscription).filter(
        Subscription.user_id == user.id, Subscription.script_id == script_id
    ).first()
    return {"subscribed": exists is not None}


@router.get("/play-data/{script_id}")
def get_play_data(script_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    data = user_service.get_play_data(db, user, script_id)
    return data or {"script_id": script_id, "title": "", "session_data": {}, "updated_at": ""}


@router.get("/play-sessions")
def list_play_sessions(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """列出用户未完成的游玩会话（NPC 开场判断是否有进行中剧本）"""
    return user_service.list_play_sessions(db, user)


@router.put("/play-data/{script_id}")
def save_play_data(script_id: str, req: PlaySessionSaveRequest,
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return user_service.save_play_data(db, user, script_id, req.session_data)


@router.post("/cloud-sync/upload")
def cloud_sync_upload(req: CloudSyncUploadRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return user_service.cloud_sync_upload(db, user, req.model_dump())


@router.get("/cloud-sync/download")
def cloud_sync_download(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return user_service.cloud_sync_download(db, user)


@router.get("/status-bar-save")
def get_status_bar_save(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """读取当前用户的状态栏 UI 存档。"""
    return user_service.get_status_bar_save(db, user)


@router.put("/status-bar-save")
def save_status_bar_save(req: dict, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """保存当前用户的状态栏 UI 存档（每用户一份）。"""
    return user_service.save_status_bar_save(db, user, req.get("payload") or {})


@router.get("/game-data-save")
def get_game_data_save(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """读取当前用户的游戏数据存档（条件进度/线索道具等）。"""
    return user_service.get_game_data_save(db, user)


@router.put("/game-data-save")
def save_game_data_save(req: dict, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """保存当前用户的游戏数据存档（每用户一份）。"""
    return user_service.save_game_data_save(db, user, req.get("payload") or {})


# ============ MCP 长期凭证（M27）============
# 请求体就地定义：backend/schemas 不归本轮改，而这里只有一处用。
# name/scopes 的细则校验放在 token_service 里（那样 422 的错误形状与其它业务校验一致）。

class McpTokenCreateRequest(BaseModel):
    name: str = ""
    scopes: list[str] = []


@router.post("/mcp-tokens", status_code=201)
def create_mcp_token(req: McpTokenCreateRequest,
                     user: User = Depends(require_login_not_token), db: Session = Depends(get_db)):
    """生成一把 MCP 长期凭证。**响应里的 token 明文只出现这一次**。"""
    try:
        row, raw = token_service.create(db, user, req.name, req.scopes)
    except token_service.InvalidArgument as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_argument", "message": str(exc)})
    except token_service.TokenLimitReached as exc:
        raise HTTPException(status_code=409, detail={"code": "token_limit_reached", "message": str(exc)})
    out = row.to_dict()
    out["token"] = raw  # 明文，仅此一次；库里只有 sha256
    out["warning"] = "这串 token 只显示这一次，关掉就再也拿不到；丢了请吊销后重新生成。"
    # 诚实标注：v1 的 scopes 只控制「能不能调这类动作」，不细分到「能读哪一本」，
    # 也不提供管理面（门票一律进不去 admin/owner，见 security._deny_by_token）。
    # 不写这句，前端那排勾选框会让人以为权限是逐条生效的（审计 S4）。
    out["note"] = ("当前版本 scopes 只区分动作大类，不细分数据范围；门票一律不能访问"
                   "管理员/站长面，也不能签发或吊销门票。")
    return out


@router.get("/mcp-tokens")
def list_mcp_tokens(user: User = Depends(require_login_not_token), db: Session = Depends(get_db)):
    """我自己的凭证清单（含已吊销的，方便对账）。**不含明文、不含哈希**。"""
    return [row.to_dict() for row in token_service.list_for_user(db, user)]


@router.delete("/mcp-tokens/{token_id}", status_code=204)
def delete_mcp_token(token_id: str,
                     user: User = Depends(require_login_not_token), db: Session = Depends(get_db)):
    """吊销一把凭证（软删，行留着给审计）。幂等；不是自己的当不存在（404，不透存在性）。"""
    if not token_service.revoke(db, user, token_id):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "没有这把凭证"})
    return None
