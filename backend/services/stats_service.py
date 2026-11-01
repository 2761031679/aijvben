"""用户数据统计与成就引擎（v4.6c 新增）

设计原则：
- 事件点同事务计数器 ±1（点赞/通关/上传/关注时顺带更新），无定时聚合，写入开销 O(1)；
- 成就引擎：每个事件点后只检查该事件相关的 auto 成就（阈值比较，索引查询）；
- 等级由经验换算（写入时重算，公式见 level_of），零新增读负荷。

经验/金币规则（集中在此，便于调整）：
- 通关剧本（首次）：经验 +100，金币 +50
- 上传剧本：经验 +50
- 作品获得点赞：经验 +2
"""
from datetime import datetime, timezone
from sqlalchemy.orm import Session

from ..models.stats import UserStats, Completion, Achievement, UserAchievement, Follow
from ..models.user import User
from .notification_service import create_notification

# 经验/金币规则
EXP_COMPLETE = 100
EXP_UPLOAD = 50
EXP_LIKE_RECEIVED = 2
COINS_COMPLETE = 50


def level_of(exp: int) -> int:
    """经验 → 等级：level = floor(sqrt(exp/100)) + 1
    （100 经验升 2 级，400 升 3 级，900 升 4 级……越往后越慢）"""
    return int((max(exp, 0) / 100) ** 0.5) + 1


def ensure(db: Session, user_id: str) -> UserStats:
    """取用户统计行，不存在则创建"""
    stats = db.query(UserStats).filter(UserStats.user_id == user_id).first()
    if not stats:
        stats = UserStats(user_id=user_id)
        db.add(stats)
        db.flush()
    return stats


def _add_exp(stats: UserStats, amount: int) -> bool:
    """加经验并重算等级，返回是否升级"""
    old_level = stats.level or 1
    stats.exp = (stats.exp or 0) + amount
    stats.level = level_of(stats.exp)
    return stats.level > old_level


def add_tokens(db: Session, user_id: str, total_tokens: int) -> None:
    """记录一次 AI 调用的 token 消耗（前端直连上报 / 后端代理提取）"""
    if not user_id or total_tokens <= 0:
        return
    stats = ensure(db, user_id)
    stats.tokens_used = (stats.tokens_used or 0) + int(total_tokens)
    db.commit()
    check_achievements(db, user_id, {"tokens_used"})


def count_uploaded(db: Session, user_id: str) -> int:
    """真值：这个人名下有幾個没删的剧本。

    为什么不继续用 +1：`scripts_uploaded` 自 v4.6c 起是个**事件累加器**，可它统计的东西
    （剧本行）本来就在库里 —— 存量剧本从没被回填过、删掉的也不减，于是后台按行数数出 4、
    个人中心按计数器显示 0（用户实测的两个数字对不上）。真值只有一个来源：他的 Script 行，
    计数器只是它的缓存。
    「没删」口径与后台 total_scripts、个人档案 scripts_count 一致（都不看过审状态），
    否则三个地方又会各说一套。
    """
    from ..models.script import Script
    return db.query(Script).filter(
        Script.user_id == user_id, Script.is_deleted == False  # noqa: E712
    ).count()


def sync_scripts_uploaded(db: Session, user_id: str) -> UserStats:
    """把缓存值对齐到真值。幂等：重复调用不会因为同一条剧本再加一次（不 commit，由调用方决定）。"""
    stats = ensure(db, user_id)
    stats.scripts_uploaded = count_uploaded(db, user_id)
    return stats


def on_script_uploaded(db: Session, user_id: str) -> None:
    """剧本上传成功：先对齐真值，只有在「真的比缓存多」时才发一次上传经验。

    幂等：同一剧本再提交一遍（编辑后重新提审、连点提交）不会再加计数 —— 计数来自行数，
    不是 +1。经验也只在真值变大时发一份：既不给重复提交刷经验，也不会让存量用户
    下次登录时被补发一大堆。
    """
    stats = ensure(db, user_id)
    before = stats.scripts_uploaded or 0
    real = count_uploaded(db, user_id)
    stats.scripts_uploaded = real
    if real > before:
        _add_exp(stats, EXP_UPLOAD)
    db.commit()
    check_achievements(db, user_id, {"scripts_uploaded"})


