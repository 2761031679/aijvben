"""提示词组装（服务端唯一实现）
====================================================================
把 `frontend/js/modules/npc/prompt_builder.js` 的行为原样搬到后端。

为什么要有这个：
  以前提示词在浏览器里拼，意味着「喂给 AI 的 system prompt」里的汤底、条件表、
  隐藏条件，全都躺在浏览器内存里 —— 玩家打开 F12 就能看。组装搬到后端之后，
  浏览器拿到的只有要显示的东西，AI 拿到的那份永远不过网（只发给模型服务商）。

本模块的硬指标：**与前端实现逐字节一致**。
  判据不是「看起来对」，而是 `tools/golden/compare_py.py` 拿 20 组冻结样本回放，
  必须 20/20 全等。所以这里的每个键名、标点、缩进都是从 JS 那段代码照抄的，
  看起来啰嗦的地方是在对齐 JS 的语义（例如空串视为「无内容」）。

纯粹函数式：不碰数据库、不读文件。输入全是纯数据，输出就是那段 JSON 字符串。
生产环境要的 env（站长配置的表情清单等）由调用方（routers/host.py）装好再传进来。
"""
from __future__ import annotations

import hashlib
import json

# ============ 配方表（键名是中文且被提示词文件引用，不允许翻译/重命名）============

#: 分节名 → 多分节组内嵌套对象的子键名
SECTION_KEYS = {
    "soul": "角色设定",
    "guide": "网页面板引导",
    "sidebar_guide": "侧边栏状态引导",
    "greeting": "开场规则",
    "iron_rules": "铁律",
    "tools": "工具手册",
    "sidebar_tools": "侧边栏工具",
    "mode_rules": "模式规则",
    "script_info": "剧本内容",
    "experience_tools": "剧本体验工具",
    "inventory": "线索/道具面板（当前状态，每轮实时更新；序号即 remove 指令的 index 参数）",
    "capability": "表情控制",
    "status_bar": "状态栏 UI（可操作）",
}

#: 状态 → 分组配方。顶层键 = 分组名；值 = 组内分节；「a|b」= 回退链（a 空则用 b）
STATE_RECIPE = {
    "default": {
        "A 角色设定": ["soul"],
        "B 铁律": ["iron_rules"],
        "C 网页面板引导": ["guide", "greeting"],
        "D 工具手册": ["tools"],
        "F 标记手册": ["__markers__"],
        "输出规范": ["output_style"],
        "G 表情/动画清单": ["capability"],
        "I 玩家信息": ["player_info"],
    },
    "browsing": {
        "A 角色设定": ["soul"],
        "B 铁律": ["iron_rules"],
        "C 侧边栏引导": ["sidebar_guide|guide", "greeting"],
        "D 工具手册": ["sidebar_tools|tools"],
        "F 标记手册": ["__markers__"],
        "输出规范": ["output_style"],
        "G 表情/动画清单": ["capability"],
        "I 玩家信息": ["player_info"],
    },
    "experience": {
        "A 角色设定": ["soul"],
        "B 铁律": ["iron_rules"],
        "C 模式规则": ["mode_rules"],
        "D 剧本内容": ["script_info"],
        "E 线索/道具面板": ["inventory"],
        "F 标记手册": ["__markers__"],
        "输出规范": ["output_style"],
        "G 表情/动画清单": ["capability"],
        "H 状态栏 UI": ["status_bar"],
        "I 玩家信息": ["player_info"],
    },
}

WORKFLOW_KEY = "工作流程（最高优先级，务必逐级严格遵循）"
LIBRARY_KEY = "资料库（按需查阅）"

#: 特殊表情不开放给 NPC 主动 [emotion:] 调用（仅系统事件触发）
SPECIAL_EMOTIONS = ("dazed",)

