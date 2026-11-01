"""数据库引擎与会话管理"""
import os
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, declarative_base
from .config import DATABASE_URL, DATA_DIR

os.makedirs(DATA_DIR, exist_ok=True)

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI 依赖注入：提供数据库会话"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _add_column_if_missing(table: str, column: str, col_def: str):
    """SQLite 幂等加列：表已存在但缺少某列时执行 ALTER TABLE ADD COLUMN"""
    with engine.connect() as conn:
        existing = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
        if column not in existing:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_def}"))
            conn.commit()


def init_db():
    """初始化数据库表，并对已存在的库补齐缺失列（兼容旧数据）"""
    Base.metadata.create_all(bind=engine)
    # 结束条件：海龟汤新增字段，与汤底同级保密
    _add_column_if_missing("scripts", "ending_condition", "TEXT NOT NULL DEFAULT ''")
    # 胜利/失败条件表（JSON 字符串）：条件系统核心字段
    _add_column_if_missing("scripts", "endings", "TEXT NOT NULL DEFAULT ''")
    # 任务条件表（JSON 字符串）：任务完成触发自定义效果（揭示线索/给予道具/通知 NPC）
    _add_column_if_missing("scripts", "tasks", "TEXT NOT NULL DEFAULT ''")
    # 主持指导词（作者可选填写，注入 NPC 主持提示词）
    _add_column_if_missing("scripts", "host_guide", "TEXT NOT NULL DEFAULT ''")
    # 实名认证（国家网络身份认证公共服务 / 网号网证）：仅存核验结果，不留存身份证件信息
    _add_column_if_missing("users", "realname_verified", "BOOLEAN NOT NULL DEFAULT 0")
    _add_column_if_missing("users", "realname_adult", "BOOLEAN NOT NULL DEFAULT 0")
    _add_column_if_missing("users", "realname_verified_at", "DATETIME")
    # 账号注销（个人信息删除权，GB/T 35273）：软删除标记
    _add_column_if_missing("users", "is_deleted", "BOOLEAN NOT NULL DEFAULT 0")
    # 上面这张手写清单永远会漏。改成每次启动按模型声明自动补齐（见 _sync_columns），
    # 手写那几条留着是因为它们带 NOT NULL DEFAULT，自动补列只能补成可空。
    _sync_columns()


def _sync_columns():
    """按模型声明，把库里缺的列补上。

    为什么需要：`Base.metadata.create_all()` 只建**不存在的表**，对已存在的表一个字段都不加。
    所以给模型加一个字段，在老库上不会生效——本地新库跑得好好的，一到线上旧库就
    `no such column: scripts.synopsis`，整个接口 500。这不是假想：本地开发库实测缺 10 列。

    取舍：ALTER TABLE ADD COLUMN 在 SQLite 里不能加「NOT NULL 且无默认值」的列，
    因此这里补出来的列一律可空（模型声明有默认值的带上 DEFAULT）。
    也就是说「老库补出来的列」和「新库建出来的列」在 NOT NULL 上可能不完全一致，
    但读出来的值是一样的，不会 500。要严格一致得上重建表的新迁移框架，那是后话。
    """
    # 模型必须先注册，metadata 里才有表。正常启动路径（main.py 导入 routers）已经注册了，
    # 但单独跑脚本调 init_db 时可能还没有，这里兜一层。
    try:
        from .. import models  # noqa: F401
    except Exception:
        pass

    added = []
    with engine.connect() as conn:
        existing_tables = {r[0] for r in conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table'"))}
        for table in Base.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue
            have = {r[1] for r in conn.execute(
                text("PRAGMA table_info(%s)" % table.name))}
            for col in table.columns:
                if col.name in have or col.primary_key:
                    continue
                try:
                    col_type = col.type.compile(engine.dialect)
                except Exception:
                    col_type = "TEXT"
                ddl = "ALTER TABLE %s ADD COLUMN %s %s" % (table.name, col.name, col_type)
                default = None
                if getattr(col, "server_default", None) is not None:
                    default = str(col.server_default.arg)
                elif col.default is not None and getattr(col.default, "is_scalar", False):
                    v = col.default.arg
                    if isinstance(v, bool):
                        default = "1" if v else "0"
                    elif isinstance(v, (int, float)):
                        default = str(v)
                    elif isinstance(v, str):
                        default = "'%s'" % v.replace("'", "''")
                if default is not None:
                    ddl += " DEFAULT %s" % default
                conn.execute(text(ddl))
                added.append("%s.%s" % (table.name, col.name))
        if added:
            conn.commit()
    if added:
        print("[db] 已补齐缺失列：%s" % ", ".join(added))
