"""站点设置业务逻辑"""
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session
from fastapi import HTTPException

from ..models.user import User
from ..models.system import SiteSettings, Announcement, OwnerChangeLog
from ..models.npc import NpcReviewLog, AiErrorReport


# 默认设置
DEFAULT_SETTINGS = {
    "visible_categories": ["hai-gui-tang", "dnd", "coc", "ju-ben-ban-yan"],
    "hidden_scripts": [],
    "visible_npcs": ["mo", "qing", "yan"],
    "npc_layouts": {},
    "npc_layout": {"right": 6, "top": 10, "size": 80, "frame_w": 180, "frame_h": 240},
    "desk_layout": {"height_vh": 22},
    "edge_tts_voice_map": {
        "zh_male_qingrun": "zh-CN-YunxiNeural",
        "zh_female_shuangkuai": "zh-CN-XiaoyiNeural",
        "zh_male_wanzi": "zh-CN-YunjianNeural",
    },
    # 首页轮播海报：banners 为空数组时不展示海报模块
    "home_banners": {"enabled": True, "interval": 4000, "banners": []},
    # 免费体验活动：游客 ip_limit 次 / 账号无限（user_unlimited）
    "free_trial_config": {
        "enabled": True,
        "ip_limit": 10,
        "user_unlimited": True,
        "user_limit": 3,
        "start_at": "",
        "end_at": "",
    },
    # BGM 背景音乐：文件列表 + 场景映射 + 默认音量（用户可在本地覆盖场景映射与音量）
    "bgm_config": {
        "base_url": "/static/audio/bgm/",
        "default_volume": 35,
        "files": [
            {"id": "default", "name": "Daydream", "file": "BGM-默认.mp3"},
            {"id": "turtle_soup", "name": "Cloud in a Cup", "file": "BGM-海龟汤.mp3"},
            {"id": "mischief", "name": "Little Devil", "file": "BGM-小恶作剧.mp3"},
            {"id": "happy", "name": "Dawn's Trumpet", "file": "BGM-欢快.mp3"},
        ],
        "scenes": {
            "main": "default",
            "turtle_soup": "turtle_soup",
        },
    },
}


# 哪些设置项里含有「不能对外」的字段 —— 对外返回前必须剔除。
# 新增任何带密钥/令牌的配置时，**一定要在这里登记**，
# 否则会跟 free_ai_config 一样被整行原样吐给所有访客（2026-10-28 修过一次）。
SECRET_FIELDS = {
    "free_ai_config": ("api_key",),
}


def _public_setting_value(key: str, value):
    """把一个设置项转成可以对外返回的形状：剔除登记过的密钥字段，其余原样返回。"""
    fields = SECRET_FIELDS.get(key)
    if not fields or not isinstance(value, dict):
        return value
    return {k: v for k, v in value.items() if k not in fields}


def append_bgm_file(db: Session, title: str, filename: str) -> dict:
    """把一首新上传的 BGM 登记进 bgm_config.files，返回更新后的 bgm_config。

    只做「存文件 + 记一条」：曲名取文件名（调用方已截断），id 随机。
    不做"自动识别曲风"——识别错了比不识别更糟，场景映射仍由玩家在设置里自己选。
    """
    row = db.query(SiteSettings).filter(SiteSettings.key == "bgm_config").first()
    if row is not None and isinstance(row.value, dict):
        cfg = dict(row.value)
    else:
        cfg = json.loads(json.dumps(DEFAULT_SETTINGS["bgm_config"]))
    files = list(cfg.get("files") or [])
    files.append({"id": "u_" + uuid.uuid4().hex[:8], "name": title, "file": filename})
    cfg["files"] = files
    if row is not None:
        row.value = cfg
    else:
        db.add(SiteSettings(key="bgm_config", value=cfg))
    db.commit()
    return cfg


def get_site_settings(db: Session) -> dict:
    """获取站点设置（公开）。

    注意：这个函数的结果会被**未登录访客**直接读到（/api/site-settings 与
    /api/admin/site-settings 都走这里），所以任何密钥字段都必须经
    _public_setting_value 剔除。需要明文密钥的内部调用请用 get_free_ai_secret()。
    """
    rows = db.query(SiteSettings).all()
    result = {}
    for r in rows:
        result[r.key] = _public_setting_value(r.key, r.value)
    for k, v in DEFAULT_SETTINGS.items():
        if k not in result:
            result[k] = v
    return result


