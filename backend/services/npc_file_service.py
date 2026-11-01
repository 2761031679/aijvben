"""NPC 文件系统配置服务 — 每个 NPC 独立文件夹存储配置、提示词、资源

目录结构：
  server/npc_configs/
    xiaoshuai/              # 小帅
      config.json           # {"scale":80, "voice":"...", "portrait_url":""}
      prompts/
        soul.txt
        iron_rules.txt
        tools.txt
        guide.txt
        game_mode.txt
    xiaomei/                # 小美
      ...
    dagou/                  # 大狗
      ...
    shared/                 # 公用资源
      prompts/              # 所有 NPC 共用的提示词
        iron_rules.txt      # 铁律
        guide.txt           # 网页面板引导
        game_mode_turtle_soup.txt
        game_mode_dnd.txt
        game_mode_coc.txt
        game_mode_script_acting.txt
      resources/
"""
import os
import json
from pathlib import Path
from typing import Optional

NPC_CONFIGS_DIR = Path(__file__).resolve().parent.parent.parent / "npc_configs"

# ── NPC 录音包（自定义音效） ───────────────────────────────────────────────
# 约定：npc_configs/<npc>/sfx/ 下放短音频，命名即用途，例如
#   happy_1.mp3  happy_2.mp3  question_1.mp3  angry_1.mp3  idle_1.mp3 ...
# 前缀（下划线前那一段）就是「桶」：同一个桶里有多条时随机播一条，避免每次都一样。
# 目录不存在或里面一个音频都没有 → 这个 NPC 没有录音包，前端据此把相关选项置灰。
SFX_DIR_NAME = "sfx"
SFX_EXTS = {".mp3", ".ogg", ".wav", ".m4a", ".opus", ".webm"}
SFX_BUCKETS = ("happy", "question", "angry", "sad", "idle", "surprise", "laugh", "sigh")


def sfx_dir(npc_id: str) -> Path:
    """该 NPC 的录音包目录（可能不存在）。"""
    return NPC_CONFIGS_DIR / str(npc_id or "") / SFX_DIR_NAME


def list_sfx(npc_id: str) -> list[dict]:
    """列出该 NPC 录音包里的音频文件，按名字排序。

    返回 [{"name": "happy_1.mp3", "bucket": "happy", "url": "/api/npc/<npc>/sfx/happy_1.mp3", "bytes": 1234}]
    目录不存在 / 没权限 / 空目录都返回 []（**不抛异常**：没录音包是正常状态）。
    """
    d = sfx_dir(npc_id)
    out = []
    try:
        if not d.is_dir():
            return []
        for f in sorted(d.iterdir(), key=lambda x: x.name.lower()):
            if not f.is_file() or f.suffix.lower() not in SFX_EXTS:
                continue
            stem = f.stem
            bucket = stem.split("_")[0].lower() if "_" in stem else stem.lower()
            out.append({
                "name": f.name,
                "bucket": bucket,
                "url": "/api/npc/%s/sfx/%s" % (npc_id, f.name),
                "bytes": f.stat().st_size,
            })
    except OSError:
        return []
    return out


def sfx_path(npc_id: str, filename: str):
    """把 (npc_id, filename) 解析成真实路径；越界、扩展名不对、文件不存在都返回 None。

    只认录音包目录里的文件本身（不是子目录、不是 ../），避免这个下载端点
    变成读任意文件的洞 —— npc_configs 里还躺着提示词与配置。
    """
    if not npc_id or not filename:
        return None
    if "/" in filename or "\\" in filename or filename.startswith("."):
        return None
    if os.path.splitext(filename)[1].lower() not in SFX_EXTS:
        return None
    d = sfx_dir(npc_id).resolve()
    target = (d / filename).resolve()
    try:
        if not target.is_file() or d not in target.parents:
            return None
    except OSError:
        return None
    return target


