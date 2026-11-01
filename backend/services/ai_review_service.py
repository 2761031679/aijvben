"""AI 初审调度服务。

设计原则：
  - AI 仅做风险筛查与建议（recommend_approve / recommend_reject / need_human），
    不拥有最终否决权；初审结束后一律进入「站长/管理员复审」由人工裁定。
  - 若后端未配置 LLM，则优雅降级：跳过 AI 初审，直接进入人工复审。
  - 每次提交均触发一次 AI 初审（同步执行，结果持久化到 AiReview 供管理员参考）。
"""
from datetime import datetime, timezone
from sqlalchemy.orm import Session

from ..models.script import Script, REVIEW_PENDING_ADMIN, REVIEW_PENDING_API
from ..models.review import ApiReviewPrompt, AiReview
from ..core.ai_client import is_configured, chat_json

SYSTEM_PROMPT = (
    "你是内容安全初审员。判断用户上传的剧本是否存在违规风险（如色情、暴力、仇恨、"
    "自残、违法、政治敏感等）。只输出 JSON，格式："
    '{"decision":"recommend_approve|recommend_reject|need_human",'
    '"score":0到100的风险分,"reasons":["命中理由"],'
    '"flags":["风险类别"],"suggestion":"给管理员的修改建议"}'
)


def _build_user_prompt(script: Script, extra: str = "") -> str:
    return (
        f"分类：{script.category}\n标题：{script.title}\n"
        f"简介：{script.synopsis}\n标签：{', '.join(script.tags or [])}\n"
        f"正文（汤面/谜题）：{script.story[:1500]}\n"
        f"{extra}\n请严格只返回 JSON。"
    )


def run_ai_review(db: Session, script: Script) -> AiReview | None:
    """对单个剧本执行 AI 初审，并把状态推进到人工复审。返回 AiReview 或 None（降级）。"""
    if not is_configured():
        # 优雅降级：未配置 LLM，跳过 AI，直接进入人工复审
        script.review_status = REVIEW_PENDING_ADMIN
        db.commit()
        return None

    # 获取该分类的站长自定义审核提示词（如有）
    extra = ""
    prompt = db.query(ApiReviewPrompt).filter(ApiReviewPrompt.category == script.category).first()
    if prompt:
        extra = f"站长补充审核要求：{prompt.prompt_template}"

    try:
        result = chat_json([
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _build_user_prompt(script, extra)},
        ], temperature=0.2)
    except Exception:
        # AI 调用失败（网络/超时/限流）不阻断提交：降级为「跳过 AI 初审，直接人工复审」
        result = None

    script.review_status = REVIEW_PENDING_ADMIN  # AI 初审结束，交人工终审
    if result:
        ai = AiReview(
            script_id=script.id,
            decision=result.get("decision", "need_human"),
            score=float(result.get("score", 0) or 0),
            reasons=result.get("reasons", []) or [],
            flags=result.get("flags", []) or [],
            suggestion=result.get("suggestion", "") or "",
            raw_response="",
            model="",
            created_at=datetime.now(timezone.utc),
        )
        db.add(ai)
        db.commit()
    db.commit()
    return get_latest_ai_review(db, script.id)


def get_latest_ai_review(db: Session, script_id: str) -> "AiReview | None":
    """按 script_id 取最新一次 AI 初审记录（无需在 Script 上冗余列）。"""
    return db.query(AiReview).filter(AiReview.script_id == script_id).order_by(
        AiReview.created_at.desc()
    ).first()
