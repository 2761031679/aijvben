"""安全工具：JWT、密码哈希、中间件"""
import logging
import time
from datetime import datetime, timedelta, timezone
from fastapi import Request, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from jose import jwt, JWTError
from passlib.context import CryptContext
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
from .config import APP_SECRET, TOKEN_EXPIRE_DAYS, GUEST_TOKEN_EXPIRE_DAYS
from .database import get_db

logger = logging.getLogger(__name__)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(user_id: str, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRE_DAYS)
    payload = {"sub": user_id, "role": role, "exp": expire}
    return jwt.encode(payload, APP_SECRET, algorithm="HS256")


def create_guest_token(guest_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=GUEST_TOKEN_EXPIRE_DAYS)
    payload = {"sub": guest_id, "role": "guest", "exp": expire}
    return jwt.encode(payload, APP_SECRET, algorithm="HS256")


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, APP_SECRET, algorithms=["HS256"])
    except JWTError:
        return None


# ============ M27：MCP 长期凭证（mcp_...）============

def _is_mcp_token(raw: str) -> bool:
    """是不是 MCP 长期凭证。**认的是前缀**（token_service.TOKEN_PREFIX）——
    这是它与 JWT（含两个点）、主持证（>=40 位无点裸串）之间唯一可靠的分水岭。
    """
    from ..services.token_service import TOKEN_PREFIX
    return bool(raw) and raw.startswith(TOKEN_PREFIX)


def _audit_mcp_call(user, request: Request | None, token_id: str) -> None:
    """每次 MCP 调用记一条 access_logs（action="MCP调用"）。

    用独立会话写：这条记录不该和业务事务同生共死，业务回滚了"某把钥匙调过这个接口"
    这件事仍然成立。写不进去只 warning —— 审计落库失败不能反过来拦住请求。
    """
    path = method = ip = port = ua = tool = ""
    if request is not None:
        try:
            tool = (request.headers.get("x-mcp-tool") or "").strip()[:80]
            path = request.url.path or ""
            method = request.method or ""
            ua = (request.headers.get("user-agent") or "")[:255]
            client = request.client
            ip = getattr(client, "host", "") or ""
            port = str(getattr(client, "port", "") or "")
        except Exception:  # 请求对象在极端情况下残缺，别为审计把请求带崩
            pass
    detail = (f"token={token_id} tool={tool}" if tool else f"token={token_id}")[:255]
    try:
        from .database import SessionLocal
        from ..models.access_log import AccessLog
        db = SessionLocal()
        try:
            db.add(AccessLog(
                user_email=(getattr(user, "email", "") or ""),
                user_id=str(getattr(user, "id", "")),
                action="MCP调用",
                ip=ip, port=port[:10], path=path[:255], method=method[:10],
                status=0, user_agent=ua, detail=detail,
            ))
            db.commit()
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("写 MCP 调用审计失败（不影响本次请求）：%s", exc)


def _mcp_actor(credentials, db: Session, request: Request | None, required: bool):
    """用 mcp_ 长期凭证认身份，返回 User（挂 `_mcp_scopes`）或 None。

    失败一律 401 `no_actor`（契约 §9.3）—— 不区分"不存在/已吊销/哈希不符"，避免
    给人一枚 oracle 去爆破。**空能力集也算失败**：一把钥匙 scopes 全是不认识的名字，
    或用户已被降权/注销，它此刻做不了任何事，不该被当成"登录成功但没权限"。
    required=False（get_optional_user）时安静地返回 None，与原来"无效 token 不抛"一致。
    """
    from ..services import token_service
    from ..models.user import User

    raw = credentials.credentials if credentials else ""
    row = token_service.parse(db, raw)
    if row is None:
        if not required:
            return None
        raise HTTPException(401, detail={"code": "no_actor", "message": "MCP 凭证无效或已被吊销，请重新生成"})

    user = db.query(User).filter(User.id == row.user_id).first()
    if user is None or user.is_deleted:
        if not required:
            return None
        raise HTTPException(401, detail={"code": "no_actor", "message": "这把 MCP 凭证所属的账号不存在或已注销"})

    caps = token_service.resolve_capabilities(row, user)
    if not caps:
        if not required:
            return None
        raise HTTPException(401, detail={"code": "no_actor", "message": "这把 MCP 凭证当前没有任何可用能力，请重新生成"})

    token_service.enforce_rate_limit(row)   # 超 60 次/分钟 → 429 rate_limited
    token_service.touch(db, row)            # last_used_at，60 秒节流
    try:
        # 能力集挂在 User 实例上（不落库、不改 User 表）：下游代码用 getattr(user, "_mcp_scopes", None)
        # 判断"这是钥匙来的身份，能力要收窄"。JWT 登录的 user 上没有这个属性 → None。
        user._mcp_scopes = caps
    except Exception:  # SQLAlchemy 实例理论上允许挂任意属性，保险起见
        pass
    _audit_mcp_call(user, request, getattr(row, "id", ""))
    return user