def on_like_changed(db: Session, author_id: str, like_type: str, active: bool) -> None:
    """作品被点赞/点踩（active=True 新增，False 取消）。不计作者本人操作。"""
    if not author_id:
        return
    stats = ensure(db, author_id)
    field = "likes_received" if like_type == "like" else "dislikes_received"
    delta = 1 if active else -1
    stats.__setattr__(field, max(0, (getattr(stats, field) or 0) + delta))
    if like_type == "like" and active:
        _add_exp(stats, EXP_LIKE_RECEIVED)
    db.commit()
    if like_type == "like":
        check_achievements(db, author_id, {"likes_received"})


def on_sub_changed(db: Session, author_id: str, delta: int) -> None:
    """作品被收藏/取消收藏"""
    if not author_id:
        return
    stats = ensure(db, author_id)
    stats.subs_received = max(0, (stats.subs_received or 0) + delta)
    db.commit()
    if delta > 0:
        check_achievements(db, author_id, {"subs_received"})


def on_follow(db: Session, follower_id: str, followee_id: str) -> None:
    """关注：双方计数 +1"""
    s1 = ensure(db, follower_id)
    s1.following_count = (s1.following_count or 0) + 1
    s2 = ensure(db, followee_id)
    s2.follower_count = (s2.follower_count or 0) + 1
    db.commit()
    check_achievements(db, followee_id, {"follower_count"})


def on_unfollow(db: Session, follower_id: str, followee_id: str) -> None:
    s1 = ensure(db, follower_id)
    s1.following_count = max(0, (s1.following_count or 0) - 1)
    s2 = ensure(db, followee_id)
    s2.follower_count = max(0, (s2.follower_count or 0) - 1)
    db.commit()


def on_script_completed(db: Session, user_id: str, script_id: str,
                        ending_id: str = "", ending_name: str = "") -> dict:
    """通关结算（仅胜利调用）：写通关记录 + 通关数/经验/金币，返回奖励明细供结算面板展示。
    重复通关同一剧本只更新结局记录，不重复计数/发奖。"""
    stats = ensure(db, user_id)
    existing = db.query(Completion).filter(
        Completion.user_id == user_id, Completion.script_id == script_id
    ).first()

    rewards = {"first_time": not existing, "exp_gained": 0, "coins_gained": 0,
               "level": stats.level or 1, "new_achievements": []}

    if existing:
        # 重复通关：更新达成的结局，不重复发奖
        existing.ending_id = ending_id or existing.ending_id
        existing.ending_name = ending_name or existing.ending_name
        db.commit()
        return rewards

    db.add(Completion(user_id=user_id, script_id=script_id,
                      ending_id=ending_id or "", ending_name=ending_name or ""))
    stats.scripts_completed = (stats.scripts_completed or 0) + 1
    stats.coins = (stats.coins or 0) + COINS_COMPLETE
    _add_exp(stats, EXP_COMPLETE)
    rewards["exp_gained"] = EXP_COMPLETE
    rewards["coins_gained"] = COINS_COMPLETE
    rewards["level"] = stats.level
    db.commit()

    rewards["new_achievements"] = [
        a.to_dict() for a in check_achievements(db, user_id, {"scripts_completed"})
    ]
    return rewards