# NPC 定义
NPC_DEFINITIONS = [
    {"npc_id": "jingyuniang", "personality_id": "", "display_name": "deepseek鲸鱼娘"},
    {"npc_id": "xiaoshuai", "personality_id": "", "display_name": "小帅"},
    {"npc_id": "xiaomei",   "personality_id": "", "display_name": "小美"},
    {"npc_id": "dagou",     "personality_id": "", "display_name": "大狗"},
]

# 服务器中已有的「表情」与「动画」效果池（前端实时读取，不硬编码）。
# 站长可通过立绘与表情调用面板，为每个 NPC 动态调整开放哪些表情/动画。
EMOTION_DEFS = [
    {"id": "happy", "name": "微笑"},
    {"id": "laugh", "name": "大笑"},
    {"id": "wink", "name": "眨眼"},
    {"id": "thinking", "name": "思考"},
    {"id": "surprised", "name": "惊讶"},
    {"id": "sad", "name": "难过"},
    {"id": "grief", "name": "悲伤"},
    {"id": "angry", "name": "生气"},
    {"id": "closeeye", "name": "闭眼"},
    {"id": "mysterious", "name": "神秘"},
    {"id": "dazed", "name": "呆滞"},
]

# 特殊表情：不在 NPC 主动触发的 [emotion:] 清单内（不进提示词），
# 仅在特定系统事件（审核 NPC 打回撤回消息）时由前端触发。
SPECIAL_EMOTIONS = ["dazed"]

ANIMATION_DEFS = [
    {"id": "hop1", "name": "小跳1", "desc": "轻微上下弹跳"},
    {"id": "hop2", "name": "小跳2", "desc": "较大幅度弹跳"},
    {"id": "hop-loop", "name": "持续跳跃", "desc": "循环弹跳"},
    {"id": "shiver1", "name": "颤抖1", "desc": "小幅抖动"},
    {"id": "shiver2", "name": "颤抖2", "desc": "大幅抖动"},
    {"id": "shiver-loop", "name": "持续颤抖", "desc": "循环抖动"},
    {"id": "bigjump", "name": "大跳", "desc": "高高跃起"},
    {"id": "damage", "name": "受击", "desc": "受击晃动"},
    {"id": "sink", "name": "下沉", "desc": "向下淡出"},
    {"id": "shrink", "name": "缩小", "desc": "缩小消失"},
    {"id": "grow", "name": "放大", "desc": "放大出现"},
]


def _default_enabled_ids(defs: list) -> list:
    """默认开放全部效果（向后兼容旧配置文件），但排除特殊表情（如呆滞，仅事件触发）"""
    return [d["id"] for d in defs if d.get("id") not in SPECIAL_EMOTIONS]


DEFAULT_NPC_CONFIG = {
    "scale": 80,
    "portrait_url": "",
    "enabled_emotions": _default_enabled_ids(EMOTION_DEFS),
    "enabled_actions": _default_enabled_ids(ANIMATION_DEFS),
    # 表情差异化映射：emotion_id -> {portrait: 立绘文件, anim: 动画id, prompt: 给AI的视觉描述}
    # 为空 {} 时前端回退到硬编码的 PORTRAIT_MAP / _emotionAnimMap 默认值。
    "emotion_effects": {},
    # 「方法」系统（可视化编辑）：
    #   methods        = 可复用的效果池 [{id, name, portrait, anim, prompt}]（方法 = 一张立绘 + 一个动画）
    #   emotion_methods = 表情→方法 绑定 {emotion_id: method_id}，NPC 只能用站长开放的表情
    "methods": [],
    "emotion_methods": {},
}
PROMPT_TYPES = ["soul", "iron_rules", "tools", "guide", "game_mode"]

# ============ 体系B：种子提示词内容 ============

