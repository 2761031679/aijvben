"""AI剧本网 HTTP 客户端 —— 整个插件唯一与站点通信的地方。

设计约束（来自任务规格，改动前先想清楚）：

- 只走 HTTP。不 import 站点后端、不读 SQLite、不假设与站点同机。这样插件既能连
  线上 https://jvben.cn，也能连本机 `uvicorn backend.main:app --port 8092`。
- 主持证（X-Host-Token）与用户凭证（Authorization）严格分两个头。原因见 README
  「为什么主持证不能塞进 Authorization」：后端解析主持证时会顺手把 Authorization
  里的值当候选，形状不符就丢弃，混用会静默失效。
- 所有失败都抛 AijubenError，带 status / code / message / hint 四件套。hint 是给
  **AI 读的**处置建议，不是给人看的日志——工具返回错误时 AI 会照着 hint 决定下一步。
"""
from __future__ import annotations

import contextvars
import logging
from typing import Any

import httpx

from .auth import DEFAULT_BASE_URL

LOG = logging.getLogger("aijuben_mcp.api")

DEFAULT_TIMEOUT = 15.0
# 拼上下文要读剧本+条件+任务+玩家档案，实测 1~2 秒，给宽一点
CONTEXT_TIMEOUT = 30.0

# 契约 §9.3 的错误码 -> 给 AI 的处置建议（写清楚"下一步做什么"，别只说"出错了"）
ERROR_HINTS: dict[str, str] = {
    "no_actor": "没有身份或凭证失效。检查 AIJUBEN_TOKEN 环境变量 / ~/.aijuben/token 文件；"
                "门票过期就去站点重新签发一张。不要用假 token 反复重试。",
    "capability_denied": "这把凭证没有该能力（scopes 不够），或者这场不是它主持的。"
                         "换一张有对应能力的门票，或者用开房时的那个凭证继续。重试无用。",
    "host_token_expired": "这一场已经结束了（或主持证超过 4 小时上限）。本地会话状态已失效："
                          "需要继续就重新 start_session 开一场，不要在旧 session_id 上重试。",
    "session_phase_conflict": "相位不对。合法顺序是 hosting -> settling（begin_settling）"
                              "-> narrated（mark_narrated）-> ended（end_session）。"
                              "先调 session_status 看当前 phase 再决定下一步，别跳步。",
    "session_not_idle": "还没到『安静超时』（默认 5 分钟无心跳），不能用 timeout 收场。"
                        "玩家中途不玩了就改用 reason=aborted。",
    "session_busy": "同一主持证上一条请求还在处理（后端有轮次锁）。等一两秒再发，别并发写。",
    "script_not_approved": "这本剧本没过审，不能开体验场。换一本已通过审核的剧本（list_scripts 可查 review_status）。",
    "script_not_found": "剧本不存在、已下架，或（未过审的剧本）你不是作者/管理员。核对 script_id。",
    "session_not_found": "session_id 不存在或不是你的。用 session_status 确认，或重新开一场。",
    "contract_mismatch": "契约版本对不上：插件与站点的 aijuben.context 版本不一致。"
                         "升级插件或站点，不要改 contract 字段硬试。",
    "rate_limited": "触发限流（开房次数上限 / 每分钟请求数）。等一会儿再试；"
                    "开房上限是每天的，循环重试只会继续被拒。",
    "quota_exhausted": "额度用尽（可能是开房次数或会员额度）。等额度恢复或换账号，重试无用。",
    "invalid_request": "请求参数不合法。按错误里的 message 改参数（比如 id 不是合法 uuid、page_size 越界）。",
    "network_error": "连不上站点。确认 base_url 正确、网络可用；本机调试时确认后端已启动在 8092。",
    "server_error": "站点内部错误（5xx）。这不是你参数的问题，等一会儿再试；连续失败就报给用户。",
}

