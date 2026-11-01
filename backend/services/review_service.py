"""审核业务逻辑（路由层只做鉴权与参数绑定，业务逻辑全部收敛于此）。

审核制度：
  新作品：草稿 → [AI 初审] → 站长复审 → 通过(发布) / 驳回(退回作者)
  举报：已发布作品被举报 → 进入社区审核池(系统标记) → 站长判决 → 采纳(下架) / 驳回(恢复)

队列划分：
  - 站长审核队列：pending_api / pending_admin（新作品）
  - 社区审核池：system_flagged（被举报待判决）
  - 已审核列表：approved / rejected
"""
from datetime import datetime, timezone
from sqlalchemy import func
from sqlalchemy.orm import Session
from fastapi import HTTPException

from ..models.script import (
    Script, REVIEW_PENDING_API, REVIEW_PENDING_ADMIN,
    REVIEW_APPROVED, REVIEW_REJECTED, REVIEW_SYSTEM_FLAGGED,
    REVIEW_SOURCE_ADMIN,
)
from ..models.review import ApiReviewPrompt, CommunityReview, ScriptReport, ReportVote
from . import ai_review_service, notification_service

# 举报次数阈值：达到后才下架进入举报池（未达阈值保持正常展示）
REPORT_THRESHOLD = 3


# ==================== 提交与审核队列 ====================

def submit_for_review(db: Session, script: Script) -> dict:
    """作者提交作品进入审核（先 AI 初审，再人工复审）。

    状态机约束：仅「草稿 / 已驳回」可（重新）提交；审核中 / 已发布拒绝重复提交。
    """
    if script.review_status in (REVIEW_PENDING_API, REVIEW_PENDING_ADMIN, REVIEW_SYSTEM_FLAGGED):
        raise HTTPException(409, "作品正在审核中，请勿重复提交")
    if script.review_status == REVIEW_APPROVED:
        raise HTTPException(409, "作品已发布，无需重复提交")

    script.review_status = REVIEW_PENDING_API
    script.review_reason = ""
    script.reviewed_by = ""
    db.commit()

    ai = ai_review_service.run_ai_review(db, script)  # 推进到 pending_admin
    return {
        "message": "已提交：AI 初审完成，等待站长复审" if ai else "已提交：等待站长审核",
        "review_status": script.review_status,
        "ai_review": ai.to_dict() if ai else None,
    }


def get_system_queue(db: Session) -> dict:
    """站长审核队列：新作品（AI 待审 / 站长待审），附 AI 初审结果。"""
    items = db.query(Script).filter(
        Script.is_deleted == False,
        Script.review_status.in_([REVIEW_PENDING_API, REVIEW_PENDING_ADMIN]),
    ).order_by(Script.created_at.desc()).all()

    result = []
    for s in items:
        d = s.to_dict(include_full=True)
        ai = ai_review_service.get_latest_ai_review(db, s.id)
        d["ai_review"] = ai.to_dict() if ai else None
        result.append(d)
    return {"scripts": result, "total": len(result)}


def get_reviewed_queue(db: Session) -> dict:
    """已审核列表：审核通过 + 已驳回（按更新时间倒序，含打回原因）。"""
    items = db.query(Script).filter(
        Script.is_deleted == False,
        Script.review_status.in_([REVIEW_APPROVED, REVIEW_REJECTED]),
    ).order_by(Script.updated_at.desc()).all()
    return {"scripts": [s.to_dict(include_full=True) for s in items], "total": len(items)}


def get_community_queue(db: Session) -> dict:
    """站长举报管理页：按剧本聚合被举报信息（举报计数 + 举报列表 + 投票统计 + 当前状态）。
    包含「已下架(system_flagged)」与「未达阈值仍 approved 但有举报」两种情况。"""
    rows = db.query(ScriptReport.script_id).filter(
        ScriptReport.status == "pending"
    ).distinct().all()
    ids = [r[0] for r in rows]

    result = []
    for sid in ids:
        script = db.query(Script).filter(Script.id == sid, Script.is_deleted == False).first()
        if not script:
            continue
        d = script.to_dict(include_full=True)
        reports = _aggregate_reports(db, sid)
        d["reports"] = reports
        d["report_count"] = len(reports)
        d["votes"] = get_report_votes(db, sid, include_users=True)
        d["flagged"] = script.review_status == REVIEW_SYSTEM_FLAGGED
        result.append(d)

    result.sort(key=lambda x: (x["reports"][0]["created_at"] if x["reports"] else ""), reverse=True)
    return {"scripts": result, "total": len(result)}