def get_current_user(
    request: Request = None,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
):
    """要求登录的依赖：返回 User 或 401

    M27：`Authorization: Bearer mcp_...` 先分流到长期凭证（token_service），认出来的
    用户带 `_mcp_scopes`；其余仍是原样的 JWT 路径 —— 老的 401 文案一个字节没动。
    """
    from ..models.user import User
    if not credentials:
        raise HTTPException(401, "请先登录")
    if _is_mcp_token(credentials.credentials):
        return _mcp_actor(credentials, db, request, required=True)
    payload = decode_token(credentials.credentials)
    if not payload:
        raise HTTPException(401, "登录已过期，请重新登录")
    user = db.query(User).filter(User.id == payload["sub"]).first()
    if not user or user.is_deleted:
        raise HTTPException(401, "用户不存在")
    return user


def get_optional_user(
    request: Request = None,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
):
    """可选认证：登录返回 User，未登录/游客返回 None

    M27：带 mcp_ 凭证时同样先分流；钥匙无效/能力为空按"没登录"处理（返回 None，不抛）。
    """
    from ..models.user import User
    if not credentials:
        return None
    if _is_mcp_token(credentials.credentials):
        return _mcp_actor(credentials, db, request, required=False)
    payload = decode_token(credentials.credentials)
    if not payload:
        return None
    if payload.get("role") == "guest":
        return None
    return db.query(User).filter(User.id == payload["sub"]).first()


def _deny_by_token(user, area):
    """门票（MCP 长期凭证）一律不得进入管理面。

    门票的能力集里没有 admin 面这一类（见 token_service.SCOPES），所以这里不是
    「再判一次」，而是把「门票 ≠ 管理员」写死：只要这次请求是门票认证的，
    无论账号本身是不是管理员，管理面一律 403。

    没有这一句，一张声明为 `["player:read"]` 的门票等于把管理员的**全部权限**
    原样外包出去 —— 审计 M1 实测用那样的票读到了未过审稿的汤底。
    """
    if getattr(user, "_mcp_scopes", None) is not None:
        raise HTTPException(403, {"code": "capability_denied",
                                  "message": "AI 门票不能访问%s，请用站长本人的登录态操作" % area})


def require_scope(*needed):
    """门票能力校验依赖（只对门票生效，普通登录态直通）。

    语义按契约 §9.4：scopes 是**上限**，实际生效 = 门票授权 ∩ 该账号本该有的能力。
    这里只管「门票这一层」；账号身份层由各端点原有的 require_* 负责。
    """
    def _dep(user=Depends(get_current_user)):
        caps = getattr(user, "_mcp_scopes", None)
        if caps is None:
            return user                     # 普通登录态，不归这层管
        lack = [x for x in needed if x not in caps]
        if lack:
            raise HTTPException(403, {"code": "capability_denied",
                                      "message": "这张 AI 门票没有 %s 能力" % "、".join(lack),
                                      "needed": lack})
        return user
    return _dep


