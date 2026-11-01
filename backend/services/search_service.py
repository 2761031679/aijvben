"""统一的剧本搜索 / 筛选 / 排序服务。

搜索权重模型（关键词命中时累加）：
  标题命中        : +5
  简介命中        : +3
  标签精确匹配    : +4 + 标签点赞数 * 0.1
  标签模糊匹配    : +2 + 标签点赞数 * 0.05
  （标签点赞数同时为该作品增加搜索权重，满足需求②）

排序方式（sort）：
  relevance  : 按上述权重降序（默认：有关键词时）
  newest     : 创建时间降序（默认：无关键词时）
  oldest     : 创建时间升序
  popular    : 下载量降序
  rating     : 平均评分降序
  hot_likes  : 高点赞顺位（likes + 标签点赞总和 * 0.1）降序
  comments_24h : 24 小时内评论数顺位降序
"""
from datetime import datetime, timedelta, timezone
from sqlalchemy import or_, func, distinct, not_
from sqlalchemy.orm import Session

from ..models.script import Script, ScriptTag, ScriptTagLike, REVIEW_APPROVED
from ..models.script import VALID_CATEGORIES

# 排序方式白名单
SORT_MODES = ["relevance", "newest", "oldest", "popular", "rating", "hot_likes", "comments_24h"]
DEFAULT_NO_KEYWORD = "newest"
DEFAULT_WITH_KEYWORD = "relevance"


def _tag_likes_map(db: Session, script_ids: list) -> dict:
    """返回 {script_id: 标签点赞总数}。"""
    if not script_ids:
        return {}
    rows = db.query(ScriptTag.script_id, func.coalesce(func.sum(ScriptTag.likes), 0)).filter(
        ScriptTag.script_id.in_(script_ids)
    ).group_by(ScriptTag.script_id).all()
    return {r[0]: int(r[1] or 0) for r in rows}


