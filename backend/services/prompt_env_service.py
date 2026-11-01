"""提示词组装的「环境」装载器
====================================================================
`prompt_assembly_service.assemble()` 只吃纯数据，不吃数据库。这个模块负责
把服务端掌握的东西装成那样一份 env：

  experience      有无剧本体验 + 主持数据（汤底就在这里面，只有主持人才拿得到）
  inventory       线索/道具面板当前状态
  status_uis      状态栏各 UI 的 id/名称/说明/可调用命令
  npc_configs     站长给每个 NPC 开放的表情/动画
  available_defs  全站表情/动画定义（名称查表）
  emotion_effects 表情→表现（方法池优先，与前端 AccountInit.getEmotionEffect 一致）
  ui_targets      引导高亮的目标名清单

对照物是浏览器里那几份模块：`account/init.js`、`status_bar.js`、`ui_locator.js`。
前端仍留着它们（过渡期双跑），但**提示词组装已经不吃前端了**。
"""
from __future__ import annotations

import json

from . import npc_file_service

#: 引导高亮目标名（与 frontend/js/modules/ui/ui_locator.js 的 TARGETS 键一致）。
#: 提示词里只用键名（NPC 说 [guide:home]），不关心选择器。
UI_TARGETS = {
    "settings": "设置",
    "voice": "语音",
    "tool": "工具面板",
    "login": "登录",
    "register": "注册",
    "home": "主页",
    "board": "剧本区",
    "reward": "打赏",
    "chat": "对话",
}

#: 状态栏 UI 说明（与 frontend/js/modules/game/status_ui_*.js 的元数据一致）。
#: 三个都是模块加载即注册，故浏览器里 describeForNpc() 恒返回这三条。
STATUS_UIS = [
    # 顺序必须是浏览器的**注册序**：index.html 先加载 status_ui_mode.js、再 status_ui_hp.js、
    # 最后 status_ui_conditions.js，而 StatusBar.describeForNpc() 用的是对象插入序。
    # 之前这里写成 hp→mode 两条，与浏览器既不同序也不同数 —— 于是「逐字节一致」那句声明
    # 在接线上是假的，20 组样本谁都没覆盖到（审计 M5）。
    {
        "id": "mode",
        "name": "模式状态",
        "desc": "显示当前正在游玩的剧本类型。玩家点击此卡可退出当前剧本体验（由玩家操作，非 NPC 命令）。",
        "npcCmds": [],
    },
    {
        "id": "hp",
        "name": "血量条",
        "desc": "玩家血量条。默认不显示，NPC 通过 hp_* 命令调用时自动显示并操作。",
        "npcCmds": [
            "hp_reset —— 初始化/重置血量至默认值（生命值 100/100，上限 100）",
            "hp_set:value=数字 —— 设置当前生命值",
            "hp_add:amount=数字(可负) —— 增减生命值",
            "hp_max:value=数字 —— 设置生命值上限",
            "hp_clear —— 生命值清零",
            "hp_fill —— 生命值补满",
            "hp_name:value=名字 —— 设置血量条名称",
        ],
    },
    {
        "id": "conditions",
        "name": "失败/成功条件",
        "desc": "实时显示当前海龟汤剧本的胜利/失败条件进度（条件名 + 次数/阈值）。隐藏条件达成后自动浮现。此卡只读，NPC 通过 [cond:] 标记推进条件，不直接修改。",
        "npcCmds": [],
    },
]

#: 与 frontend/js/shared/constants.js 的 CATEGORY_NAMES 一致
CATEGORY_NAMES = {
    "hai-gui-tang": "海龟汤",
    "dnd": "DND",
    "coc": "COC",
    "ju-ben-ban-yan": "剧本扮演",
}


def available_defs() -> dict:
    """全站表情/动画定义（名称查表用）。"""
    return {
        "emotions": [{"id": d["id"], "name": d["name"]} for d in npc_file_service.EMOTION_DEFS],
        "actions": [{"id": d["id"], "name": d["name"]} for d in npc_file_service.ANIMATION_DEFS],
    }


def ui_meta() -> dict:
    """浏览器/插件侧的 UI 元数据快照（GET /api/host/ui-meta 的唯一数据源，M28）。

    **为什么不直接把 env 切一块出来用**：env 里那块 `status_uis` 的键是 camelCase
    `npcCmds`，而 `prompt_assembly_service._status_bar()` 正是按这个键读；提示词那侧
    有 20 组黄金样本要求「逐字节一致」，所以 env 里的形状一个字符都不许动。
    ui-meta 是**对外公开契约**（前端和 MCP 插件照它渲染与调用），对外一律 snake_case。
    于是这里做一次显式改名：同一份数据、两个形状、两处用途。改这个函数时注意
    别顺手把 STATUS_UIS 的键名也改了 —— 那一侧会立刻红。

    每次调用都造新对象（UI_TARGETS/STATUS_UIS 是模块级字面量，全站共用，调用方
    拿去改一下就污染所有人），所以这里等价于一份深拷贝。
    """
    return {
        "ui_targets": dict(UI_TARGETS),
        "status_uis": [
            {
                "id": ui.get("id", ""),
                "name": ui.get("name", ""),
                "desc": ui.get("desc", ""),
                "npc_cmds": list(ui.get("npcCmds") or []),
            }
            for ui in STATUS_UIS
        ],
        # 表情/动画定义同样复用 npc_file_service 里那一份，不再抄一份到路由层。
        # 用 dict（id -> {name, desc}）是因为调用方要按 id 查名字；顺序沿用定义序。
        "emotions": {
            d["id"]: {"name": d.get("name", ""), "desc": d.get("desc", "")}
            for d in npc_file_service.EMOTION_DEFS
        },
        "animations": {
            d["id"]: {"name": d.get("name", ""), "desc": d.get("desc", "")}
            for d in npc_file_service.ANIMATION_DEFS
        },
    }


