"""MCP 服务入口：装配工具、给客户端写 instructions、解析命令行。

两种传输：
- stdio（默认）：Claude Desktop / Cursor / Claude Code / DSH 这类在自己的进程里拉子进程的客户端；
- streamable-http：给远程或容器里的客户端用，起一个 HTTP 服务，路径默认 /mcp。

**日志一律写 stderr**。stdio 传输时 stdout 就是协议通道，任何一行杂输出都会把会话搞坏。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from typing import Any

from . import __version__
from .api_client import AijubenError, ApiClient
from .auth import load_base_url, load_token, mask_token, token_kind, token_path
from .tools import configure, dumps

LOG = logging.getLogger("aijuben_mcp")

SERVER_NAME = "aijuben"
SERVER_TITLE = "AI剧本网"
DEFAULT_HTTP_PORT = 8765

INSTRUCTIONS = """\
这是 AI剧本网（jvben.cn）的 MCP 插件。站点是一个海龟汤 / 剧本内容社区：
上面有剧本（题面 + 汤底 + 结局条件 + 主持手册）、NPC 主持人形象，以及一套"主持会话"机制。

你能用它做两类事：
1. 读站点：浏览/搜索剧本、读全文（含汤底与主持手册）、看 NPC、看当前账号的档案与战绩。
2. 主持一场海龟汤：开房 -> 取主持上下文 -> 中途续命 -> 揭晓结算 -> 收场。

主持一场的标准流程（顺序不能跳）：
  start_session(script_id, npc_id)
  -> get_context(state="experience") 拿 system_prompt（那是这一场的规则，照它做）
  -> 与玩家互动；每隔几分钟 heartbeat() 续命；需要最新进度就 session_status()
  -> 玩家猜出真相（或你要揭晓）：begin_settling() -> 把汤底讲给玩家 -> mark_narrated()
  -> end_session(reason="settled")
  玩家中途不玩了：end_session(reason="aborted")；安静超过 5 分钟才允许 reason="timeout"。

几条必须守住的边界：
- 主持证由插件保管，工具不会把它回显给你，也不需要你传。
- 一次只主持一场；要换场必须先 end_session。
- 开房有每日次数上限，不需要主持就别开会。
- 汤底（explanation / host_guide / system_prompt）只对有权的人下发。返回里 is_full=false
  表示你拿到的是删节版，此时**不要猜答案**，明确告诉用户看不到完整汤底。
- 工具失败时返回 {"ok": false, "error": {...}}，里面 code 是契约错误码、hint 是给你看的
  处置建议。按 hint 调整，不要靠改参数反复重试同一个被拒的调用。

