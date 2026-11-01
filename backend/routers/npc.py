"""NPC 路由"""
from typing import Optional
from fastapi import APIRouter, Depends, Query, HTTPException, Header
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from ..core.database import get_db
from ..core.security import get_current_user, get_optional_user, require_admin, require_admin_or_station_master
from ..models.user import User
from ..models.npc import NpcReviewLog, NpcIssueReport, AiErrorReport, TrendItem
from ..schemas.npc import ScriptSearchRequest
from ..services import npc_service, npc_file_service

router = APIRouter(prefix="/api/npc", tags=["NPC"])


@router.post("/review-log")
def create_review_log(payload: dict, user: User | None = Depends(get_optional_user), db: Session = Depends(get_db)):
    """审核 NPC 打回记录：前端在驳回时 fire-and-forget 落库（游客/登录均可）。
    记录对话上下文 + 待审回复 + 修改建议，供站长排查 bug。"""
    try:
        round_no = int(payload.get("round") or 1)
    except (TypeError, ValueError):
        round_no = 1
    log = NpcReviewLog(
        npc_id=str(payload.get("npc_id") or "")[:50],
        user_id=str(user.id) if user else None,
        transcript=str(payload.get("transcript") or ""),
        raw_reply=str(payload.get("raw_reply") or ""),
        suggestion=str(payload.get("suggestion") or ""),
        round=round_no,
    )
    db.add(log)
    db.commit()
    return {"message": "已记录", "id": log.id}


@router.post("/issue-report")
def create_issue_report(payload: dict, user: User | None = Depends(get_optional_user), db: Session = Depends(get_db)):
    """NPC 问题反馈：经玩家同意后落库（游客/登录均可）。
    记录对话上下文 + 反馈理由，供站长在管理面板查看。"""
    report = NpcIssueReport(
        npc_id=str(payload.get("npc_id") or "")[:50],
        user_id=str(user.id) if user else None,
        reason=str(payload.get("reason") or ""),
        transcript=str(payload.get("transcript") or ""),
        source=str(payload.get("source") or "npc_report")[:20],
    )
    db.add(report)
    db.commit()
    return {"message": "已反馈", "id": report.id}


@router.post("/ai-error-report")
def create_ai_error_report(payload: dict, user: User | None = Depends(get_optional_user), db: Session = Depends(get_db)):
    """AI 对话报错书：前端各 AI 调用环节出错、重试无效后 fire-and-forget 落库（游客/登录均可）。"""
    report = AiErrorReport(
        npc_id=str(payload.get("npc_id") or "")[:50],
        user_id=str(user.id) if user else None,
        error_type=str(payload.get("error_type") or "empty_content")[:20],
        provider=str(payload.get("provider") or "")[:20],
        model=str(payload.get("model") or "")[:50],
        message=str(payload.get("message") or "")[:500],
        kind=str(payload.get("kind") or "")[:30],
    )
    db.add(report)
    db.commit()
    return {"message": "已记录", "id": report.id}


def _can_access_user(current_user: User, user_id: str) -> bool:
    return str(current_user.id) == str(user_id) or current_user.role in ("admin", "station_master", "owner")


@router.get("/{npc_id}/sfx")
def npc_sfx_manifest(npc_id: str):
    """这个 NPC 有没有录音包、里面有哪些音频。

    公开接口：录音包是「简单语句的音效」，不含任何剧本内容；前端切换 NPC 时
    先问一次，没包就把相关选项置灰。空目录 = 没有录音包（正常状态，不是错误）。
    """
    files = npc_file_service.list_sfx(npc_id)
    return {
        "npc_id": npc_id,
        "has_pack": bool(files),
        "count": len(files),
        "buckets": sorted({f["bucket"] for f in files}),
        "files": files,
    }


@router.get("/{npc_id}/sfx/{filename}")
def npc_sfx_file(npc_id: str, filename: str):
    """取一条录音包音频。只认 npc_configs/<npc>/sfx/ 下的音频文件，其它一律 404。"""
    path = npc_file_service.sfx_path(npc_id, filename)
    if path is None:
        raise HTTPException(status_code=404, detail="录音不存在")
    media = {
        ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
        ".m4a": "audio/mp4", ".opus": "audio/opus", ".webm": "audio/webm",
    }.get(path.suffix.lower(), "application/octet-stream")
    # 录音包是静态资源：允许浏览器缓存一天，省得每次切 NPC 都重下
    return FileResponse(str(path), media_type=media, headers={"Cache-Control": "public, max-age=86400"})