PROFICIENCY_NAMES = {"new": "新玩家", "regular": "普通玩家", "veteran": "老玩家"}
PROFICIENCY_GUIDES = {
    "new": "积极引导：多鼓励，卡住时主动给方向（但不点破线索）",
    "regular": "必要时引导：只在玩家卡住或跑偏时给一句方向提示",
    "veteran": "消极引导：几乎不引导，只做判定，除非玩家明确求助",
}
DEFAULT_TIER_GUIDE = PROFICIENCY_GUIDES["regular"]


# ============ 工具 ============

def parse_content(content):
    """提示词文件内容是 JSON → 解析成对象；不是 JSON → 原文嵌入（容错）。"""
    if not content:
        return ""
    try:
        return json.loads(content)
    except (ValueError, TypeError):
        return content


def _merge(contents):
    """同类型多份内容合并：单份直接嵌入，多份合并为数组。"""
    parsed = [parse_content(c) for c in contents]
    return parsed[0] if len(parsed) == 1 else parsed


def dumps(root) -> str:
    """等价于 JS `JSON.stringify(root, null, 2)`：缩进 2 空格、不转义中文、无尾随换行。"""
    return json.dumps(root, ensure_ascii=False, indent=2)


# ============ 各分节渲染 ============

def _script_block(s):
    """剧本内容块（仅主持人可见）。键名与数据标签耦合，与前端一致。"""
    block = {
        "标题": s.get("title") or "",
        "类型": s.get("categoryName") or "",
        "谜面/剧情": s.get("story") or "（无）",
        "汤底/真相（仅主持人可见，禁止泄露）": s.get("explanation") or "（无）",
        "结束条件（仅主持人可见）": s.get("ending_condition") or "（无，按模式规则判定胜利）",
    }
    endings = s.get("endings")
    if isinstance(endings, list) and endings:
        block["胜利/失败条件表（仅主持人可见；只需按「触发信号」发送标记，次数与结算由系统判定）"] = _format_endings(endings)
    tasks = s.get("tasks")
    if isinstance(tasks, list) and tasks:
        block["任务条件表（仅主持人可见；只需按「触发信号」发送标记，效果由系统自动执行）"] = _format_tasks(tasks)
    if s.get("host_guide"):
        block["主持指导词（作者撰写，主持时遵循）"] = s["host_guide"]
    return block


def _format_endings(endings):
    out = []
    for e in endings:
        note = e.get("note")
        out.append({
            "结局": "%s（%s）%s" % (e.get("name"), "胜利" if e.get("type") == "win" else "失败",
                                 ("——" + note) if note else ""),
            "触发信号": [
                "当【%s】时 → 发送 [cond:%s.%s]%s" % (
                    c.get("rule") or c.get("name"), e.get("id"), c.get("id"),
                    "（隐藏条件，勿向玩家暗示）" if c.get("hidden") else "")
                for c in (e.get("conditions") or [])
            ],
        })
    return out


def _format_tasks(tasks):
    out = []
    for t in tasks:
        note = t.get("note")
        out.append({
            "任务": "%s%s" % (t.get("name"), ("——" + note) if note else ""),
            "触发信号": [
                "当【%s】时 → 发送 [task:%s.%s]%s" % (
                    c.get("rule") or c.get("name"), t.get("id"), c.get("id"),
                    "（隐藏条件，勿向玩家暗示）" if c.get("hidden") else "")
                for c in (t.get("conditions") or [])
            ],
        })
    return out


def _inventory_view(state):
    """线索/道具面板的 NPC 视角文本（带 1 起始序号，与 remove 指令的 index 参数对应）。"""
    state = state or {}
    clues = state.get("clues") or []
    items = state.get("items") or []
    return {
        "线索": ["%d. %s%s" % (i + 1, c.get("text"), ("（来源：%s）" % c["source"]) if c.get("source") else "")
               for i, c in enumerate(clues)] if clues else ["（暂无线索）"],
        "道具": ["%d. %s%s" % (i + 1, it.get("text"), ("（来源：%s）" % it["source"]) if it.get("source") else "")
               for i, it in enumerate(items)] if items else ["（暂无道具）"],
    }


