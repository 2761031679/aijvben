"""管理路由"""
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from sqlalchemy.orm import Session
from ..core.database import get_db
from ..core.security import require_admin, require_owner, get_current_user
from ..models.user import User
from ..models.npc import NpcReviewLog, NpcIssueReport, AiErrorReport, TrendItem
from ..schemas.admin import (
    ApiPromptUpdateRequest, AnnouncementCreateRequest,
    AnnouncementUpdateRequest, SiteSettingSaveRequest,
)
from ..services import review_service, site_service, npc_service as ns

router = APIRouter(prefix="/api/admin", tags=["管理"])


# --- 审核提示词 ---
@router.get("/review-prompts")
def list_review_prompts(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    return review_service.get_review_prompts(db)


@router.put("/review-prompts/{category}")
def update_review_prompt(category: str, req: ApiPromptUpdateRequest,
                         user: User = Depends(require_admin), db: Session = Depends(get_db)):
    return review_service.update_review_prompt(db, user, category, req.prompt_template)


# --- 统计数据 ---
@router.get("/stats")
def stats(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    return site_service.get_stats(db)


# --- 免费海龟汤 AI 模型配置（仅站长） ---
@router.get("/free-ai-config")
def get_free_ai_config(user: User = Depends(require_owner), db: Session = Depends(get_db)):
    return site_service.get_free_ai_config(db)


@router.put("/free-ai-config")
def save_free_ai_config(req: dict, user: User = Depends(require_owner), db: Session = Depends(get_db)):
    return site_service.save_free_ai_config(db, user, req)


# --- 免费体验活动配置（仅站长） ---
@router.get("/free-trial-config")
def get_free_trial_config(user: User = Depends(require_owner), db: Session = Depends(get_db)):
    return site_service.get_free_trial_config(db)


@router.put("/free-trial-config")
def save_free_trial_config(req: dict, user: User = Depends(require_owner), db: Session = Depends(get_db)):
    return site_service.save_free_trial_config(db, user, req)


@router.get("/free-trial-usage")
def get_free_trial_usage(user: User = Depends(require_owner), db: Session = Depends(get_db)):
    """免费活动 token 消耗统计（仅站长可见）。"""
    return site_service.get_free_trial_usage(db)


# --- 首页轮播海报配置（管理员/站长） ---
@router.get("/banners")
def get_banners(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    return site_service.get_banner_config(db)


@router.put("/banners")
def save_banners(req: dict, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    return site_service.save_banner_config(db, user, req)


# --- 海报图片上传（管理员/站长） ---
@router.post("/upload-banner")
async def upload_banner(file: UploadFile = File(...), user: User = Depends(require_admin)):
    filename = file.filename or ""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ("png", "jpg", "jpeg", "gif", "webp"):
        raise HTTPException(400, "仅支持 png/jpg/jpeg/gif/webp 图片")
    data = await file.read()
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(413, "图片不能超过 5MB")
    banner_dir = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "img", "banner")
    os.makedirs(banner_dir, exist_ok=True)
    name = uuid.uuid4().hex[:12] + "." + ext
    with open(os.path.join(banner_dir, name), "wb") as f:
        f.write(data)
    return {"url": f"/static/img/banner/{name}"}


# --- BGM 音频上传（管理员/站长） ---
@router.post("/bgm/upload")
async def upload_bgm(file: UploadFile = File(...), name: str = Query(""),
                     user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """上传一首 BGM：存进 frontend/audio/bgm/ 并登记到 bgm_config.files。"""
    filename = file.filename or ""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ("mp3", "ogg", "wav", "m4a", "aac", "flac"):
        raise HTTPException(400, "仅支持 mp3/ogg/wav/m4a/aac/flac 音频")
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "音频不能超过 15MB")
    bgm_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "audio", "bgm"))
    os.makedirs(bgm_dir, exist_ok=True)
    stored = uuid.uuid4().hex[:12] + "." + ext
    with open(os.path.join(bgm_dir, stored), "wb") as f:
        f.write(data)
    title = (name or os.path.splitext(filename)[0] or "新 BGM").strip()[:40]
    return site_service.append_bgm_file(db, title, stored)


# --- 公告 ---
@router.post("/announcements")
def create_announcement(req: AnnouncementCreateRequest,
                        user: User = Depends(require_admin), db: Session = Depends(get_db)):
    return site_service.create_announcement(db, user, req.title, req.content, req.is_pinned)


@router.put("/announcements/{ann_id}")
def update_announcement(ann_id: str, req: AnnouncementUpdateRequest,
                        user: User = Depends(require_admin), db: Session = Depends(get_db)):
    return site_service.update_announcement(db, user, ann_id, req.model_dump(exclude_none=True))


@router.delete("/announcements/{ann_id}")
def delete_announcement(ann_id: str, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    return site_service.delete_announcement(db, user, ann_id)


# --- 站点设置 ---
@router.get("/site-settings")
def get_all_settings(db: Session = Depends(get_db)):
    return site_service.get_site_settings(db)


@router.put("/site-settings/{key}")
def save_setting(key: str, req: SiteSettingSaveRequest,
                 user: User = Depends(require_admin), db: Session = Depends(get_db)):
    return site_service.save_site_setting(db, user, key, req.value)


# --- NPC 提示词（这张表的接口已废弃，见下方说明）---
#
# 提示词的可信源是**文件系统**：npc_configs/{npc_id}/prompts/*.txt 与
# npc_configs/shared/prompts/*.txt（main.py 的 lifespan 里也写了这条约定）。
# npc_prompts 这张表只剩历史数据（线上 28 行 = 4 NPC × 7 种），改它不会影响 NPC 说什么。
#
# 以前这里「保存成功」但 NPC 读不到——是最容易让人白忙一天的坑。所以：
#   · GET 保留，只为兼容脚本核对历史数据，并明确标注 deprecated；
#   · POST / DELETE 直接 410，把调用方指到真正生效的文件接口。
# 文案与 /api/npc/prompts 共用同一句（npc_service.DEPRECATED_PROMPT_HINT），
# 后面再补一句「为什么」——同一个废弃接口在两个前缀下给两种说法，只会让人以为其中一个是新的。
_DEPRECATED_PROMPT_HINT = (
    ns.DEPRECATED_PROMPT_HINT
    + "（提示词以文件为唯一可信源：npc_configs/{npc_id}/prompts/ 与 "
    "npc_configs/shared/prompts/。改 npc_prompts 表不会生效。）"
)


@router.get("/npc-prompts")
def list_npc_prompts(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    from ..models.npc import NpcPrompt
    prompts = db.query(NpcPrompt).all()
    return {
        "deprecated": True,
        "source": "db",
        "effective_source": "files",
        "notice": _DEPRECATED_PROMPT_HINT,
        "prompts": [
            {
                "id": p.id, "npc_id": p.npc_id, "personality_id": p.personality_id,
                "prompt_type": p.prompt_type, "category": p.category,
                "content": p.content,
                "updated_by": p.editor.username if p.editor else "",
                "updated_at": p.updated_at.strftime("%Y-%m-%d %H:%M:%S") if p.updated_at else "",
            }
            for p in prompts
        ]
    }


@router.post("/npc-prompts")
def save_npc_prompt(req: dict, user: User = Depends(require_admin)):
    """已废弃：写库不生效。410 把调用方指到文件接口。"""
    raise HTTPException(status_code=410, detail=_DEPRECATED_PROMPT_HINT)


@router.delete("/npc-prompts/{prompt_id}")
def delete_npc_prompt(prompt_id: str, user: User = Depends(require_admin)):
    """已废弃：删库不生效。410 把调用方指到文件接口。"""
    raise HTTPException(status_code=410, detail=_DEPRECATED_PROMPT_HINT)


# --- 站长变更 ---
@router.get("/owner-logs")
def owner_logs(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    return site_service.get_owner_logs(db)


# --- 点赞记录（仅站长） ---
@router.get("/likes-records/{script_id}")
def likes_records(script_id: str, user: User = Depends(require_owner), db: Session = Depends(get_db)):
    from ..models.system import LikesRecord
    records = db.query(LikesRecord).filter(LikesRecord.script_id == script_id).all()
    likes = [r.user.username for r in records if r.like_type == "like" and r.user]
    dislikes = [r.user.username for r in records if r.like_type == "dislike" and r.user]
    return {"likes_users": likes, "dislikes_users": dislikes}


# --- 回收站 ---
@router.get("/deleted/items")
def deleted_items(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    from ..models.script import Script
    from ..models.system import Announcement
    scripts = db.query(Script).filter(Script.is_deleted == True).all()
    anns = db.query(Announcement).filter(Announcement.is_deleted == True).all()
    return {"scripts": [s.to_dict() for s in scripts], "announcements": [a.to_dict() for a in anns]}


# --- 审核打回记录（仅站长） ---
@router.get("/npc-review-logs")
def list_npc_review_logs(page: int = Query(1, ge=1), user: User = Depends(require_owner), db: Session = Depends(get_db)):
    """审核打回记录列表（站长排查用，按时间倒序分页）。"""
    total = db.query(NpcReviewLog).count()
    logs = db.query(NpcReviewLog).order_by(NpcReviewLog.created_at.desc()).offset((page - 1) * 20).limit(20).all()
    return {"logs": [l.to_dict() for l in logs], "total": total, "page": page, "total_pages": max(1, (total + 19) // 20)}


@router.delete("/npc-review-logs/{log_id}")
def delete_npc_review_log(log_id: str, user: User = Depends(require_owner), db: Session = Depends(get_db)):
    log = db.query(NpcReviewLog).filter(NpcReviewLog.id == log_id).first()
    if not log:
        raise HTTPException(404, "记录不存在")
    db.delete(log)
    db.commit()
    return {"message": "已删除"}


@router.delete("/npc-review-logs")
def clear_npc_review_logs(user: User = Depends(require_owner), db: Session = Depends(get_db)):
    """清空全部审核打回记录。"""
    db.query(NpcReviewLog).delete()
    db.commit()
    return {"message": "已清空"}


# --- NPC 问题反馈（仅站长） ---
@router.get("/npc-issue-reports")
def list_npc_issue_reports(page: int = Query(1, ge=1), user: User = Depends(require_owner), db: Session = Depends(get_db)):
    """NPC 问题反馈列表（站长排查用，按时间倒序分页）。"""
    total = db.query(NpcIssueReport).count()
    reports = db.query(NpcIssueReport).order_by(NpcIssueReport.created_at.desc()).offset((page - 1) * 20).limit(20).all()
    return {"reports": [r.to_dict() for r in reports], "total": total, "page": page, "total_pages": max(1, (total + 19) // 20)}


@router.delete("/npc-issue-reports/{report_id}")
def delete_npc_issue_report(report_id: str, user: User = Depends(require_owner), db: Session = Depends(get_db)):
    report = db.query(NpcIssueReport).filter(NpcIssueReport.id == report_id).first()
    if not report:
        raise HTTPException(404, "反馈不存在")
    db.delete(report)
    db.commit()
    return {"message": "已删除"}


@router.delete("/npc-issue-reports")
def clear_npc_issue_reports(user: User = Depends(require_owner), db: Session = Depends(get_db)):
    """清空全部问题反馈。"""
    db.query(NpcIssueReport).delete()
    db.commit()
    return {"message": "已清空"}


# --- AI 对话报错书（仅站长） ---
@router.get("/ai-error-reports")
def list_ai_error_reports(page: int = Query(1, ge=1), user: User = Depends(require_owner), db: Session = Depends(get_db)):
    """AI 对话报错书列表（站长排查 AI 调用故障用，按时间倒序分页）。"""
    total = db.query(AiErrorReport).count()
    reports = db.query(AiErrorReport).order_by(AiErrorReport.created_at.desc()).offset((page - 1) * 20).limit(20).all()
    return {"reports": [r.to_dict() for r in reports], "total": total, "page": page, "total_pages": max(1, (total + 19) // 20)}


@router.delete("/ai-error-reports/{report_id}")
def delete_ai_error_report(report_id: str, user: User = Depends(require_owner), db: Session = Depends(get_db)):
    report = db.query(AiErrorReport).filter(AiErrorReport.id == report_id).first()
    if not report:
        raise HTTPException(404, "报错书不存在")
    db.delete(report)
    db.commit()
    return {"message": "已删除"}


@router.delete("/ai-error-reports")
def clear_ai_error_reports(user: User = Depends(require_owner), db: Session = Depends(get_db)):
    """清空全部报错书。"""
    db.query(AiErrorReport).delete()
    db.commit()
    return {"message": "已清空"}


# --- 热梗/问好资源库管理 ---
@router.get("/trends")
def list_trends(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """热梗/问好资源库列表（全部，含禁用，按更新时间倒序）。"""
    items = db.query(TrendItem).order_by(TrendItem.updated_at.desc()).all()
    return {"items": [it.to_dict() for it in items]}


@router.post("/trends")
def create_trend(req: dict, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """新增热梗/问好条目。"""
    keyword = (req.get("keyword") or "").strip()
    if not keyword:
        raise HTTPException(400, "关键词不能为空")
    item = TrendItem(
        id=uuid.uuid4().hex[:12],
        keyword=keyword,
        content=req.get("content") or "",
        category=req.get("category") or "trend",
        enabled=bool(req.get("enabled", True)),
        updated_by=user.id,
    )
    db.add(item)
    db.commit()
    return item.to_dict()


@router.put("/trends/{item_id}")
def update_trend(item_id: str, req: dict, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """更新热梗/问好条目（keyword/content/category/enabled 按需更新）。"""
    item = db.query(TrendItem).filter(TrendItem.id == item_id).first()
    if not item:
        raise HTTPException(404, "条目不存在")
    if "keyword" in req:
        kw = (req.get("keyword") or "").strip()
        if not kw:
            raise HTTPException(400, "关键词不能为空")
        item.keyword = kw
    if "content" in req:
        item.content = req.get("content") or ""
    if "category" in req:
        item.category = req.get("category") or "trend"
    if "enabled" in req:
        item.enabled = bool(req.get("enabled"))
    item.updated_by = user.id
    db.commit()
    return item.to_dict()


@router.delete("/trends/{item_id}")
def delete_trend(item_id: str, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """删除热梗/问好条目。"""
    item = db.query(TrendItem).filter(TrendItem.id == item_id).first()
    if not item:
        raise HTTPException(404, "条目不存在")
    db.delete(item)
    db.commit()
    return {"message": "已删除"}
