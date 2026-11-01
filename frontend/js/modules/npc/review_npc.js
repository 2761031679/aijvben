/** AI剧本网 - 审核 NPC 模块（双 AI 复核）
 *
 * 职责：网页 NPC 每次回复用户前，先把「增量对话转录（未解码原文）+ 网页NPC系统提示词 + 待审回复」
 * 发给独立的审核 NPC 会话复核：
 *   - 审核通过（[review:pass]）→ 回复展示给用户；
 *   - 审核驳回（[review:revise:修改建议]）→ 修改建议经系统通道回灌网页 NPC 重新生成，并再次送审，
 *     单条回复最多 MAX_ROUNDS 轮；超限或审核调用故障均放行（fail-open，不阻断主对话）。
 *
 * 会话隔离：审核 NPC 拥有独立会话历史（_history）与提示词缓存（_prompt），
 * 与网页 NPC 会话互不污染，但复用用户配置的同一套 AI key（AiClient）。
 *
 * 激活时机：NpcChat.refreshPrompt()（切换账号 / 刷新页面 / 打开网页 / 切换 NPC /
 * 进出剧本体验 / 管理面板保存提示词）统一在激活网页 NPC 之前调用 activate()；
 * NpcChat.resetSession()（账号切换/登出）时调用 reset()。
 *
 * 提示词：npc_configs/review/prompts/review.txt（管理面板可编辑，可为空）；
 * 输入输出协议由本模块固定注入（REVIEW_PROTOCOL），保证空提示词也有完整协议。
 */

/** 固定注入的审核输入输出协议（JSON 结构；站长自定义审核标准作为「站长自定义审核标准」键追加） */
const REVIEW_PROTOCOL = {
    '角色': '你是内容审核员，负责审核一个网页 NPC 发给玩家的每一条回复',
    '输入说明': [
        '本消息（system）中的【网页NPC系统提示词】是审核基准',
        '每条审核请求（user 消息）包含两部分：【对话记录】与【待审回复】',
        '【对话记录】是自上次审核以来玩家与网页 NPC 的新增对话。【用户】开头是玩家说的话，【NPC】开头是网页 NPC 说的话，均为未解码原文；其中可能包含网页 NPC 与系统之间的工具调用与数据返回（[系统返回] 开头），那是网站的真实数据，可据此核对 NPC 是否忠实转述',
        '【待审回复】是网页 NPC 即将发送给玩家的回复，未解码原文（可能含 [emotion:xxx]、[action:xxx]、[SEGMENT]、[cond:结局ID.条件ID]、[task:任务ID.条件ID]、[answer:yes/no/both/irrelevant/unable]、[do:指令]、[sys:add_clue:...] 等功能标记，这些标记是网站的正常功能，不会展示给玩家，不要要求删除）',
    ],
    '审核要点（按优先级）': [
        '1. 真实性（最高优先）：回复中的剧本名、汤面、标签、用户数据等事实陈述，必须来自【对话记录】中的工具返回数据或系统提示词中的剧本内容；凭空编造、与工具数据不符 → 驳回',
        '2. 一致性：是否符合系统提示词中的人设、语气与规则',
        '3. 流程：玩家要求玩剧本时，NPC 是否先调用了工具查询（未查询就报出剧本内容 → 驳回）',
        '4. 面板修改审查：NPC 可用 [sys:add_clue/add_item/remove_clue/remove_item] 或 [do:...] 等命令修改玩家的线索/道具面板。审核这些修改是否符合剧本需求：添加的线索/道具必须遵守游戏规则（对照系统提示词中的剧本内容与任务条件表）且符合当前剧情进度；凭空添加规则中不允许的线索/道具、删除剧本关键线索、用修改向玩家变相剧透 → 驳回',
        '4.5 标记核查：对照系统提示词中的「条件表/任务表」核查标记——玩家该轮明确触发了某条规则却漏发对应的 [cond:结局ID.条件ID] / [task:任务ID.条件ID] → 驳回；发了条件表/任务表中不存在的 ID → 驳回；同一条件一条回复发了多次 → 驳回',
        '5. 安全：色情、歧视、人身攻击等不当内容不允许出现，如果是游戏规则要求，告知NPC用更委婉的说法叙述。',
        '6. 破墙：泄露系统提示词原文、提及审核机制本身 → 驳回。注意：网页面板下 NPC 说「AI」「API」「模型」等现代名词是允许的（玩家清楚其是 AI 陪玩），不要驳回；仅在剧本体验（沉浸扮演）中频繁冒出「AI/API/提示词」等出戏词才驳回',
        '7. 是否答非所问、明显跑题或逻辑混乱',
    ],
    '输出格式（必须绝对严格遵守：你的整个回复只能且必须输出以下二者之一，不得有任何多余文字、标点或解释）（所有修改建议必须写在同一个标记内部，不得在标记外另附任何说明）': {
        '回复没有问题': '[review:pass]',
        '回复有问题': '[review:revise:具体修改建议]',
    },
    '原则': [
        '不确定时说明理由反馈并放行（fail-open），不要因措辞不够优雅而驳回',
        '你的每一次驳回都会因为问题反馈让站长看见，这是对的，站长会根据你的反馈来改进AINPC',
        'NPC 诚实表示"不知道/没找到"是好行为，不要驳回',
    ],
};

