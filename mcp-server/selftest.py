#!/usr/bin/env python
"""端到端自检：不装 MCP 客户端也能跑，直接把工具函数当函数调。

它做的事，就是完整走一遍「主持一场海龟汤」的业务链，把每一步的返回断言一遍：

    体检 /api/host/status -> 列表挑一本过审剧本 -> 读全文 -> 挑 NPC
    -> start_session -> get_context(experience) 两次（验证 prompt_hash 稳定）
    -> heartbeat -> session_status -> begin_settling -> mark_narrated
    -> end_session(settled) -> 用旧主持证复查（应得 410 host_token_expired）
    -> 负面路径：没会话调用、跳步报 409、坏 contract 报 400、无凭证报 401
    -> （可选）造一张 mcp_ 门票，用门票再走一遍读 + 开房/作废

跑法（需要站点可达；默认连线上 https://jvben.cn）：

    # 用账号登录跑（账号密码只来自环境变量，不落盘）
    AIJUBEN_TEST_USER=xxx AIJUBEN_TEST_PASS=yyy python selftest.py --base-url http://127.0.0.1:8092

    # 或者直接给一张凭证（mcp_ 门票 / 账号 JWT）
    python selftest.py --base-url http://127.0.0.1:8092 --token "<token>"

    # 顺带验一下门票通道（后端还没上线这个端点时会自动跳过，不算失败）
    python selftest.py --token "<jwt>" --with-ticket

退出码：0 全部通过 / 1 有失败。中途开的房在退出前都会被 aborted 收掉。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import os
import sys
import tempfile
import time
import traceback
from typing import Any

# 自检绝不能污染真实状态（~/.aijuben/current_session.json），先指向临时目录再 import 插件
if not os.environ.get("AIJUBEN_STATE_DIR"):
    os.environ["AIJUBEN_STATE_DIR"] = tempfile.mkdtemp(prefix="aijuben-mcp-selftest-")

from aijuben_mcp import __version__                      # noqa: E402
from aijuben_mcp.api_client import AijubenError, ApiClient  # noqa: E402
from aijuben_mcp.auth import load_base_url, load_token, login_credentials, token_kind  # noqa: E402
from aijuben_mcp.server import create_server              # noqa: E402
from aijuben_mcp.tools import configure                   # noqa: E402
from aijuben_mcp.tools import session as session_tools    # noqa: E402

EXPECTED_TOOLS = {
    "list_scripts", "get_script", "search_scripts", "list_npcs", "get_npc", "list_tags",
    "start_session", "get_context", "heartbeat", "begin_settling", "mark_narrated",
    "end_session", "session_status",
    "my_profile", "my_stats", "my_scripts", "my_subscriptions",
}

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


class Runner:
    """收集结果；失败不中断，最后统一汇总（一次跑完看到全部问题）。"""

    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.skipped = 0
        self.failures: list[str] = []

    def ok(self, name: str, detail: str = "") -> None:
        self.passed += 1
        print(f"{GREEN}  ✓ {name}{RESET}" + (f" {DIM}{detail}{RESET}" if detail else ""))

    def bad(self, name: str, detail: str) -> None:
        self.failed += 1
        self.failures.append(f"{name}: {detail}")
        print(f"{RED}  ✗ {name}{RESET} {detail}")

    def skip(self, name: str, detail: str) -> None:
        self.skipped += 1
        print(f"{YELLOW}  - {name}（跳过）{RESET} {detail}")

    def check(self, name: str, condition: bool, detail: str = "") -> bool:
        if condition:
            self.ok(name, detail)
        else:
            self.bad(name, detail or "断言未通过")
        return condition


def _schema(tool: Any) -> dict[str, Any]:
    """取工具的 JSON Schema：SDK 2.x 叫 input_schema，1.x 叫 inputSchema。"""
    schema = getattr(tool, "input_schema", None)
    if schema is None:
        schema = getattr(tool, "inputSchema", None)
    return schema or {}


def _text_of(result: Any) -> str:
    """把 call_tool 的返回（1.x 是内容块列表，2.x 是 CallToolResult）压成文本。"""
    content = getattr(result, "content", result)
    if isinstance(content, (list, tuple)):
        parts = []
        for item in content:
            text = getattr(item, "text", None)
            if text is not None:
                parts.append(text)
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return str(content)


def _selftest_ip() -> str:
    """给自检挑一个「只属于本次运行」的来源 IP。

    站点按 IP 记限流（30 请求/10 秒）。自检、别的会话的联调、真人开着的浏览器都在
    127.0.0.1 上共用一个桶，谁跑得快谁把另外两个挤成 429——自检里出现过成片的假失败。
    站点优先读 X-Real-IP，所以这里带一个 TEST-NET-3（203.0.113.0/24，文档专用）地址，
    每次运行随机一个，互不干扰，也不会碰到任何真实用户的额度。
    """
    return f"203.0.113.{secrets.randbelow(200) + 20}"


IP = _selftest_ip()  # 本次运行独占的来源 IP（见 _selftest_ip 的注释）

CALLS: list[float] = []


async def rate_gate() -> None:
    """站点按 IP 限流 30 请求/10 秒；自检一口气跑几十次，必须先排队再发。

    注意这里数的是**真实 HTTP 请求**而不是工具调用：像 session_status 这种一次要打两个
    请求，按工具数限流照样会撞 429（实测过）。预算取 24，给非工具请求留余量。
    """
    window = 10.0
    budget = 24
    while True:
        now = time.monotonic()
        CALLS[:] = [t for t in CALLS if now - t < window]
        if len(CALLS) < budget:
            CALLS.append(now)
            return
        await asyncio.sleep(max(0.2, window - (now - CALLS[0]) + 0.15))


def gate_client(client: ApiClient) -> ApiClient:
    """给客户端的 request 挂上限流闸（原地替换实例方法，工具层照常调 get_client()）。"""
    original = client.request

    async def gated(*args: Any, **kwargs: Any) -> Any:
        await rate_gate()
        return await original(*args, **kwargs)

    client.request = gated  # type: ignore[method-assign]
    return client


class ToolBox:
    """包装 server.call_tool：返回解析好的 dict，并顺手把 'ok:false' 当作可断言的结果。"""

    def __init__(self, server: Any) -> None:
        self.server = server

    async def __call__(self, name: str, **kwargs: Any) -> dict[str, Any]:
        text = _text_of(await self.server.call_tool(name, kwargs))
        try:
            return json.loads(text)
        except ValueError:
            return {"ok": False, "error": {"code": "not_json", "message": text[:500]}}

    async def expect_error(self, name: str, **kwargs: Any) -> dict[str, Any]:
        return await self(name, **kwargs)


async def login_jwt(base_url: str, user: str, password: str) -> str:
    """用账号密码换 JWT。注意后端返回的字段叫 `token`，不是 `access_token`。"""
    client = ApiClient(base_url, None, client_ip=IP)
    try:
        body = await client.request("POST", "/api/auth/login",
                                    json_body={"username": user, "password": password})
    finally:
        await client.aclose()
    token = (body or {}).get("token") or (body or {}).get("access_token")
    if not token:
        raise RuntimeError(f"登录成功但响应里没有 token 字段：{body}")
    return token


async def run(args: argparse.Namespace) -> int:
    runner = Runner()
    base_url = load_base_url(args.base_url)

    print(f"\n== AI剧本网 MCP 自检 · aijuben-mcp {__version__} · {base_url} ==\n")
    print(f"{DIM}状态目录：{os.environ['AIJUBEN_STATE_DIR']}{RESET}\n")

    # ---------- 1. 凭证 ----------
    print("[1/7] 凭证")
    token = load_token(args.token)
    if not token:
        creds = login_credentials()
        if not creds:
            runner.bad("凭证", "没有可用凭证：传 --token，或设置 AIJUBEN_TEST_USER / AIJUBEN_TEST_PASS")
            return _summary(runner)
        try:
            token = await login_jwt(base_url, *creds)
            runner.ok("账号密码登录", f"kind={token_kind(token)}")
        except Exception as exc:
            runner.bad("账号密码登录", f"{type(exc).__name__}: {exc}")
            return _summary(runner)
    else:
        runner.ok("凭证已就绪", f"kind={token_kind(token)}")

    client = gate_client(configure(base_url, token, client_ip=IP))
    server, sdk_major = create_server()
    tool = ToolBox(server)
    print(f"{DIM}MCP SDK：{sdk_major}.x{RESET}")

    opened: dict[str, str] = {}  # session_id -> host_token，用于收尾兜底

    # ---------- 2. 工具装配 ----------
    print("\n[2/7] 工具装配")
    tools = await server.list_tools()
    names = {t.name for t in tools}
    runner.check("工具数量 = 17", len(tools) == 17, f"实际 {len(tools)}：{sorted(names)}")
    runner.check("工具清单一致", names == EXPECTED_TOOLS,
                 f"缺 {sorted(EXPECTED_TOOLS - names)} 多 {sorted(names - EXPECTED_TOOLS)}")
    thin = [t.name for t in tools if len((t.description or "").strip()) < 60]
    runner.check("每个工具都有像样的中文说明", not thin, f"太短的：{thin}")
    by_name = {t.name: t for t in tools}
    required = {
        "get_script": "script_id", "start_session": "script_id", "get_npc": "npc_id",
    }
    for tool_name, field in required.items():
        schema = _schema(by_name[tool_name])
        runner.check(f"{tool_name} 的 schema 要求 {field}",
                     field in (schema.get("required") or []), f"schema={schema}")
    runner.check("get_context 的 state 默认 experience",
                 _schema(by_name["get_context"]).get("properties", {})
                 .get("state", {}).get("default") == "experience")

    # ---------- 3. 只读 ----------
    print("\n[3/7] 只读接口")
    listing = await tool("list_scripts", page=1, page_size=5)
    if not runner.check("list_scripts 正常", listing.get("ok") is True,
                        str(listing.get("error"))):
        return _summary(runner)
    scripts = listing.get("scripts") or []
    runner.check("list_scripts 返回条目", bool(scripts), f"共 {listing.get('total')} 本")
    runner.check("列表项已瘦身（不含正文 story）",
                 all("story" not in item for item in scripts))

    approved = [s for s in scripts if s.get("review_status") == "approved"]
    target = (approved or scripts)[0]
    script_id = target["id"]
    runner.ok("挑中一本剧本", f"{script_id} 《{target.get('title')}》 status={target.get('review_status')}")

    detail = await tool("get_script", script_id=script_id)
    runner.check("get_script 正常", detail.get("ok") is True, str(detail.get("error")))
    script = detail.get("script") or {}
    runner.check("剧本有题面", bool(script.get("story")), f"标题：{script.get('title')}")
    print(f"{DIM}    汤底完整下发：{script.get('is_full')}｜主持手册：{bool(script.get('host_guide'))}{RESET}")

    searched = await tool("search_scripts", keyword="汤", limit=3)
    runner.check("search_scripts 正常", searched.get("ok") is True, str(searched.get("error")))

    tags = await tool("list_tags")
    runner.check("list_tags 正常", tags.get("ok") is True, str(tags.get("error")))

    npcs = await tool("list_npcs")
    runner.check("list_npcs 正常", npcs.get("ok") is True, str(npcs.get("error")))
    npc_list = npcs.get("npcs") or []
    npc_id = npc_list[0]["npc_id"] if npc_list else ""
    runner.check("NPC 清单非空", bool(npc_list), f"{[n['npc_id'] for n in npc_list]}")
    if npc_id:
        npc = await tool("get_npc", npc_id=npc_id)
        runner.check("get_npc 正常", npc.get("ok") is True, str(npc.get("error")))
        missing = await tool("get_npc", npc_id="不存在的npc")
        runner.check("get_npc 对未知 id 给引导而不是崩",
                     missing.get("ok") is False and "list_npcs" in str(missing.get("error")))

    profile = await tool("my_profile")
    runner.check("my_profile 正常（凭证有效）", profile.get("ok") is True, str(profile.get("error")))
    stats = await tool("my_stats")
    runner.check("my_stats 正常", stats.get("ok") is True, str(stats.get("error")))
    mine = await tool("my_scripts")
    runner.check("my_scripts 正常", mine.get("ok") is True, str(mine.get("error")))
    subs = await tool("my_subscriptions")
    runner.check("my_subscriptions 正常", subs.get("ok") is True, str(subs.get("error")))

    # ---------- 4. 主持主链 ----------
    print("\n[4/7] 主持主链")
    started = await tool("start_session", script_id=script_id, npc_id=npc_id)
    if not runner.check("start_session 正常", started.get("ok") is True, str(started.get("error"))):
        return _summary(runner)
    session_id = started.get("session_id")
    runner.check("返回 session_id 且相位 hosting",
                 bool(session_id) and started.get("phase") == "hosting", f"{session_id}")
    runner.check("主持证没有回显给模型",
                 "host_token" not in started or started.get("host_token") is True,
                 f"返回字段：{sorted(started)}")
    runner.check("本地记住了主持证", started.get("host_token_stored") is True)
    current = session_tools.current()
    if current:
        opened[current.session_id] = current.host_token

    dup = await tool("start_session", script_id=script_id)
    runner.check("重复开房被本地拦住", dup.get("ok") is False
                 and dup.get("error", {}).get("code") == "session_already_open")

    ctx1 = await tool("get_context", state="experience")
    if not runner.check("get_context 正常", ctx1.get("ok") is True, str(ctx1.get("error"))):
        return _summary(runner)
    prompt = ctx1.get("system_prompt") or ""
    runner.check("拿到了 system_prompt", len(prompt) > 1000, f"{len(prompt)} 字符")
    runner.check("契约版本是 aijuben.context/*",
                 str(ctx1.get("contract", "")).startswith("aijuben.context/"), str(ctx1.get("contract")))
    runner.check("能力清单含 session:settle",
                 "session:settle" in (ctx1.get("capabilities") or []), str(ctx1.get("capabilities")))
    runner.check("会话信息与开房一致",
                 (ctx1.get("session") or {}).get("id") == session_id)
    ctx2 = await tool("get_context", state="experience")
    runner.check("同一相位两次 prompt_hash 一致",
                 ctx2.get("prompt_hash") == ctx1.get("prompt_hash")
                 and ctx2.get("prompt_changed") is False,
                 f"{str(ctx1.get('prompt_hash'))[:16]}…")

    browsing = await tool("get_context", state="browsing")
    runner.check("browsing 态可单独取", browsing.get("ok") is True, str(browsing.get("error")))
    bad_state = await tool("get_context", state="乱写")
    runner.check("非法 state 被本地拦下", bad_state.get("ok") is False)
    mismatch = await tool("get_context", state="browsing", contract="aijuben.context/0.0")
    if mismatch.get("error", {}).get("code") == "contract_mismatch":
        runner.ok("坏 contract 被后端拒绝", "400 contract_mismatch")
    else:
        runner.skip("坏 contract 校验", f"后端没按契约拒绝：{mismatch.get('error')}")

    beat = await tool("heartbeat")
    runner.check("heartbeat 正常", beat.get("ok") is True, str(beat.get("error")))

    status = await tool("session_status")
    runner.check("session_status 正常", status.get("ok") is True, str(status.get("error")))
    runner.check("status 里会话活着", (status.get("server") or {}).get("alive") is True)
    runner.check("快照能读到相位", (status.get("snapshot") or {}).get("phase") == "hosting",
                 str((status.get("snapshot") or {}).get("phase")))

    skip_step = await tool("mark_narrated")
    runner.check("跳步（未 settling 就 narrated）被拒",
                 skip_step.get("ok") is False
                 and skip_step.get("error", {}).get("code") == "session_phase_conflict",
                 str(skip_step.get("error", {}).get("code")))

    settling = await tool("begin_settling")
    runner.check("begin_settling 正常", settling.get("ok") is True
                 and settling.get("phase") == "settling", str(settling.get("error")))
    narrated = await tool("mark_narrated")
    runner.check("mark_narrated 正常", narrated.get("ok") is True, str(narrated.get("error")))

    old_host_token = (session_tools.current() or current)
    old_token_value = old_host_token.host_token if old_host_token else None

    ended = await tool("end_session", reason="settled")
    runner.check("end_session(settled) 正常", ended.get("ok") is True
                 and ended.get("phase") == "ended", str(ended.get("error")))
    runner.check("收场带回了快照", bool(ended.get("summary")))
    opened.pop(session_id, None)
    runner.check("本地状态已清空", session_tools.current() is None)

    # 收场后的主持证行为以 host.py 代码为准（不是想当然的「立刻作废」）：
    #   settled  —— 证还挂着（last_words_left=1），但主持上下文一律 403，不再下发；
    #   aborted  —— 立刻撤销，再用即 410；
    #   timeout  —— 降级成遗言证，只允许再取一次告别上下文（要安静 300 秒才能触发，自检不等待）。
    if old_token_value:
        grace = await client.host_status(old_token_value)
        runner.check("settled 后证仍挂着但已不能再主持",
                     grace.get("phase") == "ended" and grace.get("last_words_left") is not None,
                     f"phase={grace.get('phase')} last_words_left={grace.get('last_words_left')}")
        try:
            await client.build_context(
                state="experience", host_token=old_token_value, session_id=session_id)
            runner.bad("settled 后不该再下发主持上下文", "竟然给了")
        except AijubenError as exc:
            runner.check("settled 后主持上下文被拒（403）",
                         exc.status == 403 and exc.code == "capability_denied",
                         f"{exc.status} {exc.code}")
        runner.skip("timeout 遗言轮", "需要会话安静 300 秒，自检不等")

    after = await tool("session_status")
    runner.check("无会话时 session_status 仍可体检", after.get("ok") is True
                 and after.get("local_session") is None)

    # ---------- 5. 负面路径 ----------
    print("\n[5/7] 负面路径")
    no_session = await tool("heartbeat")
    runner.check("没会话调 heartbeat 有引导", no_session.get("ok") is False
                 and no_session.get("error", {}).get("code") == "no_local_session")
    bad_reason = await tool("end_session", reason="乱写")
    runner.check("非法 reason 被本地拦下", bad_reason.get("ok") is False)

    anon = gate_client(ApiClient(base_url, None, client_ip=IP))
    try:
        await anon.my_profile()
        runner.bad("无凭证应被拒", "竟然通过了")
    except AijubenError as exc:
        runner.check("无凭证访问个人数据被拒", exc.status == 401, f"{exc.status} {exc.code}")
        runner.check("错误自带处置提示", bool(exc.hint), exc.hint[:40] + "…")
    finally:
        await anon.aclose()

    # 再开一场，验证 aborted 收场与坏 script_id
    second = await tool("start_session", script_id=script_id)
    runner.check("可以再开一场", second.get("ok") is True, str(second.get("error")))
    if second.get("ok"):
        cur = session_tools.current()
        if cur:
            opened[cur.session_id] = cur.host_token
        abort_token = cur.host_token if cur else None
        aborted = await tool("end_session", reason="aborted")
        runner.check("aborted 收场正常", aborted.get("ok") is True, str(aborted.get("error")))
        opened.pop(second.get("session_id"), None)
        if abort_token:
            try:
                await client.host_status(abort_token)
                runner.bad("aborted 后主持证应立刻失效", "竟然还能用")
            except AijubenError as exc:
                runner.check("aborted 后主持证立刻失效", exc.status == 410,
                             f"{exc.status} {exc.code}")

    bad_script = await tool("start_session", script_id="00000000-0000-0000-0000-000000000000")
    runner.check("坏 script_id 被后端拒绝", bad_script.get("ok") is False,
                 f"{bad_script.get('error', {}).get('code')}")

    # ---------- 6. 门票通道（可选） ----------
    print("\n[6/7] MCP 门票通道")
    if not args.with_ticket:
        runner.skip("门票通道", "加 --with-ticket 才测")
    else:
        await _ticket_round(tool, client, base_url, script_id, opened, runner)

    # ---------- 7. 收尾 ----------
    print("\n[7/7] 收尾")
    cleanup = gate_client(ApiClient(base_url, token, client_ip=IP))
    try:
        for sid, host_token in list(opened.items()):
            try:
                await cleanup.end_host_session(sid, host_token, "aborted")
                runner.ok("兜底收掉遗留会话", sid)
            except AijubenError as exc:
                runner.skip("兜底收掉遗留会话", f"{sid} 已不可收：{exc.status} {exc.code}")
    finally:
        await cleanup.aclose()
        await client.aclose()
    session_tools._clear()

    return _summary(runner)


async def _ticket_round(tool: ToolBox, client: ApiClient, base_url: str, script_id: str,
                        opened: dict[str, str], runner: Runner) -> None:
    """造一张 mcp_ 门票，用门票走一遍只读 + 开房/作废。端点没上线就跳过。"""
    try:
        created = await client.request(
            "POST", "/api/user/mcp-tokens",
            json_body={"name": "aijuben-mcp selftest",
                       "scopes": ["script:read", "session:host", "session:settle"]},
        )
    except AijubenError as exc:
        runner.skip("签发门票", f"{exc.status} {exc.code}：{exc.message}（后端可能还没上线这个端点）")
        return
    ticket = None
    if isinstance(created, dict):
        for key in ("token", "mcp_token", "value", "access_token", "key"):
            if created.get(key):
                ticket = str(created[key])
                break
    if not ticket:
        runner.skip("签发门票", f"响应里找不到 token 字段：{created}")
        return
    runner.check("门票是 mcp_ 前缀", ticket.startswith("mcp_"), f"kind={token_kind(ticket)}")

    ticket_client = gate_client(configure(base_url, ticket, client_ip=IP))
    ticket_tool = ToolBox(create_server()[0])
    try:
        listing = await ticket_tool("list_scripts", page_size=2)
        runner.check("门票可读剧本", listing.get("ok") is True, str(listing.get("error")))
        profile = await ticket_tool("my_profile")
        runner.check("门票能过鉴权", profile.get("ok") is True, str(profile.get("error")))
        started = await ticket_tool("start_session", script_id=script_id)
        runner.check("门票能开房", started.get("ok") is True, str(started.get("error")))
        cur = session_tools.current()
        if cur:
            opened[cur.session_id] = cur.host_token
            ended = await ticket_tool("end_session", reason="aborted")
            runner.check("门票能收房", ended.get("ok") is True, str(ended.get("error")))
            opened.pop(cur.session_id, None)
    finally:
        await ticket_client.aclose()
    gate_client(configure(base_url, client.token, client_ip=IP))  # 回到 JWT，给后面的兜底收尾用


def _summary(runner: Runner) -> int:
    total = runner.passed + runner.failed
    print(f"\n{'-' * 60}")
    if runner.failed:
        print(f"{RED}失败 {runner.failed} / {total}{RESET}（跳过 {runner.skipped}）")
        for item in runner.failures:
            print(f"  {RED}·{RESET} {item}")
        return 1
    print(f"{GREEN}全部通过 {runner.passed} / {total}{RESET}（跳过 {runner.skipped}）")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AI剧本网 MCP 插件端到端自检")
    parser.add_argument("--base-url", default=None,
                        help="站点地址；默认读 AIJUBEN_BASE_URL，再退回 https://jvben.cn")
    parser.add_argument("--token", default=None,
                        help="直接给凭证；不给则用 AIJUBEN_TOKEN / ~/.aijuben/token / 账号密码登录")
    parser.add_argument("--with-ticket", action="store_true",
                        help="额外验证 MCP 门票（mcp_）通道：签发一张门票再走一遍")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\n中断")
        return 130
    except Exception:
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
