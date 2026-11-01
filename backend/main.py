"""AI剧本网 API 服务 - 主入口"""
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Depends
from sqlalchemy.orm import Session
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .core.database import init_db, get_db, SessionLocal
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from .core.security import CacheControlMiddleware, RateLimitMiddleware, AccessLogMiddleware
from .routers import auth, scripts, review, admin, announcements, user, game, npc, tts, stt, npc_config, notification, ai_proxy, stats, host, client_log


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动/关闭生命周期"""
    init_db()
    from .seed import seed_all
    seed_all(SessionLocal())
    # 初始化 NPC 配置文件目录，将 DB 提示词同步到文件
    from .services import npc_file_service
    npc_file_service.init_npc_dirs()
    # 注：提示词以文件系统为唯一可信源，不再做 DB→文件覆盖式同步，
    # 避免服务器重启把站长后台的修改冲掉（见 #8 修复）。
    yield


app = FastAPI(
    title="AI剧本网",
    description="AI剧本网——海龟汤、DND、COC、剧本扮演分享与下载平台",
    version="4.0.0",
    lifespan=lifespan,
)

# 中间件
# 显式声明「只信任本机 nginx 传来的 X-Forwarded-For」。
# 游客计数（提示/提问次数）按 IP 算，靠的就是这一层：不信任的地址填的 XFF 会被丢弃。
# 不写这一句也能工作，但它依赖 uvicorn 的隐式默认（proxy_headers=True、
# forwarded_allow_ips="127.0.0.1"）——哪天启动参数或服务器一换，计数立刻能被同一个头绕过。
# 审计 S7 点名过这个隐性依赖，这里把它写死。
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=["127.0.0.1"])
app.add_middleware(CacheControlMiddleware)
app.add_middleware(RateLimitMiddleware, max_requests=30, window_seconds=10)
app.add_middleware(AccessLogMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 路由
app.include_router(auth.router)
app.include_router(scripts.router)
app.include_router(review.router)
app.include_router(admin.router)
app.include_router(announcements.router)
app.include_router(user.router)
app.include_router(game.router)
app.include_router(npc.router)
app.include_router(tts.router)
app.include_router(stt.router)
app.include_router(npc_config.router)
app.include_router(notification.router)
app.include_router(ai_proxy.router)
app.include_router(stats.router)
app.include_router(host.router)
app.include_router(client_log.router)


# 公开站点设置接口
@app.get("/api/site-settings")
def public_site_settings(db: Session = Depends(get_db)):
    from .services.site_service import get_site_settings
    return get_site_settings(db)


# 静态文件
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
def index():
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"message": "AI剧本网 API 服务运行中", "docs": "/docs"}


@app.get("/health")
def health():
    """活着 ≠ 能用。原来只回一个 ok，进程能应答就算健康：

    ① 数据库连不上/表结构漂移 —— 照样 200；
    ② `--workers 2` 下父进程持有监听 socket，**一个 worker 崩了 /health 仍然 200**
       （所以 deploy.sh 的「活过来」实际只等于 uvicorn 起来了，审计 建议-5）。

    这里做两件微秒级的实事：**验数据库连接能不能开**、**验提示词目录读不读得到**。
    措辞要准：这验的是「连通性」，不是「可用性」——`SELECT 1` 不读任何表也不取锁，
    所以表被锁死、schema 漂移、库文件损坏它都查不出来（审计 H6）。之所以故意用不取锁的写法，
    是因为反过来会误伤：高峰期偶发 `database is locked` 会让 /health 偶发 503，
    部署脚本从此把正常部署判成失败。

    worker 各自的存活由返回里的 pid 暴露给调用方对账（连打几次看是不是两个 pid）。
    503 时**只回错误码**：异常原文里有 `/opt/turtlesoup/data/...` 这类绝对路径与 SQL 片段，
    而这个端点无鉴权（审计 N3）。
    """
    import logging
    import os
    problems = []
    try:
        from sqlalchemy import text
        from .core.database import engine
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as exc:
        problems.append("db: %s" % exc)
    try:
        # 提示词是文件系统的唯一可信源（契约 §5），目录读不出来等于主持人没台词
        os.listdir(os.path.join(FRONTEND_DIR, "..", "npc_configs", "shared", "prompts"))
    except Exception as exc:
        problems.append("npc_configs: %s" % exc)

    if problems:
        logging.getLogger("uvicorn.error").error("健康检查失败：%s", "；".join(problems))
        from fastapi import HTTPException
        raise HTTPException(status_code=503, detail={"code": "unhealthy"})
    return {"status": "ok", "pid": os.getpid()}


@app.get("/api/version")
def version():
    """本次部署的构建标识。

    deploy.sh 每次推送后会在服务器上写一个 BUILD 文件（推送时间、来源、文件清单）。
    这个接口把它读出来，用来回答「线上跑的到底是哪一版」——
    线上没有 git 仓库，没有这个接口就只能靠猜。
    """
    build_path = os.path.join(os.path.dirname(__file__), "..", "BUILD")
    info = {"status": "no BUILD file"}
    try:
        with open(build_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    info[k.strip()] = v.strip()
        info["status"] = "ok"
    except FileNotFoundError:
        pass
    except Exception as e:                      # 读失败也不能让服务 500
        info["status"] = "error: " + type(e).__name__
    return info