def _capability(npc_id, env):
    """表情控制：按站长开放的表情/动画生成清单。"""
    if not npc_id:
        return None
    cfgs = env.get("npc_configs") or {}
    cfg = cfgs.get(npc_id) or {}
    enabled_emotions = cfg.get("enabled_emotions") or []
    enabled_actions = cfg.get("enabled_actions") or []
    if not enabled_emotions and not enabled_actions:
        return None

    defs = env.get("available_defs") or {}
    emotion_defs = defs.get("emotions") or []
    action_defs = defs.get("actions") or []
    emo_names = {d.get("id"): d.get("name") for d in emotion_defs}
    act_names = {d.get("id"): d.get("name") for d in action_defs}
    fxs = env.get("emotion_effects") or {}
    name_of = lambda m, i: m.get(i) if m.get(i) is not None else i

    cap = {
        "说明": [
            "以下是你可调用的表情与动画标记（属于 soul 设定，严格只使用清单内的标记，每段最多1个表情 + 1个动画）",
            "如果soul 设定没有写使用表情与动画的频率，那么尽量多使用表情。",
            "这些表情/动画会在你说对应情绪时自动在画面播放，你只需自然表达，无需在文字里描述肢体动作",
            "清单之外的情绪不要输出 [emotion:] 标记；某段没有情绪起伏时该段不写任何表情标记",
        ],
    }
    if enabled_emotions:
        rows = []
        for eid in enabled_emotions:
            if eid in SPECIAL_EMOTIONS:
                continue
            fx = fxs.get(eid) or {}
            parts = []
            if fx.get("name"):
                parts.append("方法「%s」" % fx["name"])
            if fx.get("portrait"):
                parts.append("切换对应立绘")
            if fx.get("anim"):
                parts.append("触发动画「%s」" % name_of(act_names, fx["anim"]))
            if fx.get("prompt"):
                parts.append(fx["prompt"])
            desc = ("：" + "，".join(parts)) if parts else ""
            rows.append("[emotion:%s](%s%s)" % (eid, name_of(emo_names, eid), desc))
        cap["表情"] = rows
    if enabled_actions:
        cap["动画"] = ["[action:%s](%s)" % (aid, name_of(act_names, aid)) for aid in enabled_actions]
    return cap


def _player_block(player_info):
    """玩家信息块（三态注入）：熟练度档位 + 当前引导策略 + 玩家档案 + 双轨校准说明。"""
    prof = player_info.get("proficiency")
    tier_name = PROFICIENCY_NAMES.get(prof, "普通玩家")
    tier_guide = PROFICIENCY_GUIDES.get(prof, DEFAULT_TIER_GUIDE)
    return {
        "熟练度档位": tier_name,
        "引导策略（内部参考）": tier_guide,
        "玩家档案": "用户名 %s，Lv.%s，通关 %s 本，上传 %s 本，成就分 %s" % (
            player_info.get("username") or "未知",
            player_info.get("level") or 1,
            player_info.get("scripts_completed") or 0,
            player_info.get("scripts_uploaded") or 0,
            player_info.get("achievement_points") or 0,
        ),
        "说明": "以上只用于你判断用怎样的引导力度对待玩家。历史档位是初始参考，实时表现是最终权威，冲突以实时为准；玩家自称新手/老手时以自述为准",
    }