凭证：环境变量 AIJUBEN_TOKEN 或 ~/.aijuben/token 文件，两种都支持——
`mcp_` 开头的 MCP 门票（推荐，可限权可撤销）或账号登录拿到的 JWT（临时调试用）。
没配凭证时只读工具大多还能用（游客身份），主持与个人数据会回 no_actor。
"""


def create_server(*, name: str = SERVER_NAME) -> tuple[Any, str]:
    """建 MCP server 并挂上全部工具，返回 (server, SDK 主版本 "1"/"2")。

    兼容层：MCP Python SDK 2.x 把 FastMCP 改名成 MCPServer（`mcp.server.mcpserver`），
    1.x 只有 `mcp.server.fastmcp.FastMCP`。两边 `server.tool(name=, description=)` 与
    `server.run(transport=...)` 的形状一致，只有 streamable-http 的参数传递方式不同，
    见 `_run`。
    """
    try:  # mcp >= 2
        from mcp.server.mcpserver import MCPServer as Factory  # type: ignore

        major = "2"
    except ImportError:  # mcp 1.x
        from mcp.server.fastmcp import FastMCP as Factory  # type: ignore

        major = "1"

    server = Factory(
        name=name,
        title=SERVER_TITLE,
        instructions=INSTRUCTIONS,
        version=__version__,
    )

    from .tools import catalog, player, session

    catalog.register(server)
    session.register(server)
    player.register(server)
    LOG.debug("工具已装配完毕（SDK %s.x）", major)
    return server, major


def _run(server: Any, major: str, transport: str, host: str, port: int, path: str) -> None:
    """按传输方式起服务。"""
    if transport == "stdio":
        server.run(transport="stdio")
        return

    if major == "2":
        server.run(
            transport="streamable-http",
            host=host,
            port=port,
            streamable_http_path=path,
            stateless_http=False,
        )
        return

    # 1.x：HTTP 参数走 settings（FastMCP.settings.host/port/streamable_http_path）
    settings = getattr(server, "settings", None)
    if settings is not None:
        settings.host = host  # type: ignore[attr-defined]
        settings.port = port  # type: ignore[attr-defined]
        if hasattr(settings, "streamable_http_path"):
            settings.streamable_http_path = path  # type: ignore[attr-defined]
    server.run(transport="streamable-http")


async def _doctor(base_url: str | None, token: str | None) -> int:
    """连通性体检：站点能不能连、凭证能不能用、本地有没有遗留会话。"""
    from .tools import session as session_tools

    client = configure(base_url, token)
    report: dict[str, Any] = {
        "plugin": {"name": "aijuben-mcp", "version": __version__, "python": sys.version.split()[0]},
        "endpoint": {"base_url": client.base_url},
        "credential": {
            "configured": client.has_token,
            "kind": token_kind(load_token(token)),
            "masked": mask_token(load_token(token)),
            "expected_file": str(token_path()),
        },
        "checks": {},
    }
    try:
        import importlib.metadata

        try:
            report["plugin"]["mcp_sdk"] = importlib.metadata.version("mcp")
        except Exception:
            report["plugin"]["mcp_sdk"] = "unknown"
        _, major = create_server()
        report["plugin"]["sdk_factory"] = f"mcp-{major}.x"
    except Exception as exc:  # 没装 mcp 也要能跑 doctor
        report["plugin"]["mcp_sdk"] = f"不可用：{exc}"

    ok = True
    try:
        status = await client.host_status()
        report["checks"]["host_status"] = {"ok": True, "response": status}
    except AijubenError as exc:
        ok = False
        report["checks"]["host_status"] = {"ok": False, "error": exc.to_payload()}

    if client.has_token:
        try:
            profile = await client.my_profile()
            report["checks"]["credential"] = {
                "ok": True,
                "username": profile.get("username"),
                "role": profile.get("role"),
            }
        except AijubenError as exc:
            ok = False
            report["checks"]["credential"] = {"ok": False, "error": exc.to_payload()}
    else:
        report["checks"]["credential"] = {
            "ok": False,
            "skipped": "未配置凭证：只读工具可用，主持与个人数据会回 no_actor。",
        }

    current = session_tools.current()
    report["local_session"] = current.public() if current else None
    if current is not None:
        try:
            live = await client.host_status(current.host_token)
            report["checks"]["local_session"] = {"ok": True, "alive": live.get("alive"),
                                                 "phase": live.get("phase")}
        except AijubenError as exc:
            report["checks"]["local_session"] = {"ok": False, "error": exc.to_payload()}

    report["ok"] = ok
    print(dumps(report))
    await client.aclose()
    return 0 if ok else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="aijuben-mcp",
        description="AI剧本网（jvben.cn）MCP 插件：读剧本 / 看玩家档案 / 主持一场海龟汤。",
    )
    parser.add_argument("--transport", choices=("stdio", "streamable-http"), default="stdio",
                        help="stdio=给本地客户端拉子进程（默认）；streamable-http=起 HTTP 服务")
    parser.add_argument("--host", default="127.0.0.1", help="streamable-http 监听地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, default=DEFAULT_HTTP_PORT,
                        help=f"streamable-http 端口（默认 {DEFAULT_HTTP_PORT}）")
    parser.add_argument("--path", default="/mcp", help="streamable-http 的路径（默认 /mcp）")
    parser.add_argument("--base-url", default=None,
                        help="站点地址，默认读 AIJUBEN_BASE_URL，再退回 https://jvben.cn")
    parser.add_argument("--token", default=None,
                        help="凭证（mcp_ 门票或账号 JWT）。一般不用传，走 AIJUBEN_TOKEN / ~/.aijuben/token")
    parser.add_argument("--doctor", action="store_true", help="做一次连通性体检后退出")
    parser.add_argument("--log-level", default="INFO",
                        choices=("DEBUG", "INFO", "WARNING", "ERROR"), help="日志级别（写 stderr）")
    parser.add_argument("--version", action="version", version=f"aijuben-mcp {__version__}")
    return parser


def _force_utf8_streams() -> None:
    """Windows 控制台默认 cp936，中文会变乱码；统一切到 UTF-8（失败就算了）。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _force_utf8_streams()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        stream=sys.stderr,  # stdio 传输时 stdout 是协议通道，日志绝不能进去
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.doctor:
        return asyncio.run(_doctor(args.base_url, args.token))

    configure(args.base_url, args.token)
    server, major = create_server()
    LOG.info(
        "aijuben-mcp %s 启动 transport=%s sdk=%s.x base_url=%s 凭证=%s",
        __version__, args.transport, major, load_base_url(args.base_url), mask_token(load_token(args.token)),
    )
    try:
        _run(server, major, args.transport, args.host, args.port, args.path)
    except KeyboardInterrupt:
        LOG.info("收到中断，退出")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
