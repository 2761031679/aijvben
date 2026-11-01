/**
 * NPC ↔ 系统 双向通信总线 (NpcBus)
 * ------------------------------------------------------------------
 * 目标（需求）：
 *   1. NPC 调用站内能力（如搜索剧本）时，系统即时把结果回传给 NPC，NPC 据此回复用户。
 *   2. 系统可主动向 NPC 推送额外信息 / 通知 / 信号，且不打断用户与 NPC 的对话流畅度。
 *   3. NPC 回复给系统的语句（[tool:] / [sys:]）不会解析展示给用户。
 *
 * 设计：
 *   - NPC → 系统：NPC 在回复中输出 [tool:name:params] 或 [sys:name:params]，
 *     由 handle() 解析并执行对应处理器，返回结果文本回灌给 NPC（多轮，见 chat._resolveSystemChannel）。
 *   - 系统 → NPC：调用 NpcBus.push(text) 把系统信息入队；
 *       · 随用户下一轮对话自然带入（drain()），不打断当前节奏；
 *       · 或 push(text, {immediate:true}) 立即触发 NPC 主动发言（NpcChat.systemTurn）。
 *
 * 所有交互都在「当前 AI 对话 API 的上下文」内完成，不新增第三方服务。
 */
const NpcBus = {
    MAX_ROUNDS: 3,          // 单轮用户消息内，NPC↔系统 最多往返次数（防死循环）
    _queue: [],             // 待推送给 NPC 的系统消息 [{text, ts}]
    _sysHandlers: {},       // [sys:name] 指令处理器 { name: async (params) => resultText }
    _signals: {},           // 通用信号注册表：自定义信号（如 clickNpc）

    /* ========== 通用信号 ========== */
    /** 订阅某个信号，返回订阅 id */
    onSignal(name, fn) {
        (this._signals[name] = this._signals[name] || []).push(fn);
        return (this._uid = (this._uid || 0) + 1);
    },
    /** 触发某个信号 */
    emitSignal(name, payload) {
        (this._signals[name] || []).forEach((fn) => {
            try { fn(payload); } catch (e) { console.error('[NpcBus] signal', name, e); }
        });
    },
    /** 鼠标点击 NPC 立绘信号（具体行为由订阅者决定，目前未绑定业务） */
    clickNpc() {
        const npc = (window.NpcChat && NpcChat.getCurrentNpc) ? NpcChat.getCurrentNpc() : null;
        this.emitSignal('clickNpc', { npcId: npc ? npc.id : null });
        if (window.Events) Events.emit('npc-click', { npcId: npc ? npc.id : null });
    },

    /* ========== 系统 → NPC ========== */

    /**
     * 系统向 NPC 推送信息。
     * @param {string} text 要转达给 NPC 的系统信息
     * @param {object} opts { immediate:boolean 是否立即触发 NPC 主动发言 }
     */
    push(text, opts = {}) {
        if (!text) return;
        this._queue.push({ text, ts: Date.now() });
        if (opts.immediate && window.NpcChat) {
            return NpcChat.systemTurn();
        }
    },

    /** 取出并清空队列，拼成上下文文本（供下一轮对话带入） */
    drain() {
        if (!this._queue.length) return '';
        return this._queue.splice(0).map(m => m.text).join('\n');
    },

    hasPending() {
        return this._queue.length > 0;
    },

    /* ========== NPC → 系统 ========== */

    /** 注册一个 [sys:name] 系统指令处理器 */
    register(name, fn) {
        this._sysHandlers[name] = fn;
    },

    /**
     * 解析并执行 NPC 回复中的系统指令（[tool:] 优先，其次 [sys:]）。
     * @returns {Promise<string|null>} 结果文本；无系统指令时返回 null。
     */
    async handle(reply) {
        if (!reply) return null;

        // 1) 复用既有工具通道 [tool:name:params]
        const tool = NpcTools.parse(reply);
        if (tool) {
            return NpcTools.run(tool);
        }

        // 2) 通用系统指令 [sys:name:params]
        const m = reply.match(/\[sys:([a-zA-Z_]+)(?::([^\]]*))?\]/);
        if (m) {
            const name = m[1];
            if (name === 'ignore') return null;          // 忽略指令由上层处理
            const fn = this._sysHandlers[name];
            if (!fn) return `未知系统指令: ${name}`;
            try {
                const r = await fn(this._parseParams(m[2] || ''));
                // 处理器返回 null/undefined = 静默执行成功（如线索/道具面板修改）：
                // 不回灌、不触发额外 AI 往返，NPC 下一轮经 system prompt 注入感知结果
                return r == null ? null : r;
            } catch (e) {
                return `系统指令执行失败: ${e.message}`;
            }
        }

        return null;
    },

    /** 静默执行一条指令（供分段延迟指令 [do:...] 使用）。
     *  先查系统指令表（add_clue 等），再按工具名执行（结果丢弃，不回灌）。
     *  @param {string} body 指令体，形如 "add_clue:content=xxx" 或 "search_scripts:keyword=x"
     *  @returns {Promise<{ok:boolean, error?:string}>} 执行失败时由调用方告知 NPC 纠正 */
    async executeSilent(body) {
        const m = (body || '').match(/^([a-zA-Z_]+)(?::([\s\S]*))?$/);
        if (!m) return { ok: false, error: `无法解析的指令: ${body}` };
        const name = m[1];
        const params = this._parseParams(m[2] || '');
        try {
            if (this._sysHandlers[name]) {
                await this._sysHandlers[name](params);
                return { ok: true };
            }
            // 工具名（支持别名）：查询结果丢弃——[do:] 是执行通道，查询请用 [tool:]
            const toolName = (window.NpcTools && NpcTools.ALIASES[name.toLowerCase()]) || name;
            const r = await NpcTools.run({ name: toolName, params });
            if (typeof r === 'string' && (r.startsWith('未知工具') || r.startsWith('工具调用失败'))) {
                return { ok: false, error: r };
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    },

    _parseParams(str) {
        const params = {};
        str.split('&').forEach(p => {
            const idx = p.indexOf('=');
            if (idx < 0) return;
            const k = p.slice(0, idx).trim();
            if (k) params[k] = decodeURIComponent(p.slice(idx + 1));
        });
        return params;
    },
};

// 订阅站内通知：有新通知时把摘要推送给 NPC（不打断当前对话，随下轮带入）
// 推送文案见 npc_configs/shared/prompts/system_texts.txt（notification.push）
if (window.Events) {
    Events.on('notification-new', (n) => {
        if (!n) return;
        const summary = n.title || n.content || n.message || '你有一条新的站内通知';
        NpcBus.push(window.SystemTexts ? SystemTexts.t('notification.push', { summary }) : `站内通知：${summary}`);
    });
}

window.NpcBus = NpcBus;