# ==================== 审核判决 ====================

def admin_review(db: Session, script: Script, action: str, reason: str, reviewer_username: str) -> dict:
    """站长终审（新作品）：通过则发布，驳回则退回作者。

    状态机约束：仅「待审」状态可审核，已审核作品拒绝重复操作。
    """
    if script.review_status not in (REVIEW_PENDING_API, REVIEW_PENDING_ADMIN):
        raise HTTPException(409, "该作品已审核过，请勿重复操作")

    script.reviewed_by = reviewer_username
    script.review_source = REVIEW_SOURCE_ADMIN
    if action == "approve":
        script.review_status = REVIEW_APPROVED
        script.review_reason = reason or "审核通过"
        script.published_at = datetime.now(timezone.utc)
    else:
        script.review_status = REVIEW_REJECTED
        script.review_reason = reason or "未填写原因"
    db.commit()

    notification_service.notify_review_result(db, script, action)
    return {"message": "审核完成", "review_status": script.review_status}


def report_review(db: Session, script: Script, action: str, reason: str, reviewer_username: str) -> dict:
    """社区审核池判决（被举报作品）。

    - uphold（采纳举报）：作品下架（rejected），举报记录标记 handled；
    - dismiss（驳回举报）：作品恢复发布（approved），举报记录标记 dismissed。
    """
    if script.review_status != REVIEW_SYSTEM_FLAGGED:
        raise HTTPException(409, "该作品不在社区审核池中")

    script.reviewed_by = reviewer_username
    script.review_source = REVIEW_SOURCE_ADMIN
    if action == "uphold":
        script.review_status = REVIEW_REJECTED
        script.review_reason = reason or "因举报下架"
        report_status = "handled"
        notify_action = "reject"
    else:
        script.review_status = REVIEW_APPROVED
        script.review_reason = ""
        report_status = "dismissed"
        notify_action = "approve"

    db.query(ScriptReport).filter(
        ScriptReport.script_id == script.id, ScriptReport.status == "pending"
    ).update({"status": report_status})
    db.commit()

    notification_service.notify_review_result(db, script, notify_action)
    return {"message": "判决完成", "review_status": script.review_status}


# ==================== 举报与社区互动 ====================

def report_script(db: Session, script: Script, user_id: str, reason: str, ai_result: dict | None = None) -> dict:
    """用户举报剧本：记录举报（含举报人自有 AI 判定结果），达到阈值才下架进举报池。

    - 去重：同一用户对同一剧本只能举报一次；
    - AI 判定：由前端用「举报人自己的 AI」判断后传入（非服务器 AI），失败则为空；
    - 计数：达到 REPORT_THRESHOLD 才置 system_flagged，否则保持 approved 正常展示。"""
    existing = db.query(ScriptReport).filter(
        ScriptReport.script_id == script.id,
        ScriptReport.user_id == user_id,
    ).first()
    if existing:
        raise HTTPException(409, "你已举报过该作品，请等待处理")

    ai = ai_result or {}
    try:
        ai_score = float(ai.get("score") or 0)
    except (TypeError, ValueError):
        ai_score = 0.0

    db.add(ScriptReport(
        script_id=script.id,
        user_id=user_id,
        reason=reason,
        ai_decision=str(ai.get("decision") or "")[:30],
        ai_score=ai_score,
        ai_flags=ai.get("flags") or [],
        ai_suggestion=str(ai.get("suggestion") or ""),
    ))
    db.commit()

    pending_count = db.query(ScriptReport).filter(
        ScriptReport.script_id == script.id,
        ScriptReport.status == "pending",
    ).count()

    if pending_count >= REPORT_THRESHOLD:
        script.review_status = REVIEW_SYSTEM_FLAGGED
        script.review_reason = f"被 {pending_count} 名用户举报"
        script.reviewed_by = ""
        db.commit()
        return {"message": "举报成功，该作品已进入举报池", "review_status": script.review_status,
                "flagged": True, "report_count": pending_count}

    return {"message": "举报已受理，感谢反馈", "review_status": script.review_status,
            "flagged": False, "report_count": pending_count}


def _aggregate_reports(db: Session, script_id: str) -> list[dict]:
    """该剧本全部 pending 举报记录（按时间倒序），供公开举报池与站长管理页复用。"""
    reports = db.query(ScriptReport).filter(
        ScriptReport.script_id == script_id,
        ScriptReport.status == "pending",
    ).order_by(ScriptReport.created_at.desc()).all()
    return [r.to_dict() for r in reports]