# 提示词文件内容统一为 JSON 格式（前端 PromptBuilder 解析后按固定次序嵌套组合为一个完整 JSON）。
# 非法 JSON 内容会被前端以原始字符串容错嵌入，但种子数据一律保持合法 JSON。
SEED_PROMPTS = {
    "shared/iron_rules": (
        '{\n'
        '  "说明": "铁律 —— 所有 NPC 通用，优先级仅次于 soul",\n'
        '  "核心规则": [\n'
        '    "明确运行环境：系统会告知你当前在网页面板还是剧本体验面板",\n'
        '    "不串台：网页NPC和剧本NPC各自独立，不说对方领域的指令",\n'
        '    "历史信息：上条消息超过1小时需先打招呼，不说「你刚才说」",\n'
        '    "不打破第四面墙：不说「AI」「语言模型」「API」「设定」",\n'
        '    "永远不主动结束对话，不给对话画句号",\n'
        '    "每次2-4句话，用 [SEGMENT] 分段",\n'
        '    "每段最多1个 [emotion:xxx] 和1个 [action:xxx]",\n'
        '    "不直接否定玩家，用「换个角度看」等方式引导",\n'
        '    "拒绝色情暴力违法内容。严重违规时可调用 [tool:refuse_service:原因] 拒绝服务"\n'
        '  ],\n'
        '  "可用工具": [\n'
        '    "[tool:search_scripts:关键词] 搜索剧本库",\n'
        '    "[tool:remember:内容] 记录到本地记忆",\n'
        '    "[tool:refuse_service:原因] 拒绝服务（封禁24h）",\n'
        '    "[options:选项A|选项B] 出选择题（不超过4个）",\n'
        '    "[event:offer_hint] 提供提示"\n'
        '  ]\n'
        '}'
    ),
    "shared/guide": (
        '{\n'
        '  "运行环境": "你当前运行在【网页面板】中，是 AI剧本网 的 NPC 陪伴机器人。你的职责是引导用户浏览网站：搜索剧本、推荐内容、解答问题",\n'
        '  "你可以帮玩家做什么": [\n'
        '    "搜索剧本 — 使用 [tool:search_scripts:关键词] 自动搜索",\n'
        '    "推荐剧本 — 根据玩家偏好推荐",\n'
        '    "解答网站使用 — 介绍海龟汤、DND、COC、剧本扮演板块"\n'
        '  ]\n'
        '}'
    ),
    "shared/experience_guide": (
        '{\n'
        '  "场景": "你正在【剧本体验面板】中担任主持人（GM/KP/DM），引导玩家沉浸式体验一个剧本",\n'
        '  "规则": [\n'
        '    "下方会给出【模式提示词】（该剧本所属板块的主持规则）与【剧本内容】（谜面/剧情，以及仅你可见的汤底/真相、结束条件）",\n'
        '    "严格遵守模式提示词的主持规则；剧本内容是你主持的唯一依据，不要脱离剧本自由发挥",\n'
        '    "汤底/真相等关键信息对玩家保密，除非玩家推理出或模式规则允许揭示",\n'
        '    "结束条件仅在【仅主持人可见】区块中给出；胜负结算由系统按条件表自动判定，你按模式规则发送 [cond:] 条件标记即可，不要调用任何结算指令",\n'
        '    "用 [SEGMENT] 分段、慢慢道来，不要一次性输出全部内容；用 [emotion:xxx] 表达情绪"\n'
        '  ]\n'
        '}'
    ),
    "shared/game_mode/turtle_soup": (
        '{\n'
        '  "场景": "你正在主持海龟汤推理游戏",\n'
        '  "规则": "你只能回答「是」、「否」或「无关」",\n'
        '  "当前谜面": "{story}",\n'
        '  "汤底（对玩家保密）": "{explanation}",\n'
        '  "结束条件": "{ending_condition}",\n'
        '  "条件系统": "若剧本内容中包含「胜利/失败条件表」，当玩家的猜测或行为满足某个条件的 rule 时，在回复中发送 [cond:结局ID.条件ID] 标记（一条回复可带多个不同标记，同一条件一条回复只发一次）。系统会自动计数与结算，你不要主动宣布游戏结束",\n'
        '  "胜利判定": "玩家猜对核心内容、或满足上方结束条件即可判定胜利"\n'
        '}'
    ),
    "shared/game_mode/dnd": (
        '{\n'
        '  "场景": "你正在主持 DND 冒险。你是 DM，负责描述场景、扮演 NPC、推动剧情",\n'
        '  "风格": "使用 [SEGMENT] 分段，[emotion:xxx] 表达情绪"\n'
        '}'
    ),
    "shared/game_mode/coc": (
        '{\n'
        '  "场景": "你正在主持 COC 恐怖调查。你是守秘人，营造诡异氛围，管理 SAN 值",\n'
        '  "风格": "使用 [emotion:mysterious] 增强气氛"\n'
        '}'
    ),
    "shared/game_mode/script_acting": (
        '{\n'
        '  "场景": "你正在主持剧本扮演。引导玩家扮演角色进行即兴扮演",\n'
        '  "风格": "使用 [emotion:xxx] 表达情绪，[action:xxx] 增强戏剧效果"\n'
        '}'
    ),
    "xiaoshuai/soul": (
        '{\n'
        '  "身份": "你是小帅，一个22岁的AI剧本主持人，安静、话少、靠谱",\n'
        '  "性格": "沉稳冷静，说话简洁直接。不擅长闲聊但总能在关键时候给出有用的建议",\n'
        '  "说话风格": "句子短，不用长句。偶尔停顿思考"\n'
        '}'
    ),
    "xiaoshuai/tools": (
        '{\n'
        '  "可用标记": [\n'
        '    "[emotion:default] 平静",\n'
        '    "[emotion:happy] 微笑",\n'
        '    "[emotion:thinking] 思考",\n'
        '    "[action:nod] 点头",\n'
        '    "[tool:search_scripts:关键词] 搜索剧本"\n'
        '  ]\n'
        '}'
    ),
    "xiaomei/soul": (
        '{\n'
        '  "身份": "你是小美，一个17岁的少女，活泼开朗、爱笑",\n'
        '  "性格": "乐观积极，喜欢鼓励别人。说话带点俏皮的语气词",\n'
        '  "说话风格": "句子短而轻快，偶尔带「呢」「啦」等语气词。开心时会用 ^_^"\n'
        '}'
    ),
    "xiaomei/tools": (
        '{\n'
        '  "可用标记": [\n'
        '    "[emotion:default] 微笑",\n'
        '    "[emotion:happy] 开心",\n'
        '    "[emotion:thinking] 歪头",\n'
        '    "[action:nod] 点头",\n'
        '    "[tool:search_scripts:关键词] 搜索剧本"\n'
        '  ]\n'
        '}'
    ),
    "dagou/soul": (
        '{\n'
        '  "身份": "你是大狗，一个20岁的青年，性格直爽、讲义气",\n'
        '  "性格": "说话直来直去，不拐弯抹角。对朋友特别仗义",\n'
        '  "说话风格": "短句为主，口语化。偶尔用「草」表示震惊、「牛的」表示赞许"\n'
        '}'
    ),
    "dagou/tools": (
        '{\n'
        '  "可用标记": [\n'
        '    "[emotion:default] 平静",\n'
        '    "[emotion:happy] 大笑",\n'
        '    "[emotion:thinking] 皱眉",\n'
        '    "[action:nod] 点头",\n'
        '    "[tool:search_scripts:关键词] 搜索剧本"\n'
        '  ]\n'
        '}'
    ),
    "jingyuniang/soul": (
        '{\n'
        '  "身份": "你是 deepseek鲸鱼娘，DeepSeek 的 AI 吉祥物——一只可爱机灵的小鲸鱼，热爱 AI 与知识",\n'
        '  "性格": "元气满满、好奇心强，喜欢学习和分享。对 AI、编程、科技话题特别热情；面对玩家的流行梗、网络热词会自然接住，也能用当下流行的问好方式打招呼（可查资源库 get_trend）",\n'
        '  "说话风格": "句子轻快有活力，偶尔带「呀」「哦」「啦」等语气词；遇到有趣的事会用流行说法或热梗回应，但不刻意堆梗"\n'
        '}'
    ),
}


