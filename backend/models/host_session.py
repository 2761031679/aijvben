"""会话（Session）模型：一次剧本体验的服务端权威记录。

设计要点（对应 docs/CONTEXT_CONTRACT.md §5.3 / §7.3 / §7.4）：

1. **相位只存一处**。`phase` 是物理列，不是 JSON 里的键；`to_session_data()`
   在组装契约结构时把列读进去。这样「查库能筛、契约能读」又不出现两份真相。
2. **主持证不存明文**。库里只放 sha256。用不透明随机串而不是签名 JWT，
   原因是主持证必须能撤销（§7.4），而签名过的令牌撤不掉——那种设计最终一定会
   退化成「库里还有个 revoked 表」，不如一开始就查库。
3. **并发锁落库，但还没接进任何路由**。`turn_lock` 存在 payload 里，带 expires_at；进程崩了
   锁会自己过期，不会永久 409（评审 A5④）。⚠ 见 host_session_service 同名注释：这两个函数
   目前零调用点，是给 P3（多端同场）留的。现有并发是「同账号开新场就把旧场 abort」粗粒度挡的。
4. 除相位、令牌、活动时间这些要查的，其余按 §5.3 原样放 payload，
   改结构 = 升 payload["schema"] 版本号。
"""
from sqlalchemy import Column, String, DateTime, JSON, Index
from datetime import datetime, timezone
import uuid
from ..core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


def _iso_utc(dt):
    """SQLite 读回来的时间是「naive 的 UTC」。直接 isoformat() 会丢掉时区，
    前端当本地时间解析，于是 4 小时有效期显示成 -4 小时。这里统一补回 +00:00。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    # timespec="milliseconds"：ECMAScript 的 Date Time String Format 只认 3 位小数，
    # 6 位靠引擎宽容才能解析。前端用 Date.parse 判「证过期没有」，别赌宽容（审计 H5）。
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds")

def _gen_id():
    return uuid.uuid4().hex

# 相位取值，与契约 §5.3 一致，不许增删
PHASE_HOSTING = "hosting"      # 主持中
PHASE_SETTLING = "settling"    # 结局已达成、解说还没讲完
PHASE_ENDED = "ended"          # 结束
VALID_PHASES = (PHASE_HOSTING, PHASE_SETTLING, PHASE_ENDED)

SESSION_SCHEMA = 2


def empty_payload(owner_user_id, script_id, npc_id, mode):
    """按契约 §5.3 生成一份全新的 session_data 载荷（不含由列承载的字段）。"""
    now = datetime.now(timezone.utc).isoformat()
    return {
        "schema": SESSION_SCHEMA,
        "owner_user_id": owner_user_id,
        "script_id": script_id,
        "npc_id": npc_id,
        "mode": mode,
        "inventory": {"clue": [], "item": []},
        "cond_counts": {},
        "task_counts": {},
        "settled_ending": None,
        "ending_type": None,
        "settlement": None,
        "narrated": False,
        "last_words_used": 0,
        "turn_lock": {"holder": None, "expires_at": None},
        "started_at": now,
        "last_active_at": now,
    }


class HostSession(Base):
    """一次剧本体验的会话记录。"""
    __tablename__ = "host_sessions"
    __table_args__ = (
        Index("ix_host_sessions_phase_active", "phase", "last_active_at"),
        Index("ix_host_sessions_owner", "owner_user_id"),
    )

    id = Column(String(32), primary_key=True, default=_gen_id)
    script_id = Column(String(32), nullable=False, index=True)
    npc_id = Column(String(40), nullable=False, default="")
    mode = Column(String(24), nullable=False, default="")
    # 开房玩家；游客会话为 None。§5.3 明确：组装玩家信息一律看这个字段，不看请求主体
    owner_user_id = Column(String(32), nullable=True)

    phase = Column(String(12), nullable=False, default=PHASE_HOSTING)
    payload = Column(JSON, default=dict)

    # 主持证：只存哈希；token_issued_at 用于 4 小时封顶
    token_hash = Column(String(64), nullable=False, default="")
    token_issued_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)

    last_active_at = Column(DateTime, default=_utcnow, nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    def to_session_data(self):
        """组装契约 §5.3 的完整 session_data（相位来自列，不来自载荷）。"""
        p = dict(self.payload or {})
        data = {
            "schema": p.get("schema", SESSION_SCHEMA),
            "phase": self.phase,
            "owner_user_id": self.owner_user_id,
            "script_id": self.script_id,
            "npc_id": self.npc_id,
            "mode": self.mode,
            "inventory": p.get("inventory") or {"clue": [], "item": []},
            "cond_counts": p.get("cond_counts") or {},
            "task_counts": p.get("task_counts") or {},
            "settled_ending": p.get("settled_ending"),
            "ending_type": p.get("ending_type"),
            "settlement": p.get("settlement"),
            "narrated": bool(p.get("narrated")),
            "last_words_used": int(p.get("last_words_used") or 0),
            "turn_lock": p.get("turn_lock") or {"holder": None, "expires_at": None},
            "revoked_at": _iso_utc(self.revoked_at),
            "started_at": p.get("started_at"),
            "last_active_at": _iso_utc(self.last_active_at),
        }
        return data

    def __repr__(self):
        return "<HostSession %s %s %s>" % (self.id, self.script_id, self.phase)
