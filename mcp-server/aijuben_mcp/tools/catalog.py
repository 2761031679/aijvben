"""只读工具组：剧本浏览 / 搜索 / 详情 / NPC / 标签。

这一组不需要主持证，也不需要登录就能用大部分（未过审剧本除外）。给 AI 的用法主线是：
先 list_scripts 或 search_scripts 挑一本 -> get_script 读全文（含汤底与主持手册）
-> list_npcs 选一个 NPC -> 交给 session 组开房。
"""
from __future__ import annotations

import json
import logging
from typing import Any

from . import dumps, get_client, script_summary, tool_guard

LOG = logging.getLogger("aijuben_mcp.tools.catalog")

CATEGORIES = "hai-gui-tang（海龟汤）| dnd | coc | ju-ben-ban-yan（剧本扮演）"
SORTS = "relevance | newest | oldest | popular | rating | hot_likes | comments_24h"


def _wrap_list(scripts: list[dict[str, Any]], **meta: Any) -> str:
    return dumps(
        {
            "ok": True,
            "count": len(scripts),
            "scripts": [script_summary(item) for item in scripts],
            **{k: v for k, v in meta.items() if v is not None},
        }
    )


def register(server: Any) -> None:
    """把本组工具挂到 MCP server 上。"""

    @server.tool(
        name="list_scripts",
        description=(
            "分页浏览 AI剧本网上架的剧本列表，返回每条的关键信息与截断简介（不含正文全文）。\n"
            "什么时候用：用户说『有什么剧本/推荐几本/海龟汤有哪些』；或者你要先看一圈再决定读哪一本；"
            "或者想按分类/标签/热度筛一遍。\n"
            "什么时候别用：已知关键词找具体内容用 search_scripts（那个是搜索排序，这个是列表分页）；"
            "已知 script_id 要读正文用 get_script；要读汤底和主持手册也用 get_script。\n"
            "参数：category 取 " + CATEGORIES + "；sort 取 " + SORTS + "（默认 newest）；"
            "page_size 1~60（默认 12）。tag 是单个标签精确筛，tags 是逗号分隔的标签串。"
        ),
    )
    @tool_guard
    async def list_scripts(
        page: int = 1,
        page_size: int = 12,
        category: str = "",
        tag: str = "",
        sort: str = "newest",
        keyword: str = "",
        tags: str = "",
        min_likes: int = 0,
    ) -> str:
        result = await get_client().list_scripts(
            page=page,
            page_size=page_size,
            category=category or None,
            tag=tag or None,
            sort=sort or None,
            keyword=keyword or None,
            tags=tags or None,
            min_likes=min_likes or None,
        )
        scripts = result.get("scripts") or []
        return _wrap_list(
            scripts,
            page=result.get("page"),
            total=result.get("total"),
            total_pages=result.get("total_pages"),
            sort=result.get("sort"),
        )

    @server.tool(
        name="get_script",
        description=(
            "读一本剧本的全文：题面、汤底、结局条件、任务、主持手册、评分与标签都会返回（取决于你的权限）。\n"
            "什么时候用：要给用户讲题、要判断该不该推荐，或者开房前先看一遍汤底与主持手册——"
            "主持一场之前必须先用它读一遍，否则你不知道答案。\n"
            "什么时候别用：只是想挑一本别用它（一本来回上千字，占上下文），先用 list_scripts / search_scripts。\n"
            "注意：未过审的剧本只有作者或管理员能读，其他人会得到 404；"
            "返回里的 is_full 表示汤底是否完整下发——为 false 说明你读到的是删节版，别自己编答案。"
        ),
    )
    @tool_guard
    async def get_script(script_id: str) -> str:
        script = await get_client().get_script(script_id)
        return dumps({"ok": True, "script": script})

    @server.tool(
        name="search_scripts",
        description=(
            "按关键词搜索剧本，返回按相关度/热度排序的结果（标题、标签、简介命中都会加权）。\n"
            "什么时候用：用户提了具体题材词（『校园』『古堡』『时间循环』）想知道站上有没有；"
            "或者想按标签+分类+点赞阈值筛一批。\n"
            "什么时候别用：没有关键词、只是想浏览全站列表用 list_scripts；要看某一本正文用 get_script。\n"
            "参数：limit 1~50（默认 20）；sort 取 " + SORTS + "；有 keyword 时默认按 relevance。"
        ),
    )
    @tool_guard
    async def search_scripts(
        keyword: str = "",
        category: str = "",
        tags: str = "",
        sort: str = "",
        min_likes: int = 0,
        limit: int = 20,
    ) -> str:
        result = await get_client().search_scripts(
            keyword=keyword or None,
            category=category or None,
            tags=tags or None,
            sort=sort or None,
            min_likes=min_likes or None,
            limit=limit,
        )
        scripts = result.get("scripts") or []
        return _wrap_list(scripts, keyword=keyword or None)

    @server.tool(
        name="list_npcs",
        description=(
            "列出站点上可用的 NPC（海龟汤主持搭档）：npc_id、显示名，以及它们各自支持的表情、"
            "动作、情绪效果等配置。host_token 无关，公开可读。\n"
            "什么时候用：开一场之前挑 npc_id（start_session 的 npc_id 参数就从这里取）；"
            "或者用户问『有哪些 NPC/主持人』。\n"
            "什么时候别用：别用它确认某一场用的是哪个 NPC——那看 session_status 或 get_context 的 npc 字段。"
        ),
    )
    @tool_guard
    async def list_npcs() -> str:
        result = await get_client().list_npcs()
        npcs = result.get("npcs") or []
        configs = result.get("configs") or {}
        items = []
        for npc in npcs:
            npc_id = npc.get("npc_id")
            config = configs.get(npc_id) or {}
            items.append(
                {
                    "npc_id": npc_id,
                    "display_name": npc.get("display_name"),
                    "personality_id": npc.get("personality_id"),
                    "portrait_url": config.get("portrait_url"),
                    "enabled_emotions": config.get("enabled_emotions"),
                    "enabled_actions": config.get("enabled_actions"),
                }
            )
        return dumps(
            {
                "ok": True,
                "count": len(items),
                "npcs": items,
                "note": "npc_id 直接传给 start_session(npc_id=...) 即可；不传则用剧本默认。",
            }
        )

    @server.tool(
        name="get_npc",
        description=(
            "读单个 NPC 的完整配置：表情/动作开关、情绪效果、立绘、方法定义。\n"
            "什么时候用：你准备用某个 NPC 主持、想先知道它支持哪些情绪与动作（决定叙事里怎么描写它）；"
            "或者调试『为什么这个动作没生效』。\n"
            "什么时候别用：只是想列出有哪些 NPC 用 list_npcs（更省上下文）。"
        ),
    )
    @tool_guard
    async def get_npc(npc_id: str) -> str:
        result = await get_client().list_npcs()
        configs = result.get("configs") or {}
        definitions = result.get("npcs") or []
        config = configs.get(npc_id)
        definition = next((n for n in definitions if n.get("npc_id") == npc_id), None)
        if config is None and definition is None:
            return dumps(
                {
                    "ok": False,
                    "error": {
                        "status": 404,
                        "code": "npc_not_found",
                        "message": f"没有 npc_id={npc_id} 的 NPC",
                        "hint": "先调 list_npcs 看有哪些可用 npc_id。",
                    },
                }
            )
        return dumps(
            {
                "ok": True,
                "npc": {"npc_id": npc_id, **(definition or {}), "config": config or {}},
                "available_emotions": result.get("available_emotions"),
                "available_actions": result.get("available_actions"),
            }
        )

    @server.tool(
        name="list_tags",
        description=(
            "读站点的标签榜（按标签点赞数排），每条带 tag 名、点赞数与使用次数。\n"
            "什么时候用：想知道站上流行什么题材、给 search_scripts 找准确的 tag 拼写。\n"
            "什么时候别用：不要拿它当剧本列表——它只有标签，没有剧本。"
        ),
    )
    @tool_guard
    async def list_tags(keyword: str = "") -> str:
        result = await get_client().list_tags(keyword or None)
        return dumps({"ok": True, **(result or {})})