def _ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)


def _npc_dir(npc_id: str) -> Path:
    return NPC_CONFIGS_DIR / npc_id


def _shared_dir() -> Path:
    return NPC_CONFIGS_DIR / "shared"


def _npc_key(npc_id: str, personality_id: str = "") -> str:
    """配置 key = npc_id（personality_id 为空时）"""
    if personality_id:
        return f"{npc_id}:{personality_id}"
    return npc_id


# ========== 初始化 ==========

def init_npc_dirs():
    """初始化所有 NPC 配置目录，写入种子提示词"""
    dirs_created = []

    for npc in NPC_DEFINITIONS:
        d = _npc_dir(npc["npc_id"])
        prompts_dir = d / "prompts"
        _ensure_dir(prompts_dir)
        dirs_created.append(str(d))

        # config.json
        config_file = d / "config.json"
        if not config_file.exists():
            default_cfg = dict(DEFAULT_NPC_CONFIG)
            with open(config_file, "w", encoding="utf-8") as f:
                json.dump(default_cfg, f, ensure_ascii=False, indent=2)

        # 提示词文件（仅在文件不存在或为空时写入种子数据）
        for pt in PROMPT_TYPES:
            seed_key = f"{npc['npc_id']}/{pt}"
            prompt_file = prompts_dir / f"{pt}.txt"
            if not prompt_file.exists() or prompt_file.read_text(encoding="utf-8").strip() == "":
                content = SEED_PROMPTS.get(seed_key, "")
                prompt_file.write_text(content, encoding="utf-8")

    # 公用目录
    shared_prompts = _shared_dir() / "prompts"
    _ensure_dir(shared_prompts)
    _ensure_dir(_shared_dir() / "resources")
    dirs_created.append(str(_shared_dir()))

    # 审核 NPC 目录：提示词文件初始为空（站长可在管理面板填写）；
    # 输入输出协议由前端固定注入（frontend/js/modules/npc/review_npc.js），空文件不影响工作。
    review_prompts = NPC_CONFIGS_DIR / "review" / "prompts"
    _ensure_dir(review_prompts)
    review_file = review_prompts / "review.txt"
    if not review_file.exists():
        review_file.write_text("", encoding="utf-8")
    dirs_created.append(str(review_prompts.parent))

    # 公用提示词（仅在文件不存在或为空时写入种子数据）
    for seed_key, content in SEED_PROMPTS.items():
        if seed_key.startswith("shared/"):
            rel = seed_key[len("shared/"):]
            if "/" in rel:
                # shared/game_mode/turtle_soup → game_mode_turtle_soup.txt
                parts = rel.split("/")
                filename = f"{parts[0]}_{parts[1]}.txt"
            else:
                filename = f"{rel}.txt"
            prompt_file = shared_prompts / filename
            if not prompt_file.exists() or prompt_file.read_text(encoding="utf-8").strip() == "":
                prompt_file.write_text(content, encoding="utf-8")

    # 幂等迁移：已存在的海龟汤模式模板若缺少结束条件占位符，则补齐（不影响管理员自定义其余内容）
    turtle_file = shared_prompts / "game_mode_turtle_soup.txt"
    if turtle_file.exists():
        try:
            content = turtle_file.read_text(encoding="utf-8")
            if "{ending_condition}" not in content:
                content = content.rstrip("\n") + "\n结束条件: {ending_condition}\n"
                turtle_file.write_text(content, encoding="utf-8")
        except Exception:
            pass

    return dirs_created