def save_site_setting(db: Session, user: User, key: str, value: dict | list | str) -> dict:
    """保存站点设置"""
    if user.role not in ("admin", "owner"):
        raise HTTPException(403, "需要管理员权限")

    setting = db.query(SiteSettings).filter(SiteSettings.key == key).first()
    if setting:
        setting.value = value
        setting.updated_by = user.id
        setting.updated_at = datetime.now(timezone.utc)
    else:
        setting = SiteSettings(key=key, value=value, updated_by=user.id)
        db.add(setting)
    db.commit()
    return {"message": "设置已保存"}


# ========== 免费海龟汤 AI 模型配置（仅站长） ==========

FREE_AI_CONFIG_KEY = "free_ai_config"


def _as_int(v, default: int = 0) -> int:
    """把站点设置里的数字读成 int（站点设置是 JSON，历史数据可能是字符串/空）。"""
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


#: 免费额度的默认上限（元 / 每人每天）。站长可在「免费 AI 配置」里改；0 = 不限。
DEFAULT_BUDGET_RMB = 10.0

#: 默认单价（元 / 百万 token）。分三段是因为缓存命中的输入通常便宜一个数量级，
#: 只按 total_tokens 折算会把花费系统性高估。数字按 DeepSeek 官网公开价量级填，
#: 换模型一定要在后台改这三格，否则算出来的「已花多少元」只是看着像。
DEFAULT_PRICE_PER_M = {"input_miss": 2.0, "input_hit": 0.5, "output": 8.0}


def _as_float(v, default: float = 0.0) -> float:
    """把站点设置里的数字读成 float（站点设置是 JSON，历史数据可能是字符串/空）。"""
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _get_free_ai_prices(db: Session) -> dict:
    """免费通道的三段单价（元/百万 token）。缺项用默认值补。"""
    setting = db.query(SiteSettings).filter(SiteSettings.key == FREE_AI_CONFIG_KEY).first()
    cfg = setting.value if setting and isinstance(setting.value, dict) else {}
    raw = cfg.get("price_per_m") if isinstance(cfg.get("price_per_m"), dict) else {}
    out = {}
    for k, dv in DEFAULT_PRICE_PER_M.items():
        out[k] = max(0.0, _as_float(raw.get(k), dv))
    return out


def _get_free_ai_budget(db: Session) -> float:
    """免费通道的额度上限（元 / 每人每天，0 = 不限）。"""
    setting = db.query(SiteSettings).filter(SiteSettings.key == FREE_AI_CONFIG_KEY).first()
    cfg = setting.value if setting and isinstance(setting.value, dict) else {}
    return max(0.0, _as_float(cfg.get("budget_rmb"), DEFAULT_BUDGET_RMB))


def _get_free_ai_daily_limit(db: Session) -> int:
    """免费 AI 通道的每日上限（free_ai_config.daily_limit，0 = 不限）。"""
    setting = db.query(SiteSettings).filter(SiteSettings.key == FREE_AI_CONFIG_KEY).first()
    cfg = setting.value if setting and isinstance(setting.value, dict) else {}
    return max(0, _as_int(cfg.get("daily_limit"), 0))


#: 站点时区偏移（北京时间）。按天限额要按「玩家看到的今天」分窗：
#: 用 UTC 的话中国玩家会在早上 8 点回满，看着像 bug。
_SITE_TZ_HOURS = 8


def _site_today() -> str:
    """站点日期串（北京时间），给「按天重置」的计数分窗用。"""
    return (datetime.utcnow() + timedelta(hours=_SITE_TZ_HOURS)).strftime("%Y-%m-%d")


def get_free_ai_config(db: Session) -> dict:
    """获取免费海龟汤使用的 AI 模型配置（密钥掩码返回，不暴露明文）。"""
    setting = db.query(SiteSettings).filter(SiteSettings.key == FREE_AI_CONFIG_KEY).first()
    cfg = setting.value if setting else {}
    result = {
        "provider": cfg.get("provider", "deepseek"),
        "model": cfg.get("model", ""),
        "base_url": cfg.get("base_url", ""),
        # 每日上限：0 = 不限（默认）。这是站长唯一能拦住「免费通道被无限使用」的旋钮，
        # 见 check_free_quota 里的注释。
        "daily_limit": _as_int(cfg.get("daily_limit"), 0),
        # 免费额度上限（元/人/天）。0 = 不限。这是主闸：按真实花费算，比「次数」准确得多。
        "budget_rmb": _as_float(cfg.get("budget_rmb"), DEFAULT_BUDGET_RMB),
        # 单价（元 / 百万 token），按「缓存未命中输入 / 缓存命中输入 / 输出」三段分别计。
        # 默认值取自 DeepSeek 官网公开价量级，站长可在后台改；数字变了只改这里就够。
        "price_per_m": _get_free_ai_prices(db),
        # 今天全站免费通道花了多少元（站长看「离 10 元还有多远」用）
        "today_cost": round(float((_load_cost_ledger(db)[1]).get("today_cost") or 0.0), 4),
    }
    key = cfg.get("api_key", "") or ""
    result["api_key_masked"] = (key[:4] + "****" + key[-4:]) if len(key) > 8 else ("****" if key else "")
    return result