def _marker_manual(state, env):
    """标记手册（F）：所有可输出标记的速查表，按状态裁剪。语法与系统解析器强耦合。"""
    m = {
        "说明": "你所有可输出的功能标记速查表。标记是发给系统执行的指令，不会展示给玩家。何时发、发哪个，严格对照本表。",
        "情绪与动画": {
            "[emotion:表情id]": "表达情绪（id 见资料库 G「表情/动画清单」）",
            "[action:动画id]": "播放动画（id 见资料库 G「表情/动画清单」）",
        },
        "分段": {
            "[SEGMENT]": "把输出拆成短段（每段 2~20 字），不要一次性输出大段文本",
        },
        "通用系统指令": {
            "[info:文本]": "显示一条居中系统信息（非对话气泡）",
            "[guide:目标名]": "在目标按钮画引导高亮圆环（目标名见本表末尾「引导目标表」）",
            "[options:标题1:备注1|标题2:备注2]": "出选择题（2~4 个，互斥有差异，选项前要有自然对话铺垫）",
            "[sys:report_issue:reason=具体原因]": "上报系统问题/提示词缺失（确实需要时用，reason 写清原因）",
            "[tool:history]": "回想历史对话记录（查看早前的完整对话，不受上下文隔断限制）",
        },
    }
    if state in ("default", "browsing"):
        m["网页工具与体验"] = {
            "[tool:工具名:参数1=值1&参数2=值2]": "查询网站真实数据（工具清单见资料库 D「工具手册」，一次只调一个）",
            "[btn:按钮文字:open_tutorial:模型ID]": "渲染「API 获取教程」按钮（玩家问如何配模型/拿 Key 时用）",
            "[sys:start_experience:script_id=剧本ID]": "开启剧本体验（先确认玩家要玩，且已用 [tool:get_script] 查询）",
            "[sys:resume_experience]": "继续玩家上次未完成的剧本",
        }
    if state == "experience":
        m["海龟汤回答标记（仅海龟汤模式，代替文字作答）"] = {
            "说明": "发送回答标记后系统自动转成对应文字展示给玩家，不要再用文字重复作答",
            "[answer:yes]": "是",
            "[answer:no]": "否",
            "[answer:both]": "是也不是",
            "[answer:irrelevant]": "不重要",
            "[answer:unable]": "无法回答",
        }
        m["条件与任务标记（核心，漏发会判错）"] = {
            "[cond:结局ID.条件ID]": "玩家这轮满足资料库 D「剧本内容」条件表某条 rule 时发送（ID 严格照抄）",
            "[task:任务ID.条件ID]": "玩家这轮满足资料库 D「剧本内容」任务表某条 rule 时发送（ID 严格照抄）",
        }
        m["面板修改"] = {
            "[sys:add_clue:content=内容]": "添加线索到面板",
            "[sys:remove_clue:index=序号]": "删除线索（序号见资料库 E）",
            "[sys:add_item:content=内容]": "添加道具到面板",
            "[sys:remove_item:index=序号]": "删除道具（序号见资料库 E）",
            "[do:指令]": "分段延迟指令：夹在两段文本间执行（如 [do:add_clue:content=xxx]）",
        }
        m["通用系统指令"]["[sys:end_experience]"] = "主动结束当前剧本体验"
    ui_targets = env.get("ui_targets")
    if ui_targets is not None:
        m["引导目标表"] = list(ui_targets.keys())
    return m


def _status_bar(env):
    """状态栏 UI 说明：列出各 UI 的 id/名称/说明/可调用命令。"""
    uis = env.get("status_uis")
    if uis is None:
        return None
    if not uis:
        return None
    obj = {}
    for u in uis:
        cmds = u.get("npcCmds") or []
        obj[u.get("id")] = {
            "名称": u.get("name"),
            "说明": u.get("desc") or "",
            "可调用命令": cmds if cmds else "（无，仅展示/玩家操作）",
        }
    return obj


# ============ 组装 ============

class _Ctx:
    __slots__ = ("by_type", "npc_id", "exp_data", "player_info", "state", "env", "fallbacks")

    def __init__(self, by_type, npc_id, exp_data, player_info, state, env):
        self.by_type = by_type
        self.npc_id = npc_id
        self.exp_data = exp_data
        self.player_info = player_info
        self.state = state
        self.env = env
        self.fallbacks = []


