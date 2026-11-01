"""邮箱验证码模块 — 独立负责验证码生成、存储和发送"""
import random
import string
import smtplib
from email.mime.text import MIMEText
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session
from fastapi import HTTPException

from .config import SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS


def generate_code(length: int = 6) -> str:
    """生成随机数字验证码"""
    return ''.join(random.choices(string.digits, k=length))


def send_email(to: str, subject: str, body: str) -> None:
    """发送邮件，失败时抛出异常"""
    # 账号密码一律不写进代码：SMTP_USER 走环境变量或 data/smtp_user.key，SMTP_PASS 走环境变量或 data/smtp_pass.key
    if not SMTP_HOST or not SMTP_USER or not SMTP_PASS:
        missing = [n for n, v in (("SMTP_HOST", SMTP_HOST), ("SMTP_USER", SMTP_USER), ("SMTP_PASS", SMTP_PASS)) if not v]
        raise HTTPException(500, "邮件服务未配置（缺少 %s），请在服务器环境变量或 data/*.key 中配置" % "、".join(missing))

    msg = MIMEText(body, "html", "utf-8")
    msg["Subject"] = subject
    msg["From"] = SMTP_USER
    msg["To"] = to

    # QQ邮箱优先尝试 SSL/465，失败则尝试 TLS/587；保留每种方式的真实错误便于诊断
    errors = []
    for use_ssl in [True, False]:
        try:
            if use_ssl:
                with smtplib.SMTP_SSL(SMTP_HOST, 465, timeout=15) as server:
                    server.login(SMTP_USER, SMTP_PASS)
                    server.send_message(msg)
            else:
                with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                    server.starttls()
                    server.login(SMTP_USER, SMTP_PASS)
                    server.send_message(msg)
            return  # 发送成功
        except smtplib.SMTPRecipientsRefused as e:
            codes = [resp[0] for resp in e.recipients.values()
                     if isinstance(resp, tuple) and resp]
            if 550 in codes:
                raise HTTPException(400, "收件邮箱不存在或无法接收邮件，请检查邮箱地址后重试") from None
            raise HTTPException(502, "邮件暂时无法投递，请稍后重试") from None
        except HTTPException:
            raise
        except Exception as e:
            errors.append(f"{'SSL/465' if use_ssl else 'TLS/587'}: {e}")

    detail = "; ".join(errors)
    if "535" in detail or "Login fail" in detail:
        raise HTTPException(
            500,
            "邮件发送失败：SMTP 授权码失效或该邮箱未开启 SMTP 服务。"
            "请在 QQ 邮箱设置中重新生成授权码，并更新 data/smtp_pass.key（或环境变量 SMTP_PASS）",
        )
    # 上游原文只留服务端日志，不下发给浏览器（可能含服务器/收件人内部信息）。
    print(f"[SMTP] 邮件发送失败：{detail}")
    raise HTTPException(500, "邮件发送失败，请稍后重试或联系管理员")


def send_verification_code(db: Session, email: str, purpose: str,
                           user_exists_check: bool = True) -> str:
    """
    生成并发送邮箱验证码，返回验证码字符串。
    
    该函数独立于认证模块，仅负责：
    1. 生成验证码
    2. 存储到 VerificationCode 表
    3. 调用邮件服务发送
    4. 发送失败时抛出异常（不会静默忽略）
    """
    from ..models.system import VerificationCode
    from ..models.user import User

    if user_exists_check:
        existing = db.query(User).filter(User.email == email).first()
        if purpose == "register" and existing:
            raise HTTPException(400, "该邮箱已注册")
        if purpose in ("change_password", "reset_password", "set_owner") and not existing:
            raise HTTPException(400, "该邮箱未注册")

    code = generate_code()
    vc = VerificationCode(
        email=email,
        code=code,
        purpose=purpose,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    db.add(vc)
    db.commit()

    subject_map = {
        "register": "AI剧本网 - 注册验证码",
        "change_password": "AI剧本网 - 修改密码验证码",
        "reset_password": "AI剧本网 - 找回密码验证码",
        "set_owner": "AI剧本网 - 站长变更验证码",
    }
    body = (
        f"<h2>您的验证码是：</h2>"
        f"<h1 style='color:#6366f1'>{code}</h1>"
        f"<p>10分钟内有效，请勿泄露给他人。</p>"
    )
    send_email(email, subject_map.get(purpose, "验证码"), body)
    return code


def verify_code(db: Session, email: str, code: str, purpose: str) -> bool:
    """验证验证码是否正确"""
    from ..models.system import VerificationCode

    vc = db.query(VerificationCode).filter(
        VerificationCode.email == email,
        VerificationCode.code == code,
        VerificationCode.purpose == purpose,
        VerificationCode.used == False,
    ).order_by(VerificationCode.created_at.desc()).first()

    if not vc or vc.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(400, "验证码无效或已过期")

    vc.used = True
    db.commit()
    return True