def npc_configs() -> dict:
    """各 NPC 开放的启用清单 + 表情映射（键与前端 AccountInit 一致：npc_id）。"""
    return npc_file_service.get_all_npc_configs()


def resolve_emotion_effects(cfg: dict) -> dict:
    """表情 → 表现。方法池优先，其次 emotion_effects；与前端 AccountInit.getEmotionEffect 同序。

    注意 `name` 只在「来自方法池」时有值 —— 提示词里「方法「XXX」」那段就靠它。
    """
    out = {}
    for emo_id, fx in (cfg.get("emotion_effects") or {}).items():
        out[emo_id] = {
            "portrait": (fx or {}).get("portrait") or "",
            "anim": (fx or {}).get("anim") or "",
            "prompt": (fx or {}).get("prompt") or "",
            "name": "",
        }
    methods = {m.get("id"): m for m in (cfg.get("methods") or [])}
    for emo_id, method_id in (cfg.get("emotion_methods") or {}).items():
        m = methods.get(method_id)
        if m:
            out[emo_id] = {
                "portrait": m.get("portrait") or "",
                "anim": m.get("anim") or "",
                "prompt": m.get("prompt") or "",
                "name": m.get("name") or "",
            }
    return out


def _fill_placeholders(text: str, script) -> str:
    """填模式提示词里的占位符（与前端 Experience._buildHostData 的 fill() 一致）。"""
    if not text:
        return ""
    sid = getattr(script, "id", "") or ""
    subs = {
        "{story}": getattr(script, "story", "") or "",
        "{explanation}": getattr(script, "explanation", "") or "",
        "{ending_condition}": getattr(script, "ending_condition", "") or "",
        "{title}": getattr(script, "title", "") or "",
        "{script_id}": sid,
    }
    for k, v in subs.items():
        text = text.replace(k, v)
    return text


def _parse_condition_table(raw, key):
    """剧本的 endings/tasks 是 JSON 字符串（形如 {"endings":[...]}），坏 JSON 按无条件表处理。"""
    if not raw:
        return []
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError):
        return []
    if isinstance(data, dict):
        val = data.get(key)
        return val if isinstance(val, list) else []
    return []


def build_host_data(script) -> dict | None:
    """主持上下文（含汤底）。**只有主持人拿得到**，别的地方不许调。"""
    if script is None:
        return None
    guide_text = npc_file_service.get_experience_prompt(getattr(script, "category", "") or "")
    return {
        "guide": _fill_placeholders(guide_text.get("guide", ""), script),
        "modePrompt": _fill_placeholders(guide_text.get("mode_prompt", ""), script),
        "script": {
            "id": getattr(script, "id", "") or "",
            "title": getattr(script, "title", "") or "",
            "categoryName": CATEGORY_NAMES.get(getattr(script, "category", ""), getattr(script, "category", "") or ""),
            "story": getattr(script, "story", "") or "",
            "explanation": getattr(script, "explanation", "") or "",
            "ending_condition": getattr(script, "ending_condition", "") or "",
            "endings": _parse_condition_table(getattr(script, "endings", None), "endings"),
            "tasks": _parse_condition_table(getattr(script, "tasks", None), "tasks"),
            "host_guide": getattr(script, "host_guide", "") or "",
        },
    }


def build_env(npc_id=None, script=None, session=None) -> dict:
    """装一份完整的 env。script 只在「确认是主持人在取」时传进来。"""
    cfgs = npc_configs()
    cfg = cfgs.get(npc_id) or {} if npc_id else {}

    inventory = {"active": False, "state": {"clues": [], "items": []}}
    if session is not None:
        payload_inv = (session.payload or {}).get("inventory")
        if payload_inv:
            clues = payload_inv.get("clues") or []
            items = payload_inv.get("items") or []
            if clues or items:
                inventory = {"active": True, "state": {"clues": clues, "items": items}}

    host_data = build_host_data(script) if script is not None else None

    return {
        "experience": {"active": host_data is not None, "host_data": host_data},
        "inventory": inventory,
        "status_uis": STATUS_UIS,
        "npc_configs": cfgs,
        "available_defs": available_defs(),
        "emotion_effects": resolve_emotion_effects(cfg),
        "ui_targets": UI_TARGETS,
    }


def build_player_info(user=None, stats=None) -> dict | None:
    """玩家信息块数据。登录用户取库里的档案；游客给一份最小档案。"""
    if user is not None:
        from .stats_service import proficiency_of

        lvl = (stats.level if stats else 1) or 1
        return {
            "username": getattr(user, "username", "") or "",
            "level": lvl,
            "scripts_completed": (stats.scripts_completed if stats else 0) or 0,
            "scripts_uploaded": (stats.scripts_uploaded if stats else 0) or 0,
            "achievement_points": (stats.achievement_points if stats else 0) or 0,
            "proficiency": proficiency_of(stats) if stats else "new",
        }
    return {
        "username": "游客",
        "level": 1,
        "scripts_completed": 0,
        "scripts_uploaded": 0,
        "achievement_points": 0,
        "proficiency": "new",
    }
