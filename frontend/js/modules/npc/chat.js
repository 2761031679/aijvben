/** AI剧本网 - NPC 聊天模块（核心管线）
 * ------------------------------------------------------------------
 *  职责（v4.6 起只做编排，不实现具体功能）：
 *    发消息 → 系统通道往返 → 审核复核 → 条件计数 → 分段渲染 的管线调度，
 *    以及消息列表 / 气泡渲染 / 打字机 / 语音 / 设置弹窗。
 *
 *  已剥离的独立模块：
 *   - modules/npc/tools.js          NpcTools          工具调用（[tool:] 解析/执行/格式化）
 *   - modules/npc/system_channel.js NpcSystemChannel  系统通道往返（[tool:]/[sys:] 回灌）
 *   - modules/npc/segments.js       NpcSegments       分段叙述（[SEGMENT]/[do:] 状态与执行）
 *   - modules/npc/markers.js        NpcMarkers        渲染期标记处理 / 打字文本
 *   - modules/npc/system_texts.js   SystemTexts       进入 AI 对话流的系统文案（外置可编辑）
 */
const NpcChat = {
    /** 当前 NPC（供信号模块等调用） */
    getCurrentNpc() { return this._currentNpc || CONFIG.NPC_LIST[0]; },

    _currentNpc: null,
    _messages: [],
    _isLoading: false,
    // 上一轮还没出完字时玩家又发了一句：先接着，等这一轮收尾再自动发出去。
    // 以前是直接 return（连输入框都不清），玩家的感觉是「我发了怎么没反应」，
    // 而且等上一轮的答案迟到，看上去就像「回复串位、提问丢了」。
    _pendingInput: null,
    _recognition: null,
    _promptCache: {},   // { npcId: [{prompt_type, content}, ...] }
    _msgId: 0,          // 消息自增 ID，用于选项定位来源消息
    _contextBreakId: 0, // 上下文隔断点：打包发给 AI 时只取 _id > 此值的消息（切换剧本时推进，UI 历史不受影响）

    _captureAI: false,  // 站长示例「完整 API 调用」捕获开关
    _greeted: false,    // 本次会话是否已触发过开场主动问好（防重复）
    _playerInfo: null,        // 玩家信息缓存（username/level/.../proficiency，登录态）
    _playerInfoLoaded: false, // 是否已尝试加载玩家信息
    _captureBuffer: [], // 捕获缓冲：每轮 { provider, model, url, request_messages, response, error? }

    _apiLog: [],        // 全量 API 真实收发记录（环形缓冲，仅留最近 30 轮），供管理面板「发往 AI 的上下文」展示
    _API_LOG_MAX: 30,

    // —— 主持通道（M30b）——
    _lastPromptHash: null,    // 最近一次校验通过的 prompt_hash（契约 §4.2 的内容指纹）
    _hashWarned: false,       // 「提示词与服务端不一致」只提醒一次（每轮都弹就成了噪音）
    _hashCheckSkipped: false, // 环境不支持 crypto.subtle（非安全上下文）时跳过校验，别反复打日志
    _roundHost: null,         // 本轮开头取到的那份主持上下文 {bundle,state,at,used}；中途取失败时用它兜底

    /* ========== 初始化 ========== */
    init() {
        // 尊重用户默认 NPC 设置
        const config = Utils.getConfig();
        const defaultNpcId = config.defaultNpc || 'jingyuniang';
        const idx = CONFIG.NPC_LIST.findIndex(n => n.id === defaultNpcId);
        this._currentNpc = CONFIG.NPC_LIST[idx >= 0 ? idx : 0] || CONFIG.NPC_LIST[0];

        // 打字机 / 语音 / 自动播放下一段 状态
        this._typeEnabled = config.typewriterEnabled !== false;   // 默认开启
        this._typeSpeed = parseInt(config.typewriterSpeed) || 30;
        // 说话方式：唯一的人声开关（'off' 静音 / 'blip' 说话音 / 'sfx' 录音包 / 'tts' 合成朗读）。
        // 以前这里是 voiceEnabled + blipEnabled + sfxEnabled 三个独立布尔，加上引擎又有一个值，
        // 四份状态互相盖来盖去（默认值还三处不一致），已经出过"整站没声音""设置面板重复"两次事故。
        // 现在只认一个字段，_speechModeOf() 负责把旧配置迁移过来。
        this._speechMode = this._speechModeOf(config);
        this._autoAdvanceNext = config.autoAdvanceNext !== false;   // 默认开启：分段回复自动逐段播完，避免"最后一句被吞"
        this._autoAdvanceDelay = parseInt(config.autoAdvanceDelay) || 1200;
        NpcSegments.reset();
        this._typeTimer = null;
        this._autoTimer = null;
        this._voiceGuard = null;   // 朗读看门狗：合成朗读没回调时兜底推进，避免分段回复卡死在半路

        NpcUI.renderPortrait(this._currentNpc);
        // 启动时先问一次当前 NPC 有没有录音包（决定默认人声是音效还是沉默）
        if (window.NpcSfx && NpcSfx.forNpc) NpcSfx.forNpc(this._currentNpc && this._currentNpc.id);
        this._bindInput();
        this._bindBlankAdvance();
        this._bindActionButtons();
        this._bindHistoryScroll();

        console.log('[NpcChat] 初始化 NPC:', this._currentNpc.id, this._currentNpc.displayName);
    },

    _bindInput() {
        document.getElementById('companionChatInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });
        // 输入栏按钮：改用 pointerdown（按下瞬间触发）修复移动端问题——
        // 输入框聚焦时键盘弹出，点击按钮先触发 blur（键盘收起）→ 布局重排 → 按钮位移，
        // click 因「按下/抬起不在同一元素」而失效。pointerdown 早于 blur，稳定可靠。
        const bindDown = (sel, fn) => {
            const el = document.querySelector(sel);
            if (!el) return;
            el.addEventListener('pointerdown', (e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;   // 忽略右键
                e.preventDefault();                                        // 阻止 blur 与后续 click
                fn();
            });
        };
        bindDown('.tea-send-btn', () => this.sendMessage());
        bindDown('#btnVoice', () => this.toggleVoice());
        bindDown('#btnSettingsLeft', () => this.openSettings());
        bindDown('#btnToolPanel', () => { if (window.ToolPanel) ToolPanel.toggle(); });
    },

    /** 「点击空白 / 空格」推进分段叙述
     *  规则：只要没有点击到功能性元素（按钮 / 输入框 / 链接 / 弹窗 / 下拉等），
     *  在网页任意空白处点击即视为「点击空白」→ 推进下一段；按空格键同理。
     */
    _bindBlankAdvance() {
        // 功能性元素选择器：命中这些则不视为「点击空白」
        const FUNCTIONAL = 'button, a, input, textarea, select, label, .option-btn, .npc-action-btn, .fold-toggle, .modal, .npc-dropdown, .forum-sidebar, .forum-content, [role="button"], [onclick]';

        document.addEventListener('click', (e) => {
            if (!NpcSegments.hasPending()) return;
            if (e.target.closest(FUNCTIONAL)) return;   // 点到功能按钮 → 忽略
            if (e.target.closest('#teahouse-npc')) return;  // NPC 立绘区域不触发空白推进
            this._advanceSegmentDisplay();
        });

        document.addEventListener('keydown', (e) => {
            if (e.code !== 'Space' && e.key !== ' ') return;
            // 正在输入框内打字时，空格不推进（正常输入空格）
            const t = e.target;
            const tag = (t && t.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
            if (!NpcSegments.hasPending()) return;
            e.preventDefault();   // 阻止页面滚动
            this._advanceSegmentDisplay();
        });

        // 历史超长消息：展开 / 收起全文
        document.addEventListener('click', (e) => {
            const t = e.target.closest('.fold-toggle');
            if (!t) return;
            const bubble = t.closest('.chat-bubble-npc, .chat-bubble-user');
            if (!bubble) return;
            const preview = bubble.querySelector('.fold-preview');
            const full = bubble.querySelector('.fold-full');
            if (!preview || !full) return;
            const expanded = full.style.display !== 'none';
            if (expanded) {
                full.style.display = 'none';
                preview.style.display = '';
                t.textContent = '展开全文';
            } else {
                full.style.display = '';
                preview.style.display = 'none';
                t.textContent = '收起';
            }
        });
    },

    /** 对话中的功能按钮（[btn:文字:动作:参数] 标记渲染的 .npc-action-btn）事件委托。
     *  NPC 回复与离线引导通用；目前支持 open_tutorial：打开对应模型的 API 获取教程。 */
    _bindActionButtons() {
        const area = document.getElementById('teaChatArea');
        if (!area) return;
        area.addEventListener('click', (e) => {
            const btn = e.target.closest('.npc-action-btn');
            if (!btn || btn.disabled) return;
            const act = btn.dataset.npcAct || '';
            const arg = btn.dataset.npcArg || '';
            if (act === 'open_tutorial' && window.Tutorial) {
                Tutorial.open(arg || undefined);
            }
        });
    },

    /** 向上滚动到顶部自动加载更早的历史对话 */
    _bindHistoryScroll() {
        const area = document.getElementById('teaChatArea');
        if (!area) return;
        area.addEventListener('scroll', () => {
            if (area.scrollTop > 6 || this._histLoading) return;
            if (!NpcHistory.hasMore()) return;
            this._histLoading = true;
            const prevHeight = area.scrollHeight;
            const older = NpcHistory.olderPage();
            if (older.length) {
                this._messages = older.concat(this._messages);
                this._renderMessages({ keepScrollFrom: prevHeight });
            }
            this._histLoading = false;
        });
    },

    /* ========== NPC 切换 ========== */
    getNpcs() {
        return CONFIG.NPC_LIST || [];
    },

    getCurrentNpcIndex() {
        const idx = (CONFIG.NPC_LIST || []).findIndex(n => n.id === this._currentNpc?.id);
        return idx >= 0 ? idx : 0;
    },

    /** 以当前 NPC 提示词向 AI 发送一条消息，返回原始（未解码）回复文本 */
    async askRaw(text) {
        const prompts = await this._getPrompts();
        return this._callAI(prompts, text);
    },

    /** 调试用：发送并捕获「打包给 AI 的完整请求 + AI 原始回复」，供站长示例展示 */
    async askRawDebug(text) {
        this._captureBuffer = [];
        this._captureAI = true;
        try {
            const raw = await this.askRaw(text);
            return { raw, turns: this._captureBuffer };
        } finally {
            this._captureAI = false;
        }
    },

    switchNpc(npcIndex) {
        this._currentNpc = CONFIG.NPC_LIST[npcIndex] || CONFIG.NPC_LIST[0];
        // 换人前先把上一个 NPC 的动画类清干净。
        // 不清的话，上一轮残留的 anim-hop-loop / anim-shiver-loop 会挂在新立绘身上继续播，
        // 看上去就像「换了人之后新立绘还带着上一个人的表情动作」。
        const stage = document.getElementById('teahouse-npc');
        if (stage) {
            Array.from(stage.classList)
                .filter(c => c.indexOf('anim-') === 0)
                .forEach(c => stage.classList.remove(c));
        }
        if (window.AccountInit && AccountInit._applyNpcPortrait) AccountInit._applyNpcPortrait(this._currentNpc);
        else NpcUI.renderPortrait(this._currentNpc);
        // 立绘缩放是「每个 NPC 各一份」的后台配置（npc_personality_configs.scale），
        // 而 --npc-scale 只在新配置到手后才重算。这里主动刷一次，
        // 否则换到缩放值不同的 NPC 时，容器还用着上一个人的高度：立绘被拉长/压扁。
        if (window.AccountInit && AccountInit._applyWindowScale) AccountInit._applyWindowScale();
        // 换人就换录音包：有包才播音效，没包就把设置里的开关置灰（NpcSfx 内部处理）
        if (window.NpcSfx && NpcSfx.forNpc) {
            NpcSfx.forNpc(this._currentNpc && this._currentNpc.id);
        }
        // 上一个 NPC 的说话音不能跟着过来
        if (window.BlipVoice) BlipVoice.cancel();
        this._messages = [];
        NpcSegments.reset();
        // 清除当前 NPC 的提示词缓存（重新加载时获取最新内容）
        delete this._promptCache[this._currentNpc.id];

        NpcHistory.resetCursor();
        this._renderMessages();
        this.addSystemMessage(`已切换到 ${this._currentNpc.displayName}`);
        // 恢复该 NPC 的历史对话
        this.loadHistory();

        // 通知其他模块 NPC 已切换（TTS 音色等）
        Events.emit('npc-changed', { npcId: this._currentNpc.id, npc: this._currentNpc });
        // 重新发送/刷新系统提示词（激活 NPC 时触发，确保采用最新上下文）
        this.refreshPrompt();
    },

    /* ========== 消息发送 ========== */
    async sendMessage() {
        const input = document.getElementById('companionChatInput');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;

        // NPC 还在出字：把这句接住，等本轮结束自动发出，而不是丢掉。
        // 只留一句（后一句覆盖前一句），否则连按回车会堆成一串复读。
        if (this._isLoading) {
            this._pendingInput = text;
            input.value = '';
            Utils.showToast('NPC 还在回复，这句话会在它说完后自动发出', 'info');
            return;
        }

        input.value = '';
        return this._sendUserMessage(text);
    },

    /** 用户点击 NPC 给出的选项时调用：将选项内容作为消息发送 */
    async sendOption(text) {
        if (!text) return;
        if (this._isLoading) {
            this._pendingInput = text;
            Utils.showToast('NPC 还在回复，你的选择会在它说完后自动发出', 'info');
            return;
        }
        return this._sendUserMessage(text);
    },

    /** 记录某条 NPC 消息中被选中的选项（幂等：已选过返回 false） */
    selectOption(msgId, optionText) {
        const msg = this._messages.find(m => m._id === msgId);
        if (!msg || msg._selectedOption) return false;
        msg._selectedOption = optionText;
        this._renderMessages();   // 立即刷新勾选视觉
        return true;
    },

    async _sendUserMessage(text) {
        // 无 AI 模式：走离线本地引导回应（不调 AI，零 token）
        // 但体验态（剧本体验中）即使无 key 也走 AI 流程（_callAI 会走免费接口），不走离线引导
        if (NoAiModule.isActive() && !(window.Experience && Experience.isActive())) {
            await this._offlineReply(text);
            return;
        }

        // 一轮用户对话：体验取消冷却计数 -1
        if (window.Experience && Experience._tickCooldown) Experience._tickCooldown();

        // 先置 loading 状态，再渲染；任何环节异常都由 finally 复位，杜绝 _isLoading 卡死
        this._isLoading = true;
        try {
            // ⓪ M30b：体验态先验一次主持通道。通道不可用就**这一轮不发**。
            //    必须赶在把玩家的话插进对话之前拦住：插完再撤会留下一条已渲染、
            //    而且已经写进本地历史（NpcHistory.append）的用户消息，玩家的感觉是
            //    「我说了、它没理我」，比直接说「没发出去」更糟。
            this._roundHost = null;
            if (window.GameState && GameState.get && GameState.get() === 'experience') {
                try {
                    await this._loadHostPrompt('experience');
                } catch (e) {
                    if (e && e.hostUnavailable) {
                        this._failHostRound(e, text, false);
                        return;              // 复位交给 finally
                    }
                    throw e;
                }
            }

            // ① 显示用户消息 + 省略号（渲染异常不阻断主流程）
            try {
                this.addMessage('user', text);
                this._renderLoading();
            } catch (e) {
                console.warn('[NpcChat] 渲染用户消息/省略号失败:', e);
            }

            const prompts = await this._getPrompts();

            // 若系统有待推送给 NPC 的信息（通知/信号），随本轮一并带入上下文
            let userTurn = text;
            const pending = NpcBus.drain();
            if (pending) userTurn += `\n\n[系统提示（仅供你参考，请自然融入回答）]\n${pending}`;

            let reply = await this._callAI(prompts, userTurn, '初始生成');

            // 多轮系统交互：NPC 可连续向系统请求数据（[tool:] / [sys:]），
            // 系统即时回灌结果，直至 NPC 产出面向用户的最终回答。
            reply = await this._resolveSystemChannel(prompts, reply);

            // 保留含功能标记的原始回复，供审核 NPC 核对（标记是网站正常功能，不展示给玩家）
            const rawReply = reply;

            // 条件系统：提取条件触发标记并计数，同时剥离标记得到干净展示文本
            if (window.ConditionTracker) reply = ConditionTracker.processReply(reply);
            // 海龟汤回答标记：[answer:yes] → 是（在空值判定与 TTS 之前转换，避免被当纯标记静默）
            reply = NpcMarkers.convertAnswers(reply);

            // 剥离功能标记后为空：区分「纯指令回复」（如 [sys:ignore]，静默不展示）与「AI 未返回内容」
            if (!this._stripForTTS(reply)) {
                // 剥掉功能标记后什么都没有，分两种，别再混为一谈：
                //   ① AI 真的没吐字（网络/模型/吃掉了整段）→ 必须给玩家一句人话，否则界面上
                //      只是省略号消失、什么都没有，看起来就是「卡死了、没保底」；
                //   ② AI 吐的本来就只有指令（[sys:ignore] 之类）→ 静默是对的，不要硬塞提示。
                const hadText = !!(reply && reply.trim());
                if (!hadText || reply.trim() === '[info:AI 未返回内容]') {
                    // 模型一个字都没吐：给玩家一句人话（原来这里什么都不显示）
                    this.addMessage('system', '[info:没听清，你再说一遍？]');
                } else if (reply.trim().startsWith('[info:')) {
                    // AI 侧已经写明了具体原因（密钥没配、被限流、渠道报错…），
                    // 原样转述比统一换成「没听清」有用得多
                    this.addMessage('system', reply.trim());
                }
                this._renderMessages();
                return;
            }

            // 先展示给用户（不再阻塞等待审核，显著提升响应速度）
            const msgId = this._addNpcReply(reply);

            // 异步审核：展示后后台复核，驳回则撤回该条消息并重写（不阻塞本轮返回）
            if (window.NpcReview) NpcReview.gateAsync(rawReply, prompts, msgId);
        } catch (e) {
            // 主持通道在这一轮中途断了（预检时还好好的）：这一轮答不完，但玩家的话已经发出去了，
            // 所以不还原输入框 —— 还原会让人以为没发出去，再发一遍就是两遍。
            if (e && e.hostUnavailable) {
                this._failHostRound(e, text, true);
            } else {
                try { this.addMessage('system', `[info:对话出错：${e.message}]`); }
                catch (e2) { console.warn('[NpcChat] 错误提示渲染失败:', e2); }
            }
        } finally {
            this._isLoading = false;   // 无论成功/失败/渲染异常，务必复位，避免后续消息被静默拦截
            // 玩家在上一轮出字期间补发的那句，现在自动接上。
            // 用 setTimeout 让出一次事件循环：让本轮的消息渲染先画完，避免排队那句
            // 与本轮的 addMessage 抢同一个渲染帧，看上去像两条挤在一起。
            const queued = this._pendingInput;
            if (queued) {
                this._pendingInput = null;
                setTimeout(() => { this._sendUserMessage(queued); }, 0);
            }
        }
    },

    /** 系统通道往返（委托 NpcSystemChannel；review_npc.js 复用此入口） */
    _resolveSystemChannel(prompts, reply) {
        return NpcSystemChannel.resolve(this, prompts, reply);
    },

    /** 离线引导回应（无 AI 模式）：本地关键词匹配（规则来自可编辑配置），不调 AI，零 token */
    async _offlineReply(text) {
        this.addMessage('user', text);
        let res = { reply: '（离线引导暂不可用）', highlight: null };
        if (window.OfflineNpc) {
            try { res = await OfflineNpc.answer(text); } catch (e) { /* 加载失败用默认 */ }
        }
        setTimeout(() => {
            this.addMessage('npc', res.reply, { _offline: true });
            clearTimeout(this._voiceGuard);
            this._voiceGuard = null;
            if (window.TTS && TTS.stop) TTS.stop();   // 中断上一句语音，随即朗读本句（与正常 NPC 分段推进一致）
            this._speakSegment(res.reply);   // 离线引导回复也朗读（开启语音时）
            if (res.highlight && window.GuideHighlight) GuideHighlight.show(res.highlight, res.reply);
        }, 400);
    },

    /** 系统主动向 NPC 推送信息并触发一次 NPC 发言（用于站内通知/信号）。
     *  不会打断正在进行的对话；NPC 若认为无需告知用户可回复 [sys:ignore]（不展示）。
     */
    async systemTurn() {
        if (this._isLoading) return;              // 正在对话则不打断，信息留待下轮
        const pending = NpcBus.drain();
        if (!pending) return;
        this._isLoading = true;
        this._renderLoading();
        try {
            const prompts = await this._getPrompts();
            let reply = await this._callAI(prompts, SystemTexts.t('channel.system_notify', { result: pending }), '系统通知');
            reply = await this._resolveSystemChannel(prompts, reply);
            if (/\[sys:ignore\]/i.test(reply)) {
                this._renderMessages();           // NPC 选择忽略：清除 loading
            } else {
                const rawReply = reply;
                // 条件系统：系统触发的 NPC 发言同样计入条件标记（剥离标记得到干净文本）
                if (window.ConditionTracker) reply = ConditionTracker.processReply(reply);
                reply = NpcMarkers.convertAnswers(reply);
                if (this._stripForTTS(reply)) {
                    const msgId = this._addNpcReply(reply);
                    // 先展示后异步审核（系统触发的发言同样适用）
                    if (window.NpcReview) NpcReview.gateAsync(rawReply, prompts, msgId);
                } else {
                    this._renderMessages();
                }
            }
        } catch (e) {
            if (e && e.hostUnavailable) {
                this.addSystemMessage('主持通道暂时不可用（' + ((e && e.message) || '') + '），这条通知没能送达');
            }
            this._renderMessages();
        }
        this._isLoading = false;
    },

    addSystemMessage(text) {
        this._messages.push({ role: 'system', text: `[info:${text}]`, time: new Date(), _system: true, _id: ++this._msgId });
        this._renderMessages();
    },

    /* ========== 提示词缓存加载 ========== */
    async _getPrompts() {
        const npcId = this._currentNpc.id;
        // 有缓存直接返回
        if (this._promptCache[npcId]) {
            return this._promptCache[npcId];
        }
        // 从服务器加载
        try {
            const prompts = await API.get(`/npc/prompts?npc_id=${npcId}`);
            this._promptCache[npcId] = prompts || [];
            console.log(`[NpcChat] 加载 ${npcId} 提示词:`, (prompts || []).map(p => `${p.prompt_type}(${p.npc_id})`).join(', '));
            return this._promptCache[npcId];
        } catch (e) {
            console.warn('[NpcChat] 提示词加载失败:', e);
            return [];
        }
    },

    /** 强制重新加载当前NPC提示词（管理面板保存后调用） */
    async reloadPrompts() {
        const npcId = this._currentNpc.id;
        delete this._promptCache[npcId];
        if (window.SystemTexts) await SystemTexts.reload();
        return this._getPrompts();
    },

    /* ========== AI 调用 ==========
     * kind：本轮调用的用途标注（初始生成 / 工具结果回灌 / 审核驳回重生成 / 系统通知），
     *       仅用于管理面板「AI 原始回复」日志分组展示，不影响请求内容。 */
    async _callAI(prompts, userInput, kind) {
        if (!AiClient.currentKey()) {
            // 无 key：处于剧本体验态时走免费接口（服务器密钥），否则提示配置
            const free = await this._callFreeAI(prompts, userInput);
            if (free) return free;
            return '[info:请先在设置中配置 AI API Key]';
        }

        // 消息打包逻辑抽为 _buildRequestMessages（供 _callAI 与示例页"上下文预览"复用）
        const { messages, ep } = await this._buildRequestMessages(userInput);

        // 分级超时 + 检测式重试：
        //   首轮 5 秒（超过即视为可能挂起/异常）；
        //   首轮超时后不直接报错，而是「检测重试」——用更长的 30 秒再请求一次，
        //   以区分「AI 在思考复杂问题（慢）」与「真没响应」；重试也超时才判定失败。
        //   全程在同一轮对话内，不重复添加用户消息。
        const ATTEMPTS = [
            { timeout: 5000, label: '首轮' },
            { timeout: 30000, label: '检测重试' },
        ];
        let content = '';
        let lastError = '';
        const npcId = this._currentNpc ? this._currentNpc.id : '';
        for (let i = 0; i < ATTEMPTS.length; i++) {
            try {
                const r = await AiClient.complete(messages, { timeout: ATTEMPTS[i].timeout });
                content = (r && r.content) || '';
                if (content) break;   // 有内容：正常返回
                // 空内容：若还有重试机会则进入检测重试，否则跳出循环走报错书落库
                lastError = 'AI 返回空内容';
                if (i < ATTEMPTS.length - 1) {
                    console.warn(`[NpcChat] AI 返回空内容（${ATTEMPTS[i].label}），进入检测重试`);
                    continue;
                }
            } catch (e) {
                const msg = (e && e.message) || '';
                lastError = msg;
                const retryable = /超时|网络|fetch|failed to fetch|timeout/i.test(msg);
                if (retryable && i < ATTEMPTS.length - 1) {
                    console.warn(`[NpcChat] AI 未及时响应（${ATTEMPTS[i].label} ${ATTEMPTS[i].timeout / 1000}秒超时），进入检测重试`);
                    continue;
                }
                this._logApiTurn(ep, kind, messages, msg, true);
                if (this._captureAI) {
                    this._captureBuffer.push({
                        provider: ep.provider, model: ep.model, url: ep.url,
                        kind: kind || '初始生成',
                        request_messages: messages, response: msg, error: true,
                    });
                }
                // 不可重试的异常（API 错误等）：落库报错书后抛给上层
                AiClient.reportError({ provider: ep.provider, model: ep.model, message: msg, kind, npc_id: npcId });
                throw e;
            }
        }
        // 空内容（重试后仍空）：落库报错书，返回占位符（由 _sendUserMessage 识别并提示用户）
        if (!content) {
            AiClient.reportError({ error_type: 'empty_content', provider: ep.provider, model: ep.model, message: lastError, kind, npc_id: npcId });
        }
        this._logApiTurn(ep, kind, messages, content, false);
        if (this._captureAI) {
            this._captureBuffer.push({
                provider: ep.provider, model: ep.model, url: ep.url,
                kind: kind || '初始生成',
                request_messages: messages, response: content,
            });
        }
        return content || '[info:AI 未返回内容]';
    },

    /** 免费 AI 调用：无 key 且处于剧本体验态时，走服务器密钥的免费接口（/api/game/free-chat）。
     *  返回 AI 回复内容；非体验态或失败返回 null（失败原因已 toast）。 */
    async _callFreeAI(prompts, userInput) {
        if (!window.Experience || !Experience.isActive()) return null;
        try {
            const { messages } = await this._buildRequestMessages(userInput);
            // noAuthLogout：这个 401 是「免费通道不认这张票」，不是「你登录过期了」。
            // 不声明的话 api.js 会顺手把玩家登出，并把报错原因统一改写成「请先登录」，
            // 于是报错书里记下的全是这四个字，真正的原因（上游 401/密钥死了）被吃掉。
            const res = await API.post('/game/free-chat', { messages }, { noAuthLogout: true });
            return (res && res.content) ? res.content : null;
        } catch (e) {
            AiClient.reportError({ message: (e && e.message) || '免费接口调用失败', kind: '免费接口', npc_id: this._currentNpc ? this._currentNpc.id : '' });
            const m = String((e && e.message) || '');
            // 免费通道用的是站长的 Key，坏了对玩家来说是「整站不能玩」，得说清楚该找谁，别让人以为是自己电脑坏了
            const shown = /401|403|Authentication Fails|invalid/i.test(m)
                ? '免费体验暂不可用：站点的 AI Key 已被平台拒绝，需要站长在「模型管理」里换一把新的。'
                : (m || '免费体验失败');
            Utils.showToast(shown, 'error');
            // 体验态免费通道失败必须保留真实原因，不能返回 null 后被上层
            // 误写成「请先在设置中配置 AI API Key」（玩家没有这个服务器开关）。
            throw e;
        }
    },

    /** 记录一轮真实 API 收发（请求原文 + 响应原文，一字不改），并通知管理面板刷新 */
    _logApiTurn(ep, kind, messages, response, isError) {
        this._apiLog.push({
            time: new Date(),
            provider: ep.provider, model: ep.model, url: ep.url,
            kind: kind || '初始生成',
            request_messages: messages,
            response: response || '',
            error: !!isError,
        });
        if (this._apiLog.length > this._API_LOG_MAX) {
            this._apiLog.splice(0, this._apiLog.length - this._API_LOG_MAX);
        }
        window.dispatchEvent(new CustomEvent('npc-api-log'));
    },

    /** 构建发往 AI 的消息数组 + 端点配置（供 _callAI 与示例页"上下文预览"复用）。
     *  userInput 为空时不追加 user 消息（用于纯上下文预览）。 */
    async _buildRequestMessages(userInput) {
        const systemPrompt = (await this._buildPrompt() || '').trim();
        // 缓存最近一次系统提示词原文，供审核 NPC 转录（一字不差）
        this._lastSystemPrompt = systemPrompt;

        // 组装历史：真实对话 + 合并后的工具交换。
        // 连续的工具往返（[tool:] 请求 + [系统返回] 结果）合并为一条，避免多次查询把
        // 系统数据重复堆砌进上下文（token 暴涨、AI 思考变慢的根源之一）；
        // 剥离功能标记后若为空则不送入，否则 provider 会因空内容返回 400。
        const rawMsgs = this._messages
            .filter(m => m.role === 'user' || m.role === 'npc')
            .filter(m => m._id > this._contextBreakId)   // 上下文隔断：只发隔断点之后的消息（切换剧本时推进，UI 历史不受影响）
            .slice(-30);
        const history = [];
        for (const m of rawMsgs) {
            const content = (m.text || '').replace(/\[.*?\]/g, '').trim();
            if (!content) continue;
            if (m._toolExchange) {
                const last = history[history.length - 1];
                if (last && last._toolExchange) {
                    last.content = (last.content + '\n' + content).slice(-2000);   // 合并连续工具往返，防超长
                } else {
                    history.push({ role: m.role === 'user' ? 'user' : 'assistant', content, _toolExchange: true });
                }
            } else {
                history.push({ role: m.role === 'user' ? 'user' : 'assistant', content });
            }
        }
        const trimmed = history.slice(-10);

        // 端点与角色名映射统一由共享客户端 AiClient 提供（minimax 需 USER/BOT/SYSTEM）
        const ep = AiClient.endpoint();
        const rm = ep.rm;

        // 去重：用户消息经 addMessage 已进入 _messages（成为 history 末尾最后一条 user），
        // 若 userInput 正是这条消息（或仅在其后追加了系统提示后缀），则合并为一条，
        // 避免同一句话重复发给 AI 两次（此前会重复，导致 AI 困惑甚至不回复）。
        const msgs = trimmed.map(m => ({ role: rm[m.role], content: m.content }));
        if (userInput) {
            const last = msgs[msgs.length - 1];
            if (last && last.role === rm.user &&
                (last.content === userInput || userInput.startsWith(last.content + '\n'))) {
                last.content = userInput;   // 覆盖为完整 userInput（含系统提示后缀）
            } else {
                msgs.push({ role: rm.user, content: userInput });
            }
        }

        const messages = [
            ...(systemPrompt ? [{ role: rm.system, content: systemPrompt }] : []),
            ...msgs,
        ];
        // 测试信息：上下文体积统计（用于验证去重效果；工具交换条数应显著少于原始消息数）
        console.log('[NpcChat] 上下文统计:', {
            原始user_npc消息数: rawMsgs.length,
            合并后历史条数: trimmed.length,
            其中工具交换条数: trimmed.filter(m => m._toolExchange).length,
            系统提示词字符数: systemPrompt.length,
        });
        return { messages, ep, provider: ep.provider };
    },

    /** 组合系统提示词：**向服务端要**（契约 §4 / §9.2 `POST /api/host/context`）。
     *
     *  为什么改到服务端：汤底是海龟汤唯一的秘密，而原来提示词在浏览器里拼，
     *  汤底就必然出现在浏览器内存里——玩家按 F12 就能看见。现在浏览器只说
     *  「我在什么状态、用哪个 NPC、主持哪一场」，服务端把提示词拼好整段发回来，
     *  汤底全程不出服务器。
     *
     *  M30b 起这里多了三件事：
     *   ① 每轮校验 `prompt_hash`（契约 §4.2 的内容指纹）：本地算一遍 sha256(system_prompt)[:16]
     *      与 bundle 里的比，不一致就告警一次 —— **仍用服务端那份**（本地没有第二份可信任的）。
     *   ② 体验态不可达（连不上/超时/5xx/契约版本对不上/这一场没证）**必须显式失败**：
     *      抛 hostUnavailable 出去，让这一轮彻底不发，而不是拿一份没有汤底的提示词继续主持。
     *   ③ default / browsing 态不可达：用本地缓存的 NPC 提示词顶上，只在控制台留痕，不打扰玩家。
     *
     *  本轮开头已经取过一份（体验态预检）就复用，同一轮不打两次上下文；之后要走工具往返
     *  再取时照旧现取现拼，别让一轮里越聊越旧的提示词拖住条件判定。
     */
    async _buildPrompt() {
        const webState = (window.GameState && GameState.get) ? GameState.get() : 'default';
        const round = this._roundHost;
        if (round && !round.used && round.state === webState) {
            round.used = true;
            const sp = (round.bundle && round.bundle.system_prompt) || '';
            await this._verifyPromptHash(round.bundle, sp);
            return sp;
        }
        return this._loadHostPrompt(webState);
    },

    /** 真正取一份主持上下文并处置失败（预检与常规取值共用这一条路径）。返回提示词原文。 */
    async _loadHostPrompt(webState) {
        const npcId = this._currentNpc ? this._currentNpc.id : null;
        let h = (window.Experience && Experience.hostSession) ? Experience.hostSession() : null;

        // 体验态却没有可用主持证（开场时开房失败、或证已满 4 小时过期）：
        // 当场补一张再发。补不到才退化成无证请求 —— 此时服务端会拒（这场没有主持人），
        // 但**不能静默**：玩家会以为自己在玩，实际上结局永远不会触发。
        if (!h && webState === 'experience' && window.Experience && Experience.ensureHostSession) {
            try {
                await Experience.ensureHostSession();
                h = (Experience.hostSession && Experience.hostSession()) || null;
            } catch (e) { /* 已在下面对 null 做提示 */ }
            if (!h && !this._hostWarned) {
                this._hostWarned = true;
                console.warn('[NpcChat] 这一场没有主持证，条件判定不会生效');
                if (window.Utils && Utils.showToast) {
                    Utils.showToast('这一场没能建立主持通道：条件判定可能不生效', 'error');
                }
            }
        }
        if (h) this._hostWarned = false;

        const body = { state: webState, npc_id: npcId };   // contract 由 HostClient 统一补
        if (h && h.id) body.session_id = h.id;

        let bundle;
        try {
            bundle = await this._fetchHostContext(body, (h && h.token) || null);
        } catch (e) {
            // 「不可达」与「这一场没证」都要在这里分清：前者体验态必须显式失败，
            // 后者连重试都没意义（证都没有，重试还是 401）。
            if (this._hostUnavailable(e)) return this._promptFallback(e, webState);
            throw e;
        }

        const sp = (bundle && bundle.system_prompt) ? bundle.system_prompt : '';
        await this._verifyPromptHash(bundle, sp);
        this._lastBundle = bundle;
        this._roundHost = { bundle: bundle, state: webState, at: Date.now(), used: false };
        console.log(`[NpcChat] system prompt 来自服务端: ${npcId}, webState=${webState}, ${sp.length} 字符`);
        return sp;
    },

    /** 发请求本身。证「刚好在请求途中过期」（410）时补一张再试一次 ——
     *  不接这一手的话，玩家会看到「这一场已经结束了」然后整场哑掉，只能刷页面。 */
    async _fetchHostContext(body, token, allowRetry) {
        const opts = token ? { hostToken: token } : {};
        try {
            return await HostClient.context(body, opts);
        } catch (e) {
            // 「这一场没了」服务端有两种说法，都要接：
            //   410 host_token_expired（证到点了）；
            //   403 capability_denied + message「这一场已经结束，主持上下文不再下发」（这一场提前收了）。
            // 只认 410 的话，收场后残留的前端会一直拿着死证撞 403，玩家只能刷页面。
            const msg = (e && e.message) || '';
            const expired = !!e && (e.code === 'host_token_expired' || e.status === 410 || /已经结束/.test(msg));
            const canRetry = allowRetry !== false && window.Experience && Experience.ensureHostSession;
            if (!expired || !canRetry) throw e;
            // 先把手上的死证丢掉：只 expiresAt 判断不出一场提前收了的会话，
            // 不丢就会「补证」补回同一张，第二次仍然撞 403。
            if (Experience.dropHostSession) await Experience.dropHostSession('aborted');
            console.warn('[NpcChat] 这一场的主持证已失效（' + ((e && e.code) || 'ended') + '），补一张再试一次');
            const token2 = await Experience.ensureHostSession();   // 不给参数 = 补当前这一本
            if (!token2) throw e;
            const h2 = Experience.hostSession();
            const body2 = Object.assign({}, body);
            if (h2 && h2.id) body2.session_id = h2.id; else delete body2.session_id;
            return this._fetchHostContext(body2, token2, false);
        }
    },

    /** 这个错误是不是「主持通道不可用」（M30b 的降级/失败判据）。
     *  不可达 = 连不上 / 超时 / 5xx / 契约版本对不上（判定权在 HostClient）；
     *  另外「这一场没证」「证不是这一场」在体验态同样是没通道，补也补不回来。 */
    _hostUnavailable(e) {
        if (!e || !e.host) return false;
        if (window.HostClient && HostClient.isUnreachable(e)) return true;
        return e.code === 'no_actor' || e.code === 'capability_denied';
    },

    /** 取不到上下文时的处置（M30b 两情况表）。
     *  体验态：**抛 hostUnavailable**（显式失败），绝不返回一份「看起来正常但没有汤底」的提示词。
     *  default / browsing：本地兜底提示词，控制台留痕，不打扰玩家。 */
    _promptFallback(e, webState) {
        const reason = (e && e.message) || '未知原因';
        if (window.HostClient && HostClient.noteDegraded) {
            HostClient.noteDegraded('取上下文失败（' + ((e && e.code) || 'error') + '）');
        }
        // 本轮已经取到过一份（几秒前）：宁可沿用那份，也别把这一轮打死 —— 这是降级，不是失败
        if (this._roundHost && this._roundHost.bundle && this._roundHost.state === webState) {
            console.warn('[NpcChat] 中途取上下文失败，沿用本轮开头那份：' + reason);
            return (this._roundHost.bundle.system_prompt) || '';
        }
        if (webState === 'experience') {
            const err = new Error(reason);
            err.hostUnavailable = true;
            err.code = (e && e.code) || '';
            err.status = (e && e.status) || 0;
            throw err;
        }
        console.warn('[NpcChat] 主持通道不可达，改用本地兜底提示词：' + reason);
        return this._localFallbackPrompt(reason);
    },

    /** 本地兜底提示词：用 /npc/prompts 已经缓存的那份（不是凭空编的），并自报家门 ——
     *  这段不是服务端拼的那份，行为本来就会与主持通道在场时不同，别让 NPC 装懂汤底。 */
    _localFallbackPrompt(reason) {
        const npcId = this._currentNpc ? this._currentNpc.id : '';
        const cached = (npcId && this._promptCache) ? this._promptCache[npcId] : null;
        const parts = [];
        if (Array.isArray(cached)) {
            for (let i = 0; i < cached.length; i++) {
                const c = cached[i] && cached[i].content;
                if (c) parts.push(String(c));
            }
        }
        if (!parts.length) return '';   // 连兜底素材都没有：宁可不带 system 消息，也不编一段假提示词
        return '[本地兜底提示词] 主持通道暂时不可用（' + reason + '），以下内容来自本地缓存的 NPC 提示词，'
            + '不含本场剧本的汤底与条件表；不要假装知道汤底，也不要宣布任何结局。\n\n'
            + parts.join('\n\n');
    },

    /** 本地算一遍内容指纹（契约 §4.2：sha256(system_prompt UTF-8) 前 16 位十六进制）。
     *  只有安全上下文（https / localhost）才有 crypto.subtle；没有就返回 null = 不校验。 */
    async _sha256_16(text) {
        const subtle = window.crypto && window.crypto.subtle;
        if (!subtle || !window.TextEncoder) return null;
        try {
            const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text || ''));
            const bytes = new Uint8Array(buf);
            let hex = '';
            for (let i = 0; i < 8; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);   // 8 字节 = 16 个十六进制字符
            return hex;
        } catch (e) {
            return null;
        }
    },

    /** 每轮比对 prompt_hash：本地算一份与服务端给的对齐。
     *  不一致 → 告警 + 只弹一次提示，**仍然用服务端那份**（本地没有第二份可信任的实现）。 */
    async _verifyPromptHash(bundle, sp) {
        const hash = (bundle && bundle.prompt_hash) || '';
        if (!hash || this._hashCheckSkipped) return true;
        const mine = await this._sha256_16(sp);
        if (mine === null) {
            this._hashCheckSkipped = true;
            console.info('[NpcChat] 当前环境不支持 crypto.subtle，跳过 prompt_hash 校验');
            return true;
        }
        this._lastPromptHash = hash;
        if (mine === hash) return true;
        console.warn('[NpcChat] 提示词与服务端不一致，已以服务端为准', { 服务端hash: hash, 本地算得: mine, 长度: (sp || '').length });
        if (window.HostClient && HostClient.noteDegraded) HostClient.noteDegraded('提示词与服务端不一致');
        if (!this._hashWarned) {
            this._hashWarned = true;
            if (window.Utils && Utils.showToast) Utils.showToast('提示词与服务端不一致，已以服务端为准', 'info');
        }
        return false;
    },

    /** 体验态主持通道不可用时的收口：明确告诉玩家、必要时把原文还回输入框。
     *  静默失败是这里最坏的选择 —— 玩家会以为话说出去了，只是 NPC 没理他。 */
    _failHostRound(e, text, sentAlready) {
        const reason = (e && e.message) || '未知原因';
        console.warn('[NpcChat] 体验态主持通道不可用：' + reason + (sentAlready ? '（本轮已发出）' : '（本轮未发出）'));
        if (sentAlready) {
            this.addSystemMessage('主持通道暂时不可用（' + reason + '），这一轮没能答完');
        } else {
            this.addSystemMessage('主持通道暂时不可用（' + reason + '），这一轮没能发出去');
            this._restoreInput(text);
        }
    },

    /** 把玩家这句话还回输入框（别让人重打一遍），并恢复联动状态 */
    _restoreInput(text) {
        const input = document.getElementById('companionChatInput');
        if (!input || !text) return;
        input.value = text;
        try { input.focus(); } catch (e) { /* ignore */ }
        try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* ignore */ }
    },

    /** 重新发送/刷新系统提示词（状态机变更 / 激活NPC / 登录态变化时调用）。
     *  - 游客态：提示词模块不生效，走 NoAiModule（NPC 不可用）。
     *  - 登录态：重建提示词缓存，使下一轮对话立即采用最新上下文。 */
    async refreshPrompt() {
        // 游客态：提示词模块不生效（NPC 走 NoAiModule，由 AccountInit 统一控制），不做任何组装
        if (STATE.get('isGuest')) {
            console.log('[NpcChat] 游客态：提示词模块不生效，跳过刷新');
            return;
        }
        // 登录态：先激活审核 NPC（独立会话与提示词缓存）、加载系统文案，
        // 再清缓存并预热拉取网页 NPC 最新提示词，下一轮对话立即采用最新上下文
        if (window.SystemTexts) SystemTexts.ensure();
        if (window.NpcReview) await NpcReview.activate();
        if (this._currentNpc) delete this._promptCache[this._currentNpc.id];
        try { await this._getPrompts(); } catch (e) { /* 预热失败忽略 */ }
        this._loadPlayerInfo();   // 并行预取玩家信息（供下一轮 prompt 注入）
        console.log(`[NpcChat] 已刷新系统提示词，webState=${(window.GameState && GameState.get) ? GameState.get() : 'default'}`);
    },

    /** NPC 激活时主动问好：有 key 走正常 AI，无 key 尝试免费额度（按开场规则先问海龟汤经验），
     *  失败回退离线开场白。仅本次会话首次激活触发一次（_greeted 防重复）。 */
    async greetOnActivate() {
        if (this._greeted) return;
        this._greeted = true;

        // 无 key（游客或未配置）：直接离线开场白，不做 AI 问好。
        // 游客的「询问熟练度」发生在进入海龟汤体验期间（见 game_mode_turtle_soup 规则13）。
        if (!AiClient.currentKey()) {
            if (window.OfflineNpc) {
                const g = await OfflineNpc.greeting();
                this.addMessage('npc', g.reply, { _offline: true });
                if (this._speakSegment) this._speakSegment(g.reply);
            }
            return;
        }

        const prompts = await this._getPrompts();
        await this._loadPlayerInfo();   // 确保开场问好能拿到玩家信息（差异化打招呼）
        // 收集开场上下文（上次对话时间 + 未完成剧本），让 AI 自己决定说什么、是否沉默
        const ctx = await this._buildGreetingContext();
        const trigger = (window.SystemTexts)
            ? SystemTexts.t('greeting.activate', { last_time: ctx.lastTime, pending: ctx.pending })
            : '';
        if (!trigger) return;

        let reply = null;
        try { reply = await this._callAI(prompts, trigger, '开场问候'); }
        catch (e) { reply = null; }

        if (!reply || reply.startsWith('[info:')) return;

        reply = await this._resolveSystemChannel(prompts, reply);
        if (/\[sys:ignore\]/i.test(reply)) return;   // AI 判断无需打扰（如刚聊过）：静默不展示
        const rawReply = reply;
        if (window.ConditionTracker) reply = ConditionTracker.processReply(reply);
        reply = NpcMarkers.convertAnswers(reply);
        if (!this._stripForTTS(reply)) return;
        const msgId = this._addNpcReply(reply);
        if (window.NpcReview) NpcReview.gateAsync(rawReply, prompts, msgId);
    },

    /** 收集开场上下文：上次对话时间（本地历史）+ 未完成剧本（后端 play-sessions）。 */
    async _buildGreetingContext() {
        let lastTime = '';
        if (window.NpcHistory) {
            const t = NpcHistory.lastTime();
            if (t) lastTime = this._formatElapsed(t);
        }
        if (!lastTime) lastTime = '无（首次对话）';

        let pending = '无';
        if (!STATE.get('isGuest')) {
            try {
                const sessions = await API.get('/user/play-sessions');
                const titles = (sessions || []).map(s => (s.title || '').trim()).filter(Boolean);
                if (titles.length) pending = titles.join('、') + '（共' + titles.length + '个）';
            } catch (e) { /* 查询失败视为无未完成剧本 */ }
        }
        return { lastTime, pending };
    },

    /** 把 Date 距现在的时间格式化成人类可读（刚刚 / N分钟前 / N小时前 / N天前）。 */
    _formatElapsed(d) {
        const diff = Date.now() - d.getTime();
        const m = Math.floor(diff / 60000);
        if (m < 1) return '刚刚';
        if (m < 60) return m + '分钟前';
        const h = Math.floor(m / 60);
        if (h < 24) return h + '小时前';
        const days = Math.floor(h / 24);
        return days + '天前';
    },

    /** 加载并缓存当前登录玩家的统计信息（供玩家信息块注入 system prompt）。
     *  幂等：已加载/游客态直接返回缓存；失败返回 null（不注入玩家信息）。 */
    async _loadPlayerInfo() {
        if (this._playerInfoLoaded) return this._playerInfo;
        this._playerInfoLoaded = true;
        if (STATE.get('isGuest')) { this._playerInfo = null; return null; }
        try {
            const res = await API.get('/user/stats');
            const s = (res && res.stats) || {};
            this._playerInfo = {
                username: res.username || '',
                level: s.level || 1,
                scripts_completed: s.scripts_completed || 0,
                scripts_uploaded: s.scripts_uploaded || 0,
                achievement_points: s.achievement_points || 0,
                proficiency: s.proficiency || 'regular',
            };
            return this._playerInfo;
        } catch (e) {
            this._playerInfo = null;
            return null;
        }
    },

    /* ========== 消息管理 ========== */
    addMessage(role, text, opts = {}) {
        // 音效：用户发送 / NPC 回复 分别触发（Web Audio，不触发移动端媒体会话小窗口）
        if (role === 'user' && window.SfxPlayer) SfxPlayer.play('send');
        if (role === 'npc' && window.SfxPlayer) SfxPlayer.play('receive');
        const msg = { role, text, time: new Date(), _id: ++this._msgId, ...opts };
        this._messages.push(msg);
        // 持久化对话记录（仅 user / npc，分账号 + 分 NPC 本地存储）
        NpcHistory.append(msg);
        this._renderMessages();
    },

    /** 载入当前账号 + 当前 NPC 的历史对话（登录初始化 / 切换 NPC 时调用）。
     *  用本地历史重建对话，同时保留本次会话的系统提示（如"已就绪"），
     *  避免多次调用（如保存设置后重新初始化）造成消息重复叠加。
     */
    loadHistory() {
        const systemMsgs = this._messages.filter(m => m.role !== 'user' && m.role !== 'npc');
        const restored = NpcHistory.restoreRecent();
        this._messages = restored.concat(systemMsgs);
        // 恢复上下文隔断点：刷新后 _id 重新编号，按「隔断时刻」在恢复的历史里定位
        // （隔断点 = 该时刻之后第一条消息的前一条；找不到则保持 0 不隔断）
        const breakAt = (window.Store && Store.get('context_break_at', 0)) || 0;
        if (breakAt) {
            const firstAfter = restored.find(m => m.time && m.time.getTime && m.time.getTime() >= breakAt);
            this._contextBreakId = firstAfter ? (firstAfter._id - 1) : 0;
        }
        this._renderMessages();
    },

    /* ========== 分段显示 (SEGMENT) ==========
     *  galgame 式分段：AI 回复含 [SEGMENT] 时拆成多段（状态与切分逻辑在 NpcSegments）。
     *  界面先显示第一段，用户点击空白/按空格逐段「累积」展示（每段换行追加，
     *  最终所有段落都保留在同一气泡内）。完整原文写入历史，恢复时按行合并展示。
     */
    _addNpcReply(reply) {
        // 清除上一条回复遗留的持续动画（loop），并恢复默认立绘；本条回复重新触发表情
        const _fxNpcId = this._currentNpc?.id || 'jingyuniang';
        if (window.NpcAnim) NpcAnim.clear(_fxNpcId);
        if (window.NpcUI) NpcUI.setEmotionPortrait(_fxNpcId, 'default');
        // 按自然段切分（[SEGMENT] / 空行 / [do:] 段边界），每段单独用打字机显示在同一气泡内；
        // [do:] 延迟指令随段推进按位执行
        const { parts, commands } = NpcSegments.split(reply);
        NpcSegments.parts = parts;
        NpcSegments.index = 0;
        NpcSegments.commands = commands;
        if (parts.length > 1) {
            // 分段消息：整段动画由 _playFx 按段触发，故禁用气泡自动触发
            const msg = { role: 'npc', text: parts[0], time: new Date(), _id: ++this._msgId, _hasSegments: true, _noAutoFx: true, _fxDone: true, _typePrefix: [], _typeCurrent: parts[0] };
            this._messages.push(msg);
            if (window.SfxPlayer) SfxPlayer.play('receive');   // 分段首段不走 addMessage，单独触发接收音效
            // 历史存完整原文（含 [SEGMENT]），与界面逐段展示解耦
            NpcHistory.append({ role: 'npc', text: reply, time: msg.time });
            NpcSegments.runCommands(0);         // 首段展示前的延迟指令
            this._playFx(parts[0]);
            this._prepareSegmentVoice(parts[0]);   // 必须在 _renderMessages 起打字机之前
            this._renderMessages();
            this._speakSegment(parts[0]);   // 朗读首段（开启语音时）
            return msg._id;
        } else {
            // 普通消息：重置分段状态，走通用逻辑（气泡自动触发动画）
            NpcSegments.reset();
            this._prepareSegmentVoice(reply);   // 必须在 addMessage 起打字机之前
            this.addMessage('npc', reply);
            this._speakSegment(reply);      // 朗读整条（开启语音时）
            NpcSegments.runAllCommands();   // 单段：展示后执行全部延迟指令
            return this._messages[this._messages.length - 1]._id;
        }
    },

    /** 撤回一条已展示的 NPC 消息（审核驳回时调用）：从会话与历史中删除并重新渲染 */
    _revokeMsg(msgId) {
        if (!msgId) return;
        const idx = this._messages.findIndex(m => m._id === msgId);
        if (idx >= 0) this._messages.splice(idx, 1);
        // 同步删除历史中的最后一条 npc 消息（撤回的是刚展示的 NPC 回复，避免刷新后复现）
        if (window.NpcHistory && NpcHistory.removeLastNpc) NpcHistory.removeLastNpc();
        NpcSegments.reset();   // 撤回后清除分段状态，避免残留推进逻辑
        this._renderMessages();
    },

    _advanceSegmentDisplay() {
        const segs = NpcSegments.parts;
        if (NpcSegments.index >= segs.length - 1) return;
        clearTimeout(this._autoTimer);
        clearTimeout(this._typeTimer);                    // 立即终止上一段打字机
        clearTimeout(this._voiceGuard);                   // 上一段的朗读看门狗作废
        this._voiceGuard = null;
        if (window.TTS && TTS.stop) TTS.stop();           // 立即终止上一段语音，随即进入下一段
        if (window.BlipVoice) BlipVoice.cancel();         // 上一段的说话音也立刻掐掉
        NpcSegments.index++;
        const idx = NpcSegments.index;
        // 先定这一步靠什么出声：打字机的第一个字是同步揭示的，晚一步就漏掉第一声
        this._prepareSegmentVoice(segs[idx]);
        NpcSegments.runCommands(idx);                 // 本段展示前的延迟指令（上一段输出完后触发）
        if (idx >= segs.length - 1) NpcSegments.runAllCommands();   // 末段：收尾指令
        // 优先定位当前分段消息（带 _hasSegments 标记），而非盲目取最后一条：
        // 若分段展示期间插入了其他消息（系统提示/新回复），仍能正确累积更新，避免吞段。
        const lastMsg = this._messages.filter(m => m.role === 'npc' && m._hasSegments).pop()
            || this._messages[this._messages.length - 1];
        if (lastMsg && lastMsg.role === 'npc') {
            // 累积：已揭示的段落逐段拼接，全部保留在气泡内（段落间以空行分隔）
            lastMsg.text = segs.slice(0, idx + 1).join('\n\n');
            lastMsg._hasSegments = idx < segs.length - 1;
            // 前序段落作为静态前缀（已打完），仅对新揭示的这一段做打字机，避免整段重打；
            // 同步刷新 _bodyHtml 为本段「已揭示文本」（供打字机结尾还原，避免泄露后续未揭示段落）
            lastMsg._typing = false;
            lastMsg._typePrefix = segs.slice(0, idx);
            lastMsg._typeCurrent = segs[idx];
            lastMsg._bodyHtml = this._processMarkers(lastMsg.text, lastMsg, false).trim().replace(/\n/g, '<br>');

            // 关键修复：直接更新最后一条气泡，避免调用 _renderMessages() 整条重渲染
            // 导致「已揭示文本先闪现全量、再塌缩重打」的视觉闪烁（用户反馈的字跳变/代码闪现）。
            const el = document.querySelector(`#chatBubblesContainer [data-msg-id="${lastMsg._id}"]`);
            if (el) {
                if (this._typeEnabled) {
                    lastMsg._typing = true;
                    this._typewriter(el, lastMsg);       // 仅对新段打字，前缀静态保留
                } else {
                    el.innerHTML = lastMsg._bodyHtml;    // 关闭打字机：直接显示已揭示文本
                }
            }
        }
        this._playFx(segs[idx]);                    // 仅触发新揭示这一段的表情/动画
        this._speakSegment(segs[idx]);              // 朗读新段（开启语音时）
        this._scrollToBottom();
    },

    /* ========== 语音（说话方式） ========== */
    /** 读出配置里的说话方式。
     *  新配置只认 config.speechMode；老配置（只有 voiceEnabled / blipEnabled / sfxEnabled）
     *  在这里折算一次：开过合成朗读 → tts；否则有说话音 → blip；再否则静音。
     *  注意不能「有录音包就优先录音包」：sfxEnabled 的老默认值是 true，那样会把所有人
     *  默认推进一个多数 NPC 并没有录音包的模式里，结果就是一片安静。 */
    _speechModeOf(config) {
        const c = config || ((window.Utils && Utils.getConfig) ? Utils.getConfig() : {});
        const m = c.speechMode;
        if (m === 'off' || m === 'blip' || m === 'sfx' || m === 'tts') return m;
        if (c.voiceEnabled === true) return 'tts';
        if (c.blipEnabled !== false) return 'blip';
        if (c.sfxEnabled === true) return 'sfx';
        return 'off';
    },

    /** 当前朗读引擎：browser / server（只在说话方式为 tts 时有意义） */
    _engine() {
        const c = (window.Utils && Utils.getConfig) ? Utils.getConfig() : {};
        return c.ttsEngine === 'browser' ? 'browser' : 'server';
    },

    /** 这一段该不该发说话音。只由说话方式决定，不再看别的开关。 */
    _blipWanted() {
        if (this._segBlip) return true;
        if (this._segSfx) return false;
        return this._speechMode === 'blip' && !!(window.BlipVoice && BlipVoice.available());
    },

    /** 本段开始前定「这一段靠什么出声」。必须在 _typewriter 之前调用 ——
     *  打字机第一个字是同步揭示的，晚一步就会漏掉第一声。 */
    _prepareSegmentVoice(text) {
        this._segSfx = false;
        this._segBlip = false;
        if (this._speechMode === 'sfx') {
            // 录音包：短句用录好的一声（最像人）。当前 NPC 没包时什么都不做（设置里已置灰）。
            if (window.NpcSfx && NpcSfx.has && NpcSfx.has()
                && NpcSfx.isSimple(text) && NpcSfx.playFor(text)) {
                this._segSfx = true;
            }
            return;
        }
        if (this._speechMode === 'blip' && window.BlipVoice && BlipVoice.available()) {
            this._segBlip = true;
        }
    },

    /** 朗读某段文本；若开启「读完自动播放下一段」，则在朗读结束后自动推进 */
    _speakSegment(text) {
        // ① 录音包：短促的「嗯」「哼？」合成出来最假，录的最像角色。音效是**代替**朗读播的（不叠加）。
        if (this._segSfx) {
            // 音效很短，没必要等它播完。打字机开着时由 _onSegmentTyped 打完后推进
            // （这里再插定时器会推进两次、跳段）；只有打字机也关着时才用延时兜底。
            if (!this._typeEnabled && this._autoAdvanceNext && NpcSegments.hasPending()) {
                clearTimeout(this._autoTimer);
                this._autoTimer = setTimeout(() => this._advanceSegmentDisplay(), this._autoAdvanceDelay || 1200);
            }
            return;
        }
        const plain = this._stripForTTS(text);
        // ② 说话音：打字机开着时逐字响（见 _typewriter），这里不排程，推进交给 _onSegmentTyped；
        //    打字机关着时一口气念完。
        if (this._speechMode === 'blip' && window.BlipVoice && BlipVoice.available()) {
            if (!this._typeEnabled) {
                const ms = plain ? (BlipVoice.speak(plain) || 0) : 0;
                if (this._autoAdvanceNext && NpcSegments.hasPending()) {
                    clearTimeout(this._autoTimer);
                    this._autoTimer = setTimeout(() => this._advanceSegmentDisplay(), Math.max(320, ms + 140));
                }
            }
            return;
        }
        // ③ 静音 / 录音包没命中：推进交给打字机完成回调。
        if (this._speechMode !== 'tts') {
            if (!this._typeEnabled && this._autoAdvanceNext && NpcSegments.hasPending()) {
                clearTimeout(this._autoTimer);
                this._autoTimer = setTimeout(() => this._advanceSegmentDisplay(), this._autoAdvanceDelay || 1200);
            }
            return;
        }
        if (!plain) {
            // 本段无可朗读文本：退化为延时推进，避免流程卡死
            if (this._autoAdvanceNext && NpcSegments.hasPending()) {
                clearTimeout(this._autoTimer);
                this._autoTimer = setTimeout(() => this._advanceSegmentDisplay(), this._autoAdvanceDelay || 1200);
            }
            return;
        }
        // ④ 合成朗读：播完（回调）推进到下一段。
        //    **必须加看门狗**：以前推进单点依赖 TTS 的 onEnded，任意环节哑火（服务端 503、
        //    浏览器自动播放策略拦、系统没装中文音色、音频"无声但不触发 onend"）都会让分段回复
        //    永久停在这一段 —— 实测 20 秒后 NpcSegments.hasPending() 仍为 true，后几段再也不出现。
        const guardMs = Math.max(4000, Math.min(90000, plain.length * 320 + 5000));
        clearTimeout(this._voiceGuard);
        this._voiceGuard = setTimeout(() => {
            this._voiceGuard = null;
            console.warn('[NpcChat] 朗读 ' + guardMs + 'ms 未回调，强制推进下一段');
            try { if (window.TTS && TTS.stop) TTS.stop(); } catch (e) { /* 忽略 */ }
            if (this._autoAdvanceNext && NpcSegments.hasPending()) this._advanceSegmentDisplay();
        }, guardMs);
        const advance = () => {
            clearTimeout(this._voiceGuard);
            this._voiceGuard = null;
            if (this._autoAdvanceNext && NpcSegments.hasPending()) this._advanceSegmentDisplay();
        };
        try {
            Promise.resolve(TTS.speak(plain, this._voiceId(), advance)).catch((e) => {
                console.warn('[NpcChat] 朗读失败，改为按时长推进', e);
                advance();
            });
        } catch (e) {
            console.warn('[NpcChat] 朗读异常，改为按时长推进', e);
            advance();
        }
    },

    /** 本段打字机完成后回调：非合成朗读时由这里推进到下一段。
     *  （合成朗读时推进改由语音结束回调 / 看门狗触发，避免重复推进。） */
    _onSegmentTyped() {
        if (this._speechMode === 'tts' && !this._segBlip && !this._segSfx) return;
        if (this._autoAdvanceNext && NpcSegments.hasPending()) {
            clearTimeout(this._autoTimer);
            this._autoTimer = setTimeout(() => this._advanceSegmentDisplay(), this._autoAdvanceDelay || 800);
        }
    },

    /** 去除所有功能标记，得到纯朗读文本（委托 NpcDecoder 统一解码） */
    _stripForTTS(text) {
        return NpcDecoder.toPlainText(text);
    },

    /** 根据当前 NPC + 引擎选择默认音色（可在设置中覆盖）：
     *  browser 引擎用浏览器本地音色（voiceIdBrowser，留空则自动选中文）；
     *  server 引擎用后端在线音色（voiceId，微软 id，未来豆包/火山 id）。 */
    _voiceId() {
        const config = Utils.getConfig();
        const engine = config.ttsEngine || 'server';
        if (engine === 'browser') {
            return config.voiceIdBrowser || '';
        }
        if (config.voiceId) return config.voiceId;
        const id = this._currentNpc?.id;
        if (id === 'xiaomei') return 'zh-CN-XiaoxiaoNeural';
        if (id === 'xiaoshuai') return 'zh-CN-YunxiNeural';
        return CONFIG.TTS_VOICES?.[0]?.id || 'zh-CN-XiaoxiaoNeural';
    },

    /** 触发某一段文本内的表情 / 动作标记（供分段逐段触发动画 + 立绘） */
    _playFx(text) {
        const id = this._currentNpc?.id || 'jingyuniang';
        // 清除上一段遗留的持续动画（loop），再播放本段表情
        if (window.NpcAnim) NpcAnim.clear(id);
        const emotionTokens = text.match(/\[emotion:([^\]]+)\]/g) || [];
        if (emotionTokens.length) {
            // 本段有表情调用 → 播放该表情绑定的立绘 + 动画（方法由站长在编辑页设定）
            emotionTokens.forEach(tok => {
                const emotion = NpcMarkers.emotionId(tok.slice(9, -1));
                NpcAnim.triggerEmotion(id, emotion);
                if (window.NpcUI) NpcUI.setEmotionPortrait(id, emotion);
            });
        } else {
            // 本段无表情调用 → 恢复默认立绘并清除动画（每段表情状态独立、不残留）
            if (window.NpcAnim) NpcAnim.clear(id);
            if (window.NpcUI) NpcUI.setEmotionPortrait(id, 'default');
        }
        (text.match(/\[action:([^\]]+)\]/g) || []).forEach(tok => NpcAnim.play(id, tok.slice(8, -1), false));
    },

    /** 重置当前会话（退出登录 / 账号切换时调用）：清空对话、分段与历史游标 */
    resetSession() {
        this._messages = [];
        NpcSegments.reset();
        if (window.NpcHistory && NpcHistory.resetCursor) NpcHistory.resetCursor();
        if (window.NpcReview) NpcReview.reset();   // 审核 NPC 会话同步重置，避免跨账号污染
        this._renderMessages();
    },

    /* ========== 渲染 ==========
     *  opts.keepScrollFrom：向上加载历史时传入旧的 scrollHeight，
     *  渲染后保持视口相对位置（避免跳动）；否则自动滚动到底部。
     */
    _renderMessages(opts) {
        const container = document.getElementById('chatBubblesContainer');
        if (!container) return;
        const area = document.getElementById('teaChatArea');   // 真正的滚动容器
        // _toolExchange（NPC↔系统的工具交换）只进 AI 上下文，不在聊天界面渲染
        const msgs = this._messages.filter(m => !m._toolExchange).slice(-300);
        container.innerHTML = msgs.map(m => this._renderBubble(m)).join('');

        // 打字机效果：对最新一条 NPC 消息逐字显示（避免重渲染时重复打字）
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === 'npc' && !lastMsg._restored && !lastMsg._typed && !lastMsg._typing && this._typeEnabled) {
            const el = container.querySelector(`[data-msg-id="${lastMsg._id}"]`);
            if (el) { lastMsg._typing = true; this._typewriter(el, lastMsg); }
        }

        if (opts && opts.keepScrollFrom != null && area) {
            // 保持向上加载前的视口位置
            area.scrollTop = area.scrollHeight - opts.keepScrollFrom;
        } else if (area) {
            area.scrollTop = area.scrollHeight;
        }
    },

    /** 打字过程中滚动到底部（_typewriter 调用） */
    _scrollToBottom() {
        const area = document.getElementById('teaChatArea');
        if (area) area.scrollTop = area.scrollHeight;
    },

    /** 打字机：逐字显示对话内容，完成后还原含选项按钮的完整 HTML。
     *  分段消息：仅对新揭示的这一段（_typeCurrent）逐字打字，前序段落（_typePrefix）静态保留，
     *  段落间以单个 <br> 分隔（与最终 fullHtml 一致）；非分段消息按整条 msg.text 打字。 */
    _typewriter(el, msg) {
        const fullHtml = msg._bodyHtml || '';
        // 打字文本与最终 _bodyHtml 采用同一套「转义 + 去标记 + 折叠空行 + 去首尾空白」处理，
        // 否则打字过程中会因未折叠的 \n\n 多出空行、收尾瞬间塌缩，产生「跳变」闪烁。
        const segMode = Array.isArray(msg._typePrefix);
        const plain = segMode ? NpcDecoder.toTypingText(msg._typeCurrent) : NpcDecoder.toTypingText(msg.text);
        const render = s => s.replace(/\n/g, '<br>');   // s 已转义，仅做换行转换，避免二次转义
        let base = '';
        if (segMode && msg._typePrefix.length) {
            // 前序段落作为静态前缀；段间以单个 <br> 分隔，与最终 fullHtml（标记处理已折叠空行）保持一致。
            // 关键修复：过滤「纯标记段」（toTypingText 为空），否则会多出空行，打字时闪现、收尾塌缩（Bug 2）。
            const prefixParts = msg._typePrefix
                .map(s => NpcDecoder.toTypingText(s))
                .filter(s => s !== '');
            if (prefixParts.length) base = prefixParts.map(render).join('<br>') + '<br>';
        }
        msg._typing = true;   // 标记正在打字，防止重渲染时重复触发
        const isLastSeg = () => NpcSegments.index >= NpcSegments.parts.length - 1;
        if (!plain) {
            el.innerHTML = fullHtml;
            msg._typing = false;
            if (!segMode) msg._typed = true;
            else if (isLastSeg()) msg._typed = true;
            this._onSegmentTyped();
            return;
        }
        el.innerHTML = base;
        let i = 0;
        const speed = this._typeSpeed > 0 ? this._typeSpeed : 30;
        const step = () => {
            if (i >= plain.length) {
                el.innerHTML = fullHtml;   // 打字结束：显示完整内容（含选项按钮）
                this._scrollToBottom();
                msg._typing = false;
                if (!segMode) msg._typed = true;
                else if (isLastSeg()) msg._typed = true;
                this._onSegmentTyped();    // 本段打字完成 → 视情况自动推进下一段
                return;
            }
            // 防御：剥离开头可能残留的 <br>，确保打字过程与最终 fullHtml 换行完全一致（消除顶部空行）
            el.innerHTML = (base + render(plain.slice(0, ++i))).replace(/^(\s*<br\s*\/?>)+/i, '');
            // 说话音：一个字一个短音，跟着打字机走（打字机多快它就多快，永远念得完）
            if (this._blipWanted() && window.BlipVoice) BlipVoice.blipFor(plain[i - 1]);
            this._scrollToBottom();
            this._typeTimer = setTimeout(step, speed);
        };
        step();
    },

    _renderBubble(msg) {
        // 防御：text 可能为 undefined/null（异常历史数据），统一按空串处理，避免 startsWith 抛异常
        const text = msg.text || '';
        if (text.startsWith('[info:')) {
            const content = text.replace('[info:', '').replace(/\]$/, '');
            return `<div class="chat-info">${Utils.escapeHtml(content)}</div>`;
        }
        const cls = msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-npc';
        let hasSegments = msg._hasSegments;

        // 动画只在「最新一条、非历史恢复、且未触发过」时执行一次，
        // 避免重渲染 / 加载历史时对所有消息重复触发动画。
        const isLast = msg === this._messages[this._messages.length - 1];
        const allowFx = isLast && !msg._restored && !msg._fxDone && !msg._noAutoFx;

        // 历史记录中的超长消息折叠：实时对话不折叠，仅历史回看折叠，避免臃肿
        const HISTORY_FOLD_THRESHOLD = 500;
        const rawLen = (msg.text || '').length;
        const doFold = msg._restored && rawLen > HISTORY_FOLD_THRESHOLD;

        let body;
        if (doFold) {
            const preview = this._processMarkers((msg.text || '').slice(0, HISTORY_FOLD_THRESHOLD), msg, false);
            const full = this._processMarkers(msg.text || '', msg, false);
            const previewHtml = preview.replace(/\n/g, '<br>') + '…';
            const fullHtml = full.replace(/\n/g, '<br>');
            body = `<span class="fold-preview">${previewHtml}</span>` +
                   `<span class="fold-full" style="display:none">${fullHtml}</span>` +
                   `<span class="fold-toggle" data-action="expand">展开全文</span>`;
        } else {
            const processed = this._processMarkers(msg.text || '', msg, allowFx);
            body = processed.trim().replace(/\n/g, '<br>');
            // 离线标识纳入 _bodyHtml：打字机结束（el.innerHTML=fullHtml）还原时也能带上，
            // 否则标识会延迟到「下一条消息渲染」才出现
            msg._bodyHtml = body + (msg._offline ? this._offlineBadgeHtml() : '');
        }

        const segAttr = hasSegments ? ' data-seg-advance="true"' : '';
        const idAttr = msg._id ? ` data-msg-id="${msg._id}"` : '';
        const offlineBadge = msg._offline ? this._offlineBadgeHtml() : '';
        return `<div class="${cls}"${segAttr}${idAttr}>${body}${offlineBadge}</div>`;
    },

    /** 渲染期标记处理（委托 NpcMarkers） */
    _processMarkers(text, msg, allowFx) {
        return NpcMarkers.process(text, msg, allowFx, this._currentNpc?.id);
    },

    /** 离线引导消息状态标识 HTML（黄色圆点 + 自定义 tooltip，避免 emoji 字体兼容问题） */
    _offlineBadgeHtml() {
        return '<span class="offline-badge" data-tip="当前为无 API 的离线模式，所有回复都是模板回复"><i class="offline-dot"></i>离线模式</span>';
    },

    _renderLoading() {
        const container = document.getElementById('chatBubblesContainer');
        if (!container) return;
        const loadDiv = document.createElement('div');
        loadDiv.className = 'chat-bubble-npc loading-dots';
        loadDiv.textContent = '...';
        container.appendChild(loadDiv);
        const area = document.getElementById('teaChatArea');
        if (area) area.scrollTop = area.scrollHeight;
    },

    /* ========== 语音输入 ========== */
    toggleVoice() {
        STT.toggle((text) => {
            const input = document.getElementById('companionChatInput');
            if (input) { input.value = text; input.focus(); }
            Utils.showToast('已识别：' + text, 'success');
        });
    },

    /* ========== NPC 下拉 ========== */
    toggleNpcDropdown() {
        const dd = document.getElementById('npcDropdown');
        if (!dd) return;
        dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
        const list = document.getElementById('npcDropdownList');
        if (list) {
            list.innerHTML = CONFIG.NPC_LIST.map((n, i) =>
                `<div class="npc-dropdown-item" onclick="NpcChat.switchNpc(${i});document.getElementById('npcDropdown').style.display='none'">
                    ${n.displayName}</div>`).join('');
        }
    },

    /* ========== 设置弹窗 ========== */
    openSettings() {
        Utils.openModal('npcSettingsModal');
        const config = Utils.getConfig();

        // AI 标签（key / model 按 provider 分槽缓存，切换 provider 自动载入对应槽位）
        this._settingsProvider = config.aiProvider || 'deepseek';
        // 豆包/千问/MiniMax 暂时关闭（未调整好）：旧配置若指向已关闭模型，强制回 DeepSeek，避免 key 串槽
        if (AiClient.AVAILABLE_PROVIDERS && !AiClient.AVAILABLE_PROVIDERS.includes(this._settingsProvider)) {
            this._settingsProvider = 'deepseek';
            config.aiProvider = 'deepseek';
        }
        this._settingsDraft = {};
        document.getElementById('cfgAiProvider').value = this._settingsProvider;
        document.getElementById('cfgAiKey').value = (config.aiKeys && config.aiKeys[this._settingsProvider]) || config.aiKey || '';
        this._updateModelList();
        const modelEl = document.getElementById('cfgAiModel');
        if (modelEl) modelEl.value = (config.aiModels && config.aiModels[this._settingsProvider]) || config.aiModel || this._defaultModel(this._settingsProvider);
        // 审核 NPC 复核开关（默认开启）
        const reviewEl = document.getElementById('cfgReviewNpcEnabled');
        if (reviewEl) reviewEl.checked = config.reviewNpcEnabled !== false;

        // NPC 标签：动态渲染下拉选项（跟随 CONFIG.NPC_LIST，新增 NPC 无需改 HTML）
        const npcSel = document.getElementById('cfgDefaultNpc');
        if (npcSel) {
            npcSel.innerHTML = CONFIG.NPC_LIST.map(n =>
                `<option value="${n.id}">${n.displayName}</option>`).join('');
        }
        document.getElementById('cfgDefaultNpc').value = config.defaultNpc || 'jingyuniang';
        const speedEl = document.getElementById('cfgTypewriterSpeed');
        if (speedEl) { speedEl.value = config.typewriterSpeed || 30; document.getElementById('cfgTypewriterSpeedVal').textContent = (config.typewriterSpeed || 30) + 'ms'; }
        document.getElementById('cfgTextColor').value = config.textColor || '#e2e8f0';

        // 文字设置（字号/字体/加粗/行高/字间距）
        const fontSizeEl = document.getElementById('cfgFontSize');
        if (fontSizeEl) { fontSizeEl.value = config.fontSize || 16; document.getElementById('cfgFontSizeVal').textContent = (config.fontSize || 16) + 'px'; }
        const fontFamilyEl = document.getElementById('cfgFontFamily');
        if (fontFamilyEl) fontFamilyEl.value = config.fontFamily || 'system';
        const fontBoldEl = document.getElementById('cfgFontBold');
        if (fontBoldEl) fontBoldEl.checked = !!config.fontBold;
        const lhEl = document.getElementById('cfgLineHeight');
        if (lhEl) { lhEl.value = config.lineHeight || 1.6; document.getElementById('cfgLineHeightVal').textContent = String(config.lineHeight || 1.6); }
        const lsEl = document.getElementById('cfgLetterSpacing');
        if (lsEl) { lsEl.value = config.letterSpacing || 0; document.getElementById('cfgLetterSpacingVal').textContent = (config.letterSpacing || 0) + 'px'; }

        // 检测浏览器/系统是否缩放了网页文字，缩放则提示用户（文字设置可能被系统覆盖）
        if (window.TextSettings && TextSettings.detectBrowserScaling) {
            const r = TextSettings.detectBrowserScaling();
            const warn = document.getElementById('textScaleWarn');
            if (warn) {
                warn.style.display = r.scaled ? 'block' : 'none';
                if (r.scaled) document.getElementById('textScaleVal').textContent = r.scale;
            }
        }

        // 语音标签：说话方式单选 + 只显示选中那一种的配置
        document.getElementById('cfgVoiceVolume').value = config.voiceVolume || 80;
        document.getElementById('cfgVoiceVolumeVal').textContent = (config.voiceVolume || 80) + '%';
        const sfxVol = document.getElementById('cfgSfxVolume');
        if (sfxVol) {
            const v = Math.round((config.sfxVolume != null ? Number(config.sfxVolume) : 0.8) * 100);
            sfxVol.value = v;
            const lbl = document.getElementById('cfgSfxVolumeVal');
            if (lbl) lbl.textContent = v + '%';
            sfxVol.oninput = () => { if (lbl) lbl.textContent = sfxVol.value + '%'; };
        }
        const mode = this._speechModeOf(config);
        document.querySelectorAll('#npcSettingsModal input[name="cfgSpeechMode"]').forEach(r => {
            r.checked = (r.value === mode);
            r.onchange = () => this._syncSpeechOpts();
        });
        const recheck = document.getElementById('cfgTtsRecheck');
        if (recheck) recheck.onclick = () => {
            if (window.TTS && TTS.resetServerHealth) TTS.resetServerHealth();
            this._syncSpeechOpts(true);
        };
        const autoAdv = document.getElementById('cfgAutoAdvance');
        if (autoAdv) autoAdv.checked = !!config.autoAdvanceNext;
        const engineSel = document.getElementById('cfgTtsEngine');
        if (engineSel) {
            engineSel.value = config.ttsEngine || 'server';
            engineSel.onchange = () => { this._renderVoiceList(); };   // 换引擎 → 刷新音色列表
        }
        this._renderVoiceList();
        this._renderBlipOptions(config);
        this._syncSpeechOpts();
        const sttSel = document.getElementById('cfgSttProvider');
        if (sttSel) {
            sttSel.innerHTML = '<option value="vosk">Vosk 离线识别（服务器）</option>';
            sttSel.value = config.sttProvider || 'vosk';
            // 动态读取系统支持的语音识别引擎列表（支持多少显示多少）
            this._loadSttProviders().then(list => {
                sttSel.innerHTML = list.map(p => `<option value="${Utils.escapeHtml(p.id)}">${Utils.escapeHtml(p.name)}</option>`).join('');
                sttSel.value = config.sttProvider || 'vosk';
            });
        }

        // BGM 背景音乐
        const bgmOn = document.getElementById('cfgBgmEnabled');
        if (bgmOn) bgmOn.checked = config.bgmEnabled === true;   // 默认关闭
        // 音量默认值优先取 BgmPlayer 已初始化的实际音量（来自服务器 default_volume），其次 50
        const bgmVol = config.bgmVolume != null
            ? config.bgmVolume
            : ((window.BgmPlayer && BgmPlayer._volume != null) ? BgmPlayer._volume : 50);
        document.getElementById('cfgBgmVolume').value = bgmVol;
        document.getElementById('cfgBgmVolumeVal').textContent = bgmVol + '%';
        this._renderBgmSelects(config);

        // 默认 AI 标签
        this._switchSettingsTab('ai');

        // 滑块绑定
        document.getElementById('cfgTypewriterSpeed')?.addEventListener('input', (e) => { document.getElementById('cfgTypewriterSpeedVal').textContent = e.target.value + 'ms'; });
        document.getElementById('cfgVoiceVolume')?.addEventListener('input', (e) => { document.getElementById('cfgVoiceVolumeVal').textContent = e.target.value + '%'; });
        document.getElementById('cfgBgmVolume')?.addEventListener('input', (e) => { document.getElementById('cfgBgmVolumeVal').textContent = e.target.value + '%'; });
        document.getElementById('cfgFontSize')?.addEventListener('input', (e) => { document.getElementById('cfgFontSizeVal').textContent = e.target.value + 'px'; });
        document.getElementById('cfgLineHeight')?.addEventListener('input', (e) => { document.getElementById('cfgLineHeightVal').textContent = e.target.value; });
        document.getElementById('cfgLetterSpacing')?.addEventListener('input', (e) => { document.getElementById('cfgLetterSpacingVal').textContent = e.target.value + 'px'; });
    },

    /** 说话音专属参数：只在引擎=blip 时显示；音色下拉在 blip 下没有意义，置灰 */
    /** 说话方式 → 只显示选中那一种的配置块；当前 NPC 没录音包时把「录音包」置灰。
     *  force=true 时重新问一次服务端语音健康状态（重新检测按钮用）。 */
    _syncSpeechOpts(force) {
        const sel = document.querySelector('#npcSettingsModal input[name="cfgSpeechMode"]:checked');
        const mode = sel ? sel.value : 'blip';
        const map = { off: 'speechOptOff', blip: 'speechOptBlip', sfx: 'speechOptSfx', tts: 'speechOptTts' };
        Object.keys(map).forEach(k => {
            const el = document.getElementById(map[k]);
            if (el) el.style.display = k === mode ? 'block' : 'none';
        });
        const hasPack = !!(window.NpcSfx && NpcSfx.has && NpcSfx.has());
        const item = document.getElementById('speechModeSfxItem');
        const radio = item && item.querySelector('input');
        if (radio) radio.disabled = !hasPack;
        if (item) item.classList.toggle('is-disabled', !hasPack);
        const hint = document.getElementById('cfgSfxHint');
        if (hint) hint.textContent = hasPack ? '使用该 NPC 的录音包音效' : '当前 NPC 没有录音包，不可选';
        // 选了录音包却没有包（换 NPC 之后）：回落到说话音，并说一句，别让用户以为坏了
        if (mode === 'sfx' && !hasPack && CONFIG && CONFIG.DEFAULT_CONFIG) {
            const fallback = 'blip';
            document.querySelectorAll('#npcSettingsModal input[name="cfgSpeechMode"]').forEach(r => {
                r.checked = (r.value === fallback);
            });
            this._speechMode = fallback;
            this._syncSpeechOpts();
            if (window.Utils && Utils.showToast) Utils.showToast('这个 NPC 没有录音包，已改用说话音', 'info');
            return;
        }
        if (mode === 'tts' && window.TTS && TTS.probeServer) {
            const el = document.getElementById('cfgTtsHealth');
            if (el) el.textContent = '检测中…';
            TTS.probeServer(force).then(ok => {
                if (el) el.textContent = ok ? '✅ 可用' : '⚠️ 不可用（会改用系统合成）';
            });
        }
    },

    _renderBlipOptions(config) {
        const c = config || (window.Utils ? Utils.getConfig() : {});
        // 说话音那几行的显隐现在由 _syncSpeechOpts() 按「说话方式」统一管，这里只填值。
        const pitch = document.getElementById('cfgBlipPitch');
        if (pitch) {
            const v = Number(c.blipPitch != null ? c.blipPitch : 1.0);
            pitch.value = v;
            const lbl = document.getElementById('cfgBlipPitchVal');
            if (lbl) lbl.textContent = v.toFixed(2);
            pitch.oninput = () => {
                if (lbl) lbl.textContent = Number(pitch.value).toFixed(2);
                // 音高是实时可感的：滑一下就能听见变化，不用先保存
                if (window.BlipVoice) { BlipVoice._bufKey = ''; BlipVoice.blip(); }
            };
        }
        const speed = document.getElementById('cfgBlipSpeed');
        if (speed) {
            const v = Number(c.blipSpeed != null ? c.blipSpeed : 1.15);
            speed.value = v;
            const lbl = document.getElementById('cfgBlipSpeedVal');
            if (lbl) lbl.textContent = v.toFixed(2) + '×';
            speed.oninput = () => { if (lbl) lbl.textContent = Number(speed.value).toFixed(2) + '×'; };
        }
        const wave = document.getElementById('cfgBlipWave');
        if (wave) {
            wave.value = c.blipWave || 'triangle';
            wave.onchange = () => { if (window.BlipVoice) { BlipVoice._bufKey = ''; BlipVoice.blip(); } };
        }
        const testBtn = document.getElementById('cfgBlipTest');
        if (testBtn) {
            testBtn.onclick = () => {
                if (!window.BlipVoice) return;
                // 试听用当前滑块值（还没点保存也能听）
                BlipVoice.preview('今天也辛苦啦，要不要再坐一会儿？');
            };
        }
        // 朗读音色下拉由 _renderVoiceList() 管（它只看朗读引擎），这里不再插手。
    },

    /** 填充 BGM 下拉（主界面 / 海龟汤），选项来自 BgmPlayer 的文件列表 */
    _renderBgmSelects(config) {
        const files = (window.BgmPlayer && BgmPlayer._files && BgmPlayer._files.length)
            ? BgmPlayer._files
            : BgmPlayer.FALLBACK_FILES;
        const scenes = (config.bgmScenes) || {};
        const opts = files.map(f => `<option value="${Utils.escapeHtml(f.id)}">${Utils.escapeHtml(f.name)}</option>`).join('');
        const main = scenes.main || ((window.BgmPlayer && BgmPlayer._sceneBgmId) ? BgmPlayer._sceneBgmId('main') : 'default');
        const turtle = scenes.turtle_soup || ((window.BgmPlayer && BgmPlayer._sceneBgmId) ? BgmPlayer._sceneBgmId('turtle_soup') : 'turtle_soup');
        const mainSel = document.getElementById('cfgBgmMain');
        const turtleSel = document.getElementById('cfgBgmTurtleSoup');
        if (mainSel) { mainSel.innerHTML = opts; mainSel.value = main; }
        if (turtleSel) { turtleSel.innerHTML = opts; turtleSel.value = turtle; }
        const listEl = document.getElementById('cfgBgmTrackList');
        if (listEl) {
            listEl.innerHTML = files.length
                ? '已有曲目：' + files.map(f => Utils.escapeHtml(f.name)).join('、')
                : '还没有曲目';
        }
    },

    /** BGM 上传：传到前端 audio/bgm 并登记进站点设置，成功后立刻刷新下拉。 */
    async _uploadBgm() {
        const inp = document.getElementById('cfgBgmFile');
        const f = inp && inp.files && inp.files[0];
        if (!f) { Utils.showToast('先选一个音频文件', 'error'); return; }
        if (f.size > 15 * 1024 * 1024) { Utils.showToast('音频不能超过 15MB', 'error'); return; }
        const btn = document.getElementById('cfgBgmUploadBtn');
        if (btn) { btn.disabled = true; btn.textContent = '上传中…'; }
        try {
            const fd = new FormData();
            fd.append('file', f);
            const title = (f.name || '').replace(/\.[^.]+$/, '');
            const res = await API.upload('/admin/bgm/upload?name=' + encodeURIComponent(title), fd);
            if (window.BgmPlayer && res && Array.isArray(res.files)) {
                BgmPlayer._files = res.files;
                if (BgmPlayer._cfg) BgmPlayer._cfg.files = res.files;
                if (BgmPlayer._renderUI) BgmPlayer._renderUI();
            }
            this._renderBgmSelects(Utils.getConfig());
            if (inp) inp.value = '';
            Utils.showToast('已上传，选好场景曲目后点保存', 'success');
        } catch (e) {
            Utils.showToast('上传失败：' + ((e && e.message) || '未知错误'), 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '上传'; }
        }
    },

    closeSettings() {
        Utils.closeModal('npcSettingsModal');
    },

    /** 设置弹窗「获取 API」按钮：打开当前所选 provider 的 API 获取教程
     *  （教程弹窗按设备端自动匹配手机/电脑图文，含视频教程跳转）。 */
    openApiTutorial() {
        const p = document.getElementById('cfgAiProvider')?.value || this._settingsProvider || '';
        if (window.Tutorial) Tutorial.open(p || undefined);
    },

    _switchSettingsTab(tab) {
        ['ai', 'npc', 'voice', 'text', 'bgm'].forEach(t => {
            const panel = document.getElementById('settingsTab' + t.charAt(0).toUpperCase() + t.slice(1));
            if (panel) panel.style.display = t === tab ? 'block' : 'none';
        });
        // 用 data-tab 对号，不再靠按钮文案包含哪个字（"🎵 背景音乐" 里就有"音"字，靠文案会串）
        document.querySelectorAll('#npcSettingsModal .admin-tab[data-tab]').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
        });
        if (tab === 'voice') this._syncSpeechOpts(true);
    },

    /** 切换 provider：暂存当前未保存的输入（切回不丢），载入目标 provider 的 key/model 槽位 */
    _onProviderChange() {
        const provEl = document.getElementById('cfgAiProvider');
        const keyEl = document.getElementById('cfgAiKey');
        const modelEl = document.getElementById('cfgAiModel');
        if (!provEl) return;
        if (this._settingsProvider && keyEl) {
            this._settingsDraft = this._settingsDraft || {};
            this._settingsDraft[this._settingsProvider] = { key: keyEl.value, model: modelEl ? modelEl.value : '' };
        }
        const p = provEl.value;
        const config = Utils.getConfig();
        const draft = (this._settingsDraft || {})[p];
        if (keyEl) keyEl.value = draft ? draft.key : ((config.aiKeys && config.aiKeys[p]) || '');
        if (modelEl) modelEl.value = draft ? draft.model : ((config.aiModels && config.aiModels[p]) || this._defaultModel(p));
        this._updateModelList();
        this._settingsProvider = p;
    },

    /** 该 provider 的默认模型名（CONFIG.AI_MODELS 第一项） */
    _defaultModel(provider) {
        const models = CONFIG.AI_MODELS[provider];
        return (models && models.length) ? models[0].id : '';
    },

    /** 填充模型 datalist 建议项（模型名自由输入，火山引擎可填接入点 ID ep-xxxx） */
    _updateModelList() {
        const provEl = document.getElementById('cfgAiProvider');
        const listEl = document.getElementById('cfgAiModelList');
        if (!provEl || !listEl) return;
        const models = CONFIG.AI_MODELS[provEl.value] || [];
        listEl.innerHTML = models.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    },

    /** 动态读取系统支持的语音识别引擎列表（后端 /api/stt/providers） */
    async _loadSttProviders() {
        try {
            const data = await API.get('/stt/providers');
            return (data && data.providers) || [];
        } catch (e) {
            return [{ id: 'vosk', name: 'Vosk 离线识别（服务器）' }];
        }
    },

    /** 按当前 TTS 引擎渲染「朗读音色」下拉：
     *  browser → 浏览器本地中文音色（真实可用、离线）；server → 后端在线音色（动态下发） */
    async _renderVoiceList() {
        const engine = document.getElementById('cfgTtsEngine')?.value || 'server';
        const voiceSel = document.getElementById('cfgVoiceId');
        if (!voiceSel) return;
        const config = Utils.getConfig();
        voiceSel.disabled = false;
        if (engine === 'server') {
            const list = (window.TTS && TTS.getVoices) ? await TTS.getVoices() : (CONFIG.TTS_VOICES || []);
            this._fillVoiceOptions(voiceSel, list, config.voiceId || this._voiceId());
        } else {
            const list = (window.TTS && TTS.listBrowserVoices) ? await TTS.listBrowserVoices() : [];
            this._fillVoiceOptions(voiceSel, list, config.voiceIdBrowser || '');
        }
    },

    /** 填充音色下拉；多 provider 时按 provider 分组（optgroup） */
    _fillVoiceOptions(sel, list, currentValue) {
        const items = list || [];
        const groups = {};
        items.forEach(v => { const p = v.provider || ''; (groups[p] = groups[p] || []).push(v); });
        const keys = Object.keys(groups);
        if (keys.length > 1) {
            sel.innerHTML = keys.map(p =>
                `<optgroup label="${Utils.escapeHtml(p || '其它')}">` +
                groups[p].map(v => `<option value="${Utils.escapeHtml(v.id)}">${Utils.escapeHtml(v.name)}</option>`).join('') +
                `</optgroup>`).join('');
        } else {
            sel.innerHTML = items.map(v => `<option value="${Utils.escapeHtml(v.id)}">${Utils.escapeHtml(v.name)}</option>`).join('');
        }
        sel.value = items.some(v => v.id === currentValue) ? currentValue : (items[0]?.id || '');
    },

    saveSettings() {
        const config = Utils.getConfig();
        // 审核 NPC 复核：默认开启；用户主动关闭时提示风险（输出不稳定，建议保持开启）
        const reviewEnabled = !!document.getElementById('cfgReviewNpcEnabled')?.checked;
        if (!reviewEnabled && config.reviewNpcEnabled !== false) {
            if (!confirm('关闭审核 NPC 复核后，NPC 回复将不再经过内容复核，输出可能不稳定、存在风险，建议保持开启。\n\n确定要关闭吗？')) {
                return;   // 取消保存，保持原设置
            }
        }
        config.reviewNpcEnabled = reviewEnabled;
        const provider = document.getElementById('cfgAiProvider')?.value || 'deepseek';
        config.aiProvider = provider;
        // key / model 写入当前 provider 的独立槽位，不同 provider 之间互不串用
        config.aiKeys = config.aiKeys || {};
        config.aiKeys[provider] = (document.getElementById('cfgAiKey')?.value || '').trim();
        config.aiModels = config.aiModels || {};
        config.aiModels[provider] = (document.getElementById('cfgAiModel')?.value || '').trim();
        config.aiModel = config.aiModels[provider];   // 兼容旧读取点
        config.aiKey = '';                            // 旧版全局字段停用，以 aiKeys 为准
        config.defaultNpc = document.getElementById('cfgDefaultNpc')?.value || 'jingyuniang';
        config.typewriterSpeed = parseInt(document.getElementById('cfgTypewriterSpeed')?.value || 30);
        config.textColor = document.getElementById('cfgTextColor')?.value || '#e2e8f0';
        config.fontSize = parseInt(document.getElementById('cfgFontSize')?.value || 16);
        config.fontFamily = document.getElementById('cfgFontFamily')?.value || 'system';
        config.fontBold = !!document.getElementById('cfgFontBold')?.checked;
        config.lineHeight = parseFloat(document.getElementById('cfgLineHeight')?.value || 1.6);
        config.letterSpacing = parseFloat(document.getElementById('cfgLetterSpacing')?.value || 0);
        config.voiceVolume = parseInt(document.getElementById('cfgVoiceVolume')?.value || 80);
        // 说话方式只存一个字段；旧的三个开关同步写一份，给还没更新的旧页面兜底
        const modeEl = document.querySelector('#npcSettingsModal input[name="cfgSpeechMode"]:checked');
        config.speechMode = modeEl ? modeEl.value : 'blip';
        config.voiceEnabled = config.speechMode === 'tts';
        config.blipEnabled = config.speechMode === 'blip';
        config.sfxEnabled = config.speechMode === 'sfx';
        config.sfxVolume = parseInt(document.getElementById('cfgSfxVolume')?.value || 80) / 100;
        config.autoAdvanceNext = !!document.getElementById('cfgAutoAdvance')?.checked;
        config.ttsEngine = document.getElementById('cfgTtsEngine')?.value === 'browser' ? 'browser' : 'server';
        // 音色按引擎分槽保存：browser 存浏览器本地 voiceURI，server 存后端在线音色 id，互不串用
        const voiceValue = document.getElementById('cfgVoiceId')?.value || '';
        if (config.ttsEngine === 'browser') {
            config.voiceIdBrowser = voiceValue;
        } else {
            config.voiceId = voiceValue;
        }
        config.sttProvider = document.getElementById('cfgSttProvider')?.value || 'vosk';
        // 说话音参数
        const blipPitch = parseFloat(document.getElementById('cfgBlipPitch')?.value);
        if (!isNaN(blipPitch)) config.blipPitch = blipPitch;
        const blipSpeed = parseFloat(document.getElementById('cfgBlipSpeed')?.value);
        if (!isNaN(blipSpeed)) config.blipSpeed = blipSpeed;
        config.blipWave = document.getElementById('cfgBlipWave')?.value || 'triangle';
        // 音高/波形变了要让 BlipVoice 重烤音色（它自己看 key，这里只是催一下）
        if (window.BlipVoice && BlipVoice._buildBuffers) BlipVoice._buildBuffers();

        // BGM 背景音乐
        config.bgmEnabled = !!document.getElementById('cfgBgmEnabled')?.checked;   // 默认关闭
        config.bgmVolume = parseInt(document.getElementById('cfgBgmVolume')?.value || 50);
        config.bgmScenes = config.bgmScenes || {};
        config.bgmScenes.main = document.getElementById('cfgBgmMain')?.value || 'default';
        config.bgmScenes.turtle_soup = document.getElementById('cfgBgmTurtleSoup')?.value || 'turtle_soup';

        // 即时应用语音 / 自动播放 / 打字机 状态
        this._speechMode = this._speechModeOf(config);
        this._autoAdvanceNext = config.autoAdvanceNext;
        this._typeEnabled = config.typewriterEnabled !== false;
        this._typeSpeed = config.typewriterSpeed || 30;

        // 纯分账号存储：写入当前账号独立配置（ts_<uid>_config）与内存态，
        // 不再写全局 turtlesoup_config，避免账号间互相污染 / key 泄露。
        if (window.Store) Store.set('config', config);
        STATE.set('config', config);

        // 切换语音引擎后清除本页降级缓存，让服务端 edge-tts 立即重试，
        // 不再沿用之前的 health=false / _serverDown 而静默走浏览器。
        if (window.TTS) {
            TTS._healthOk = undefined;
            TTS._serverDown = false;
            TTS._serverFails = 0;
            if (TTS.stop) TTS.stop();
        }
        // 默认 NPC 保存后立即切换，无需刷新；下拉与当前立绘共用同一份 config.defaultNpc。
        const npcIdx = CONFIG.NPC_LIST.findIndex(n => n.id === config.defaultNpc);
        if (npcIdx >= 0 && npcIdx !== this.getCurrentNpcIndex()) this.switchNpc(npcIdx);

        // 即时应用文字设置（字号/字体/加粗/行高/字间距/颜色）
        if (window.TextSettings) TextSettings.apply();

        // 即时应用 BGM 设置（音量 / 场景映射 / 开关）
        if (window.BgmPlayer) {
            BgmPlayer._userScenes = config.bgmScenes;
            BgmPlayer.setVolume(config.bgmVolume);
            BgmPlayer.setEnabled(config.bgmEnabled);
            BgmPlayer.playScene(BgmPlayer._currentScene);   // 按新配置重新播放当前场景
        }

        Utils.showToast('设置已保存');
        this.closeSettings();

        NoAiModule.check();
    },
};

window.NpcChat = NpcChat;
window.Companion = NpcChat;
