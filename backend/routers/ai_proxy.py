"""AI 代理转发路由（/api/ai/proxy）。

用途：部分 AI provider（如火山引擎/豆包）的端点不允许浏览器跨域直连，
前端直连失败（Failed to fetch）时自动降级到本代理转发。

安全约束：
- 仅转发白名单内的 provider 端点，不接受任意 URL（防开放代理滥用）；
- 用户的 API Key 通过 X-AI-Key 请求头透传，服务器不存储、不记录；
- 不跟随上游重定向（urllib 默认会把 Authorization 一起带到重定向目标去，见 _NoRedirect）；
- 匿名调用按 IP 记日配额（key 仍是调用方自己的，所以不能改成必须登录，但也不能免鉴权无限用）；
- 消息角色名已由前端按 provider 归一化（四家均为 OpenAI 兼容小写角色名），本代理原样透传。
"""
import datetime
import json
import logging
import os
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.security import get_optional_user
from ..models.user import User

logger = logging.getLogger("ai_proxy")

router = APIRouter(prefix="/api/ai", tags=["ai"])

# 端点内置默认值（JSON 配置加载失败时的回退）
_PROVIDER_URLS_FALLBACK = {
    "deepseek": "https://api.deepseek.com/v1/chat/completions",
    "minimax": "https://api.minimaxi.com/v1/text/chatcompletion_v2",
    "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    "volcengine": "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
}

# 模型/端点单一数据源：frontend/config/ai_models.json（前后端共用，更新模型只改这一个文件）
_MODELS_CONFIG = Path(__file__).resolve().parent.parent.parent / "frontend" / "config" / "ai_models.json"


def _load_provider_urls() -> dict:
    """从 ai_models.json 读取端点白名单；失败时回退内置默认值。"""
    try:
        data = json.loads(_MODELS_CONFIG.read_text(encoding="utf-8"))
        urls = {
            p: cfg["url"]
            for p, cfg in data.get("providers", {}).items()
            if isinstance(cfg, dict) and cfg.get("url")
        }
        return urls or _PROVIDER_URLS_FALLBACK
    except Exception as e:
        logger.warning("模型配置加载失败，使用内置端点: %s", e)
        return _PROVIDER_URLS_FALLBACK


# 与前端 shared/ai_client.js 的 ENDPOINTS 保持一致（白名单）
PROVIDER_URLS = _load_provider_urls()

# 原来 120 秒。这个接口是同步 def（阻塞在 urllib 上、占线程池里一个线程），
# 一次卡满 120 秒等于一个线程白养两分钟，匿名调用方随手就能把线程池占满；
# 一次 chat/completions 30 秒足够，超时就让它失败。
_TIMEOUT = 30
_MAX_PAYLOAD = 512 * 1024  # 请求体上限，防滥用