@router.get("/prompts")
def get_prompts(npc_id: str = Query(...), personality_id: str = Query(""), db: Session = Depends(get_db)):
    """读提示词（保留兼容）。

    读的是文件（唯一可信源），所以内容是真的；这条路径留下来只为让老脚本还能跑。
    `deprecated: true` 加在**每一项**上，而不是把整个返回改成 {prompts, deprecated}——
    前端三个调用点（npc/chat.js、npc/offline_npc.js、npc/system_texts.js）都按数组 `.map`，
    改成对象就是直接把它们弄坏。
    """
    return [dict(p, deprecated=True) for p in npc_service.get_prompts(db, npc_id, personality_id)]


# 同一张表的写入口：固定 410。以前这里只声明了 GET，PUT/POST 落到框架的 405——
# 「方法不允许」读起来像「你路径拼错了」，于是调用方会继续翻文档找「正确写法」；
# 410 才是「这东西没了，去文件接口」。废弃原因见 npc_service.DEPRECATED_PROMPT_HINT。
@router.put("/prompts")
@router.post("/prompts")
def write_prompts_deprecated():
    raise HTTPException(status_code=410, detail=npc_service.DEPRECATED_PROMPT_HINT)


@router.get("/review-prompt")
def get_review_prompt(current_user: User = Depends(get_current_user)):
    """读取审核 NPC 提示词（登录即可；文件为唯一可信源，管理面板可编辑）。"""
    from ..services import npc_file_service
    return {"content": npc_file_service.get_review_npc_prompt()}


