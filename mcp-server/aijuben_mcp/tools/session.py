"""主持会话工具组：开房 -> 拼上下文 -> 心跳 -> 结算 -> 收场。

这一组是插件的核心，也是唯一写状态的一组。三条硬规则：

1. **主持证只在进程内 / 本地状态文件里流转，永不回显**。它等价于这一场的主持权限，
   进了对话历史就等于泄露，所以工具只回 `host_token_stored: true`。
2. **一次只主持一场**。后端规定一把主持证同时只能管一场（再开会被 403 capability_denied），
   所以本地也保持单例；要换场必须先 end_session。
   收场三种理由，主持证的结局不一样（**以 host.py / host_session_service.py 的代码为准**）：
   aborted = 立刻撤销（revoked_at），再用就是 410；
   settled = 证还挂着（last_words_left=1），但主持上下文一律 403 不再下发（汤底没有第二次上台的理由）；
   timeout = 降级成「遗言证」，允许再取**一次**告别上下文把最后一句讲完，用完即失效。
3. **相位顺序不可跳**：hosting(讲题面) -> settling(开始讲汤底) -> narrated(讲完)
   -> ended。跳步后端会回 409 session_phase_conflict，工具会把该走哪一步写进 hint。

会话状态落盘在 `~/.aijuben/current_session.json`（可用 AIJUBEN_STATE_DIR 改目录）：
很多 MCP 客户端每次对话都会重开一次插件进程，只在内存里记 session_id 会导致
「上一轮开的房，这一轮就忘了」。所以把 session_id + 主持证写进用户目录，重启后还能接着主持。
文件里含主持证，权限按 0600 写（Windows 上尽力而为），用完 end_session 会立刻清掉。
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..auth import state_dir
from . import dumps, get_client, tool_guard

LOG = logging.getLogger("aijuben_mcp.tools.session")

VALID_STATES = ("default", "browsing", "experience")
VALID_REASONS = ("settled", "aborted", "timeout")
STATE_FILE = "current_session.json"


@dataclass
class HostSession:
    """本地记的一场主持会话（只记怎么继续主持，不复制后端的业务真相）。"""

    session_id: str
    host_token: str
    phase: str = "hosting"
    script_id: str | None = None
    script_title: str | None = None
    npc_id: str | None = None
    npc_name: str | None = None
    started_at: str | None = None
    expires_at: str | None = None
    prompt_hash: str | None = None
    last_words_left: int | None = None
    opened_via: str = "user"  # user / guest
    updated_at: float = field(default_factory=time.time)

    def public(self) -> dict[str, Any]:
        """给模型看的形态：**不含 host_token**。"""
        data = asdict(self)
        data.pop("host_token", None)
        data["host_token_stored"] = True
        return data


_CURRENT: HostSession | None = None
_LOADED = False


def _state_file() -> Path:
    return state_dir() / STATE_FILE


def _load() -> HostSession | None:
    global _CURRENT, _LOADED
    if _LOADED:
        return _CURRENT
    _LOADED = True
    path = _state_file()
    if not path.exists():
        _CURRENT = None
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        _CURRENT = HostSession(**raw)
        LOG.info("从 %s 恢复主持会话 %s", path, _CURRENT.session_id)
    except Exception:  # 文件坏了就当没有，别让插件起不来
        LOG.warning("主持会话状态文件不可用，已忽略：%s", path, exc_info=True)
        _CURRENT = None
    return _CURRENT


def _save(session: HostSession) -> None:
    global _CURRENT, _LOADED
    session.updated_at = time.time()
    _CURRENT = session
    _LOADED = True
    path = _state_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(session), ensure_ascii=False), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass  # Windows 上不强制；至少不放在共享目录
        tmp.replace(path)
    except OSError:
        LOG.warning("写不下主持会话状态文件：%s", path, exc_info=True)


def _clear(*, keep: HostSession | None = None) -> None:
    global _CURRENT
    _CURRENT = keep
    path = _state_file()
    try:
        if path.exists() and keep is None:
            path.unlink()
    except OSError:
        LOG.warning("删不掉主持会话状态文件：%s", path, exc_info=True)


def _install_exit_cleanup() -> None:
    """进程异常退出时也要清掉状态文件（审计 S3）。

    文件里是**明文 host_token**。正常收场会走 `_clear()`，但崩溃 / Ctrl-C / 关机都不会。
    残留的代价：主持证活到过期为止（4 小时），同一台机器上任何进程都能读。
    这里挂 atexit + SIGINT/SIGTERM，能覆盖绝大多数非正常退出。
    """
    import atexit
    import signal

    def _cleanup(*_args: Any) -> None:
        try:
            if _CURRENT is not None:
                _clear()
        except Exception:            # 退出路径上绝不能再抛
            pass

    atexit.register(_cleanup)
    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue                        # Windows 没有 SIGHUP
        try:
            previous = signal.getsignal(sig)

            def _handler(signum, frame, _prev=previous):
                _cleanup()
                # 交回去给原来的处理器（默认行为是退出），别把 Ctrl-C 吞掉
                if callable(_prev) and _prev not in (signal.SIG_IGN,):
                    return _prev(signum, frame)
                raise SystemExit(0)

            signal.signal(sig, _handler)
        except (OSError, ValueError):
            pass                            # 不在主线程 / 平台不支持就跳过


_install_exit_cleanup()


def current() -> HostSession | None:
    """当前这场主持会话；没有就 None。"""
    return _load()


def require_current(tool: str) -> tuple[HostSession | None, str | None]:
    """取当前会话，取不到时返回一句给 AI 的指引（而不是抛 401）。"""
    session = _load()
    if session is None:
        return None, dumps(
            {
                "ok": False,
                "error": {
                    "status": 0,
                    "code": "no_local_session",
                    "message": f"本地没有进行中的主持会话，{tool} 无处可落。",
                    "hint": "先 start_session(script_id=...) 开一场；"
                            "或者用 session_status 确认是不是已经结束/超时了。",
                },
            }
        )
    return session, None


def _ended_payload(reason: str) -> str:
    return dumps(
        {
            "ok": True,
            "phase": "ended",
            "reason": reason,
            "note": "本地会话已清除。aborted 会立刻作废主持证（再用即 410）；"
                    "settled 之后主持上下文不再下发（403）；timeout 还留一次告别上下文。"
                    "要再主持请重新 start_session。",
        }
    )


def register(server: Any) -> None:
    """把会话工具挂到 MCP server 上。"""

    @server.tool(
        name="start_session",
        description=(
            "开一场主持会话：把某本剧本 + 某个 NPC 组成一场可以走完的海龟汤体验，返回 session_id。\n"
            "什么时候用：用户明确要『开始玩/主持一把』，并且你已经选定 script_id 时。"
            "开会之前建议先 get_script 读一遍汤底——否则你没法判玩家猜得对不对。\n"
            "什么时候别用：只是聊天/问剧本内容，不要开会（开会占服务器资源，还有每日开房次数上限）；"
            "本地已经有进行中的会话时也别重复开——先 session_status 看，要换场就 end_session(aborted)。\n"
            "返回里没有主持证（只回 host_token_stored: true），它在插件内部保管；"
            "后续心跳/结算/收场都用它，不需要你传。没配凭证时会以游客身份开会（次数少得多）。"
        ),
    )
    @tool_guard
    async def start_session(script_id: str, npc_id: str = "") -> str:
        existing = _load()
        if existing is not None and existing.phase != "ended":
            return dumps(
                {
                    "ok": False,
                    "error": {
                        "status": 0,
                        "code": "session_already_open",
                        "message": f"本地已经有一场进行中的会话 {existing.session_id}（phase={existing.phase}）。",
                        "hint": "先 session_status 看这一场的状态；不玩了就 end_session(reason=aborted) 收掉，"
                                "再开新的。一把主持证同时只能管一场。",
                    },
                }
            )

        client = get_client()
        result = await client.start_host_session(script_id, npc_id or None)
        session_id = result.get("session_id")
        host_token = result.get("host_token")
        if not session_id or not host_token:
            return dumps(
                {
                    "ok": False,
                    "error": {
                        "status": 0,
                        "code": "unexpected_response",
                        # 这里**绝不能**把 result 拼进 message：那个 dict 里就装着明文主持证，
                        # 而 message/hint 是给模型看、可能被原样念给玩家的。只报两个布尔。
                        "message": "开会成功但响应字段不全（缺少 session_id 或 host_token）",
                        "hint": ("站点版本可能与插件不一致（接口契约变了）。"
                                 "请把上面这句告诉用户，**不要**把接口返回的原文贴出来。"),
                    },
                }
            )

        # 补两个可读的名字，方便后续汇报时不额外查接口
        script_title: str | None = None
        try:
            script = await client.get_script(script_id)
            script_title = script.get("title")
        except Exception:  # 只影响可读性，不阻断
            LOG.debug("读剧本标题失败（不影响主持）", exc_info=True)

        session = HostSession(
            session_id=session_id,
            host_token=host_token,
            phase=result.get("phase") or "hosting",
            script_id=script_id,
            script_title=script_title,
            npc_id=npc_id or None,
            started_at=result.get("started_at"),
            expires_at=result.get("expires_at"),
            opened_via="user" if client.has_token else "guest",
        )
        _save(session)
        payload = session.public()
        payload.update(
            {
                "ok": True,
                "next": "调 get_context(state=\"experience\") 拿主持上下文（system_prompt 就是要遵守的规则），"
                        "然后就按它开始主持；过程中每几分钟 heartbeat 一次。",
                "acting_as": session.opened_via,
            }
        )
        return dumps(payload)

    @server.tool(
        name="get_context",
        description=(
            "取主持上下文（契约 aijuben.context）：system_prompt、能力清单、NPC 设定、玩家画像、会话进度。\n"
            "什么时候用：开完会第一步必须调一次 state=experience 拿到 system_prompt 并照它做；"
            "玩家档案变了、进度推进了、或者你怀疑上下文过期（心跳后 last_words_left 变了）时再调，"
            "用 prompt_changed 判断有没有变。玩家还没开会只想看看人设用 state=browsing。\n"
            "什么时候别用：不要每一句对话都调——它每次都要重算一遍上万个字符，"
            "同一相位重复取只会烧 token；也不要把它当剧本详情用（要正文看 get_script）。\n"
            "state：experience（默认，必须有进行中的会话）/ browsing（浏览态人设）/ default（通用介绍）。"
            "返回的 prompt_hash 变了就说明上下文真的变了，没变就沿用你手上那份。"
        ),
    )
    @tool_guard
    async def get_context(
        state: str = "experience",
        session_id: str = "",
        npc_id: str = "",
        contract: str = "",
    ) -> str:
        if state not in VALID_STATES:
            return dumps(
                {
                    "ok": False,
                    "error": {
                        "status": 0,
                        "code": "invalid_state",
                        "message": f"state 只能是 {'/'.join(VALID_STATES)}，收到 {state!r}",
                        "hint": "experience=正在主持一场时用；browsing=还没开会、只想看人设；default=通用介绍。",
                    },
                }
            )

        session = _load()
        target_session_id = session_id or (session.session_id if session else "")
        host_token = session.host_token if session else None

        if state == "experience":
            if session is None and not session_id:
                return dumps(
                    {
                        "ok": False,
                        "error": {
                            "status": 0,
                            "code": "no_local_session",
                            "message": "state=experience 需要一场进行中的会话，但本地没有。",
                            "hint": "先 start_session(script_id=...) 开一场；只想看人设就改用 state=browsing。",
                        },
                    }
                )
            if session is None or (session_id and session_id != session.session_id):
                return dumps(
                    {
                        "ok": False,
                        "error": {
                            "status": 0,
                            "code": "no_local_session",
                            "message": f"本地会话是 {session.session_id if session else '无'}，"
                                       f"拿不到 session_id={session_id} 的主持证。",
                            "hint": "主持证只对开房那一次有效，插件无法代你取别场的上下文。"
                                    "要接着主持就 session_status 确认，或重新 start_session。",
                        },
                    }
                )

        result = await get_client().build_context(
            state=state,
            host_token=host_token,
            session_id=target_session_id or None,
            npc_id=npc_id or None,
            contract=contract or None,
        )

        prompt_hash = result.get("prompt_hash")
        previous_hash = session.prompt_hash if session else None
        changed = bool(previous_hash) and prompt_hash != previous_hash
        if session is not None:
            session.prompt_hash = prompt_hash
            _save(session)

        payload: dict[str, Any] = {
            "ok": True,
            "contract": result.get("contract"),
            "state": result.get("state"),
            "generated_at": result.get("generated_at"),
            "capabilities": result.get("capabilities"),
            "npc": result.get("npc"),
            "player": result.get("player"),
            "session": result.get("session"),
            "stats": result.get("stats"),
            "prompt_hash": prompt_hash,
            "prompt_changed": changed,
            "system_prompt": result.get("system_prompt"),
        }
        if previous_hash and not changed:
            payload["note"] = "与上一次完全一致（prompt_hash 未变），你手上那份 system_prompt 仍然有效。"
        elif changed:
            payload["note"] = (
                f"上下文变了（prompt_hash {previous_hash[:12]}… -> {str(prompt_hash)[:12]}…）："
                "剧本/玩家/进度有更新，以这次的 system_prompt 为准。"
            )
        else:
            payload["note"] = "第一次取上下文：这就是你要遵守的规则，按它主持。"
        return dumps(payload)

    @server.tool(
        name="heartbeat",
        description=(
            "给当前会话续命，同时取回相位与剩余遗言轮数。\n"
            "什么时候用：正在主持、玩家还在互动时，隔几分钟调一次（后端超过 5 分钟没有心跳就算『安静』，"
            "之后只允许按 timeout 收场）；也可以在长时间思考/等玩家回复之后补一次，确认会话还活着。\n"
            "什么时候别用：不要循环狂调（占请求配额、没有新信息）；会话已结束就别再心跳，"
            "那会得到 410 host_token_expired——按提示重新开房。\n"
            "返回 last_words_left 是还能给玩家几次『遗言』，用完了就不能再追问。"
        ),
    )
    @tool_guard
    async def heartbeat() -> str:
        session, err = require_current("heartbeat")
        if err:
            return err
        assert session is not None
        result = await get_client().heartbeat(session.session_id, session.host_token)
        session.phase = result.get("phase") or session.phase
        session.last_words_left = result.get("last_words_left")
        _save(session)
        return dumps({"ok": True, **result, "alive": True})

    @server.tool(
        name="begin_settling",
        description=(
            "把会话从『主持中』推进到『结算中』，表示玩家已经猜出（或你已经决定揭晓），准备讲汤底。\n"
            "什么时候用：玩家的推理已经命中真相、或你打算公布答案时，讲汤底之前调用一次。\n"
            "什么时候别用：还没揭晓就别调（相位一进去只能往前走）；玩家中途不玩了请用 "
            "end_session(reason=aborted)，不要靠它收场。\n"
            "顺序：begin_settling -> 把汤底讲给玩家 -> mark_narrated -> end_session(reason=settled)。"
        ),
    )
    @tool_guard
    async def begin_settling() -> str:
        session, err = require_current("begin_settling")
        if err:
            return err
        assert session is not None
        result = await get_client().begin_settling(session.session_id, session.host_token)
        session.phase = result.get("phase") or "settling"
        _save(session)
        return dumps(
            {
                "ok": True,
                **result,
                "next": "现在把汤底讲给玩家；讲完调 mark_narrated()，再 end_session(reason=\"settled\")。",
            }
        )

    @server.tool(
        name="mark_narrated",
        description=(
            "告诉服务器『汤底已经讲完了』。必须在 begin_settling 之后、end_session(settled) 之前调用。\n"
            "什么时候用：你已经把完整汤底（真相）讲给玩家之后。\n"
            "什么时候别用：还没讲完就别标（标错了这场就不能再算正常结算）；"
            "玩家没猜出来、你也没讲，请用 end_session(reason=aborted)。"
        ),
    )
    @tool_guard
    async def mark_narrated() -> str:
        session, err = require_current("mark_narrated")
        if err:
            return err
        assert session is not None
        result = await get_client().mark_narrated(session.session_id, session.host_token)
        session.phase = result.get("phase") or "settling"
        _save(session)
        return dumps(
            {
                "ok": True,
                **result,
                "next": "汤底已记录。现在 end_session(reason=\"settled\") 收场，把成绩/结局留给玩家。",
            }
        )

    @server.tool(
        name="end_session",
        description=(
            "结束当前会话并作废主持证。三种理由：settled（正常结束，必须先 begin_settling + mark_narrated）、"
            "aborted（玩家中途不玩/出错了，立刻作废）、timeout（安静超过 5 分钟才允许）。\n"
            "什么时候用：一场结束时必调——不用它，主持证要挂到 4 小时才过期，之后你也开不了新房"
            "（主持证同时只能管一场）。\n"
            "什么时候别用：会话还在进行、玩家还在猜，别提前收；settled 用不了（409）说明你漏了 settle 两步，"
            "按 hint 补上，别改成 aborted 蒙过去。\n"
            "收场后本地会话会被清掉，返回值里的 summary 是这一场的最后快照，可以用来给玩家做复盘。"
            "注意主持证的去向：aborted 立刻作废；settled 之后这一场不再下发主持上下文；"
            "timeout 才允许再取一次告别上下文（遗言轮），用完就失效。"
        ),
    )
    @tool_guard
    async def end_session(reason: str = "settled") -> str:
        if reason not in VALID_REASONS:
            return dumps(
                {
                    "ok": False,
                    "error": {
                        "status": 0,
                        "code": "invalid_reason",
                        "message": f"reason 只能是 {'/'.join(VALID_REASONS)}，收到 {reason!r}",
                        "hint": "正常结算=settled；中途作废=aborted；安静超时=timeout。",
                    },
                }
            )
        session, err = require_current("end_session")
        if err:
            return err
        assert session is not None

        snapshot: dict[str, Any] | None = None
        try:
            snapshot = await get_client().get_host_session(session.session_id, session.host_token)
        except Exception:  # 收场前的快照失败不该挡住收场
            LOG.debug("收场前取快照失败", exc_info=True)

        result = await get_client().end_host_session(session.session_id, session.host_token, reason)
        _clear()
        return dumps(
            {
                "ok": True,
                **result,
                "reason": reason,
                "summary": snapshot,
                "note": "会话已结束、本地状态已清除。aborted 时主持证立刻作废；"
                        "settled 之后这一场不再下发主持上下文；timeout 才留一次告别上下文。"
                        "要再主持请重新 start_session。",
            }
        )

    @server.tool(
        name="session_status",
        description=(
            "看当前这场会话的实时状态：是否还活着、相位、是否已讲汤底、安静了多少秒、剩余遗言轮数、"
            "以及进度快照（已收集的线索/物证、条件与任务计数、结局）。\n"
            "什么时候用：玩家问『进行到哪了/还有多久』；你不确定当前相位（决定下一步该 settle 还是 end）；"
            "心跳报错之后想确认到底还活着没有。\n"
            "什么时候别用：不要用它代替 heartbeat——status 只是读，不续命（安静计时照走）。"
            "本地没有会话时它会告诉你站点的存活时间，那就够了，别反复调。"
        ),
    )
    @tool_guard
    async def session_status() -> str:
        client = get_client()
        session = _load()
        if session is None:
            status = await client.host_status()
            return dumps(
                {
                    "ok": True,
                    "local_session": None,
                    "server": status,
                    "note": "本地没有进行中的会话（已结束或从未开过）。要开始玩请 start_session。",
                }
            )

        status = await client.host_status(session.host_token)
        snapshot: dict[str, Any] | None = None
        try:
            snapshot = await client.get_host_session(session.session_id, session.host_token)
        except Exception:
            LOG.debug("取会话快照失败", exc_info=True)
        session.phase = status.get("phase") or session.phase
        session.last_words_left = status.get("last_words_left")
        _save(session)
        return dumps(
            {
                "ok": True,
                "local_session": session.public(),
                "server": status,
                "snapshot": snapshot,
                "note": "status 只是读，不续命；玩家还在互动就调 heartbeat 续上。",
            }
        )