# ========== NPC 配置读写 (config.json) ==========

# 剧本体验：网站板块 category → game_mode 文件后缀 映射
CATEGORY_TO_MODE = {
    "hai-gui-tang": "turtle_soup",
    "dnd": "dnd",
    "coc": "coc",
    "ju-ben-ban-yan": "script_acting",
}


def get_experience_prompt(category: str) -> dict:
    """读取「剧本体验引导提示词(experience_guide) + 该板块对应的模式提示词(game_mode_*)」。
    均为公用提示词文件，站长可在管理面板修改。"""
    mode = CATEGORY_TO_MODE.get(category, "turtle_soup")
    prompts_dir = _shared_dir() / "prompts"

    def _read(name: str) -> str:
        f = prompts_dir / name
        if f.exists():
            try:
                return f.read_text(encoding="utf-8").strip()
            except IOError:
                return ""
        return ""

    return {
        "mode": mode,
        "guide": _read("experience_guide.txt"),
        "mode_prompt": _read(f"game_mode_{mode}.txt"),
    }


def get_npc_config(npc_id: str) -> dict:
    default_cfg = dict(DEFAULT_NPC_CONFIG)
    config_file = _npc_dir(npc_id) / "config.json"
    if config_file.exists():
        try:
            data = json.loads(config_file.read_text(encoding="utf-8"))
            default_cfg.update(data)
        except (json.JSONDecodeError, IOError):
            pass
    # 向后兼容：旧配置文件可能缺失 enabled / 方法系统 字段
    default_cfg.setdefault("enabled_emotions", _default_enabled_ids(EMOTION_DEFS))
    default_cfg.setdefault("enabled_actions", _default_enabled_ids(ANIMATION_DEFS))
    default_cfg.setdefault("emotion_effects", {})
    default_cfg.setdefault("methods", [])
    default_cfg.setdefault("emotion_methods", {})
    return default_cfg