def save_free_ai_config(db: Session, user: User, data: dict) -> dict:
    """保存免费海龟汤 AI 模型配置（仅站长）。api_key 传入空或掩码值时不覆盖原密钥。"""
    if user.role != "owner":
        raise HTTPException(403, "需要站长权限")
    # 必须以数据库原始配置为底稿：get_free_ai_config() 是公开 DTO，
    # 已剔除 api_key，用它整份写回会在密钥框留空时把旧密钥删掉。
    setting = db.query(SiteSettings).filter(SiteSettings.key == FREE_AI_CONFIG_KEY).first()
    cfg = dict(setting.value) if setting and isinstance(setting.value, dict) else {}
    for k in ("provider", "model", "base_url"):
        if k in data and data[k] is not None:
            cfg[k] = data[k]
    if "daily_limit" in data and data["daily_limit"] is not None:
        cfg["daily_limit"] = max(0, _as_int(data["daily_limit"], 0))
    # 金额口径：budget_rmb = 每人每天的额度上限（元，0 = 不限）
    if "budget_rmb" in data and data["budget_rmb"] is not None:
        cfg["budget_rmb"] = max(0.0, _as_float(data["budget_rmb"], DEFAULT_BUDGET_RMB))
    # 单价三段（元/百万 token）。只覆盖传进来的那几格，没传的保持原值。
    if isinstance(data.get("price_per_m"), dict):
        cur = dict(cfg.get("price_per_m") or {})
        for k in ("input_miss", "input_hit", "output"):
            if k in data["price_per_m"] and data["price_per_m"][k] is not None:
                cur[k] = max(0.0, _as_float(data["price_per_m"][k], DEFAULT_PRICE_PER_M[k]))
        cfg["price_per_m"] = cur
    new_key = str(data.get("api_key", "") or "").strip()
    if new_key and "*" not in new_key:
        cfg["api_key"] = new_key
    # 展示派生字段不入库；api_key_masked 每次按真实 key 重新计算，避免旧空串残留。
    cfg.pop("api_key_masked", None)
    cfg.pop("today_cost", None)
    save_site_setting(db, user, FREE_AI_CONFIG_KEY, cfg)
    return {"message": "免费 AI 模型配置已保存"}


def get_free_ai_secret(db: Session) -> dict:
    """供后端免费调用内部读取：返回含明文密钥的完整配置（不对外暴露）。"""
    setting = db.query(SiteSettings).filter(SiteSettings.key == FREE_AI_CONFIG_KEY).first()
    cfg = setting.value if setting else {}
    return {
        "provider": cfg.get("provider", "deepseek"),
        "model": cfg.get("model", ""),
        "base_url": cfg.get("base_url", ""),
        "api_key": cfg.get("api_key", "") or "",
    }


# ========== 免费体验额度（IP / 账号） ==========

FREE_QUOTA_KEY = "free_trial_quota"
FREE_TRIAL_CONFIG_KEY = "free_trial_config"

DEFAULT_FREE_TRIAL = {
    "enabled": True,          # 活动总开关（手动关闭）
    "ip_limit": 10,           # 未登录：同一 IP 免费次数
    "user_unlimited": True,   # 已登录：账号免费无限次
    "user_limit": 3,          # user_unlimited=False 时的账号免费次数
    "start_at": "",           # 定时开始（ISO 或 "YYYY-MM-DD HH:MM"，空=不限）
    "end_at": "",             # 定时结束（空=不限）
}