# 匿名（未登录）调用方的每日额度。为什么不干脆要求登录：这个接口存在的理由就是
# 「浏览器跨域直连失败时降级到服务端转发」，key 始终是调用方自己的 X-AI-Key，
# 游客自带 key 的免费通道就靠它，改成必须登录会直接掐掉那条路。
# 但也不能不设限：它免鉴权、免 CORS 地把白名单端点当跳板用，等于给外人一个免费中继。
# 所以只给匿名调用按 IP 记日配额（落库，见 guest_counter_service），登录用户按原样放行。
_ANON_DAILY_LIMIT = int(os.environ.get("AI_PROXY_ANON_DAILY_LIMIT", "50"))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """拒绝跟随重定向。

    urllib 默认会跟 301/302/303/307/308，而且**把原请求头原样带过去** ——
    也就是把 `Authorization: Bearer <用户的 X-AI-Key>` 送到重定向目标。
    白名单只约束第一跳，第二跳落到谁手里没人管得着（provider 端点配错、域名被接管都够用），
    用户的 key 就这么漏了。redirect_request 返回 None = 不跟，3xx 会以 HTTPError 抛出，
    由下面的 except 分支显式拒绝并说明原因。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _client_ip(request: Request) -> str:
    """真实客户端 IP：经 Nginx 反代后 request.client.host 恒为 127.0.0.1（与限流中间件同一口径）。"""
    return (request.headers.get("X-Real-IP")
            or (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
            or (request.client.host if request.client else ""))


def _today() -> str:
    """站点日期串（北京时间），把匿名配额按天分窗 —— 不用加表、不用定时清零。"""
    return (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).strftime("%Y-%m-%d")


class ProxyRequest(BaseModel):
    provider: str
    model: str
    messages: list[dict]
    max_tokens: int = Field(default=1024, ge=1, le=8192)
    temperature: float = Field(default=0.8, ge=0, le=2)


@router.post("/proxy")
def ai_proxy(body: ProxyRequest, request: Request,
             db: Session = Depends(get_db), user: User | None = Depends(get_optional_user)):
    """透传 OpenAI 兼容 /chat/completions 请求到白名单 provider。
    已登录用户：从响应体提取 token 消耗计入统计（v4.6c；尽力而为，失败不影响返回）。"""
    url = PROVIDER_URLS.get(body.provider)
    if not url:
        raise HTTPException(status_code=400, detail=f"不支持的 provider: {body.provider}")
    api_key = (request.headers.get("X-AI-Key") or "").strip()
    if not api_key:
        raise HTTPException(status_code=400, detail="缺少 API Key（X-AI-Key 请求头）")

    payload = json.dumps({
        "model": body.model,
        "messages": body.messages,
        "max_tokens": body.max_tokens,
        "temperature": body.temperature,
    }, ensure_ascii=False).encode("utf-8")
    if len(payload) > _MAX_PAYLOAD:
        raise HTTPException(status_code=413, detail="请求体过大")

    # 匿名调用扣日配额。刻意放在「参数校验都过了」之后：400/413 这类请求不该白扣额度，
    # 否则一个写错 provider 的前端就自己把额度烧光了。
    if user is None:
        from ..services import guest_counter_service
        guest_counter_service.purge_old_scopes(db, "ai_proxy")   # 旧日期窗口顺手清掉，否则表只涨不减
        # subject_for 只认 request.client.host，反代后那是 127.0.0.1，所有匿名用户会挤进
        # 同一个主体、共用一份额度；这里还原真实 IP 再套个最小壳子喂进去
        # （不改 subject_for 的公共语义，那边还有别的调用方）。
        subject = guest_counter_service.subject_for(
            SimpleNamespace(client=SimpleNamespace(host=_client_ip(request))), None)
        used, ok = guest_counter_service.bump(
            db, "ai_proxy:%s" % _today(), subject, limit=_ANON_DAILY_LIMIT)
        if not ok:
            raise HTTPException(
                status_code=429,
                detail="未登录使用 AI 代理的今日额度已用完（%d/%d），登录后可继续" % (used, _ANON_DAILY_LIMIT))

    req = urllib.request.Request(
        url, data=payload, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with _OPENER.open(req, timeout=_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # 3xx 一律拒绝：跟过去就会把用户的 X-AI-Key 送到重定向目标（见 _NoRedirect）。
        # 只记 Location 不记请求头，日志里不能出现 key。
        if e.code in (301, 302, 303, 307, 308):
            loc = (e.headers or {}).get("Location", "")
            logger.warning("AI 代理拒绝跟随重定向 provider=%s status=%s location=%s",
                           body.provider, e.code, loc)
            raise HTTPException(status_code=502,
                                detail="上游返回重定向，代理已拒绝跟随（避免 API Key 被送往其他域）")
        # 透传上游真实错误（400/401/404/429 等），便于前端回显定位
        detail = ""
        try:
            detail = e.read().decode("utf-8", errors="ignore")[:800]
        except Exception:
            pass
        logger.warning("AI 代理上游错误 provider=%s status=%s", body.provider, e.code)
        raise HTTPException(status_code=e.code, detail=f"上游 AI 错误: {detail or e.reason}")
    except Exception as e:
        logger.error("AI 代理转发失败 provider=%s: %s", body.provider, e)
        raise HTTPException(status_code=502, detail=f"代理转发失败: {e}")

    # 统计：代理链路直接从响应体提取 token 消耗（直连链路由前端上报，二者互斥不重复计数）
    try:
        if user:
            usage = data.get("usage") or {}
            total = int(usage.get("total_tokens") or 0)
            if total <= 0:
                total = int(usage.get("prompt_tokens") or 0) + int(usage.get("completion_tokens") or 0)
            if total > 0:
                from ..services import stats_service
                stats_service.add_tokens(db, str(user.id), total)
    except Exception:
        pass

    return data
