"""NPC 配置路由 — 管理面板的 NPC 统一管理 API"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.security import get_current_user, require_admin
from ..models.user import User
from ..services import npc_file_service

router = APIRouter(prefix="/api/admin/npc-configs", tags=["NPC配置"])


@router.get("/management")
def get_npc_management(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """管理面板 NPC 管理标签页统一数据接口"""
    data = npc_file_service.get_npc_management_data()
    try:
        from ..services.review_service import get_review_prompts
        data["review_prompts"] = get_review_prompts(db)
    except Exception:
        data["review_prompts"] = []
    return data


@router.get("")
def list_npc_configs():
    """获取所有 NPC 配置（公开，初始化时前端拉取）。

    返回的 configs 含 enabled_emotions/enabled_actions（站长在调用面板设置的开放清单），
    available_emotions/available_actions 为服务器效果池，供前端实时读取、不硬编码。
    """
    return {
        "npcs": npc_file_service.NPC_DEFINITIONS,
        "configs": npc_file_service.get_all_npc_configs(),
        "available_emotions": npc_file_service.EMOTION_DEFS,
        "available_actions": npc_file_service.ANIMATION_DEFS,
    }


@router.get("/{npc_id}/portraits")
def list_npc_portraits(npc_id: str, user: User = Depends(require_admin)):
    """列出某 NPC 的可用立绘文件（供立绘表情编辑器展示缩略图）"""
    return {"portraits": npc_file_service.list_npc_portraits(npc_id)}


@router.put("/{npc_id}")
def update_npc_config(npc_id: str, data: dict, user: User = Depends(require_admin)):
    """管理员更新指定 NPC 的配置（scale, voice, portrait_url）"""
    # 兼容旧的 personality_id 参数
    pid = data.pop("personality_id", "") if isinstance(data, dict) else ""
    result = npc_file_service.save_npc_config(npc_id, data)
    from ..services.site_service import sync_npc_config_to_db
    from ..core.database import SessionLocal
    db = SessionLocal()
    try:
        sync_npc_config_to_db(db, user, npc_id, pid or "", result)
    finally:
        db.close()
    return {"message": "NPC 配置已保存", "config": result}


@router.put("/{npc_id}/prompts/{prompt_type}")
def save_npc_prompt(
    npc_id: str,
    prompt_type: str,
    data: dict,
    user: User = Depends(require_admin),
):
    """保存 NPC 提示词文件（文件系统为唯一可信源；game_mode 按 category 落盘到对应文件）"""
    content = data.get("content", "")
    category = data.get("category", "") or ""
    # 仅写入文件；不再回写 DB（get_prompts 已改为只读文件，避免双轨不一致，见 #8 修复）
    result = npc_file_service.save_npc_prompt_file(npc_id, prompt_type, content, category=category)
    return {"message": "提示词已保存", "prompt": result}


@router.get("/init-dirs")
def init_directories(user: User = Depends(require_admin)):
    """初始化 NPC 配置目录结构"""
    dirs = npc_file_service.init_npc_dirs()
    return {"message": f"已初始化 {len(dirs)} 个目录", "dirs": dirs}