def _parse_dt(s):
    """解析活动起止时间，返回带时区的 datetime；空/非法返回 None。"""
    s = str(s or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        try:
            dt = datetime.strptime(s, "%Y-%m-%d %H:%M")
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def get_free_trial_config(db: Session) -> dict:
    """获取免费体验活动配置（合并默认值）。"""
    setting = db.query(SiteSettings).filter(SiteSettings.key == FREE_TRIAL_CONFIG_KEY).first()
    cfg = setting.value if setting and isinstance(setting.value, dict) else {}
    merged = dict(DEFAULT_FREE_TRIAL)
    merged.update({k: v for k, v in cfg.items() if k in merged})
    return merged


def save_free_trial_config(db: Session, user: User, data: dict) -> dict:
    """保存免费体验活动配置（仅站长）。"""
    if user.role != "owner":
        raise HTTPException(403, "需要站长权限")
    cfg = get_free_trial_config(db)
    if "enabled" in data:
        cfg["enabled"] = bool(data["enabled"])
    if "user_unlimited" in data:
        cfg["user_unlimited"] = bool(data["user_unlimited"])
    for k in ("ip_limit", "user_limit"):
        if k in data and data[k] is not None:
            try:
                cfg[k] = max(0, int(data[k]))
            except (TypeError, ValueError):
                cfg[k] = DEFAULT_FREE_TRIAL[k]
    for k in ("start_at", "end_at"):
        if k in data:
            cfg[k] = str(data[k] or "").strip()
    save_site_setting(db, user, FREE_TRIAL_CONFIG_KEY, cfg)
    return {"message": "免费体验活动配置已保存"}


def _get_free_quota(db: Session) -> dict:
    setting = db.query(SiteSettings).filter(SiteSettings.key == FREE_QUOTA_KEY).first()
    val = setting.value if setting else {}
    return {"ips": dict(val.get("ips") or {}), "users": dict(val.get("users") or {})}


def _quota_subject(user, ip: str):
    """额度计数主体：登录按账号，未登录按 IP。返回 (主体串, 落在 quota 的哪个桶)。"""
    if user:
        return str(user.id), "users"
    return (ip or "unknown"), "ips"


def check_free_quota(db: Session, user, ip: str) -> tuple[bool, str]:
    """检查免费额度：先校验活动开关/定时，再按**当天**计次。返回 (是否放行, 拒绝原因)。

    为什么改成按天：旧实现把次数永久累加（`quota["users"][uid] += 1`，永不重置），
    于是 user_limit 一满就再也用不了、ip_limit 也是「这辈子 10 次」——
    跟「免费体验活动」这个名字对不上。现在计数键带日期（`<主体>@YYYY-MM-DD`），
    只看今天那一格；旧的无日期键在 record 时顺手清掉（那是错误口径的残留）。
    """
    cfg = get_free_trial_config(db)
    now = datetime.now(timezone.utc)

    if not cfg.get("enabled", True):
        return False, "免费体验活动已结束"
    start = _parse_dt(cfg.get("start_at"))
    end = _parse_dt(cfg.get("end_at"))
    if start and now < start:
        return False, "免费体验活动尚未开始"
    if end and now > end:
        return False, "免费体验活动已结束"

    quota = _get_free_quota(db)
    subject, bucket = _quota_subject(user, ip)
    count = int(quota[bucket].get("%s@%s" % (subject, _site_today())) or 0)

    # 站长在「免费 AI 配置」里设的每日上限：>0 时对**所有人**生效，包括 user_unlimited 的登录用户。
    # 这是唯一能拦住「免费额度被无限使用」的闸——以前 free_ai_config 里根本没这个字段，
    # 而 user_unlimited 默认 True，登录用户于是完全无上限（用户实测：@江辞 怎么用都用不完）。
    daily_limit = _get_free_ai_daily_limit(db)
    if daily_limit > 0 and count >= daily_limit:
        return False, "今日免费 AI 次数已用完（站点每日上限 %d 次），请在设置中配置自己的 API Key" % daily_limit

    # 金额闸：比「次数」准得多——一句话和二十句话都是一次，但花的钱差几十倍。
    # 放在 user_unlimited 之前，因为它是**所有人**的总闸（包括登录用户），
    # 否则「登录就无限」会把免费通道变成谁都能刷的公共钱包。
    budget = _get_free_ai_budget(db)
    if budget > 0:
        spent = get_subject_spent(db, user, ip)
        if spent >= budget:
            return False, "今日免费 AI 额度已用完（已花 %.2f 元 / 上限 %.2f 元），请在设置中配置自己的 API Key" % (spent, budget)

    if user:
        if cfg.get("user_unlimited", True):
            return True, ""
        if count >= int(cfg.get("user_limit", DEFAULT_FREE_TRIAL["user_limit"])):
            return False, "今日免费体验次数已用完，请在设置中配置自己的 API Key"
    else:
        if count >= int(cfg.get("ip_limit", DEFAULT_FREE_TRIAL["ip_limit"])):
            return False, "当前网络今日免费体验次数已用完，请注册登录后继续体验"
    return True, ""


def record_free_quota(db: Session, user, ip: str) -> None:
    """记录一次免费调用（IP 或账号维度、**按天** +1），直接写 SiteSettings，无需管理员权限。

    这个函数在每次「服务端免费通道调用成功」之后被无条件调用，所以它还顺手做两件事：

    1. 清掉该主体不在今天的旧计数键（含无日期的裸键——那是「永久累加」的错误口径）。
       不清理的话这张表每天长一行、永不回收。
    2. **记一次免费通道的调用次数**（free_trial_usage.total_calls）。

       为什么次数记在这里、不指望 game.py 里那句 record_free_trial_usage：
       那句被 `if total_tokens:` 包着，上游不回 usage（或回的不是 OpenAI 那种结构）
       时 token=0，于是一次都不记 —— 站长面板永远显示「0 次调用」。
       用户实测 @江辞 的 free_trial_usage 从来没更新过，就是这么来的。
       token 仍然由 record_free_trial_usage 累加（那边有真值时）。
    """
    quota = _get_free_quota(db)
    subject, bucket = _quota_subject(user, ip)
    keep = "%s@%s" % (subject, _site_today())
    for k in [k for k in quota[bucket] if k.split("@")[0] == subject and k != keep]:
        quota[bucket].pop(k, None)
    quota[bucket][keep] = int(quota[bucket].get(keep) or 0) + 1
    setting = db.query(SiteSettings).filter(SiteSettings.key == FREE_QUOTA_KEY).first()
    if setting:
        setting.value = quota
    else:
        db.add(SiteSettings(key=FREE_QUOTA_KEY, value=quota))
    # 记账失败不能把一次**已经成功**的 AI 调用打回 500（上游已经出了内容、token 已经花了）。
    # 宁可少记一次，也不能让玩家看到一个假报错 —— 与 _bump_trial_call 的处理对齐。
    try:
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logging.getLogger("uvicorn.error").warning("免费额度按天计数提交失败（已忽略）: %s", e)

    # 次数与额度分开记：额度管「还能不能用」，usage 管「站长面板上消耗了多少」。
    # 次数**只在这里**加，record_free_trial_usage 只管 token ——
    # 否则 game.py 里那两句依次调用（配额 + usage），每次成功会被数成两次。
    _bump_trial_call(db)


# ========== 免费额度的「花了多少钱」账本 ==========

FREE_COST_KEY = "free_trial_cost"


def _load_cost_ledger(db: Session):
    """取 free_trial_cost 那一行，顺手做按天翻页。

    为什么单独一个 key：`free_trial_quota` 里存的是**次数**（值是 int），
    往同一个字典里再塞 `{cost: ...}` 这种对象会让所有读它的地方都要先判类型；
    金额账本结构不同、生命周期也不同（要按主体按天留档），分开放最省事。
    """
    setting = db.query(SiteSettings).filter(SiteSettings.key == FREE_COST_KEY).first()
    val = dict(setting.value) if setting and isinstance(setting.value, dict) else {}
    today = _site_today()
    if val.get("day") != today:
        val["day"] = today
        val["today_cost"] = 0.0
        val["today_prompt"] = 0
        val["today_completion"] = 0
        # 只留今天的主体明细，昨天的扔掉：留着只为「今天谁还能用」，
        # 长期统计在 total_cost / total_prompt / total_completion 里。
        val["by_subject"] = {}
    val.setdefault("by_subject", {})
    return setting, val


def get_subject_spent(db: Session, user, ip: str) -> float:
    """某个主体今天已经花掉了多少元。"""
    subject, _bucket = _quota_subject(user, ip)
    _setting, val = _load_cost_ledger(db)
    row = val.get("by_subject", {}).get("%s@%s" % (subject, _site_today())) or {}
    return float(row.get("cost") or 0.0)


def cost_of(prompt_tokens: int, completion_tokens: int, cache_hit_tokens: int, prices: dict) -> float:
    """按三段单价折算一次调用花掉多少元。

    输入被拆成「命中缓存」与「未命中缓存」两段：只按 total 算会把便宜的那部分
    按贵的价格记，一天下来偏差能到几倍。cache_hit 缺省按 0 处理（宁可高估）。
    """
    prompt_tokens = max(0, int(prompt_tokens or 0))
    completion_tokens = max(0, int(completion_tokens or 0))
    cache_hit = min(prompt_tokens, max(0, int(cache_hit_tokens or 0)))
    miss = prompt_tokens - cache_hit
    return (
        miss / 1_000_000.0 * float(prices.get("input_miss") or 0)
        + cache_hit / 1_000_000.0 * float(prices.get("input_hit") or 0)
        + completion_tokens / 1_000_000.0 * float(prices.get("output") or 0)
    )


def record_free_usage_detail(db: Session, user, ip: str, prompt_tokens: int = 0,
                             completion_tokens: int = 0, cache_hit_tokens: int = 0) -> float:
    """记一次免费调用的 token 明细与折算花费，返回这次花掉多少元。

    与 `record_free_quota` 的分工：那边记「用了几次」（拦次数闸），这边记「花了多少钱」
    （拦金额闸）。两边都写不同的 key，所以不会被数成两次。
    """
    spent = 0.0
    try:
        prices = _get_free_ai_prices(db)
        spent = cost_of(prompt_tokens, completion_tokens, cache_hit_tokens, prices)
        subject, _bucket = _quota_subject(user, ip)
        setting, val = _load_cost_ledger(db)
        key = "%s@%s" % (subject, _site_today())
        row = dict(val["by_subject"].get(key) or {})
        row["cost"] = round(float(row.get("cost") or 0.0) + spent, 6)
        row["prompt"] = int(row.get("prompt") or 0) + max(0, int(prompt_tokens or 0))
        row["completion"] = int(row.get("completion") or 0) + max(0, int(completion_tokens or 0))
        val["by_subject"][key] = row
        val["today_cost"] = round(float(val.get("today_cost") or 0.0) + spent, 6)
        val["total_cost"] = round(float(val.get("total_cost") or 0.0) + spent, 6)
        val["today_prompt"] = int(val.get("today_prompt") or 0) + max(0, int(prompt_tokens or 0))
        val["today_completion"] = int(val.get("today_completion") or 0) + max(0, int(completion_tokens or 0))
        val["total_prompt"] = int(val.get("total_prompt") or 0) + max(0, int(prompt_tokens or 0))
        val["total_completion"] = int(val.get("total_completion") or 0) + max(0, int(completion_tokens or 0))
        if setting:
            setting.value = val
        else:
            db.add(SiteSettings(key=FREE_COST_KEY, value=val))
        db.commit()
        # 顺手把旧的 token 累计也更新上，站长面板的历史数字保持连续
        record_free_trial_usage(db, int(prompt_tokens or 0) + int(completion_tokens or 0))
    except Exception:
        db.rollback()   # 记账失败不能影响玩家对话
    return spent


def get_free_cost_summary(db: Session) -> dict:
    """金额账本的可读摘要（供站长面板）。"""
    _setting, val = _load_cost_ledger(db)
    return {
        "day": val.get("day"),
        "today_cost": round(float(val.get("today_cost") or 0.0), 4),
        "total_cost": round(float(val.get("total_cost") or 0.0), 4),
        "today_prompt": int(val.get("today_prompt") or 0),
        "today_completion": int(val.get("today_completion") or 0),
        "budget_rmb": _get_free_ai_budget(db),
        "price_per_m": _get_free_ai_prices(db),
        "subjects": len(val.get("by_subject") or {}),
    }


# ========== 免费活动 token 消耗统计 ==========

FREE_TRIAL_USAGE_KEY = "free_trial_usage"


def _load_trial_usage(db: Session):
    """取 free_trial_usage 那行（没有就返回 (None, {})），顺手做按天翻页。"""
    setting = db.query(SiteSettings).filter(SiteSettings.key == FREE_TRIAL_USAGE_KEY).first()
    val = dict(setting.value) if setting and isinstance(setting.value, dict) else {}
    today = _site_today()
    if val.get("day") != today:
        # 翻到新的一天：只清「今天」那两个数，历史总量继续累计。
        val["day"] = today
        val["today_calls"] = 0
        val["today_tokens"] = 0
    return setting, val


def _bump_trial_call(db: Session) -> None:
    """免费通道调用次数 +1。**由 record_free_quota 调用**，与上游是否回 usage 无关。

    为什么要单独一个函数：`record_free_trial_usage` 在 game.py 里被 `if total_tokens:`
    包着，上游不回 usage 时它根本不会被调用，于是「0 次调用」永远不动
    （用户实测 @江辞 的记录从没更新过）。次数必须挂在「成功调用之后无条件执行」
    的那个点上，也就是 record_free_quota。
    """
    try:
        setting, val = _load_trial_usage(db)
        val["total_calls"] = int(val.get("total_calls") or 0) + 1
        val["today_calls"] = int(val.get("today_calls") or 0) + 1
        if setting:
            setting.value = val
        else:
            db.add(SiteSettings(key=FREE_TRIAL_USAGE_KEY, value=val))
        db.commit()
    except Exception:
        db.rollback()   # 统计失败绝不影响主流程


def record_free_trial_usage(db: Session, total_tokens: int) -> None:
    """累加免费 AI 调用的 token 消耗（写 SiteSettings；失败静默，不阻断主流程）。

    职责边界（别改回去）：**这里只记 token，不记次数** —— 次数由 _bump_trial_call
    在 record_free_quota 里记。game.py 成功之后先调 record_free_quota、再调本函数，
    两边都 +1 的话每次调用会被数成两次。
    token <= 0 直接返回：没有数字可加，但「发生过一次调用」这件事已经由次数那边记下了
    （旧实现在**同一个函数**里用 token<=0 把次数也一起丢掉，那才是漏记的根因）。
    """
    try:
        total_tokens = int(total_tokens or 0)
    except (TypeError, ValueError):
        return
    if total_tokens <= 0:
        return
    try:
        setting, val = _load_trial_usage(db)
        val["total_tokens"] = int(val.get("total_tokens") or 0) + total_tokens
        val["today_tokens"] = int(val.get("today_tokens") or 0) + total_tokens
        if setting:
            setting.value = val
        else:
            db.add(SiteSettings(key=FREE_TRIAL_USAGE_KEY, value=val))
        db.commit()
    except Exception:
        db.rollback()


def get_free_trial_usage(db: Session) -> dict:
    """获取免费 AI 调用的累计 token 消耗（供站长统计面板）。

    顺带把金额账本（今天/累计花了多少元、上限多少、三段单价）一并返回——
    站长真正要看的是「今天花了多少钱、离 10 元还有多远」，不是 token 数。
    """
    setting = db.query(SiteSettings).filter(SiteSettings.key == FREE_TRIAL_USAGE_KEY).first()
    val = setting.value if setting and isinstance(setting.value, dict) else {}
    return {
        "total_tokens": int(val.get("total_tokens") or 0),
        "total_calls": int(val.get("total_calls") or 0),
        # 当天与上限：站长面板要能看出「今天用掉多少 / 上限多少」，
        # 否则「daily_limit 到底拦没拦」永远只能靠猜。
        "today": val.get("day") or "",
        "today_calls": int(val.get("today_calls") or 0),
        "today_tokens": int(val.get("today_tokens") or 0),
        "daily_limit": _get_free_ai_daily_limit(db),
        # 金额口径（站长真正要看的）
        "budget_rmb": _get_free_ai_budget(db),
        "today_cost": round(float((_load_cost_ledger(db)[1]).get("today_cost") or 0.0), 4),
        "total_cost": round(float((_load_cost_ledger(db)[1]).get("total_cost") or 0.0), 4),
        "price_per_m": _get_free_ai_prices(db),
    }


# ========== 首页轮播海报 ==========

BANNER_CONFIG_KEY = "home_banners"

DEFAULT_BANNERS = {"enabled": True, "interval": 4000, "banners": []}


def get_banner_config(db: Session) -> dict:
    """获取首页轮播海报配置（合并默认值）。banners 为空数组时前端不展示海报模块。"""
    setting = db.query(SiteSettings).filter(SiteSettings.key == BANNER_CONFIG_KEY).first()
    cfg = setting.value if setting and isinstance(setting.value, dict) else {}
    merged = dict(DEFAULT_BANNERS)
    merged.update({k: v for k, v in cfg.items() if k in merged})
    if not isinstance(merged.get("banners"), list):
        merged["banners"] = []
    try:
        merged["interval"] = max(1500, int(merged.get("interval", 4000)))
    except (TypeError, ValueError):
        merged["interval"] = 4000
    return merged


def save_banner_config(db: Session, user: User, data: dict) -> dict:
    """保存首页轮播海报配置（管理员/站长）。"""
    cfg = get_banner_config(db)
    if "enabled" in data:
        cfg["enabled"] = bool(data["enabled"])
    if "interval" in data and data["interval"] is not None:
        try:
            cfg["interval"] = max(1500, int(data["interval"]))
        except (TypeError, ValueError):
            cfg["interval"] = 4000
    if "banners" in data and isinstance(data["banners"], list):
        # 过滤：只保留含有效 image 的条目；link 缺省空串（点击不跳转）
        cleaned = []
        for b in data["banners"]:
            if not isinstance(b, dict):
                continue
            image = str(b.get("image") or "").strip()
            if not image:
                continue
            cleaned.append({
                "image": image,
                "link": str(b.get("link") or "").strip(),
                "title": str(b.get("title") or "").strip(),
            })
        cfg["banners"] = cleaned
    save_site_setting(db, user, BANNER_CONFIG_KEY, cfg)
    return {"message": "轮播海报配置已保存"}


def create_announcement(db: Session, user: User, title: str, content: str, is_pinned: bool = False) -> dict:
    """发布公告"""
    if user.role not in ("admin", "owner"):
        raise HTTPException(403, "需要管理员权限")

    ann = Announcement(title=title, content=content, author_id=user.id, is_pinned=is_pinned)
    db.add(ann)
    db.commit()
    db.refresh(ann)
    return ann.to_dict()


def list_announcements(db: Session, page: int = 1) -> dict:
    """公告列表（公开，置顶优先，排除已删除）"""
    q = db.query(Announcement).filter(Announcement.is_deleted == False)
    total = q.count()
    anns = q.order_by(Announcement.is_pinned.desc(), Announcement.created_at.desc()).offset((page - 1) * 20).limit(20).all()
    return {
        "announcements": [a.to_dict() for a in anns],
        "page": page,
        "total_pages": max(1, (total + 19) // 20),
    }


def update_announcement(db: Session, user: User, ann_id: str, data: dict) -> dict:
    """更新公告"""
    if user.role not in ("admin", "owner"):
        raise HTTPException(403, "需要管理员权限")
    ann = db.query(Announcement).filter(Announcement.id == ann_id).first()
    if not ann:
        raise HTTPException(404, "公告不存在")
    for field in ("title", "content", "is_pinned"):
        if field in data and data[field] is not None:
            setattr(ann, field, data[field])
    db.commit()
    return {"message": "公告已更新"}


def delete_announcement(db: Session, user: User, ann_id: str) -> dict:
    """软删除公告"""
    if user.role not in ("admin", "owner"):
        raise HTTPException(403, "需要管理员权限")
    ann = db.query(Announcement).filter(Announcement.id == ann_id).first()
    if not ann:
        raise HTTPException(404, "公告不存在")
    ann.is_deleted = True
    ann.deleted_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "已删除"}


# ========== NPC 配置管理（DB 同步） ==========

NPC_CONFIG_SETTINGS_KEY = "npc_personality_configs"


def get_npc_configs_from_db(db: Session) -> dict:
    """从 DB 获取 NPC 配置（仅作兜底）"""
    from . import npc_file_service
    setting = db.query(SiteSettings).filter(
        SiteSettings.key == NPC_CONFIG_SETTINGS_KEY
    ).first()
    stored = setting.value if setting else {}
    # 文件系统优先，DB 兜底
    file_configs = npc_file_service.get_all_npc_configs()
    # 合并：文件覆盖 DB
    return {**stored, **file_configs}


def sync_npc_config_to_db(db: Session, user: User, npc_id: str, personality_id: str, config: dict):
    """将文件系统配置同步到 DB（管理员保存后调用）"""
    config_key = f"{npc_id}:{personality_id}" if personality_id else npc_id

    setting = db.query(SiteSettings).filter(
        SiteSettings.key == NPC_CONFIG_SETTINGS_KEY
    ).first()

    all_configs = setting.value if setting else {}
    all_configs[config_key] = {
        "scale": config.get("scale", 80),
        "portrait_url": config.get("portrait_url", ""),
    }

    if setting:
        setting.value = all_configs
        setting.updated_by = user.id
        setting.updated_at = datetime.now(timezone.utc)
    else:
        setting = SiteSettings(
            key=NPC_CONFIG_SETTINGS_KEY,
            value=all_configs,
            updated_by=user.id,
        )
        db.add(setting)
    db.commit()


def get_stats(db: Session) -> dict:
    """获取管理统计"""
    from ..models.script import Script
    return {
        "total_users": db.query(User).count(),
        "total_scripts": db.query(Script).filter(Script.is_deleted == False).count(),
        "pending_reviews": db.query(Script).filter(
            Script.is_deleted == False, Script.review_status.in_(["draft", "pending_admin"])
        ).count(),
        "total_comments": db.query(Script).count(),  # 简化统计
        "ai_error_count": db.query(AiErrorReport).count(),
        "npc_review_log_count": db.query(NpcReviewLog).count(),
    }


def get_owner_logs(db: Session) -> list[dict]:
    """站长变更日志"""
    logs = db.query(OwnerChangeLog).order_by(OwnerChangeLog.created_at.desc()).limit(20).all()
    return [
        {"old_owner_id": l.old_owner_id, "new_owner_id": l.new_owner_id,
         "changed_by": l.changed_by, "created_at": str(l.created_at)}
        for l in logs
    ]
