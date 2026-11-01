"""凭证读取：环境变量 -> 用户目录文件 -> 命令行参数。

AI剧本网有两套凭证，形状不同但都能放进 `Authorization: Bearer <token>`：

- MCP 门票：`mcp_` 前缀 + 一串随机字符，由站点 `POST /api/user/mcp-tokens` 签发，
  可以带能力（scopes）与有效期，专给第三方 AI 客户端长期使用。
- 用户账号 JWT：`POST /api/auth/login` 拿到的 access token，三天左右过期，
  没有细粒度能力，权限＝账号本身。适合临时调试与本机测试。

解析顺序（先命中的赢）：显式参数 > 环境变量 AIJUBEN_TOKEN > `~/.aijuben/token` 文件内容。
`mcp_` 前缀的凭证优先被采用——如果你在环境变量里放了 JWT、在文件里放了门票，
调用方显式指定时以显式值为准；两者都来自自动发现时，文件里的门票优先于环境里的 JWT，
因为门票是专门为 MCP 签发的那种，过期风险更低。

站点地址同理：`--base-url` > 环境变量 AIJUBEN_BASE_URL > 默认 https://jvben.cn。
"""
from __future__ import annotations

import os
from pathlib import Path

ENV_TOKEN = "AIJUBEN_TOKEN"
ENV_BASE_URL = "AIJUBEN_BASE_URL"
DEFAULT_BASE_URL = "https://jvben.cn"
TOKEN_DIR = ".aijuben"
TOKEN_FILE = "token"
MCP_TOKEN_PREFIX = "mcp_"


def token_path() -> Path:
    """`~/.aijuben/token` 的绝对路径。"""
    return Path.home() / TOKEN_DIR / TOKEN_FILE


def _clean(raw: str | None) -> str | None:
    """去掉空白、引号与误粘贴的 "Bearer " 前缀。"""
    if raw is None:
        return None
    value = raw.strip().strip('"').strip("'").strip()
    if not value:
        return None
    lowered = value.lower()
    if lowered.startswith("bearer "):
        value = value.split(" ", 1)[1].strip()
    return value or None


def read_token_file(path: Path | None = None) -> str | None:
    """读凭证文件；文件不存在/不可读/为空都返回 None（不抛异常）。"""
    target = path or token_path()
    try:
        return _clean(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return None


def token_kind(token: str | None) -> str:
    """判断凭证种类：`mcp` / `jwt` / `none`。"""
    if not token:
        return "none"
    if token.startswith(MCP_TOKEN_PREFIX):
        return "mcp"
    return "jwt"


def mask_token(token: str | None) -> str:
    """给日志和工具返回用的脱敏形态：保留种类前缀与末 4 位。"""
    if not token:
        return "(未配置)"
    if len(token) <= 12:
        return token[:4] + "…"
    return token[:4] + "…" + token[-4:]


def load_token(explicit: str | None = None, *, path: Path | None = None) -> str | None:
    """按优先级解析凭证。

    1. explicit（命令行 `--token`，测试与临时切换用）
    2. 环境变量 AIJUBEN_TOKEN
    3. ~/.aijuben/token 文件
    """
    explicit_value = _clean(explicit)
    env_value = _clean(os.environ.get(ENV_TOKEN))
    file_value = read_token_file(path)

    if explicit_value:
        return explicit_value
    # 自动发现阶段：mcp_ 门票优先（它为 MCP 签发，能力与有效期都更可控）
    if token_kind(file_value) == "mcp":
        return file_value
    if env_value:
        return env_value
    return file_value


def token_source(explicit: str | None = None, *, path: Path | None = None) -> str:
    """凭证来自哪里：`arg` / `env` / `file` / `none`（用于 doctor 与报错提示）。"""
    explicit_value = _clean(explicit)
    env_value = _clean(os.environ.get(ENV_TOKEN))
    file_value = read_token_file(path)
    if explicit_value:
        return "arg"
    if token_kind(file_value) == "mcp":
        return "file"
    if env_value:
        return "env"
    if file_value:
        return "file"
    return "none"


def load_base_url(explicit: str | None = None) -> str:
    """站点地址：`--base-url` > AIJUBEN_BASE_URL > https://jvben.cn（去掉末尾斜杠）。"""
    value = _clean(explicit) or _clean(os.environ.get(ENV_BASE_URL)) or DEFAULT_BASE_URL
    return value.rstrip("/")


def login_credentials() -> tuple[str, str] | None:
    """测试用的账号密码（AIJUBEN_TEST_USER / AIJUBEN_TEST_PASS）。

    读不到就返回 None —— 本插件与 selftest 都不会把任何账号密码写进文件，
    仓库里也不允许出现站长账号。
    """
    user = _clean(os.environ.get("AIJUBEN_TEST_USER"))
    password = os.environ.get("AIJUBEN_TEST_PASS")
    if not user or not password:
        return None
    return user, password


def state_dir() -> Path:
    """运行期状态目录（当前主持会话的记忆文件放这里）。

    默认 `~/.aijuben`，可用 AIJUBEN_STATE_DIR 覆盖（selftest 用临时目录，避免弄脏真实状态）。
    """
    override = _clean(os.environ.get("AIJUBEN_STATE_DIR"))
    if override:
        return Path(override)
    return Path.home() / TOKEN_DIR