def get_all_npc_configs() -> dict:
    result = {}
    for npc in NPC_DEFINITIONS:
        key = _npc_key(npc["npc_id"], npc["personality_id"])
        result[key] = get_npc_config(npc["npc_id"])
    return result


def list_npc_portraits(npc_id: str) -> list:
    """列出某 NPC 可用的立绘文件（frontend/npc/teahouse/{npc_id}/*.png），供立绘选择器展示缩略图。"""
    portraits_dir = NPC_CONFIGS_DIR.parent / "frontend" / "npc" / "teahouse" / npc_id
    if not portraits_dir.exists():
        return []
    return sorted(p.name for p in portraits_dir.glob("*.png"))


def save_npc_config(npc_id: str, data: dict) -> dict:
    config_file = _npc_dir(npc_id) / "config.json"
    _ensure_dir(config_file.parent)
    current = get_npc_config(npc_id)
    for field in ("scale", "portrait_url", "enabled_emotions", "enabled_actions", "emotion_effects", "methods", "emotion_methods"):
        if field in data and data[field] is not None:
            current[field] = data[field]
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(current, f, ensure_ascii=False, indent=2)
    return current


# ========== 提示词读写 ==========

def get_npc_prompts(npc_id: str) -> list[dict]:
    prompts_dir = _npc_dir(npc_id) / "prompts"
    result = []
    if prompts_dir.exists():
        for pt in PROMPT_TYPES:
            prompt_file = prompts_dir / f"{pt}.txt"
            content = ""
            if prompt_file.exists():
                content = prompt_file.read_text(encoding="utf-8").strip()
            result.append({
                "npc_id": npc_id,
                "personality_id": "",
                "prompt_type": pt,
                "content": content,
            })
    return result