def _render_one(name, ctx):
    if name == "iron_rules":
        contents = ctx.by_type.get("iron_rules")
        return _merge(contents) if contents else None
    if name == "capability":
        return _capability(ctx.npc_id, ctx.env)
    if name == "__markers__":
        return _marker_manual(ctx.state, ctx.env)
    if name == "mode_rules":
        return parse_content(ctx.exp_data.get("modePrompt")) if ctx.exp_data else None
    if name == "script_info":
        return _script_block(ctx.exp_data.get("script") or {}) if ctx.exp_data else None
    if name == "inventory":
        inv = ctx.env.get("inventory") or {}
        if not inv.get("active"):
            return None
        return _inventory_view(inv.get("state"))
    if name == "player_info":
        return _player_block(ctx.player_info) if ctx.player_info else None
    if name == "status_bar":
        return _status_bar(ctx.env)
    contents = ctx.by_type.get(name)
    return _merge(contents) if contents else None


def _render_section(sec, ctx):
    names = sec.split("|")
    for name in names:
        v = _render_one(name, ctx)
        if v is not None and v != "":
            if len(names) > 1 and name != names[0]:
                ctx.fallbacks.append("%s→%s" % (names[0], name))
            return v
    return None


def _render_group(sections, ctx):
    if len(sections) == 1:
        return _render_section(sections[0], ctx)
    obj = {}
    for sec in sections:
        v = _render_section(sec, ctx)
        if v is None or v == "":
            continue
        obj[SECTION_KEYS[sec.split("|")[0]]] = v
    return obj or None


def assemble(prompts=None, web_state="default", npc_id=None, player_info=None, env=None):
    """组合 system prompt。返回契约 §4 的 PromptBundle 字典。

    参数全是纯数据，无副作用 —— 这样才能被黄金样本逐字节复核。
    """
    env = env or {}
    by_type = {}
    for p in (prompts or []):
        content = p.get("content")
        if not content or not content.strip():
            continue
        by_type.setdefault(p.get("prompt_type"), []).append(content.strip())

    # 体验态防御：状态为 experience 但无主持数据时回退 default 配方
    state = web_state
    exp_data = None
    if state == "experience":
        exp = env.get("experience") or {}
        exp_data = (exp.get("host_data") or None) if exp.get("active") else None
        if not exp_data:
            state = "default"

    recipe = STATE_RECIPE.get(state) or STATE_RECIPE["default"]
    ctx = _Ctx(by_type, npc_id, exp_data, player_info, state, env)
    root = {}

    # ① 工作流程：最高优先级，置顶
    workflow = _render_section("thinking_mode", ctx)
    if workflow is not None and workflow != "":
        root[WORKFLOW_KEY] = workflow

    # ② 资料库：按状态组装 A~I
    lib = {}
    sections_meta = []
    order = 0
    for slot_key, sections in recipe.items():
        val = _render_group(sections, ctx)
        if val is None:
            continue
        lib[slot_key] = val
        for sec in sections:
            order += 10
            sections_meta.append({
                "group": slot_key,
                "key": sec,
                "order": order,
                "source": _section_source(sec),
                "content": val if len(sections) == 1 else val.get(SECTION_KEYS[sec.split("|")[0]]),
            })
    if lib:
        root[LIBRARY_KEY] = lib

    system_prompt = dumps(root)
    return {
        "root": root,
        "system_prompt": system_prompt,
        "prompt_hash": hashlib.sha256(system_prompt.encode("utf-8")).hexdigest()[:16],
        "sections": sections_meta,
        "stats": {
            "chars": len(system_prompt),
            "groups": len(lib),
            "sections": len(sections_meta),
        },
        "debug": {
            "recipe": "%s/v1.3" % state,
            "fallbacks": ctx.fallbacks,
        },
    }


def _section_source(sec):
    name = sec.split("|")[0]
    if name in ("capability", "__markers__", "status_bar"):
        return "code"
    if name in ("mode_rules", "script_info", "inventory"):
        return "runtime"
    if name == "player_info":
        return "profile"
    return "npc_file"
