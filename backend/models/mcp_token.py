"""MCP 长期凭证模型（M27）
====================================================================
配套服务是 backend/services/token_service.py —— 设计取舍（为什么 id 由明文推导、
为什么哈希里掺 id）都写在那个文件的模块注释里，这里只记数据形状。

一句话记住：**这张表里没有明文**。存在的只有 sha256(id + 明文)，
明文只在 `token_service.create()` 的返回值里出现一次，之后取不回来（丢了就吊销重发）。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Index, String, Text

from ..core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


def _iso(dt):
    """输出用 ISO 串（与 host_session 同口径：带 +00:00、毫秒精度）。空值给 None。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat(timespec="milliseconds")


class McpToken(Base):
    __tablename__ = "mcp_tokens"
    __table_args__ = (
        # 「这个用户还有几把活着的钥匙」是最常查的一句；revoked_at 参与过滤，做成复合索引。
        Index("ix_mcp_tokens_user_revoked", "user_id", "revoked_at"),
    )

    id = Column(String(32), primary_key=True)      # "mt_" + 12 位 hex，**由明文推导**（见 token_service）
    user_id = Column(String(64), index=True, nullable=False)
    name = Column(String(64), default="")          # 用户自己起的名字（"家里台式" / "VS Code"）
    scopes = Column(Text, default="[]")            # JSON 数组：能力**上限**（还要 ∩ 用户当前能力才生效）
    token_hash = Column(String(64), default="")    # sha256(id + 明文) 的 hex，永不回传
    created_at = Column(DateTime, default=_utcnow)
    last_used_at = Column(DateTime, nullable=True)  # 60 秒节流写（见 token_service.touch）
    revoked_at = Column(DateTime, nullable=True)    # 非空 = 已吊销（软删，行留着给审计）

    # ---- 读法 ----

    @property
    def active(self) -> bool:
        return self.revoked_at is None

    def scope_list(self) -> list:
        """scopes 列 → list[str]。脏数据（手改过库/老格式）一律当空，不抛。"""
        try:
            data = json.loads(self.scopes or "[]")
        except (TypeError, ValueError):
            return []
        if not isinstance(data, list):
            return []
        return [s for s in data if isinstance(s, str) and s]

    def to_dict(self) -> dict:
        """对外形状（**不含** token_hash，也不含明文 —— 明文早就没了）。"""
        return {
            "id": self.id,
            "name": self.name or "",
            "scopes": self.scope_list(),
            "created_at": _iso(self.created_at),
            "last_used_at": _iso(self.last_used_at),
            "revoked_at": _iso(self.revoked_at),
            "active": self.active,
        }