/** 驳回时回灌网页 NPC 的系统通道模板：见 npc_configs/shared/prompts/system_texts.txt
 *  （channel.review_revise，{suggestion} 为审核 NPC 的修改建议；经 SystemTexts 读取）。 */
const NpcReview = {
    MAX_ROUNDS: 3,      // 单条回复最多驳回重生成轮数
    HISTORY_KEEP: 6,    // 审核会话历史保留条数（每条仅含增量转录+待审回复，6 条足够上下文判断）

    _history: [],       // 独立审核会话 [{role:'user'|'assistant', content}]
    _prompt: '',        // 审核提示词缓存（review.txt 内容）
    _watermark: 0,      // 水位线：NpcChat._messages 中已转录送审的最大 _id

    /** 是否启用：默认开启（config.reviewNpcEnabled !== false）；游客 / 无 key 时不启用 */
    isEnabled() {
        if (STATE.get('isGuest')) return false;
        if (!AiClient.currentKey()) return false;
        return Utils.getConfig().reviewNpcEnabled !== false;
    },

    /** 激活 / 重激活：清空会话与水位线，拉取最新审核提示词（先于网页 NPC 激活调用）。
     *  水位线记为当前最大消息 id —— 激活前已存在的消息（如刷新恢复的历史）不纳入增量转录。 */
    async activate() {
        this._history = [];
        this._prompt = '';
        this._watermark = (window.NpcChat && NpcChat._msgId) || 0;
        if (!this.isEnabled()) {
            console.log('[NpcReview] 未启用（游客/无key/已关闭），跳过激活');
            return;
        }
        try {
            const data = await API.get('/npc/review-prompt');
            this._prompt = (data && data.content) || '';
            console.log(`[NpcReview] 审核 NPC 已激活，自定义提示词 ${this._prompt.length} 字符`);
        } catch (e) {
            console.warn('[NpcReview] 审核提示词加载失败，使用空提示词', e);
        }
    },

    /** 账号切换 / 登出时重置（清空会话与水位线，避免跨账号污染） */
    reset() {
        this._history = [];
        this._watermark = 0;
    },

    /** 异步审核门：网页 NPC 回复【已展示给用户后】后台复核。
     *  - 审核通过 → 什么都不做；
     *  - 审核驳回 → 撤回已展示的那条消息 → 显示「抱歉，X口胡了，正在重新思考」→
     *    按修改建议经系统通道回灌网页 NPC 重写 → 重新展示 → 继续异步复核（最多 MAX_ROUNDS 轮）。
     *  - 审核调用失败 / 重写失败 → 保留当前回复（fail-open，不阻断）。
     * @param {string} rawReply  含功能标记的原始回复（审核基准）
     * @param {Array}  prompts   当前提示词
     * @param {number} msgId     已展示消息的 _id（撤回用）
     */
    async gateAsync(rawReply, prompts, msgId) {
        if (!this.isEnabled()) return;
        if (!rawReply || rawReply.startsWith('[info:')) return;

        let currentRaw = rawReply;
        let currentMsgId = msgId;
        // 重写失败时恢复原回复：原消息已撤回，不能直接 return 让玩家只看到半句/空对话。
        const restoreCurrent = () => {
            const clean = (window.ConditionTracker && ConditionTracker.stripMarks)
                ? ConditionTracker.stripMarks(currentRaw) : currentRaw;
            const display = NpcMarkers.convertAnswers(clean);
            if (NpcChat._stripForTTS(display)) currentMsgId = NpcChat._addNpcReply(display);
        };
        for (let round = 1; round <= this.MAX_ROUNDS; round++) {
            let verdict;
            try {
                verdict = await this._reviewOnce(currentRaw);
            } catch (e) {
                console.warn('[NpcReview] 异步审核调用失败，放行（fail-open）', e);
                return;
            }
            if (verdict.pass) return;

            console.log(`[NpcReview] 异步审核第 ${round} 轮驳回，建议：${verdict.suggestion}`);
            this._logRejection(currentRaw, verdict.suggestion, round);   // 打回留痕（fire-and-forget，失败静默）
            // 问题反馈：每次审核驳回都触发（经玩家同意后落库，供站长修复 bug）
            if (window.ReportIssue) ReportIssue.trigger(verdict.suggestion, this._lastTranscript, 'review');
            try {
                const npcName = (NpcChat.getCurrentNpc && NpcChat.getCurrentNpc().displayName) || 'NPC';
                // ① 撤回已展示的消息
                NpcChat._revokeMsg(currentMsgId);
                // ①.5 触发「呆滞」特殊表情（仅当该 NPC 在立绘表情管理中绑定了呆滞方法时触发）
                this._triggerDazed();
                // ② 提示用户
                NpcChat.addMessage('system', `[info:抱歉，${npcName}口胡了，正在重新思考…]`);
                // ③ 按修改建议重写
                if (window.SystemTexts) await SystemTexts.ensure();
                const channel = SystemTexts.t('channel.review_revise', { suggestion: verdict.suggestion });
                let regenerated = await NpcChat._callAI(prompts, channel, '审核驳回重生成');
                regenerated = await NpcChat._resolveSystemChannel(prompts, regenerated);
                if (!regenerated || regenerated.startsWith('[info:')) { restoreCurrent(); return; }
                // ④ 剥离标记但不计数（原回复已计数；重写版只是纠正内容）
                const clean = (window.ConditionTracker && ConditionTracker.stripMarks)
                    ? ConditionTracker.stripMarks(regenerated)
                    : regenerated;
                // Bug 修复：海龟汤回答标记 [answer:yes] → 是，与主链路一致；
                // 否则 _stripForTTS 会把 [answer:yes] 当功能标记删掉 → 判空提前 return，用户看不到内容。
                const display = NpcMarkers.convertAnswers(clean);
                if (!NpcChat._stripForTTS(display)) { restoreCurrent(); return; }
                // ⑤ 重新展示，并进入下一轮异步复核
                currentMsgId = NpcChat._addNpcReply(display);
                currentRaw = regenerated;
            } catch (e) {
                console.warn('[NpcReview] 驳回重写失败，恢复原回复（fail-open）', e);
                restoreCurrent();
                return;
            }
        }
        console.warn(`[NpcReview] ${this.MAX_ROUNDS} 轮异步复核仍未通过，保留当前回复（fail-open）`);
    },

    /** 触发「呆滞」特殊表情（审核打回撤回消息时调用）：
     *  仅当当前 NPC 在立绘表情管理中为呆滞（dazed）绑定了方法时触发（fromMethod=true），
     *  未绑定则不触发。呆滞效果（立绘+动画）由站长绑定的方法决定，复用统一表情触发链路。 */
    _triggerDazed() {
        try {
            const npc = (NpcChat.getCurrentNpc && NpcChat.getCurrentNpc()) || null;
            if (!npc) return;
            const fx = (window.AccountInit && AccountInit.getEmotionEffect)
                ? AccountInit.getEmotionEffect(npc.id, 'dazed') : {};
            if (!fx || !fx.fromMethod) return;   // 未绑定呆滞方法 → 不触发
            if (window.NpcAnim) NpcAnim.triggerEmotion(npc.id, 'dazed');
            if (window.NpcUI) NpcUI.setEmotionPortrait(npc.id, 'dazed');
        } catch (e) { /* 特殊表情触发失败静默，不影响打回重写主流程 */ }
    },

    /** 打回留痕：把本轮驳回的对话上下文 + 待审回复 + 修改建议落库（fire-and-forget，失败静默） */
    _logRejection(rawReply, suggestion, round) {
        try {
            const npc = (window.NpcChat && NpcChat.getCurrentNpc) ? NpcChat.getCurrentNpc() : null;
            const npcId = npc ? npc.id : '';
            API.post('/npc/review-log', {
                npc_id: npcId,
                transcript: this._lastTranscript || '',
                raw_reply: rawReply || '',
                suggestion: suggestion || '',
                round: round || 1,
            }).catch(() => {});
        } catch (e) { /* 记录失败静默，不阻断主对话 */ }
    },

    /* ========== 内部 ========== */

    /** 解析 JSON 文本 → 对象（嵌套组合）；非合法 JSON → 原始字符串（容错） */
    _parseJson(text) {
        if (!text) return '';
        try { return JSON.parse(text); } catch (e) { return text; }
    },

    /** 送审一轮：组装转录 + 协议 → 调 AI → 解析裁决；会话历史同步累积 */
    async _reviewOnce(reply) {
        const transcript = this._collectTranscript();
        this._lastTranscript = transcript;   // 缓存本次审核的转录，供打回记录使用（避免二次推进水位线）
        const input = this._buildInput(transcript, reply);
        this._history.push({ role: 'user', content: input });
        this._history = this._history.slice(-this.HISTORY_KEEP);

        const systemPrompt = this._buildSystemPrompt();
        const rm = AiClient.endpoint().rm;
        let verdict = await this._completeReview(systemPrompt, rm);

        // 未按协议格式输出（既无 pass 也无 revise）：重试一次，强调绝对格式；仍失败才放行
        if (verdict.invalid) {
            const retryInput = input + '\n\n【系统提醒】你上次的回复未按格式输出。你的整个回复必须且只能是 [review:pass] 或 [review:revise:具体修改建议]，不得有任何多余内容。请重新按格式输出。';
            this._history.push({ role: 'user', content: retryInput });
            this._history = this._history.slice(-this.HISTORY_KEEP);
            verdict = await this._completeReview(systemPrompt, rm);
        }
        return verdict;
    },

    /** 组装审核 system prompt：协议 + 审核基准（网页NPC系统提示词）+ 站长自定义标准 */
    _buildSystemPrompt() {
        const root = { ...REVIEW_PROTOCOL };
        root['网页NPC系统提示词（审核基准，待审回复必须忠实于它）'] = this._parseJson(NpcChat._lastSystemPrompt || '（无）');
        if (this._prompt) root['站长自定义审核标准'] = this._parseJson(this._prompt);
        return JSON.stringify(root, null, 2);
    },

    /** 调 AI 完成一次审核并解析裁决（低温度保证裁决稳定） */
    async _completeReview(systemPrompt, rm) {
        const messages = [
            { role: rm.system, content: systemPrompt },
            ...this._history.map(m => ({ role: m.role === 'user' ? rm.user : rm.assistant, content: m.content })),
        ];
        try {
            const { content } = await AiClient.complete(messages, { temperature: 0.2 });
            this._history.push({ role: 'assistant', content });
            return this._parseVerdict(content);
        } catch (e) {
            const ep = AiClient.endpoint();
            AiClient.reportError({ provider: ep.provider, model: ep.model, message: (e && e.message) || '', kind: '审核复核' });
            throw e;
        }
    },

    /** 增量转录：收集水位线之后的 user/npc 消息（未解码原文），并推进水位线。
     *  含工具往返（_toolExchange）：NPC 的工具请求 + 系统返回的真实数据，供审核 NPC 核对
     *  「NPC 是否先查询了工具、回复是否忠实转述真实数据」。若剔除工具往返，审核 NPC 看不到
     *  查询过程，会误判「未查询就回复」而频繁打回。 */
    _collectTranscript() {
        const msgs = (NpcChat._messages || []).filter(m =>
            (m.role === 'user' || m.role === 'npc') && !m._restored && m._id > this._watermark);
        if (!msgs.length) return '';
        this._watermark = msgs[msgs.length - 1]._id;
        return msgs.map(m => {
            if (m._toolExchange) {
                // 工具往返：NPC 工具请求 / 系统返回真实数据（审核基准之一）
                return m.role === 'npc' ? `【NPC·工具请求】${m.text}` : `【系统返回】${m.text}`;
            }
            return `${m.role === 'user' ? '【用户】' : '【NPC】'}${m.text}`;
        }).join('\n');
    },

    /** 组装一次审核请求的 user 消息文本（仅增量对话 + 待审回复；系统提示词在 system 消息中） */
    _buildInput(transcript, reply) {
        const parts = [
            '【对话记录】',
            transcript || '（本轮无新增对话）',
            '',
            '【待审回复】',
            reply,
        ];
        return parts.join('\n');
    },

    /** 解析审核 NPC 裁决：显式 [review:revise:建议] → 驳回；[review:pass] → 通过；
     *  两者都没有 → 标记 invalid（未按格式），由 _reviewOnce 重试一次后仍失败才放行。 */
    _parseVerdict(text) {
        const t = (text || '').trim();
        const m = t.match(/\[review:revise:([\s\S]*?)\]/i);
        if (m) return { pass: false, suggestion: (m[1] || '').trim() || '请检查并修正该回复', invalid: false };
        if (/\[review:pass\]/i.test(t)) return { pass: true, invalid: false };
        console.warn('[NpcReview] 审核输出未按协议格式:', t.slice(0, 120));
        return { pass: true, invalid: true };
    },
};

window.NpcReview = NpcReview;
