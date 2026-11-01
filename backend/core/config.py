"""应用配置"""
import os
import secrets

DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "data"))
DATABASE_URL = f"sqlite:///{os.path.join(DATA_DIR, 'turtlesoup.db')}"


def _load_or_create_secret() -> str:
    """JWT 签名密钥（安全治理）：
    1. 优先读取环境变量 APP_SECRET（生产环境建议由 systemd/部署脚本注入）；
    2. 否则读取持久化的随机密钥文件 data/secret.key（避免源码硬编码默认密钥）；
    3. 都没有则生成随机密钥并持久化到 data/secret.key。
    不再使用硬编码默认值，防止密钥泄露导致 JWT 可被伪造。"""
    env = os.environ.get("APP_SECRET")
    if env and env.strip():
        return env.strip()

    key_file = os.path.join(DATA_DIR, "secret.key")
    try:
        if os.path.exists(key_file):
            with open(key_file, "r", encoding="utf-8") as f:
                val = f.read().strip()
            if val:
                return val
    except OSError:
        pass

    val = secrets.token_urlsafe(48)
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(key_file, "w", encoding="utf-8") as f:
            f.write(val)
    except OSError:
        pass
    return val


APP_SECRET = _load_or_create_secret()
TOKEN_EXPIRE_DAYS = 30
GUEST_TOKEN_EXPIRE_DAYS = 7

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.qq.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))


def _load_smtp_user() -> str:
    """发信账号（安全治理，与 APP_SECRET / SMTP_PASS 同一套双通道）：
    1. 优先读环境变量 SMTP_USER（生产由 systemd/部署脚本注入）；
    2. 否则读本地凭据文件 data/smtp_user.key（不随源码分发）；
    3. 都没有返回空串 —— 发信处据此明确报错，而不是拿一个假账号去登录。

    这里原来硬编码的是站长的真实 QQ 邮箱：仓库一公开，等于把「私人邮箱 + 这台机器在发
    验证码」一起公布；别人自建部署也会照样用这个账号发信，失败原因还查不出来。
    改成空串后，未配置邮件服务的部署会得到一次可诊断的失败（verification.send_email
    在 SMTP_HOST/SMTP_USER 为空时直接抛 500），而不是静默假装发出去。"""
    env = os.environ.get("SMTP_USER")
    if env and env.strip():
        return env.strip()
    try:
        with open(os.path.join(DATA_DIR, "smtp_user.key"), "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


SMTP_USER = _load_smtp_user()


def _load_smtp_pass() -> str:
    """SMTP 授权码（安全治理，与 APP_SECRET 同机制）：
    1. 优先读环境变量 SMTP_PASS（生产环境由 systemd/部署脚本注入）；
    2. 否则读本地凭据文件 data/smtp_pass.key（不随源码分发，避免硬编码泄露）。
    都没有则返回空串，发邮件时会失败并提示。"""
    env = os.environ.get("SMTP_PASS")
    if env and env.strip():
        return env.strip()
    try:
        with open(os.path.join(DATA_DIR, "smtp_pass.key"), "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


SMTP_PASS = _load_smtp_pass()

DEV_MODE = os.environ.get("DEV_MODE", "0")
