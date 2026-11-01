"""MCP 长期凭证服务（M27）
====================================================================
给 AI 编辑器那侧的 MCP 插件用的「长期钥匙」：用户在本站登录一次 → 生成一串
`mcp_...` → 插件把它写进配置文件 → 之后每次调 API 带上它，就等于以该用户身份
请求，能力再受这把钥匙的 scopes 限制。

**为什么不复用 JWT？**
JWT 是无状态、带过期的。MCP 插件是长期驻留进程，让用户每两小时回来复制一次
token 不可接受；而「签一个永不过期的 JWT」会把吊销问题变成无解 —— 签出去就
收不回。所以另立一张表：库里有行 ⇒ 随时可吊销、还能看最后使用时间。

**明文只出现一次。**
库里只存 `sha256(id + 明文)`。id 是 `mt_` + sha256(明文) 的前 12 位 —— id 由
明文推导，是为了让校验能 O(1) 直接命中主键：调用方手里只有明文，先算 id 再查行，
不必为「从明文找行」另建索引表。哈希里再掺一次 id，是为了别处的同串明文算出
同一个哈希（何况 id 本身就是摘要，反推不出明文）。

**scopes 是上限，不是快照**（契约 §15.1）
真正生效的能力 = 钥匙上的 scopes ∩ 用户**当前**本该有的能力。于是用户降权/封号
时，所有钥匙自动跟着收窄，不需要去扫表逐把改写。

**每凭证限流。**
默认 60 次/分钟，进程内滑动窗口。不复用 guest_counter_service —— 那是匿名访客
配额，语义不同，混用会让游客额度被 MCP 调用吃掉。阈值可用环境变量
`MCP_RATE_LIMIT_PER_MIN` 覆盖（自动化测试要绕过 IP 中间件那条 30 次/10 秒的
429 才能验到本模块这条）。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from datetime import datetime, timezone

from fastapi import HTTPException

from ..models.mcp_token import McpToken

logger = logging.getLogger(__name__)

#: 明文前缀。**安全边界靠它**：security.py / host_session_service 都以此区分凭证种类。
TOKEN_PREFIX = "mcp_"

#: 系统认识的能力名（契约 §15.1 的 8 个）。钥匙只能在这 8 个里挑，挑不到的上限不成立。
SCOPES = frozenset({
    "script:read",      # 读剧本（含已批准剧本的正文/元数据）
    "session:host",     # 以玩家身份取主持上下文（汤底只在主持证下才给）
    "session:settle",   # 结算上报
    "player:read",      # 读玩家自己的资料/统计/存档
    "write:script",     # 投稿/改自己的剧本
    "social:vote",      # 点赞点踩
    "social:report",    # 举报
    "social:follow",    # 关注
})

#: 稳定输出序（给 GET /mcp-tokens 与 422 提示用；SCOPES 是 set，序不固定）。
SCOPE_ORDER = tuple(sorted(SCOPES))

#: 单人最多几把活跃钥匙。超过就 409 —— 不是安全问题，是防自己把自己搞糊涂。
MAX_ACTIVE_PER_USER = 10

#: 每凭证限流（次 / 窗口秒）
RATE_LIMIT_WINDOW_SECONDS = 60
try:
    RATE_LIMIT_PER_MIN = max(1, int(os.environ.get("MCP_RATE_LIMIT_PER_MIN") or 60))
except ValueError:  # 环境变量写错别把服务拖挂
    RATE_LIMIT_PER_MIN = 60

#: last_used_at 的写库节流：一分钟内只写一次，省得一个跑飞的插件把库写热。
TOUCH_INTERVAL_SECONDS = 60


class InvalidArgument(ValueError):
    """入参不合法（name 空/超长、scopes 全是不认识的）。路由层转 422。"""


class TokenLimitReached(RuntimeError):
    """活跃钥匙已满（MAX_ACTIVE_PER_USER）。路由层转 409。"""

    def __init__(self, current: int, limit: int):
        self.current = current
        self.limit = limit
        super().__init__(f"活跃凭证已达上限 {limit} 把，请先吊销一把再生成")


# ============ 哈希与 id ============

def _fingerprint(raw: str) -> str:
    return hashlib.sha256((raw or "").encode("utf-8")).hexdigest()


def token_id_for(raw: str) -> str:
    """明文 → 凭证 id（12 位摘要，够区分，也不泄露明文）。"""
    return "mt_" + _fingerprint(raw)[:12]


def _hash_of(token_id: str, raw: str) -> str:
    return hashlib.sha256(((token_id or "") + (raw or "")).encode("utf-8")).hexdigest()


# ============ scopes ============

def normalize_scopes(raw_scopes) -> tuple[list[str], list[str]]:
    """入参 scopes → (认识且去重的有序清单, 不认识的清单)。不认识的不报错，交调用方告警。"""
    clean: list[str] = []
    unknown: list[str] = []
    for item in raw_scopes or []:
        if not isinstance(item, str):
            unknown.append(repr(item))
            continue
        name = item.strip()
        if not name:
            continue
        if name in SCOPES:
            if name not in clean:
                clean.append(name)
        elif name not in unknown:
            unknown.append(name)
    return clean, unknown


def capabilities_for_user(user) -> set:
    """用户**当前**本该有的能力集（§10 权限矩阵里「登录玩家」那一档）。

    本轮 8 个能力名都落在登录玩家该有的一档（script:host 的正常来源是主持证，
    但那不等于账号本身没有这个能力 —— 见 §11.3）。所以判据只有一条：账号还在、
    没被软删除。写成一个函数而不用 `return set(SCOPES)`，是为了哪天某个能力要
    收紧（例如未实名不给 social:vote）时，只改这一处，而不是满地找调用点。
    """
    if user is None or getattr(user, "is_deleted", False):
        return set()
    return set(SCOPES)


#: 未知 scope 的告警只打一次（每 token_id + scope），否则限流下的刷屏会把日志淹掉。
_WARNED_UNKNOWN: set = set()


def _warn_unknown_once(token_id: str, name: str) -> None:
    key = (token_id or "", name)
    if key in _WARNED_UNKNOWN:
        return
    _WARNED_UNKNOWN.add(key)
    logger.warning("凭证 %s 上有一个系统不认识的能力名 %r，已忽略（不拒绝请求）", token_id, name)


def resolve_capabilities(row, user) -> set:
    """这把钥匙在这一刻真实能做的事 = 钥匙 scopes ∩ 用户当前能力。空集 = 该 401。"""
    granted = set()
    for name in _row_scopes(row):
        if name in SCOPES:
            granted.add(name)
        else:
            _warn_unknown_once(getattr(row, "id", ""), name)
    if not granted:
        return set()
    return granted & capabilities_for_user(user)


def _row_scopes(row) -> list:
    if row is None:
        return []
    getter = getattr(row, "scope_list", None)
    if callable(getter):
        return getter()
    try:
        data = json.loads(getattr(row, "scopes", "") or "[]")
    except (TypeError, ValueError):
        return []
    return [s for s in data if isinstance(s, str)] if isinstance(data, list) else []


# ============ 生命周期 ============

def create(db, user, name: str, scopes) -> tuple:
    """建一把钥匙。返回 (row, 明文)。**明文只在这里出现一次**。"""
    name = (name or "").strip()
    if not name:
        raise InvalidArgument("name 不能为空")
    if len(name) > 40:
        raise InvalidArgument("name 最长 40 个字符")

    current = active_count(db, user)
    if current >= MAX_ACTIVE_PER_USER:
        raise TokenLimitReached(current, MAX_ACTIVE_PER_USER)

    clean, unknown = normalize_scopes(scopes)
    for bad in unknown:
        logger.warning("生成凭证时忽略了不认识的能力名 %r（用户 %s）", bad, getattr(user, "id", ""))
    if not clean:
        raise InvalidArgument("scopes 里没有任何系统认识的能力名；可用的是：" + "、".join(SCOPE_ORDER))

    raw, token_id = _new_identity(db)
    row = McpToken(
        id=token_id,
        user_id=str(getattr(user, "id", "")),
        name=name,
        scopes=json.dumps(clean, ensure_ascii=False),
        token_hash=_hash_of(token_id, raw),
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    logger.info("用户 %s 生成 MCP 凭证 %s（scopes=%s）", row.user_id, row.id, ",".join(clean))
    return row, raw


def _new_identity(db) -> tuple:
    """随机造 (明文, id)。id 由明文推导，撞主键（12 位摘要碰撞）就重来，最多 5 次。"""
    for _ in range(5):
        raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
        token_id = token_id_for(raw)
        if db.query(McpToken.id).filter(McpToken.id == token_id).first() is None:
            return raw, token_id
    raise RuntimeError("生成凭证 id 连续 5 次撞主键，可能是随机源异常")


def parse(db, raw: str):
    """明文 → 行。不存在 / 已吊销 / 哈希不符 / 没前缀，一律 None（调用方统一 401 no_actor）。"""
    raw = (raw or "").strip()
    if not raw or not raw.startswith(TOKEN_PREFIX):
        return None
    row = db.query(McpToken).filter(McpToken.id == token_id_for(raw)).first()
    if row is None or row.revoked_at is not None:
        return None
    if not hmac.compare_digest(row.token_hash or "", _hash_of(row.id, raw)):
        return None
    return row


def list_for_user(db, user, include_revoked: bool = True) -> list:
    q = db.query(McpToken).filter(McpToken.user_id == str(getattr(user, "id", "")))
    if not include_revoked:
        q = q.filter(McpToken.revoked_at.is_(None))
    return q.order_by(McpToken.created_at.desc(), McpToken.id.desc()).all()


def active_count(db, user) -> int:
    return (
        db.query(McpToken)
        .filter(McpToken.user_id == str(getattr(user, "id", "")), McpToken.revoked_at.is_(None))
        .count()
    )


def revoke(db, user, token_id: str) -> bool:
    """吊销自己的钥匙。幂等（已吊销再吊销仍是成功）；不是自己的返回 False（路由层给 404）。"""
    row = (
        db.query(McpToken)
        .filter(McpToken.id == (token_id or ""), McpToken.user_id == str(getattr(user, "id", "")))
        .first()
    )
    if row is None:
        return False
    if row.revoked_at is None:
        row.revoked_at = datetime.now(timezone.utc)
        db.commit()
        logger.info("用户 %s 吊销 MCP 凭证 %s", row.user_id, row.id)
    return True


# ============ 每次调用都要做的事 ============

#: 进程内滑动窗口：token_id -> [时间戳...]。
_BUCKETS: dict = {}
#: 进程内 touch 节流兜底（库里 last_used_at 为空的头一分钟靠它）。
_LAST_TOUCH: dict = {}


def reset_rate_limits() -> None:
    """清空限流窗口（自测和热重载用；正常路径不会调）。"""
    _BUCKETS.clear()
    _LAST_TOUCH.clear()


def enforce_rate_limit(row) -> None:
    """每凭证 60 次/分钟。超了抛 429 rate_limited（§9.3 形状，带 retry_after）。"""
    token_id = getattr(row, "id", "") or ""
    now = time.time()
    bucket = [t for t in _BUCKETS.get(token_id, []) if now - t < RATE_LIMIT_WINDOW_SECONDS]
    if len(bucket) >= RATE_LIMIT_PER_MIN:
        _BUCKETS[token_id] = bucket
        retry_after = max(1, int(RATE_LIMIT_WINDOW_SECONDS - (now - bucket[0])) + 1)
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limited",
                "message": f"这把凭证调用太频繁（每分钟 {RATE_LIMIT_PER_MIN} 次），请 {retry_after} 秒后重试",
                "retry_after": retry_after,
            },
            headers={"Retry-After": str(retry_after)},
        )
    bucket.append(now)
    _BUCKETS[token_id] = bucket
    if len(_BUCKETS) > 4096:  # 长期运行别把内存吃光：清掉窗口已经空了的
        for key in [k for k, v in _BUCKETS.items() if not v or now - v[-1] >= RATE_LIMIT_WINDOW_SECONDS]:
            _BUCKETS.pop(key, None)


def touch(db, row) -> bool:
    """写 last_used_at，60 秒节流。写库失败只 warning —— 记不上时间不该让请求失败。"""
    if row is None:
        return False
    now = datetime.now(timezone.utc)
    last = getattr(row, "last_used_at", None)
    if last is not None:
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if (now - last).total_seconds() < TOUCH_INTERVAL_SECONDS:
            return False
    token_id = getattr(row, "id", "") or ""
    if time.time() - _LAST_TOUCH.get(token_id, 0.0) < TOUCH_INTERVAL_SECONDS:
        return False
    row.last_used_at = now
    try:
        db.commit()
    except Exception as exc:  # noqa: BLE001 - 审计性的写入，失败不该影响本次请求
        db.rollback()
        logger.warning("写凭证 %s 的 last_used_at 失败：%s", token_id, exc)
        return False
    _LAST_TOUCH[token_id] = time.time()
    return True