def require_admin(user=Depends(get_current_user)):
    """要求管理员权限"""
    if user.role not in ("admin", "owner"):
        raise HTTPException(403, "需要管理员权限")
    _deny_by_token(user, "管理员面")
    return user


def require_admin_or_station_master(user=Depends(get_current_user)):
    """要求管理员或站长权限（用于审核终审等环节）"""
    if user.role not in ("admin", "owner", "station_master"):
        raise HTTPException(403, "需要管理员或站长权限")
    _deny_by_token(user, "管理员/站长面")
    return user


def require_login_not_token(user=Depends(get_current_user)):
    """只认「人自己登录」的登录态，门票不行。

    用在哪：签发/列出/吊销 AI 门票本身。门票若能自签，吊销就形同作废 ——
    攻击者在你吊销之前先签 10 张，且新票的 scopes 可以比原票更大（审计 M2）。
    """
    if getattr(user, "_mcp_scopes", None) is not None:
        raise HTTPException(403, {"code": "capability_denied",
                                  "message": "AI 门票不能签发或管理门票，请用本人登录态操作"})
    return user


def require_owner(user=Depends(get_current_user)):
    """要求站长权限"""
    if user.role != "owner":
        raise HTTPException(403, "需要站长权限")
    _deny_by_token(user, "站长面")
    return user


# --- 中间件 ---

class CacheControlMiddleware(BaseHTTPMiddleware):
    """静态资源缓存控制"""
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        path = request.url.path
        if path.endswith(".html") or path == "/":
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        elif path.endswith(".css") or path.endswith(".js"):
            response.headers["Cache-Control"] = "public, max-age=300"
        return response