# 老端点只回中文人话时，按 HTTP 状态兜底成一个码，让 AI 至少有 hint 可依
STATUS_FALLBACK: dict[int, str] = {
    400: "invalid_request",
    401: "no_actor",
    403: "capability_denied",
    404: "not_found",
    409: "conflict",
    410: "host_token_expired",
    422: "invalid_request",
    429: "rate_limited",
    500: "server_error",
    502: "server_error",
    503: "server_error",
    504: "server_error",
}


# 当前正在执行的工具名。由 tools/__init__.py 的 tool_guard 在调用前后设置，
# 于是 17 个工具不用各自记得传参，`X-MCP-Tool` 也不会漏（审计 S2）。
current_tool: contextvars.ContextVar[str] = contextvars.ContextVar("current_tool", default="")


class AijubenError(Exception):
    """一次失败的站点调用。status=0 表示请求根本没发出去（网络问题）。"""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        detail: Any = None,
        method: str | None = None,
        path: str | None = None,
    ) -> None:
        self.status = status
        self.code = code
        self.message = message
        self.detail = detail
        self.method = method
        self.path = path
        super().__init__(f"[{status} {code}] {message}")

    @property
    def hint(self) -> str:
        return ERROR_HINTS.get(self.code) or ERROR_HINTS.get(
            STATUS_FALLBACK.get(self.status, ""), ""
        )

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "status": self.status,
            "code": self.code,
            "message": self.message,
        }
        if self.hint:
            payload["hint"] = self.hint
        if self.method and self.path:
            payload["request"] = f"{self.method} {self.path}"
        if self.detail not in (None, "", {}, []):
            payload["detail"] = self.detail
        return payload


def _error_from_response(response: httpx.Response, method: str, path: str) -> AijubenError:
    """把后端两种错误形状（`{detail:{code,message}}` 与 `{detail:"人话"}`）归一化。"""
    status = response.status_code
    code = STATUS_FALLBACK.get(status, "http_error")
    message = ""
    detail: Any = None
    try:
        body = response.json()
    except ValueError:
        body = None

    if isinstance(body, dict):
        raw_detail = body.get("detail")
        if isinstance(raw_detail, dict):
            code = str(raw_detail.get("code") or code)
            message = str(raw_detail.get("message") or raw_detail.get("msg") or "")
            detail = raw_detail or None
        elif isinstance(raw_detail, str):
            message = raw_detail
        elif isinstance(raw_detail, list):
            # FastAPI 参数校验失败是 list[dict]
            message = "；".join(
                str(item.get("msg", item)) if isinstance(item, dict) else str(item)
                for item in raw_detail[:3]
            ) or "参数校验失败"
            detail = raw_detail
        elif body.get("code"):
            code = str(body.get("code"))
            message = str(body.get("message") or "")
            detail = body
    elif isinstance(body, str):
        message = body
    if not message:
        # 429 来自 RateLimitMiddleware，回的是纯文本
        text = (response.text or "").strip()
        message = text[:300] if text else f"HTTP {status}"
    return AijubenError(status, code, message, detail=detail, method=method, path=path)


