/* ============================================================================
 * 【回归参考件 — 不参与运行】
 *
 * 这是 P2 之前前端自己拼提示词用的组装器。从 P2 起，提示词改由服务端组装
 * （`POST /api/host/context`，后端实现见 `backend/services/prompt_assembly_service.py`），
 * 原因：汤底不能进浏览器。
 *
 * 本文件已从 `frontend/index.html` 摘除，运行时不会加载，只服务一件事：
 * `node tools/golden/compare.js` 用它回放 20 组冻结样本，证明后端实现与历史行为逐字节一致。
 * 路径被 `tools/golden/lib.js` 的 PB_PATH 指向这里。
 *
 * 不要改它。要改行为，改后端；这份是标尺。
 * ========================================================================== */

/** AI剧本网 - NPC 系统提示词组合模块（PromptBuilder）
 * ------------------------------------------------------------------
 *  职责：按「状态 → 分节配方」（_STATE_RECIPE）组装最终 system prompt（JSON 字符串）。
 *  本模块只做组装，不实现任何业务功能；新增状态/新分节只需改配方表。
 *
 *  配方（v4.7 分组结构：顶层键名即分组名；组内单分节直接输出、多分节合并为嵌套对象）：
 *   - default    默认态：    角色设定 | 网页面板引导 | 铁律(精简) | 工具手册 | 表情控制
 *   - browsing   侧边栏浏览：角色设定 | 侧边栏状态引导 | 铁律(精简) | 侧边栏工具 | 表情控制
 *   - experience 剧本体验：  「遵守以下守则」= 角色设定 + 铁律 + 模式规则
 *                            「知悉以下剧情和任务」= 剧本内容 + 线索/道具面板
 *                            「使用以下工具」= 表情控制 + 剧本体验工具
 *   （v4.7：删除独立「主持人引导」节，体验态不再注入引导提示词，只按模式规则重构）
 *
 *  分节来源：
 *   - 提示词文件节（soul / guide / tools / sidebar_guide / sidebar_tools / experience_tools / iron_rules）：
 *     来自后端 /api/npc/prompts（npc_configs/*.txt，内容为 JSON，非法 JSON 按原文容错嵌入）；
 *   - 动态节（experience_guide/mode_rules/script_info/inventory）：
 *     来自 Experience.getPromptData()（占位符已填充）与 GameInventory 实时状态；
 *   - capability（表情控制）：代码生成（站长配置的开放表情/动画清单）。
 *
 *  铁律策略：三个状态统一使用完整铁律（iron_rules.txt，含关键红线），不再区分精简/完整版。
 *
 *  回退链：配方中「a|b」表示 a 为空时用 b（如 sidebar_guide 未撰写时回退 guide）。
 */
