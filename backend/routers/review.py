"""审核路由（薄层）：只做鉴权与参数绑定，业务逻辑在 services/review_service.py。

审核制度：
  作者提交 → [AI 初审]（仅风险筛查）→ [站长/管理员 复审]（最终裁定）
            → 通过则发布 → [社区事后监督]（举报进入社区审核池，站长判决）
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.security import get_current_user, require_admin_or_station_master
from ..models.user import User
from ..models.script import Script
from ..schemas.review import (
    AdminReviewRequest, ReportReviewRequest, CommunityVoteRequest, ApiReviewPromptRequest,
)
from ..services import review_service

router = APIRouter(prefix="/api/review", tags=["review"])


def _get_script_or_404(db: Session, script_id: str) -> Script:
    script = db.query(Script).filter(Script.id == script_id).first()
    if not script:
        raise HTTPException(status_code=404, detail="作品不存在")
    return script


@router.post("/upload")
def submit_for_review(
    payload: dict, db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """作者提交作品进入审核。"""
    script = _get_script_or_404(db, payload.get("script_id"))
    if script.user_id != str(current_user.id):
        raise HTTPException(status_code=403, detail="无权提交该作品")
    return review_service.submit_for_review(db, script)


@router.get("/queue/system")
def review_queue(
    db: Session = Depends(get_db),
    _: User = Depends(require_admin_or_station_master),
):
    """站长审核队列（新作品）。"""
    return review_service.get_system_queue(db)


@router.get("/queue/reviewed")
def reviewed_queue(
    db: Session = Depends(get_db),
    _: User = Depends(require_admin_or_station_master),
):
    """已审核列表（通过 + 驳回）。"""
    return review_service.get_reviewed_queue(db)


@router.get("/queue/community")
def community_queue(
    db: Session = Depends(get_db),
    _: User = Depends(require_admin_or_station_master),
):
    """社区审核池（被举报待判决作品）。"""
    return review_service.get_community_queue(db)


@router.post("/{script_id}/admin-review")
def admin_review(
    script_id: str, payload: AdminReviewRequest,
    db: Session = Depends(get_db),
    reviewer: User = Depends(require_admin_or_station_master),
):
    """站长终审（新作品）：通过则发布，驳回则退回作者。"""
    script = _get_script_or_404(db, script_id)
    return review_service.admin_review(db, script, payload.action, payload.reason, reviewer.username)


@router.post("/{script_id}/report-review")
def report_review(
    script_id: str, payload: ReportReviewRequest,
    db: Session = Depends(get_db),
    reviewer: User = Depends(require_admin_or_station_master),
):
    """社区审核池判决（被举报作品）：采纳举报(下架) / 驳回举报(恢复)。"""
    script = _get_script_or_404(db, script_id)
    return review_service.report_review(db, script, payload.action, payload.reason, reviewer.username)


@router.get("/flagged-pool")
def flagged_pool(db: Session = Depends(get_db)):
    """公开举报池：被举报下架的剧本（公开信息 + 举报聚合 + 投票统计，不含汤底等隐藏项）。"""
    return review_service.get_flagged_pool(db)


@router.post("/{script_id}/report")
def report_script(
    script_id: str, payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """用户举报剧本：记录举报 + 举报人自有 AI 判定结果，达到阈值才进举报池。"""
    script = _get_script_or_404(db, script_id)
    return review_service.report_script(
        db, script, str(current_user.id),
        (payload.get("reason") or "").strip(),
        payload.get("ai_result") or None,
    )


@router.post("/{script_id}/report-vote")
def report_vote(
    script_id: str, payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """用户对举报池剧本投票：ban（同意封禁）/ keep（不同意封禁）/ neutral（钝角中立）。"""
    script = _get_script_or_404(db, script_id)
    return review_service.report_vote(db, script, str(current_user.id), str(payload.get("vote") or ""))


@router.get("/{script_id}/report-votes")
def report_votes(script_id: str, db: Session = Depends(get_db)):
    """举报池投票统计（公开：仅统计数字，不含用户名单）。"""
    script = _get_script_or_404(db, script_id)
    return review_service.get_report_votes(db, script.id, include_users=False)


@router.post("/{script_id}/community-vote")
def community_vote(
    script_id: str, payload: CommunityVoteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """社区投票（点赞/点踩）。"""
    script = _get_script_or_404(db, script_id)
    return review_service.community_vote(db, script, str(current_user.id), payload.vote, payload.comment)


@router.get("/{script_id}/community-votes")
def community_votes(script_id: str, db: Session = Depends(get_db)):
    """社区投票统计。"""
    return review_service.get_community_votes(db, script_id)


@router.post("/api-review-prompt")
def save_api_review(
    payload: ApiReviewPromptRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin_or_station_master),
):
    """站长配置某分类的 AI 审核补充要求。"""
    return review_service.update_review_prompt(db, user, payload.category, payload.prompt_template)


@router.get("/api-review-prompt")
def get_api_review_prompts(
    db: Session = Depends(get_db),
    _: User = Depends(require_admin_or_station_master),
):
    """获取 AI 审核补充要求列表。"""
    return {"prompts": review_service.get_review_prompts(db)}
