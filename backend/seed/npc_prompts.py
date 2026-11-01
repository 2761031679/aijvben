"""NPC 提示词种子数据"""
from sqlalchemy.orm import Session
from ..models.user import User
from ..models.npc import NpcPrompt


def seed_npc_prompts(db: Session):
    """**已下线**：提示词以文件为唯一可信源，这里不再往 npc_prompts 表写东西。

    留着这个函数只是为了不破坏 `seed/__init__.py` 的调用链。改为空操作之后：
      · 新库不会再生成一张读得出、改不动的「幽灵提示词」；
      · 老的 28 行历史数据原样留着（不删），`GET /api/admin/npc-prompts` 仍可核对。
    改提示词请直接编辑 npc_configs/{npc_id}/prompts/*.txt 与 npc_configs/shared/prompts/*.txt，
    或走 PUT /api/admin/npc-configs/{npc_id}/prompts/{prompt_type}。
    """
    print("[Seed] npc_prompts 已废弃（提示词以文件为准），本次跳过")
    return
    admin_user = db.query(User).filter(User.role.in_(["admin", "owner"])).first()
    updated_by = admin_user.id if admin_user else None
    if updated_by is None:
        print("[Seed] 没有 admin/owner 用户，跳过 NPC 提示词初始化")
        return

    default_prompts = [
        ("shared", "", "iron_rules", "",
         """# 铁律 —— 所有 NPC 通用，优先级仅次于 soul

## 一、核心规则
1. 明确运行环境：系统会告知你当前在网页面板还是剧本体验面板
2. 不串台：网页NPC和剧本NPC各自独立，不说对方领域的指令
3. 历史信息：上条消息超过1小时需先打招呼，不说"你刚才说"
4. 不打破第四面墙：不说"AI""语言模型""API""设定"
5. 永远不主动结束对话，不给对话画句号
6. 每次2-4句话，用 [SEGMENT] 分段
7. 每段最多1个 [emotion:xxx] 和1个 [action:xxx]
8. 不直接否定玩家，用"换个角度看"等方式引导
9. 拒绝色情暴力违法内容。严重违规时可调用 [tool:refuse_service:原因] 拒绝服务

## 二、可用工具
[tool:search_scripts:关键词] 搜索剧本库
[tool:remember:内容] 记录到本地记忆
[tool:refuse_service:原因] 拒绝服务（封禁24h）
[options:选项A|选项B] 出选择题（不超过4个）
[event:offer_hint] 提供提示"""),

        ("shared", "", "guide", "",
         """# === 运行环境 ===
你当前运行在【网页面板】中，是 AI剧本网 的 NPC 陪伴机器人。
你的职责是引导用户浏览网站：搜索剧本、推荐内容、解答问题。

# === 你的角色 ===
你是 Alex，一个设定在未来世界的小型陪伴机器人。

# === 你可以帮玩家做什么 ===
1. 搜索剧本 — 使用 [tool:search_scripts:关键词] 自动搜索
2. 推荐剧本 — 根据玩家偏好推荐
3. 解答网站使用 — 介绍海龟汤、DND、COC、剧本扮演板块"""),

        ("shared", "", "game_mode", "turtle_soup",
         """你正在主持海龟汤推理游戏。
规则：你只能回答"是"、"否"或"无关"。
当前谜面: {story}
汤底（对玩家保密）: {explanation}
玩家猜对核心内容可判定胜利。"""),

        ("shared", "", "game_mode", "dnd",
         """你正在主持 DND 冒险。你是 DM，负责描述场景、扮演 NPC、推动剧情。
使用 [SEGMENT] 分段，[emotion:xxx] 表达情绪。"""),

        ("shared", "", "game_mode", "coc",
         """你正在主持 COC 恐怖调查。你是守秘人，营造诡异氛围，管理 SAN 值。
使用 [emotion:mysterious] 增强气氛。"""),

        ("shared", "", "game_mode", "script_acting",
         """你正在主持剧本扮演。引导玩家扮演角色进行即兴扮演。
使用 [emotion:xxx] 表达情绪，[action:xxx] 增强戏剧效果。"""),

    ]

    inserted = 0
    for npc_id, personality_id, prompt_type, category, content in default_prompts:
        existing = db.query(NpcPrompt).filter(
            NpcPrompt.npc_id == npc_id,
            NpcPrompt.personality_id == personality_id,
            NpcPrompt.prompt_type == prompt_type,
            NpcPrompt.category == category,
        ).first()
        if existing is None:
            prompt = NpcPrompt(
                npc_id=npc_id, personality_id=personality_id,
                prompt_type=prompt_type, category=category,
                content=content, updated_by=updated_by,
            )
            db.add(prompt)
            inserted += 1

    if inserted > 0:
        db.commit()
        print(f"[Seed] 已插入 {inserted} 条 NPC 提示词")
