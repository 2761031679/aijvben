"""工具层公共设施：运行时客户端、错误兜底、返回格式。

三条约定，改工具时必须守住：

1. **返回一律是 JSON 文本串**。MCP 工具结果最终要进模型上下文，纯文本 JSON 最省事、
   不依赖任何客户端的结构化输出支持。
2. **错误不外抛，转成 `{"ok": false, "error": {...}}`**。抛异常在很多客户端里只会显示
   "tool failed"，AI 拿不到 code 和 hint 就没法自己纠错；我们宁可把错误也当结果返回。
3. **主持证（host_token）绝不回显**。它等价于这一场的主持权限，进了对话历史就等于泄露。
   工具只回 `host_token_stored: true`，真身留在进程内存里。
"""
from __future__ import annotations

import functools
import inspect
import json
import logging
from typing import Any, Callable

from ..api_client import ApiClient, AijubenError, current_tool
from ..auth import load_base_url, load_token, mask_token, token_kind

LOG = logging.getLogger("aijuben_mcp.tools")

_CLIENT: ApiClient | None = None
_TOKEN_SOURCE = "none"


def configure(
    base_url: str | None = None,
    token: str | None = None,
    *,
    client_ip: str | None = None,
) -> ApiClient:
    """启动时注入站点地址与凭证；重复调用会重建客户端（selftest 用得上）。"""
    global _CLIENT, _TOKEN_SOURCE
    resolved_token = load_token(token)
    _TOKEN_SOURCE = "arg" if token else ("env" if resolved_token else "none")
    if not token:
        from ..auth import token_source

        _TOKEN_SOURCE = token_source(None)
    _CLIENT = ApiClient(load_base_url(base_url), resolved_token, client_ip=client_ip)
    LOG.info(
        "客户端就绪 base_url=%s 凭证=%s(%s) 来源=%s",
        _CLIENT.base_url, mask_token(resolved_token), token_kind(resolved_token), _TOKEN_SOURCE,
    )
    return _CLIENT


def get_client() -> ApiClient:
    """拿当前客户端；没配置过就按环境变量/凭证文件自动配一次。"""
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = configure()
    return _CLIENT


def token_info() -> dict[str, Any]:
    """凭证概况（脱敏），给 doctor 和错误提示用。"""
    client = get_client()
    return {
        "configured": client.has_token,
        "kind": token_kind(client.token),
        "masked": mask_token(client.token),
        "source": _TOKEN_SOURCE,
        "base_url": client.base_url,
    }


def dumps(payload: Any) -> str:
    """统一序列化：中文不转义（工具返回是给人/模型读的，不是给机器解析的）。"""
    return json.dumps(payload, ensure_ascii=False, indent=2, default=str)


def fail(error: AijubenError) -> str:
    return dumps({"ok": False, "error": error.to_payload()})


def tool_guard(fn: Callable[..., Any]) -> Callable[..., Any]:
    """把异常折成可读结果，同时保住原签名（MCP 靠签名生成参数 schema）。"""
    signature = inspect.signature(fn)

    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> str:
        # 让 api_client 知道这次是哪个工具在调（`X-MCP-Tool` -> access_logs.detail）。
        # 放在唯一的这个装饰器里，是为了不靠 17 个工具各自记得传参（审计 S2：漏一个就等于没记）。
        _token = current_tool.set(fn.__name__)
        try:
            return await fn(*args, **kwargs)
        except AijubenError as exc:
            LOG.warning("工具 %s 失败：%s", fn.__name__, exc)
            return fail(exc)
        except Exception as exc:  # 插件自身 bug：也要把现场交出去，别静默
            LOG.exception("工具 %s 崩了", fn.__name__)
            return dumps(
                {
                    "ok": False,
                    "error": {
                        "status": 0,
                        "code": "internal_error",
                        "message": f"{type(exc).__name__}: {exc}",
                        "hint": "这是插件自身的问题，不是站点拒绝。把 message 原文报给用户，"
                                "不要靠改参数反复重试。",
                    },
                }
            )
        finally:
            current_tool.reset(_token)

    wrapper.__signature__ = signature  # type: ignore[attr-defined]
    wrapper.__annotations__ = {**getattr(fn, "__annotations__", {}), "return": str}
    return wrapper


def script_summary(item: dict[str, Any], *, synopsis_chars: int = 160) -> dict[str, Any]:
    """列表项瘦身：列表页只给决策需要的字段，全文用 get_script 单独取。

    站点列表接口会把 story/synopsis 全文一起回，三条剧本就上千字——AI 只是要挑一本，
    没必要占上下文。这里保留筛选字段 + 截断简介。
    """
    synopsis = (item.get("synopsis") or "").strip().replace("\n", " ")
    if len(synopsis) > synopsis_chars:
        synopsis = synopsis[:synopsis_chars] + "…"
    return {
        "id": item.get("id"),
        "title": item.get("title"),
        "author": item.get("author"),
        "category": item.get("category"),
        "tags": item.get("tags"),
        "difficulty": item.get("difficulty"),
        "version": item.get("version"),
        "likes": item.get("likes"),
        "dislikes": item.get("dislikes"),
        "avg_rating": item.get("avg_rating"),
        "rating_count": item.get("rating_count"),
        "downloads_count": item.get("downloads_count"),
        "review_status": item.get("review_status"),
        "published_at": item.get("published_at"),
        "created_at": item.get("created_at"),
        "synopsis": synopsis,
    }