class ApiClient:
    """一个 base_url + 一把凭证的 HTTP 客户端。http 连接懒建、复用、可显式关闭。"""

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        client_ip: str | None = None,
    ) -> None:
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.token = token or None
        self.timeout = timeout
        # 仅自检用：站点按 IP 限流（30 请求/10 秒），自检和别人的测试共用 127.0.0.1
        # 会互相挤爆桶。站点读 X-Real-IP，自检带一个 TEST-NET-3 地址就把额度隔开。
        self.client_ip = client_ip or None
        self._client: httpx.AsyncClient | None = None

    # ---------- 基础设施 ----------

    @property
    def has_token(self) -> bool:
        return bool(self.token)

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout,
                follow_redirects=True,
                headers={
                    "Accept": "application/json",
                    "User-Agent": "aijuben-mcp/0.1.0",
                    **({"X-Real-IP": self.client_ip} if self.client_ip else {}),
                },
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    def with_token(self, token: str | None, *, timeout: float | None = None) -> "ApiClient":
        """派生一个换凭证的客户端（selftest 用它从 JWT 切到门票）。"""
        return ApiClient(self.base_url, token, timeout=timeout or self.timeout,
                         client_ip=self.client_ip)

    async def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: dict[str, Any] | None = None,
        host_token: str | None = None,
        timeout: float | None = None,
        auth: bool = True,
        tool: str | None = None,
    ) -> Any:
        """发一次请求，成功返回解析后的 JSON（或纯文本），失败抛 AijubenError。

        `tool`：把「这次是哪个工具在调」带给服务端（`X-MCP-Tool`），落进
        `access_logs.detail`。没有它，17 个工具在审计日志里长得一模一样（审计 S2）。
        """
        headers: dict[str, str] = {}
        tool_name = tool or current_tool.get()
        if tool_name:
            headers["X-MCP-Tool"] = str(tool_name)[:40]
        if auth and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if host_token:
            # 主持证只走这个头；混进 Authorization 会被后端判成"形状不符"而丢弃
            headers["X-Host-Token"] = host_token
        if json_body is not None:
            headers["Content-Type"] = "application/json"

        client = self._ensure_client()
        try:
            response = await client.request(
                method.upper(),
                path,
                json=json_body,
                params={k: v for k, v in (params or {}).items() if v is not None},
                headers=headers,
                timeout=timeout or self.timeout,
            )
        except httpx.TimeoutException as exc:
            raise AijubenError(
                0, "network_error", f"请求超时（{timeout or self.timeout:.0f}s）：{path}",
                detail=str(exc), method=method, path=path,
            ) from exc
        except httpx.HTTPError as exc:
            raise AijubenError(
                0, "network_error", f"连接 {self.base_url} 失败：{exc}",
                method=method, path=path,
            ) from exc

        if response.status_code >= 400:
            raise _error_from_response(response, method.upper(), path)

        if not response.content:
            return None
        content_type = response.headers.get("content-type", "")
        if "json" in content_type:
            try:
                return response.json()
            except ValueError:
                return response.text
        text = response.text
        try:
            return response.json()
        except ValueError:
            return text

    # ---------- 只读：剧本 / 标签 / NPC ----------

    async def list_scripts(
        self,
        *,
        page: int = 1,
        page_size: int = 12,
        category: str | None = None,
        tag: str | None = None,
        sort: str | None = None,
        keyword: str | None = None,
        tags: str | None = None,
        review_status: str | None = None,
        min_likes: int | None = None,
    ) -> dict[str, Any]:
        """分页浏览剧本（GET /api/scripts）。"""
        return await self.request(
            "GET",
            "/api/scripts",
            params={
                "page": page,
                "page_size": page_size,
                "category": category,
                "tag": tag,
                "sort": sort,
                "keyword": keyword,
                "tags": tags,
                "review_status": review_status,
                "min_likes": min_likes,
            },
        )

    async def get_script(self, script_id: str) -> dict[str, Any]:
        """读单本剧本全文（GET /api/scripts/{id}）。未过审的只有作者/管理员看得到。"""
        return await self.request("GET", f"/api/scripts/{script_id}")

    async def search_scripts(
        self,
        *,
        keyword: str | None = None,
        category: str | None = None,
        tags: str | None = None,
        sort: str | None = None,
        min_likes: int | None = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        """搜索（GET /api/scripts/search）——独立端点，不是 /api/scripts 的参数。"""
        return await self.request(
            "GET",
            "/api/scripts/search",
            params={
                "keyword": keyword,
                "category": category,
                "tags": tags,
                "sort": sort,
                "min_likes": min_likes,
                "limit": limit,
            },
        )

    async def list_tags(self, keyword: str | None = None) -> dict[str, Any]:
        """标签榜（GET /api/npc/tags）；按点赞数排序，用来找热门题材。"""
        return await self.request("GET", "/api/npc/tags", params={"keyword": keyword})

    async def list_npcs(self) -> dict[str, Any]:
        """NPC 清单与配置（GET /api/admin/npc-configs，公开无鉴权）。"""
        return await self.request("GET", "/api/admin/npc-configs")

    # ---------- 只读：当前用户 ----------

    async def my_profile(self) -> dict[str, Any]:
        return await self.request("GET", "/api/user/profile")

    async def my_stats(self) -> dict[str, Any]:
        return await self.request("GET", "/api/user/stats")

    async def my_scripts(self) -> Any:
        """我发布的剧本（GET /api/scripts/mine/list）——回裸数组。"""
        return await self.request("GET", "/api/scripts/mine/list")

    async def my_subscriptions(self) -> Any:
        """我订阅的剧本（GET /api/user/subscriptions）——回裸数组。"""
        return await self.request("GET", "/api/user/subscriptions")

    # ---------- 主持会话 ----------

    async def start_host_session(
        self, script_id: str, npc_id: str | None = None
    ) -> dict[str, Any]:
        """开一场（POST /api/host/session/start），返回 session_id + host_token。"""
        body: dict[str, Any] = {"script_id": script_id}
        if npc_id:
            body["npc_id"] = npc_id
        return await self.request("POST", "/api/host/session/start", json_body=body)

    async def build_context(
        self,
        *,
        state: str = "default",
        host_token: str | None = None,
        session_id: str | None = None,
        npc_id: str | None = None,
        contract: str | None = None,
        script_id: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """拼上下文（POST /api/host/context）。state=experience 时必须带主持证。"""
        body: dict[str, Any] = {"state": state}
        if session_id:
            body["session_id"] = session_id
        if npc_id:
            body["npc_id"] = npc_id
        if script_id:
            body["script_id"] = script_id
        if contract:
            body["contract"] = contract
        if extra:
            body.update({k: v for k, v in extra.items() if v is not None})
        return await self.request(
            "POST", "/api/host/context", json_body=body,
            host_token=host_token, timeout=CONTEXT_TIMEOUT,
        )

    async def heartbeat(self, session_id: str, host_token: str) -> dict[str, Any]:
        """续命（POST /api/host/session/{id}/heartbeat）。超过 5 分钟不心跳就算安静。"""
        return await self.request(
            "POST", f"/api/host/session/{session_id}/heartbeat",
            json_body={}, host_token=host_token,
        )

    async def begin_settling(self, session_id: str, host_token: str) -> dict[str, Any]:
        """进入结算（POST /api/host/session/{id}/settling）；幂等。"""
        return await self.request(
            "POST", f"/api/host/session/{session_id}/settling",
            json_body={}, host_token=host_token,
        )

    async def mark_narrated(self, session_id: str, host_token: str) -> dict[str, Any]:
        """标记汤底已讲完（POST /api/host/session/{id}/narrated）；必须在 settling 之后。"""
        return await self.request(
            "POST", f"/api/host/session/{session_id}/narrated",
            json_body={}, host_token=host_token,
        )

    async def end_host_session(
        self, session_id: str, host_token: str, reason: str = "settled"
    ) -> dict[str, Any]:
        """收场（POST /api/host/session/end）。reason: settled / aborted / timeout。"""
        return await self.request(
            "POST", "/api/host/session/end",
            json_body={"session_id": session_id, "reason": reason}, host_token=host_token,
        )

    async def host_status(self, host_token: str | None = None) -> dict[str, Any]:
        """探活（GET /api/host/status）。不带证只回 alive + server_time。"""
        return await self.request("GET", "/api/host/status", host_token=host_token)

    async def get_host_session(
        self, session_id: str, host_token: str | None = None
    ) -> dict[str, Any]:
        """读快照（GET /api/host/session/{id}）：相位、线索/物证、条件与任务计数。"""
        return await self.request(
            "GET", f"/api/host/session/{session_id}", host_token=host_token
        )