def _comments_24h_map(db: Session, script_ids: list) -> dict:
    """返回 {script_id: 近 24h 评论数}。"""
    if not script_ids:
        return {}
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    # Comment.created_at 为字符串(YYYY-MM-DD HH:MM:SS)，用函数不便；改为 Python 端过滤
    from ..models.script import Comment
    comments = db.query(Comment).filter(Comment.script_id.in_(script_ids)).all()
    result = {sid: 0 for sid in script_ids}
    for c in comments:
        try:
            ct = datetime.strptime(c.created_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if ct >= since:
            result[c.script_id] = result.get(c.script_id, 0) + 1
    return result


def _weight(script: Script, keyword: str, tag_likes_total: int) -> float:
    kw = keyword.lower()
    w = 0.0
    if kw:
        title = (script.title or "").lower()
        syn = (script.synopsis or "").lower()
        story = (script.story or "").lower()
        if kw in title:
            w += 5
        if kw in syn:
            w += 3
        for tag in (script.tags or []):
            tl = tag.lower()
            if tl == kw:
                w += 4 + tag_likes_total * 0.1
            elif kw in tl:
                w += 2 + tag_likes_total * 0.05
        # 正文命中给一点弱信号，避免长文被完全忽略
        if kw in story:
            w += 1
    return w


def _match_keyword(script: Script, keyword: str) -> bool:
    """关键词是否**真的**命中这条剧本（子串匹配，单字也认）。

    为什么必须补这个函数：以前 keyword 只参与 `_weight` 的排序权重，从不筛除任何行 ——
    于是「搜熵」返回全站剧本（命中项混在里头，看着就是「搜不到」），「搜一个不存在的词」
    也照样返回一屏。搜索框的语义应该是「筛」，不是「排」。

    口径：
      · 大小写不敏感（casefold，中文无影响，英文标签友好）；
      · 子串匹配，**没有最小长度门槛** —— 中文单字（熵/酱/鬼）是正常查询；
      · 多个词按空格拆开，全部命中才算命中（AND），与用户直觉一致；
      · 搜标题、简介、正文（story）与标签。**不搜 explanation（汤底）**：
        否则「这个词在结果里出现了吗」就成了一个汤底探针，
        玩家可以拿它一比特一比特地把汤底问出来（审查 §10.1 的收口不能从搜索漏出去）。
    """
    kw = f"{keyword or ''}".strip().casefold()
    if not kw:
        return True
    hay = "\n".join([
        script.title or "",
        script.synopsis or "",
        script.story or "",
        " ".join(str(t) for t in (script.tags or [])),
    ]).casefold()
    return all(part in hay for part in kw.split())


def _match_tags(tags, include, exclude) -> bool:
    """判断脚本标签是否命中筛选：包含全部 include 且不含任何 exclude。"""
    tag_set = {str(t) for t in (tags or [])}
    for t in include:
        if t not in tag_set:
            return False
    for t in exclude:
        if t in tag_set:
            return False
    return True


def parse_query(keyword: str):
    """解析搜索栏内容：+标签 表示想要，-标签 表示不想要，其余为自由关键词。

    返回 (free_keyword, include_tags, exclude_tags)。
    """
    include, exclude, free = [], [], []
    for tok in (keyword or "").split():
        if tok.startswith("+"):
            t = tok[1:].strip()
            if t:
                include.append(t)
        elif tok.startswith("-"):
            t = tok[1:].strip()
            if t:
                exclude.append(t)
        else:
            free.append(tok)
    return " ".join(free), include, exclude


def get_hot_tags(db: Session, days: int = 30, limit: int = 20):
    """返回最近 days 天内最热门（使用次数最多）的标签；仅包含站点已有的标签。

    若近期没有任何标签，返回空列表（前端据此决定不渲染标签栏）。
    """
    since = datetime.now(timezone.utc) - timedelta(days=days)
    scripts = db.query(Script).filter(
        Script.is_deleted == False,
        Script.updated_at >= since,
    ).all()
    counter = {}
    for s in scripts:
        for t in (s.tags or []):
            counter[t] = counter.get(t, 0) + 1
    ranked = sorted(counter.items(), key=lambda x: (-x[1], x[0]))
    return [{"tag": t, "count": c} for t, c in ranked[:limit]]


def get_range_stats(db: Session) -> dict:
    """返回当前已通过审核剧本的点赞 / 点踩数值区间，供前端动态设置滑块上下限。

    动态浮动规则（实时随站点数据变化）：
      - 下限 = 站内实际最小值（无数据则 0）
      - 上限 = 站内实际最大值，并向上预留约 10% 余量后取整到友好刻度，
        使当前最高作品也能被选中且滑块不贴边；上限至少比下限大一档。
    前端将“滑到最小值”视为不限下限、“滑到最大值”视为不限上限。
    """
    from math import ceil

    rows = db.query(Script.likes, Script.dislikes).filter(
        Script.is_deleted == False,
        Script.review_status == REVIEW_APPROVED,
    ).all()
    likes = [int(r[0] or 0) for r in rows]
    dislikes = [int(r[1] or 0) for r in rows]

    def _rng(vals):
        if not vals:
            return {"min": 0, "max": 100}
        lo, hi = min(vals), max(vals)
        if hi <= lo:
            return {"min": lo, "max": lo + 10}
        padded = ceil(hi * 1.1)
        step = 10 if padded >= 20 else 1
        padded = ((padded + step - 1) // step) * step
        return {"min": lo, "max": max(padded, lo + step)}

    return {"likes": _rng(likes), "dislikes": _rng(dislikes)}


def search(
    db: Session,
    keyword: str = "",
    category: str = "",
    tags: list = None,
    review_status: str = REVIEW_APPROVED,
    min_likes: int = 0,
    max_likes: int = None,
    min_dislikes: int = 0,
    max_dislikes: int = None,
    sort: str = "",
    page: int = 1,
    page_size: int = 12,
) -> dict:
    # 解析搜索栏内容：+标签 想要 / -标签 不想要 / 其余为自由关键词
    free_keyword, kw_include, kw_exclude = parse_query(keyword)
    include_tags = list(dict.fromkeys((tags or []) + kw_include))
    exclude_tags = list(dict.fromkeys(kw_exclude))

    q = db.query(Script).filter(Script.is_deleted == False)

    if review_status:
        q = q.filter(Script.review_status == review_status)
    if category:
        q = q.filter(Script.category == category)
    if min_likes:
        q = q.filter(Script.likes >= min_likes)
    if max_likes is not None:
        q = q.filter(Script.likes <= max_likes)
    if min_dislikes:
        q = q.filter(Script.dislikes >= min_dislikes)
    if max_dislikes is not None:
        q = q.filter(Script.dislikes <= max_dislikes)
    # 标签筛选（包含/排除）在 Python 侧基于 s.tags 列表完成，
    # 因为 SQLite 的 JSON 列对 contains()/like() 支持不可靠。
    candidates = q.all()
    keyword = free_keyword.strip()
    if include_tags or exclude_tags:
        candidates = [
            s for s in candidates
            if _match_tags(s.tags, include_tags, exclude_tags)
        ]

    # 关键词硬过滤：位置有意放在 SQL 过滤（尤其 review_status）**之后** ——
    # 关键词只能让结果更少，永远不能把未过审/已删除的稿子带出来。
    # 命不中就如实回空、不再「退化成只排序」：那种「一屏无关剧本」正是这次的现场。
    if keyword:
        candidates = [s for s in candidates if _match_keyword(s, keyword)]

    # 计算权重与辅助数据
    tag_likes_map = _tag_likes_map(db, [s.id for s in candidates])
    comments_map = _comments_24h_map(db, [s.id for s in candidates])

    enriched = []
    for s in candidates:
        tl = tag_likes_map.get(s.id, 0)
        enriched.append({
            "script": s,
            "weight": _weight(s, keyword, tl),
            "tag_likes": tl,
            "comments_24h": comments_map.get(s.id, 0),
        })

    # 排序
    if keyword and (not sort or sort == "relevance"):
        sort = "relevance"
    elif not sort:
        sort = DEFAULT_NO_KEYWORD

    if sort == "relevance":
        enriched.sort(key=lambda x: (x["weight"], x["script"].likes), reverse=True)
    elif sort == "newest":
        enriched.sort(key=lambda x: x["script"].created_at or "", reverse=True)
    elif sort == "oldest":
        enriched.sort(key=lambda x: x["script"].created_at or "")
    elif sort == "popular":
        enriched.sort(key=lambda x: x["script"].downloads_count, reverse=True)
    elif sort == "rating":
        enriched.sort(key=lambda x: (x["script"].avg_rating, x["script"].rating_count), reverse=True)
    elif sort == "hot_likes":
        enriched.sort(key=lambda x: (x["script"].likes + x["tag_likes"] * 0.1), reverse=True)
    elif sort == "comments_24h":
        enriched.sort(key=lambda x: x["comments_24h"], reverse=True)
    else:
        enriched.sort(key=lambda x: x["script"].created_at or "", reverse=True)

    total = len(enriched)
    start = (page - 1) * page_size
    page_items = enriched[start:start + page_size]

    return {
        "scripts": [e["script"].to_dict(include_synopsis=True) for e in page_items],
        "page": page,
        "total_pages": max(1, (total + page_size - 1) // page_size),
        "total": total,
        "sort": sort,
    }


def all_tags(db: Session, limit: int = 50) -> list:
    """返回全站标签与各自被使用/被点赞情况，供筛选 UI 推荐。

    标签来源以 Script.tags(JSON) 为准（覆盖所有剧本，含未写入 ScriptTag 表的旧剧本），
    点赞数优先取 ScriptTag 表，缺失时记 0。
    """
    like_map = {}
    for row in db.query(
        ScriptTag.tag,
        func.coalesce(func.sum(ScriptTag.likes), 0).label("likes"),
    ).group_by(ScriptTag.tag).all():
        like_map[row.tag] = int(row.likes or 0)

    counter = {}
    scripts = db.query(Script).filter(Script.is_deleted == False).all()
    for s in scripts:
        for t in (s.tags or []):
            if t not in counter:
                counter[t] = {"count": 0, "likes": like_map.get(t, 0)}
            counter[t]["count"] += 1

    ranked = sorted(counter.items(), key=lambda x: (-x[1]["likes"], -x[1]["count"]))
    return [{"tag": t, "likes": v["likes"], "count": v["count"]} for t, v in ranked[:limit]]