const PromptBuilder = {
    /** 分节名 → 组合后 JSON 的键名（多分节组内嵌套对象的子键名） */
    _SECTION_KEYS: {
        soul: '角色设定',
        guide: '网页面板引导',
        sidebar_guide: '侧边栏状态引导',
        greeting: '开场规则',
        iron_rules: '铁律',
        tools: '工具手册',
        sidebar_tools: '侧边栏工具',
        mode_rules: '模式规则',
        script_info: '剧本内容',
        experience_tools: '剧本体验工具',
        inventory: '线索/道具面板（当前状态，每轮实时更新；序号即 remove 指令的 index 参数）',
        capability: '表情控制',
        status_bar: '状态栏 UI（可操作）',
    },

    /** 状态 → 分组配方。每个键 = 顶层 JSON 键（分组名），值 = 该组内的分节数组。
     *  「a|b」为回退链：a 无内容时取 b；单分节组直接输出内容，多分节组合并为嵌套对象。
     *  v4.7：删除独立「主持人引导(experience_guide)」节，体验态不再注入引导提示词，
     *        只按模式规则(game_mode)重构；体验态重组为「守则/剧情任务/工具」三分组。 */
    _STATE_RECIPE: {
        default: {
            'A 角色设定': ['soul'],
            'B 铁律': ['iron_rules'],
            'C 网页面板引导': ['guide', 'greeting'],
            'D 工具手册': ['tools'],
            'F 标记手册': ['__markers__'],
            '输出规范': ['output_style'],
            'G 表情/动画清单': ['capability'],
            'I 玩家信息': ['player_info'],
        },
        browsing: {
            'A 角色设定': ['soul'],
            'B 铁律': ['iron_rules'],
            'C 侧边栏引导': ['sidebar_guide|guide', 'greeting'],
            'D 工具手册': ['sidebar_tools|tools'],
            'F 标记手册': ['__markers__'],
            '输出规范': ['output_style'],
            'G 表情/动画清单': ['capability'],
            'I 玩家信息': ['player_info'],
        },
        experience: {
            'A 角色设定': ['soul'],
            'B 铁律': ['iron_rules'],
            'C 模式规则': ['mode_rules'],
            'D 剧本内容': ['script_info'],
            'E 线索/道具面板': ['inventory'],
            'F 标记手册': ['__markers__'],
            '输出规范': ['output_style'],
            'G 表情/动画清单': ['capability'],
            'H 状态栏 UI': ['status_bar'],
            'I 玩家信息': ['player_info'],
        },
    },

    /** 组合系统提示词
     * @param {Object} opts
     * @param {Array}  opts.prompts  后端返回的原始提示词列表（含 prompt_type/category/content）
     * @param {string} opts.webState 'default' | 'browsing' | 'experience'
     * @param {string} [opts.npcId]  当前 NPC id（用于生成表情控制能力清单）
     * @returns {string} 完整 JSON 字符串形式的 system prompt
     */
    build({ prompts = [], webState = 'default', npcId = null, playerInfo = null } = {}) {
        // 按类型归组（同一类型可能有多份内容，如 NPC 私有 tools + 共享 tools）
        const byType = {};
        for (const p of prompts) {
            if (!p.content || !p.content.trim()) continue;
            (byType[p.prompt_type] = byType[p.prompt_type] || []).push(p.content.trim());
        }
        // 体验态防御：状态为 experience 但无主持数据时回退 default 配方
        let state = webState;
        let expData = null;
        if (state === 'experience') {
            const active = window.Experience && Experience.isActive && Experience.isActive();
            expData = active && Experience.getPromptData ? Experience.getPromptData() : null;
            if (!expData) {
                console.warn('[PromptBuilder] experience 态但无主持数据，回退 default 配方');
                state = 'default';
            }
        }

        const recipe = this._STATE_RECIPE[state] || this._STATE_RECIPE.default;
        const ctx = { byType, npcId, expData, playerInfo, state };
        const root = {};

        // ① 工作流程：最高优先级，置顶（NPC 第一眼看到，作为唯一重点）
        const workflow = this._renderSection('thinking_mode', ctx);
        if (workflow != null && workflow !== '') {
            root['工作流程（最高优先级，务必逐级严格遵循）'] = workflow;
        }

        // ② 资料库：按状态组装 A~I 分门别类，供工作流程「查资料库」按需查阅
        const lib = {};
        const used = [];
        for (const [slotKey, sections] of Object.entries(recipe)) {
            const val = this._renderGroup(sections, ctx);
            if (val == null) continue;
            lib[slotKey] = val;
            used.push(...sections);
        }
        if (Object.keys(lib).length) {
            root['资料库（按需查阅）'] = lib;
        }

        console.log(`[PromptBuilder] 配方 ${state}: ${used.join(' + ')}`);
        return JSON.stringify(root, null, 2);
    },

    /* ========== 内部 ========== */

    /** 渲染一个分组：单分节直接返回其内容；多分节合并为嵌套对象（子键名取 _SECTION_KEYS） */
    _renderGroup(sections, ctx) {
        if (sections.length === 1) {
            return this._renderSection(sections[0], ctx);
        }
        const obj = {};
        for (const sec of sections) {
            const val = this._renderSection(sec, ctx);
            if (val == null || val === '') continue;
            obj[this._SECTION_KEYS[sec.split('|')[0]]] = val;
        }
        return Object.keys(obj).length ? obj : null;
    },

    /** 渲染一个分节（支持回退链 a|b：取第一个有内容的） */
    _renderSection(sec, ctx) {
        const names = sec.split('|');
        for (const name of names) {
            const v = this._renderOne(name, ctx);
            if (v != null && v !== '') {
                if (names.length > 1 && name !== names[0]) {
                    console.log(`[PromptBuilder] 分节回退：${names[0]} 为空，使用 ${name}`);
                }
                return v;
            }
        }
        if (names.length === 1) console.warn(`[PromptBuilder] 分节无内容，已跳过: ${sec}`);
        return null;
    },

    _renderOne(name, ctx) {
        const { byType, npcId, expData } = ctx;
        switch (name) {
            case 'iron_rules': {
                // 铁律已合并为一份完整版（iron_rules.txt），三态统一使用（含关键红线）
                const full = byType['iron_rules'];
                return (full && full.length) ? this._merge(full) : null;
            }
            case 'capability':
                return this._capability(npcId);
            case '__markers__':
                return this._markerManual(ctx.state);
            case 'mode_rules':
                return expData ? this._parse(expData.modePrompt) : null;
            case 'script_info':
                return expData ? this._scriptBlock(expData.script || {}) : null;
            case 'inventory': {
                // 线索/道具面板当前状态（每轮实时注入，NPC 据此「查看」面板；
                // 修改面板用 [sys:add_clue:] 等指令或分段延迟指令 [do:]，见剧本体验工具）
                if (!(window.GameInventory && GameInventory.isActive && GameInventory.isActive())) return null;
                return this._inventoryView(GameInventory.getState());
            }
            case 'player_info':
                return (ctx.playerInfo) ? this._playerBlock(ctx.playerInfo) : null;
            case 'status_bar': {
                // 状态栏 UI 说明：列出各 UI 的 id/名称/说明/可调用命令，供 NPC 感知与操作
                // （如血量条 hp_* 命令、模式状态可退出等）
                if (!window.StatusBar) return null;
                const uis = StatusBar.describeForNpc();
                if (!uis.length) return null;
                const obj = {};
                for (const u of uis) {
                    obj[u.id] = {
                        '名称': u.name,
                        '说明': u.desc,
                        '可调用命令': (u.npcCmds && u.npcCmds.length)
                            ? u.npcCmds : '（无，仅展示/玩家操作）',
                    };
                }
                return obj;
            }
            default: {
                // 提示词文件节：soul / guide / tools / sidebar_guide / sidebar_tools / experience_tools ...
                const contents = byType[name];
                return (contents && contents.length) ? this._merge(contents) : null;
            }
        }
    },

    /** 同类型多份内容合并：单份直接嵌入，多份合并为数组 */
    _merge(contents) {
        const parsed = contents.map(c => this._parse(c));
        return parsed.length === 1 ? parsed[0] : parsed;
    },

    /** 解析提示词文件内容：合法 JSON → 对象（嵌套组合）；否则 → 原始字符串（容错） */
    _parse(content) {
        if (!content) return '';
        try { return JSON.parse(content); } catch (e) { return content; }
    },

    /** 剧本内容块（仅主持人可见；键名为数据标签，与动态数据耦合，保留在代码中） */
    _scriptBlock(s) {
        const block = {
            '标题': s.title || '',
            '类型': s.categoryName || '',
            '谜面/剧情': s.story || '（无）',
            '汤底/真相（仅主持人可见，禁止泄露）': s.explanation || '（无）',
            '结束条件（仅主持人可见）': s.ending_condition || '（无，按模式规则判定胜利）',
        };
        // 胜利/失败条件表：精简为「触发行为 → 发送信号」，NPC 只按规则发标记，threshold/结算由系统处理
        if (Array.isArray(s.endings) && s.endings.length) {
            block['胜利/失败条件表（仅主持人可见；只需按「触发信号」发送标记，次数与结算由系统判定）'] =
                this._formatEndings(s.endings);
        }
        // 任务条件表：同样精简为「触发行为 → 发送信号」，任务完成效果由系统自动执行
        if (Array.isArray(s.tasks) && s.tasks.length) {
            block['任务条件表（仅主持人可见；只需按「触发信号」发送标记，效果由系统自动执行）'] =
                this._formatTasks(s.tasks);
        }
        // 主持指导词：作者在上传剧本时撰写的可选指导
        if (s.host_guide) {
            block['主持指导词（作者撰写，主持时遵循）'] = s.host_guide;
        }
        return block;
    },

    /** 胜利/失败条件表 → 精简文本：只给 NPC「触发行为 + 发送信号」，隐藏 threshold/隐藏条件实现细节 */
    _formatEndings(endings) {
        return endings.map(e => ({
            '结局': `${e.name}（${e.type === 'win' ? '胜利' : '失败'}）${e.note ? '——' + e.note : ''}`,
            '触发信号': (e.conditions || []).map(c =>
                `当【${c.rule || c.name}】时 → 发送 [cond:${e.id}.${c.id}]` +
                (c.hidden ? '（隐藏条件，勿向玩家暗示）' : '')
            ),
        }));
    },

    /** 任务条件表 → 精简文本：只给 NPC「触发行为 + 发送信号」，任务效果由系统自动执行 */
    _formatTasks(tasks) {
        return tasks.map(t => ({
            '任务': `${t.name}${t.note ? '——' + t.note : ''}`,
            '触发信号': (t.conditions || []).map(c =>
                `当【${c.rule || c.name}】时 → 发送 [task:${t.id}.${c.id}]` +
                (c.hidden ? '（隐藏条件，勿向玩家暗示）' : '')
            ),
        }));
    },

    /** 线索/道具面板的 NPC 视角文本（带 1 起始序号，与 remove 指令的 index 参数对应） */
    _inventoryView(state) {
        const clues = (state && state.clues) || [];
        const items = (state && state.items) || [];
        return {
            '线索': clues.length
                ? clues.map((c, i) => `${i + 1}. ${c.text}${c.source ? `（来源：${c.source}）` : ''}`)
                : ['（暂无线索）'],
            '道具': items.length
                ? items.map((it, i) => `${i + 1}. ${it.text}${it.source ? `（来源：${it.source}）` : ''}`)
                : ['（暂无道具）'],
        };
    },

    /** 表情控制：生成该 NPC 可调用的表情/动画清单（从站长配置的开放表情/动画组装）。
     *  说明文案与清单生成逻辑耦合（方法池/立绘映射运行时解析），保留在代码中。 */
    _capability(npcId) {
        if (!npcId) return null;
        const cfg = (window.AccountInit && AccountInit.getNpcConfig(npcId)) || {};
        const enabledEmotions = cfg.enabled_emotions || [];
        const enabledActions = cfg.enabled_actions || [];
        if (!enabledEmotions.length && !enabledActions.length) return null;

        const defs = (window.AccountInit && AccountInit.getAvailableDefs && AccountInit.getAvailableDefs()) || {};
        const emotionDefs = defs.emotions || [];
        const actionDefs = defs.actions || [];
        const emoName = id => { const d = emotionDefs.find(e => e.id === id); return d ? d.name : id; };
        const actName = id => { const d = actionDefs.find(a => a.id === id); return d ? d.name : id; };
        // 统一经 getEmotionEffect 解析（方法池优先），保证提示词描述与运行时效果一致
        const fxOf = id => (window.AccountInit && AccountInit.getEmotionEffect) ? AccountInit.getEmotionEffect(npcId, id) : {};

        const cap = {
            '说明': [
                '以下是你可调用的表情与动画标记（属于 soul 设定，严格只使用清单内的标记，每段最多1个表情 + 1个动画）',
                '如果soul 设定没有写使用表情与动画的频率，那么尽量多使用表情。',
                '这些表情/动画会在你说对应情绪时自动在画面播放，你只需自然表达，无需在文字里描述肢体动作',
                '清单之外的情绪不要输出 [emotion:] 标记；某段没有情绪起伏时该段不写任何表情标记',
            ],
        };
        if (enabledEmotions.length) {
            // 特殊表情（如呆滞）不开放给 NPC 主动 [emotion:] 调用（仅系统事件触发），此处过滤
            const activeEmotions = enabledEmotions.filter(id => !['dazed'].includes(id));
            cap['表情'] = activeEmotions.map(id => {
                const fx = fxOf(id);
                const parts = [];
                if (fx.name)     parts.push(`方法「${fx.name}」`);
                if (fx.portrait) parts.push('切换对应立绘');
                if (fx.anim)     parts.push(`触发动画「${actName(fx.anim)}」`);
                if (fx.prompt)   parts.push(fx.prompt);   // 站长写的视觉描述，直接下发给 AI
                const desc = parts.length ? '：' + parts.join('，') : '';
                return `[emotion:${id}](${emoName(id)}${desc})`;
            });
        }
        if (enabledActions.length) {
            cap['动画'] = enabledActions.map(id => `[action:${id}](${actName(id)})`);
        }
        return cap;
    },

    /** 玩家信息块（三态注入）：熟练度档位 + 当前引导策略 + 玩家档案 + 双轨校准说明 */
    _playerBlock(playerInfo) {
        const tierName = { new: '新玩家', regular: '普通玩家', veteran: '老玩家' }[playerInfo.proficiency] || '普通玩家';
        const tierGuide = {
            new: '积极引导：多鼓励，卡住时主动给方向（但不点破线索）',
            regular: '必要时引导：只在玩家卡住或跑偏时给一句方向提示',
            veteran: '消极引导：几乎不引导，只做判定，除非玩家明确求助',
        }[playerInfo.proficiency] || '必要时引导：只在玩家卡住或跑偏时给一句方向提示';
        return {
            '熟练度档位': tierName,
            '引导策略（内部参考）': tierGuide,
            '玩家档案': `用户名 ${playerInfo.username || '未知'}，Lv.${playerInfo.level || 1}，通关 ${playerInfo.scripts_completed || 0} 本，上传 ${playerInfo.scripts_uploaded || 0} 本，成就分 ${playerInfo.achievement_points || 0}`,
            '说明': '以上只用于你判断用怎样的引导力度对待玩家。历史档位是初始参考，实时表现是最终权威，冲突以实时为准；玩家自称新手/老手时以自述为准',
        };
    },

    /** 标记手册（F）：集中所有可输出标记的速查表，按状态裁剪（工作流程第 4 步「对照标记手册」查阅）。
     *  标记语法与系统解析器强耦合，故保留在代码中，保证与解析逻辑永不脱节。 */
    _markerManual(state) {
        const m = {
            '说明': '你所有可输出的功能标记速查表。标记是发给系统执行的指令，不会展示给玩家。何时发、发哪个，严格对照本表。',
            '情绪与动画': {
                '[emotion:表情id]': '表达情绪（id 见资料库 G「表情/动画清单」）',
                '[action:动画id]': '播放动画（id 见资料库 G「表情/动画清单」）',
            },
            '分段': {
                '[SEGMENT]': '把输出拆成短段（每段 2~20 字），不要一次性输出大段文本',
            },
            '通用系统指令': {
                '[info:文本]': '显示一条居中系统信息（非对话气泡）',
                '[guide:目标名]': '在目标按钮画引导高亮圆环（目标名见本表末尾「引导目标表」）',
                '[options:标题1:备注1|标题2:备注2]': '出选择题（2~4 个，互斥有差异，选项前要有自然对话铺垫）',
                '[sys:report_issue:reason=具体原因]': '上报系统问题/提示词缺失（确实需要时用，reason 写清原因）',
                '[tool:history]': '回想历史对话记录（查看早前的完整对话，不受上下文隔断限制）',
            },
        };
        if (state === 'default' || state === 'browsing') {
            m['网页工具与体验'] = {
                '[tool:工具名:参数1=值1&参数2=值2]': '查询网站真实数据（工具清单见资料库 D「工具手册」，一次只调一个）',
                '[btn:按钮文字:open_tutorial:模型ID]': '渲染「API 获取教程」按钮（玩家问如何配模型/拿 Key 时用）',
                '[sys:start_experience:script_id=剧本ID]': '开启剧本体验（先确认玩家要玩，且已用 [tool:get_script] 查询）',
                '[sys:resume_experience]': '继续玩家上次未完成的剧本',
            };
        }
        if (state === 'experience') {
            m['海龟汤回答标记（仅海龟汤模式，代替文字作答）'] = {
                '说明': '发送回答标记后系统自动转成对应文字展示给玩家，不要再用文字重复作答',
                '[answer:yes]': '是',
                '[answer:no]': '否',
                '[answer:both]': '是也不是',
                '[answer:irrelevant]': '不重要',
                '[answer:unable]': '无法回答',
            };
            m['条件与任务标记（核心，漏发会判错）'] = {
                '[cond:结局ID.条件ID]': '玩家这轮满足资料库 D「剧本内容」条件表某条 rule 时发送（ID 严格照抄）',
                '[task:任务ID.条件ID]': '玩家这轮满足资料库 D「剧本内容」任务表某条 rule 时发送（ID 严格照抄）',
            };
            m['面板修改'] = {
                '[sys:add_clue:content=内容]': '添加线索到面板',
                '[sys:remove_clue:index=序号]': '删除线索（序号见资料库 E）',
                '[sys:add_item:content=内容]': '添加道具到面板',
                '[sys:remove_item:index=序号]': '删除道具（序号见资料库 E）',
                '[do:指令]': '分段延迟指令：夹在两段文本间执行（如 [do:add_clue:content=xxx]）',
            };
            m['通用系统指令']['[sys:end_experience]'] = '主动结束当前剧本体验';
        }
        // 引导目标表（guide 目标名，动态取自当前页面元素）
        if (window.UILocator && window.UILocator.TARGETS) {
            m['引导目标表'] = Object.keys(window.UILocator.TARGETS);
        }
        return m;
    },
};

window.PromptBuilder = PromptBuilder;
