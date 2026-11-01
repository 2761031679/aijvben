"""实名认证请求记录模型：关联业务序列号(bizSeq)与用户，追踪认证状态。"""
from sqlalchemy import Column, String, DateTime, Boolean
from datetime import datetime, timezone
from ..core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


class RealnameRequest(Base):
    __tablename__ = "realname_requests"

    id = Column(String, primary_key=True)
    user_id = Column(String, nullable=False, index=True)
    biz_seq = Column(String(32), nullable=False, unique=True, index=True)  # 业务序列号（生码时生成）
    biz_serial_no = Column(String(24), default="")                         # 业务流水号（平台返回）
    status = Column(String(20), default="pending")                          # pending / success / fail
    result_code = Column(String(8), default="")
    result_desc = Column(String, default="")
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
