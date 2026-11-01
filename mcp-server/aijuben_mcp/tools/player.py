"""玩家侧只读工具组：我的档案 / 战绩 / 我发的剧本 / 我的订阅。

全部依赖凭证（Authorization: Bearer <token>）。没配凭证时后端回 401「请先登录」，
工具会把它翻成 `no_actor` + 一句「去配 AIJUBEN_TOKEN 或者 ~/.aijuben/token」的 hint。
这一组只读，不改站点上的任何东西——写入类操作（发剧本、点赞、订阅）刻意不做，
插件定位是「读站点 + 主持一场」，不是替玩家操作账号。
"""
from __future__ import annotations

import logging
from typing import Any

from . import dumps, get_client, script_summary, tool_guard

LOG = logging.getLogger("aijuben_mcp.tools.player")


def register(server: Any) -> None:
    """把玩家侧工具挂到 MCP server 上。"""

    @server.tool(
        name="my_profile",
        description=(
            "读当前凭证对应账号的公开档案：用户名、角色（普通/会员/管理员）、注册时间、"
            "发布剧本数、评论数、邮箱验证状态、个人设置。\n"
            "什么时候用：主持人要按玩家身份选称呼/难度/权限（比如判断能不能读未过审剧本）；"
            "或者用户问『我的资料/我是不是会员』。\n"
            "什么时候别用：要等级、成就、经验这些成长数据用 my_stats（那个更全）；"
            "别用它验证凭证是否有效——凭证坏了会直接回 no_actor 错误，那本身就是答案。"
        ),
    )
    @tool_guard
    async def my_profile() -> str:
        profile = await get_client().my_profile()
        return dumps({"ok": True, "profile": profile})

    @server.tool(
        name="my_stats",
        description=(
            "读当前账号的成长与战绩：等级、经验、成就点、通关/发布数、收到的赞踩订阅、金币、"
            "关注/粉丝数、熟练度，以及成就列表。\n"
            "什么时候用：结算之后想给玩家报战绩；或者要判断这位玩家是老手还是新人来决定提示强度。\n"
            "什么时候别用：只想知道昵称/角色用 my_profile 更省；别把它当排行榜（它只回自己）。"
        ),
    )
    @tool_guard
    async def my_stats() -> str:
        result = await get_client().my_stats()
        return dumps({"ok": True, **(result or {})})

    @server.tool(
        name="my_scripts",
        description=(
            "列出当前账号发布的剧本（含未过审的草稿，字段里有 review_status 与审核意见）。\n"
            "什么时候用：用户问『我发的剧本怎么样了/过审了吗』；或者要开一场自己写的剧本，"
            "先从这里面挑 script_id。\n"
            "什么时候别用：看全站剧本用 list_scripts；看某一本正文用 get_script。"
        ),
    )
    @tool_guard
    async def my_scripts() -> str:
        scripts = await get_client().my_scripts() or []
        if isinstance(scripts, dict):  # 兼容后端将来包一层的情况
            scripts = scripts.get("scripts") or []
        return dumps(
            {
                "ok": True,
                "count": len(scripts),
                "scripts": [script_summary(item) for item in scripts],
            }
        )

    @server.tool(
        name="my_subscriptions",
        description=(
            "列出当前账号订阅的剧本。\n"
            "什么时候用：用户说『我订阅的那些/我收藏的剧本』，想从里面挑一本玩。\n"
            "什么时候别用：没有凭证时别抱期望（会回 no_actor）；看全站列表用 list_scripts。"
        ),
    )
    @tool_guard
    async def my_subscriptions() -> str:
        subs = await get_client().my_subscriptions() or []
        if isinstance(subs, dict):
            subs = subs.get("scripts") or subs.get("subscriptions") or []
        return dumps({"ok": True, "count": len(subs), "subscriptions": subs})