def check_achievements(db: Session, user_id: str, rule_keys: set) -> list:
    """成就引擎：检查该事件相关的 auto 成就，达标即发放。返回本次新发放的成就列表。"""
    if not rule_keys:
        return []
    stats = ensure(db, user_id)
    granted = db.query(UserAchievement.achievement_id).filter(
        UserAchievement.user_id == user_id).all()
    granted_ids = {g[0] for g in granted}
    candidates = db.query(Achievement).filter(
        Achievement.enabled == True,  # noqa: E712
        Achievement.trigger_type == "auto",
        Achievement.rule_key.in_(rule_keys),
    ).all()
    newly = []
    for ach in candidates:
        if ach.id in granted_ids:
            continue
        value = getattr(stats, ach.rule_key, 0) or 0
        if value >= (ach.threshold or 1):
            _grant(db, stats, user_id, ach, source="auto")
            newly.append(ach)
    if newly:
        db.commit()
    return newly


def grant_manual(db: Session, user_id: str, achievement_id: str) -> bool:
    """站长手动颁发成就。返回是否成功（已拥有/成就不存在返回 False）"""
    ach = db.query(Achievement).filter(Achievement.id == achievement_id).first()
    if not ach:
        return False
    exists = db.query(UserAchievement).filter(
        UserAchievement.user_id == user_id,
        UserAchievement.achievement_id == achievement_id,
    ).first()
    if exists:
        return False
    stats = ensure(db, user_id)
    _grant(db, stats, user_id, ach, source="manual")
    db.commit()
    return True


def _grant(db: Session, stats: UserStats, user_id: str, ach: Achievement, source: str) -> None:
    """发放成就：记录 + 成就分累加 + 站内通知（不落 _add_exp，成就分独立于经验）"""
    db.add(UserAchievement(user_id=user_id, achievement_id=ach.id, source=source))
    stats.achievement_points = (stats.achievement_points or 0) + (ach.points or 0)
    db.flush()
    try:
        create_notification(
            db, user_id, "system",
            f"获得成就 {ach.icon}「{ach.name}」",
            f"{ach.description or ''}（成就分 +{ach.points or 0}）",
        )
    except Exception:
        pass  # 通知失败不影响成就发放


def get_user_achievements(db: Session, user_id: str) -> list:
    """用户已获得的成就（含发放时间与来源）"""
    rows = db.query(UserAchievement, Achievement).join(
        Achievement, UserAchievement.achievement_id == Achievement.id
    ).filter(UserAchievement.user_id == user_id).order_by(UserAchievement.created_at.desc()).all()
    return [
        {**ach.to_dict(), "source": ua.source,
         "earned_at": ua.created_at.isoformat() if ua.created_at else None}
        for ua, ach in rows
    ]


def proficiency_of(stats: UserStats) -> str:
    """玩家熟练度档位（历史数据初始参考）：
    - veteran 老玩家：通关>=13 或 上传>=3 或 成就分>=200
    - new     新玩家：通关<=4 且 上传=0 且 成就分<=30
    - regular 普通玩家：其余
    LLM 结合玩家实时表现做最终校准，冲突时以实时表现为准。"""
    completed = stats.scripts_completed or 0
    uploaded = stats.scripts_uploaded or 0
    points = stats.achievement_points or 0
    if completed >= 13 or uploaded >= 3 or points >= 200:
        return "veteran"
    if completed <= 4 and uploaded == 0 and points <= 30:
        return "new"
    return "regular"


def stats_to_dict(stats: UserStats) -> dict:
    return {
        "tokens_used": stats.tokens_used or 0,
        "scripts_completed": stats.scripts_completed or 0,
        "scripts_uploaded": stats.scripts_uploaded or 0,
        "likes_received": stats.likes_received or 0,
        "dislikes_received": stats.dislikes_received or 0,
        "subs_received": stats.subs_received or 0,
        "coins": stats.coins or 0,
        "coins_spent": stats.coins_spent or 0,
        "achievement_points": stats.achievement_points or 0,
        "exp": stats.exp or 0,
        "level": stats.level or 1,
        "following_count": stats.following_count or 0,
        "follower_count": stats.follower_count or 0,
        "proficiency": proficiency_of(stats),
    }
