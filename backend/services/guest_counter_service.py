"""轻量计数：游客也要计数的场景（目前是「提示次数」）。

存在的理由很具体：`/api/game/{id}/hint` 原来只在登录时计数，游客不计——
于是不带账号就能把汤底一句一句全拉出来。计数必须落库，
生产跑 2 个 worker，放内存等于各数一份。
"""
import hashlib

from sqlalchemy.exc import IntegrityError

from ..models.system import GuestCounter


def subject_for(request, user):
    """计数主体：登录了按账号，没登录按 IP（只存哈希，不落明文 IP）。"""
    if user is not None:
        return "u:%s" % user.id
    ip = ""
    if request is not None:
        ip = getattr(getattr(request, "client", None), "host", "") or ""
    return "ip:%s" % hashlib.sha256(ip.encode("utf-8")).hexdigest()[:24]


def purge_old_scopes(db, prefix, keep_days=7):
    """清掉带日期后缀的旧 scope（`host_start:2026-10-31` 这种），否则每天长一行、永不清理。

    每次 bump 都顺手做一次（表里最多「限额 × 保留天数」行，删一次是毫秒级），
    不再用「千分之一概率」——这个站一天才开几次房，千分之一等于永不执行（审计 N5）。

    两个措辞上的坑，别改回去：
    1. 不能用 `like(prefix + ":%")`：`_` 在 LIKE 里是**通配符**，`host_start:%` 会连
       `hostXstart:...` 一起匹配。这里改用半开区间 `[prefix+":", prefix+";")`——
       `:` 是 0x3A、`;` 是 0x3B，正好是「以 prefix+':' 开头」的精确等价，且不经过 LIKE。
    2. 日期是零填充的 ISO，字典序 = 时间序，所以 `<` 比较是对的。
    """
    import datetime as _dt
    cutoff = (_dt.datetime.utcnow() - _dt.timedelta(days=keep_days)).strftime("%Y-%m-%d")
    lo = prefix + ":"
    hi = prefix + ";"          # ';' = ':' + 1，用来框住「以前缀+冒号开头」这一段
    try:
        n = db.query(GuestCounter).filter(
            GuestCounter.scope >= lo,
            GuestCounter.scope < hi,
            GuestCounter.scope < (prefix + ":" + cutoff),
        ).delete(synchronize_session=False)
        db.commit()
        return n
    except Exception:
        db.rollback()
        return 0


def peek(db, scope, subject, script_id=""):
    row = db.query(GuestCounter).filter(
        GuestCounter.scope == scope,
        GuestCounter.subject == subject,
        GuestCounter.script_id == (script_id or ""),
    ).first()
    return int(row.counter) if row else 0


def bump(db, scope, subject, script_id="", limit=None):
    """用掉一次。返回 (已用次数, 是否还在限额内)。超限不写入。"""
    row = db.query(GuestCounter).filter(
        GuestCounter.scope == scope,
        GuestCounter.subject == subject,
        GuestCounter.script_id == (script_id or ""),
    ).first()
    used = int(row.counter) if row else 0
    if limit is not None and used >= limit:
        return used, False
    if row is None:
        row = GuestCounter(scope=scope, subject=subject,
                           script_id=(script_id or ""), counter=0)
        db.add(row)
    row.counter = used + 1
    try:
        db.commit()
    except IntegrityError:
        # 生产跑 2 个 worker：同一主体的第一个请求可能同时插入，撞唯一键。
        # 这不是绕过，只是会把首次请求打成 500，所以退回去再数一次。
        db.rollback()
        row = db.query(GuestCounter).filter(
            GuestCounter.scope == scope,
            GuestCounter.subject == subject,
            GuestCounter.script_id == (script_id or ""),
        ).first()
        used = int(row.counter) if row else 0
        if limit is not None and used >= limit:
            return used, False
        row.counter = used + 1
        db.commit()
    return row.counter, True