@router.get("/scripts/search")
def search_scripts(
    keyword: str = Query(""), category: str = Query(""),
    tags: str = Query(""), sort: str = Query("popular"),
    min_likes: int = Query(0), max_likes: Optional[int] = None,
    min_dislikes: int = Query(0), max_dislikes: Optional[int] = None,
    limit: int = Query(5), current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    """NPC 搜索剧本：支持关键词/分类/标签/点赞区间筛选/排序。"""
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []
    scripts = npc_service.search_scripts(
        db, keyword=keyword, category=category, sort=sort, tags=tag_list,
        min_likes=min_likes, max_likes=max_likes,
        min_dislikes=min_dislikes, max_dislikes=max_dislikes, limit=limit,
    )
    return {"scripts": scripts}


@router.get("/user/{user_id}/works")
def npc_user_works(user_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """NPC 读取某用户全部作品。"""
    if not _can_access_user(current_user, user_id):
        raise HTTPException(status_code=403, detail="无权访问该用户数据")
    return {"works": npc_service.user_works(db, user_id)}


@router.get("/user/{user_id}/subscriptions")
def npc_user_subscriptions(user_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """NPC 读取某用户订阅列表。"""
    if not _can_access_user(current_user, user_id):
        raise HTTPException(status_code=403, detail="无权访问该用户数据")
    return {"subscriptions": npc_service.user_subscriptions(db, user_id)}


@router.get("/user/{user_id}/reviews")
def npc_user_reviews(user_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """NPC 读取某用户处于审核流程中的作品（含 AI 初审结果）。"""
    if not _can_access_user(current_user, user_id):
        raise HTTPException(status_code=403, detail="无权访问该用户数据")
    return {"reviews": npc_service.user_reviews(db, user_id)}


@router.get("/review/pending")
def npc_review_pending(_: User = Depends(require_admin_or_station_master), db: Session = Depends(get_db)):
    """NPC（站长/管理员）读取待审核队列。"""
    return {"scripts": npc_service.review_pending(db)}


@router.get("/tags")
def npc_tags(keyword: str = Query(""), db: Session = Depends(get_db)):
    """NPC 获取剧本标签列表：默认按热度返回前 20 条；带 keyword 时搜索筛选并返回前 10 条。"""
    return {"tags": npc_service.search_tags(db, keyword)}


@router.get("/scripts/{script_id}/reviews")
def script_reviews(script_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # 评论区已关闭（网站审核要求），NPC 评价查询返回空列表
    return {"comments": []}


@router.get("/scripts/{script_id}")
def npc_script_detail(
    script_id: str,
    authorization: str | None = Header(None),
    x_host_token: str | None = Header(None),
    current_user: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
):
    """NPC 获取单个剧本内容。

    **汤底与条件表不是无条件下发的**（契约 §10.1）。原来这里注释写「保密交给提示词约束」，
    可这个接口是公开的、还支持按标题模糊匹配——等于不带任何凭证、输「跳楼」就能把
    《跳楼的女人》的汤底捞走。现在改为服务端判权：

      - 公开字段（标题/类型/难度/标签/简介/谜面）：任何人可读，搜索联想度一点不减；
      - **条件表**（结束条件 + 胜利/失败条件 + 任务表）：给
        ①该剧本的作者/管理员/站长，或 ②手上有一张这一场的有效主持证，
        或 ③登录了且在这个剧本上有未结束的会话。浏览器要靠它判定「识破了没有」；
      - **汤底正文 + 主持指导词**：**对浏览器一律不下发**。
        它只在服务端拼提示词（`POST /api/host/context`）时用得到。
        正常游玩的人（不翻前端源码、不抓包）碰不到它。

    一句话：**拿汤底的钥匙是「服务端正在主持这一场」，不是「登录过」，也不再是「拿得到条件表」。**"""
    from ..services import host_session_service
    # 主持证既可能在 Authorization（纯第三方主持人，没有玩家身份），
    # 也可能在 X-Host-Token（玩家自己的浏览器：Authorization 已被长期钥匙占着）。
    raw = host_session_service.raw_from_headers(authorization, x_host_token)

    def _can_full(script):
        return host_session_service.has_script_access(
            db, script.id, user=current_user, raw_token=raw)

    d = npc_service.get_script(db, script_id, current_user, can_full=_can_full)
    if d is None:
        raise HTTPException(status_code=404, detail="剧本不存在或无权访问")
    return {"script": d}


@router.get("/user/{user_id}/info")
def user_info(user_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """查询用户信息。仅本人或站长/管理员可查；且非特权查询仅返回用户名，不泄露角色。"""
    if not (str(current_user.id) == str(user_id) or current_user.role in ("admin", "owner", "station_master")):
        raise HTTPException(status_code=403, detail="无权查询该用户信息")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        from fastapi import HTTPException
        raise HTTPException(404, "用户不存在")
    privileged = current_user.role in ("admin", "owner", "station_master")
    result = {"username": user.username}
    if privileged:
        result["role"] = user.role
    return result


@router.post("/report-refusal")
def report_refusal(req: dict, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return npc_service.report_refusal(db, user, req.get("npc_id", ""), req.get("reason", ""), req.get("chat_log"))


@router.get("/check-ban")
def check_ban(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return npc_service.check_ban(db, user)


@router.get("/refusal-reports")
def refusal_reports(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    from ..models.npc import NpcRefusalReport
    reports = db.query(NpcRefusalReport).order_by(NpcRefusalReport.created_at.desc()).limit(50).all()
    return [
        {
            "id": r.id, "user_id": r.user_id, "npc_id": r.npc_id,
            "reason": r.reason, "status": r.status,
            "ban_until": r.ban_until.strftime("%Y-%m-%d %H:%M:%S") if r.ban_until else "",
            "created_at": r.created_at.strftime("%Y-%m-%d %H:%M:%S") if r.created_at else "",
        }
        for r in reports
    ]


@router.get("/trend")
def npc_trend(keyword: str = Query(""), category: str = Query(""),
              current_user: User | None = Depends(get_optional_user), db: Session = Depends(get_db)):
    """NPC 查询热梗/问好资源库（按需 RAG 式，改善回复鲜活度）。

    按 keyword 模糊匹配条目关键词或内容，仅返回启用的条目；
    无 keyword 时按 category 返回该分类条目（最多 10 条）。"""
    from sqlalchemy import or_
    q = db.query(TrendItem).filter(TrendItem.enabled == True)
    kw = (keyword or "").strip()
    if kw:
        like = f"%{kw}%"
        q = q.filter(or_(TrendItem.keyword.like(like), TrendItem.content.like(like)))
    if category:
        q = q.filter(TrendItem.category == category)
    items = q.order_by(TrendItem.updated_at.desc()).limit(10).all()
    return {"items": [it.to_dict() for it in items]}