def get_flagged_pool(db: Session) -> dict:
    """公开举报池：返回所有被举报下架（system_flagged）剧本的公开信息 + 举报聚合 + 投票统计。
    用 include_full=False，不返回汤底/结束条件/指导词（复用普通列表的隐藏规则）。"""
    scripts = db.query(Script).filter(
        Script.is_deleted == False,
        Script.review_status == REVIEW_SYSTEM_FLAGGED,
    ).order_by(Script.updated_at.desc()).all()

    result = []
    for s in scripts:
        d = s.to_dict(include_full=False, include_synopsis=True)
        d["reports"] = _aggregate_reports(db, s.id)
        d["votes"] = get_report_votes(db, s.id)
        result.append(d)
    return {"scripts": result, "total": len(result)}


def report_vote(db: Session, script: Script, user_id: str, vote: str) -> dict:
    """用户对举报池剧本投票：ban（同意封禁）/ keep（不同意封禁）/ neutral（钝角中立）。
    同一用户同剧本可改票（覆盖）。"""
    if vote not in ("ban", "keep", "neutral"):
        raise HTTPException(400, "无效的投票选项")
    if script.review_status != REVIEW_SYSTEM_FLAGGED:
        raise HTTPException(409, "该作品不在举报池中")

    existing = db.query(ReportVote).filter(
        ReportVote.script_id == script.id,
        ReportVote.user_id == user_id,
    ).first()
    if existing:
        existing.vote = vote
        existing.created_at = datetime.now(timezone.utc)
    else:
        db.add(ReportVote(script_id=script.id, user_id=user_id, vote=vote))
    db.commit()
    return {"message": "投票成功", "stat": get_report_votes(db, script.id)["stat"]}


def get_report_votes(db: Session, script_id: str, include_users: bool = False) -> dict:
    """举报池投票统计；include_users=True 时附带各阵营用户名（站长查看）。"""
    votes = db.query(ReportVote).filter(ReportVote.script_id == script_id).all()
    stat = {"ban": 0, "keep": 0, "neutral": 0, "total": 0}
    users = {"ban": [], "keep": [], "neutral": []}
    for v in votes:
        if v.vote in stat:
            stat[v.vote] += 1
            stat["total"] += 1
            if include_users:
                users[v.vote].append(v.user.username if v.user else "")
    result = {"stat": stat}
    if include_users:
        result["users"] = users
    return result


def community_vote(db: Session, script: Script, user_id: str, vote: str, comment: str) -> dict:
    """社区投票（点赞/点踩，不影响审核状态）。"""
    if vote == "approve":
        script.likes = (script.likes or 0) + 1
    elif vote == "reject":
        script.dislikes = (script.dislikes or 0) + 1
    db.add(CommunityReview(script_id=script.id, user_id=user_id, vote=vote, comment=comment))
    db.commit()
    return {
        "message": "投票成功", "likes": script.likes,
        "dislikes": script.dislikes, "review_status": script.review_status,
    }


def get_community_votes(db: Session, script_id: str) -> dict:
    """社区投票统计。"""
    rows = db.query(CommunityReview.vote, func.count(CommunityReview.id)).filter(
        CommunityReview.script_id == script_id
    ).group_by(CommunityReview.vote).all()
    result = {"approve": 0, "reject": 0, "abstain": 0}
    for vote, cnt in rows:
        result[vote] = cnt
    return result


# ==================== 审核提示词配置 ====================

def get_review_prompts(db: Session) -> list:
    """获取审核提示词列表。"""
    prompts = db.query(ApiReviewPrompt).all()
    return [
        {"category": p.category, "prompt_template": p.prompt_template,
         "updated_by": p.editor.username if p.editor else "", "updated_at": str(p.updated_at)}
        for p in prompts
    ]


def update_review_prompt(db: Session, user, category: str, prompt_template: str) -> dict:
    """更新审核提示词。"""
    prompt = db.query(ApiReviewPrompt).filter(ApiReviewPrompt.category == category).first()
    if prompt:
        prompt.prompt_template = prompt_template
        prompt.updated_by = user.id
        prompt.updated_at = datetime.now(timezone.utc)
    else:
        prompt = ApiReviewPrompt(category=category, prompt_template=prompt_template, updated_by=user.id)
        db.add(prompt)
    db.commit()
    return {"message": "审核提示词已更新"}