class RateLimitMiddleware(BaseHTTPMiddleware):
    """IP 频率限制中间件"""
    # 每累计这么多次请求全量扫一遍过期键。一次扫描是 O(键数)，摊到单次请求可忽略。
    _SWEEP_EVERY = 2000
    # 兜底硬上限：窗口内活跃 IP 真到了这个量级（有人拿海量 IP 同时打），
    # 只删过期键已经压不住了，按最后活跃时间淘汰最旧的一部分 —— 宁可少限几个也要保住进程。
    _MAX_KEYS = 20000

    def __init__(self, app, max_requests: int = 30, window_seconds: int = 10):
        super().__init__(app)
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._store: dict[str, list[float]] = {}
        self._sweep_hits = 0

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path.startswith("/static") or path == "/health":
            return await call_next(request)

        # 经 Nginx 反向代理后 request.client.host 恒为 127.0.0.1，须读 X-Real-IP / X-Forwarded-For 取真实客户端 IP，
        # 否则所有用户共享同一 IP 计数，多人访问时极易误判「请求过于频繁」。
        ip = (request.headers.get("X-Real-IP")
              or (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
              or (request.client.host if request.client else "unknown"))
        now = time.time()
        self._store.setdefault(ip, [])
        self._store[ip] = [t for t in self._store[ip] if now - t < self.window_seconds]

        if len(self._store[ip]) >= self.max_requests:
            return Response("请求过于频繁，请稍后再试", status_code=429)

        self._store[ip].append(now)

        # 淘汰过期 IP 键。原来 self._store 只增不删：每个新出现的 IP 留一行（行里还挂着
        # 最多 max_requests 个时间戳），而这里的 ip 取自 X-Real-IP / X-Forwarded-For ——
        # 客户端自己就能随便填。换着 IP 头刷请求就等于让内存无限涨，这是可以从外部按几下
        # 就打爆的内存问题，所以必须有人定期把「早就过期」的键删掉。
        # 限流语义不变（30 请求/10 秒照旧）：只删「最后一条记录都已过期」的键，
        # 也就是窗口内计数本来就是 0 的那些，删掉与留着等价。
        self._sweep_hits += 1
        if self._sweep_hits >= self._SWEEP_EVERY:
            self._sweep_hits = 0
            self._sweep(now)

        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        return response

    def _sweep(self, now: float) -> None:
        """删掉窗口内已经没有记录的 IP 键；键数仍超上限时再按最后活跃时间淘汰最旧的一批。"""
        cutoff = now - self.window_seconds
        # 列表按时间追加，末元素就是该 IP 最后一次请求；末元素都过期 ⇒ 整条都过期。
        for key in [k for k, ts in self._store.items() if not ts or ts[-1] < cutoff]:
            self._store.pop(key, None)

        overflow = len(self._store) - self._MAX_KEYS
        if overflow > 0:
            oldest = sorted(self._store.items(), key=lambda kv: kv[1][-1] if kv[1] else 0.0)
            for key, _ in oldest[:overflow]:
                self._store.pop(key, None)


class AccessLogMiddleware(BaseHTTPMiddleware):
    """访问日志中间件：记录用户操作（邮箱/IP/端口/目标地址/访问时间），保留 180 日。

    仅记录有业务含义的请求（登录/退出/浏览/点赞点踩/收藏/下载/举报等），
    静态资源与健康检查跳过；日志写入失败静默，不影响业务。
    """
    _SKIP = ("/static", "/health", "/docs", "/openapi.json", "/favicon.ico")
    _last_purge = 0.0
    _PURGE_INTERVAL = 3600.0   # 每 1 小时清理一次 180 天前日志

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path.startswith(self._SKIP):
            return await call_next(request)
        response = await call_next(request)
        try:
            self._record(request, response.status_code)
        except Exception:
            pass
        return response

    def _record(self, request: Request, status_code: int):
        method = request.method
        path = request.url.path
        action = self._infer_action(method, path)
        if not action:
            return

        ip = (request.headers.get("X-Real-IP")
              or (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
              or (request.client.host if request.client else ""))
        port = request.client.port if request.client else ""
        email, uid = self._extract_user(request)

        from .database import SessionLocal
        from ..models.access_log import AccessLog
        db = SessionLocal()
        try:
            db.add(AccessLog(
                user_email=email, user_id=uid, action=action,
                ip=str(ip), port=str(port or ""), path=path, method=method,
                status=status_code,
                user_agent=(request.headers.get("user-agent") or "")[:255],
            ))
            db.commit()
        finally:
            db.close()
        self._maybe_purge()

    def _infer_action(self, method: str, path: str) -> str:
        p = path
        if p.endswith("/login") or p.endswith("/register"):
            return "登录/注册"
        if "/logout" in p:
            return "退出"
        if "/report" in p:
            return "举报"
        if "/subscriptions" in p:
            return "收藏"
        if "/download" in p:
            return "下载"
        if "/like" in p or "/dislike" in p:
            return "点赞/点踩"
        if "/community-vote" in p:
            return "投票"
        if "/complete" in p:
            return "通关"
        if method == "GET" and p.startswith("/api/scripts"):
            return "浏览"
        if method == "POST" and p.startswith("/api/scripts"):
            return "发布/上传"
        return ""

    def _extract_user(self, request: Request):
        """从 Authorization Bearer token 解析用户邮箱与 id（尽力而为）。"""
        try:
            auth = request.headers.get("authorization") or ""
            if auth.startswith("Bearer "):
                payload = decode_token(auth[7:])
                if payload:
                    uid = payload.get("sub") or ""
                    from .database import SessionLocal
                    from ..models.user import User
                    db = SessionLocal()
                    try:
                        u = db.query(User).filter(User.id == uid).first()
                        return (u.email or "", uid) if u else ("", uid)
                    finally:
                        db.close()
        except Exception:
            pass
        return "", ""

    def _maybe_purge(self):
        """定期清理 180 天前的访问日志（《网络安全法》要求留存不少于 6 个月）。"""
        now = time.time()
        if now - self._last_purge < self._PURGE_INTERVAL:
            return
        self._last_purge = now
        try:
            from .database import SessionLocal
            from ..models.access_log import AccessLog
            cutoff = datetime.now(timezone.utc) - timedelta(days=180)
            db = SessionLocal()
            try:
                db.query(AccessLog).filter(AccessLog.created_at < cutoff).delete()
                db.commit()
            finally:
                db.close()
        except Exception:
            pass
