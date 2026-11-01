"""访问日志模型（合规要求：保留 180 日 / 6 个月）"""
from sqlalchemy import Column, String, Integer, DateTime
from datetime import datetime, timezone
import uuid
from ..core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


def _gen_id():
    return uuid.uuid4().hex[:12]


class AccessLog(Base):
    """用户访问日志：记录账号（邮箱）、操作类型、网络源地址（IP/端口）、目标地址、访问时间。"""
    __tablename__ = "access_logs"

    id = Column(String, primary_key=True, default=_gen_id)
    user_email = Column(String(255), default="")   # 用户邮箱（游客为空）
    user_id = Column(String(64), default="")       # 用户 id（游客为空）
    action = Column(String(50), default="")        # 操作类型：登录/注册/退出/浏览/点赞点踩/收藏/下载/举报等
    ip = Column(String(64), default="")            # 网络源地址
    port = Column(String(10), default="")          # 网络源端口
    path = Column(String(255), default="")         # 目标地址（请求路径）
    method = Column(String(10), default="")        # HTTP 方法
    status = Column(Integer, default=0)            # 响应状态码
    user_agent = Column(String(255), default="")   # 用户代理
    # 下面两列只为「主持上下文下发」这类需要回答「谁看了哪一本」的审计而加（审计 S1）。
    # 普通访问日志留空。
    script_id = Column(String(64), default="")     # 涉及的剧本
    session_id = Column(String(64), default="")    # 涉及的会话
    # MCP 长期凭证调用（M27）要回答「哪把钥匙、哪个工具」：钥匙 id 记在 user_agent 之外的
    # 这里（action="MCP调用" 时 detail 形如 "tool=script.read", 无该头则为空）。
    detail = Column(String(255), default="")       # 附加说明（现在只有 MCP 调用在用）
    created_at = Column(DateTime, default=_utcnow, index=True)  # 访问时间（用于 180 日清理）