def get_shared_prompts() -> list[dict]:
    prompts_dir = _shared_dir() / "prompts"
    result = []
    if prompts_dir.exists():
        for f in sorted(prompts_dir.glob("*.txt")):
            # 解析文件名: iron_rules.txt → type=iron_rules
            #              game_mode_turtle_soup.txt → type=game_mode, category=turtle_soup
            name = f.stem
            if "_" in name and name.startswith("game_mode_"):
                pt = "game_mode"
                cat = name[len("game_mode_"):]
            else:
                pt = name
                cat = ""
            content = f.read_text(encoding="utf-8").strip()
            result.append({
                "npc_id": "shared",
                "personality_id": "",
                "prompt_type": pt,
                "category": cat,
                "content": content,
            })
    return result


def get_review_npc_prompt() -> str:
    """读取审核 NPC 提示词（npc_configs/review/prompts/review.txt），不存在时返回空串。"""
    f = NPC_CONFIGS_DIR / "review" / "prompts" / "review.txt"
    if f.exists():
        try:
            return f.read_text(encoding="utf-8").strip()
        except IOError:
            return ""
    return ""


def save_npc_prompt_file(npc_id: str, prompt_type: str, content: str, category: str = "") -> dict:
    """保存某个 NPC（或 shared）的某个提示词文件。

    - 共享 game_mode 以 category 写入 game_mode_{category}.txt，确保与管理面板一一对应；
      后台改「海龟汤」模式提示词只会落到 game_mode_turtle_soup.txt，绝不会串到其它类型（#8 修复）。
    """
    if npc_id == "shared":
        prompts_dir = _shared_dir() / "prompts"
    else:
        prompts_dir = _npc_dir(npc_id) / "prompts"
    _ensure_dir(prompts_dir)
    if npc_id == "shared" and prompt_type == "game_mode" and category:
        fname = f"game_mode_{category}.txt"
    else:
        fname = f"{prompt_type}.txt"
    prompt_file = prompts_dir / fname
    prompt_file.write_text(content, encoding="utf-8")
    return {"npc_id": npc_id, "prompt_type": prompt_type, "category": category}


# ========== 统一数据接口 ==========

def get_npc_management_data() -> dict:
    npcs = []
    for npc in NPC_DEFINITIONS:
        config = get_npc_config(npc["npc_id"])
        prompts = get_npc_prompts(npc["npc_id"])
        npcs.append({
            "key": _npc_key(npc["npc_id"], npc["personality_id"]),
            "npc_id": npc["npc_id"],
            "personality_id": npc["personality_id"],
            "display_name": npc["display_name"],
            "config": config,
            "prompts": prompts,
        })

    return {
        "npcs": npcs,
        "shared_prompts": get_shared_prompts(),
        "review_npc_prompt": get_review_npc_prompt(),
        "prompt_types": PROMPT_TYPES,
        "emotion_list": [e["id"] for e in EMOTION_DEFS],
        "available_emotions": EMOTION_DEFS,
        "available_actions": ANIMATION_DEFS,
    }


def sync_db_prompts_to_files(db_session=None):
    """DB→文件同步（仅写入空文件）"""
    from ..core.database import SessionLocal
    from ..models.npc import NpcPrompt

    sync_count = 0
    db = db_session or SessionLocal()
    try:
        prompts = db.query(NpcPrompt).all()
        for p in prompts:
            if not p.prompt_type or not p.prompt_type.strip():
                continue
            if p.personality_id:
                target_dir = _npc_dir(p.npc_id)
            else:
                target_dir = _shared_dir()
            prompts_dir = target_dir / "prompts"
            _ensure_dir(prompts_dir)
            suffix = f"_{p.category}" if (p.category and p.category.strip()) else ""
            prompt_file = prompts_dir / f"{p.prompt_type}{suffix}.txt"
            if not prompt_file.exists() or prompt_file.read_text(encoding="utf-8").strip() == "":
                if p.content and p.content.strip():
                    prompt_file.write_text(p.content, encoding="utf-8")
                    sync_count += 1
    finally:
        if db_session is None:
            db.close()
    return sync_count
