/** AI剧本网 - 线索/道具面板（GameInventory）
 * ------------------------------------------------------------------
 *  职责：剧本体验期间的「线索 / 道具」状态管理（原胜利/失败条件面板的替代面板）。
 *
 *  数据来源：
 *   1. 任务条件效果：任务全部条件达成 → ConditionTracker 自动执行 effect
 *      （reveal_clue 揭示线索 / give_item 给予道具）；
 *   2. 主持人 NPC 主动修改：NPC 发送系统指令增减线索/道具——
 *      [sys:add_clue:content=线索内容]    [sys:remove_clue:index=序号]
 *      [sys:add_item:content=道具内容]    [sys:remove_item:index=序号]
 *      （也可用分段延迟指令 [do:add_clue:...]，见 chat.js 分段命令解析）
 *   3. 查看：当前线索/道具清单由 PromptBuilder 每轮注入 NPC 的 system prompt
 *      （「剧本体验」块），NPC 无需工具即可实时看到面板状态。
 *
 *  设计要点：
 *   - 修改类指令「静默执行」：成功后 handle() 返回 null（不回灌、不触发额外 AI 往返），
 *     NPC 下一轮经 system prompt 注入即可看到更新后的清单；执行失败才回灌错误让 NPC 纠正。
 *   - 审核：NPC 的修改行为随对话转录进入审核 NPC 视野，审核 NPC 负责核对修改
 *     是否符合剧本内容与剧情进度（见 review.txt / REVIEW_PROTOCOL）。
 *   - 持久化：Store（分账号）键 inv_<scriptId>，刷新不丢；已结算剧本重进清零开新周目
 *     （与 ConditionTracker 的 cond_<scriptId>.settled 标志联动）。
 *
 *  生命周期：Experience 进入体验时 activate()，退出体验时 deactivate()。
 */
const GameInventory = {
    _active: false,
    _scriptId: null,
    _clues: [],   // [{text, source}] 线索列表
    _items: [],   // [{text, source}] 道具列表

    /** 进入体验：恢复持久化的线索/道具（已结算的记录清零重开） */
    activate(scriptId) {
        this._scriptId = scriptId;
        this._clues = [];
        this._items = [];
        // 已结算剧本重进 → 新周目，不恢复旧面板
        const condSaved = scriptId ? Store.get('cond_' + scriptId, null) : null;
        const settled = !!(condSaved && condSaved.settled);
        const saved = (!settled && scriptId) ? Store.get('inv_' + scriptId, null) : null;
        if (saved) {
            if (Array.isArray(saved.clues)) this._clues = saved.clues.filter(c => c && c.text);
            if (Array.isArray(saved.items)) this._items = saved.items.filter(i => i && i.text);
        }
        this._active = true;
        this._emitUpdate();
        console.log('[GameInventory] 激活', { scriptId, clues: this._clues.length, items: this._items.length, newRun: settled });
    },

    /** 退出体验 */
    deactivate() {
        this._active = false;
        this._scriptId = null;
        this._clues = [];
        this._items = [];
    },

    isActive() { return this._active; },

    /** 当前面板状态（供 HUD 渲染 / PromptBuilder 注入 NPC 上下文） */
    getState() {
        return {
            clues: this._clues.map(c => ({ text: c.text, source: c.source || '' })),
            items: this._items.map(i => ({ text: i.text, source: i.source || '' })),
        };
    },

    /* ========== 修改操作（任务效果 / NPC 指令共用入口） ========== */

    /** 添加线索；source 记录来源（任务名 / NPC），重复内容不重复添加 */
    addClue(text, source = '') {
        text = (text || '').trim();
        if (!text) return { ok: false, error: '线索内容不能为空' };
        if (this._clues.some(c => c.text === text)) return { ok: true, duplicated: true };
        this._clues.push({ text, source });
        this._persist();
        this._emitUpdate();
        return { ok: true };
    },

    addItem(text, source = '') {
        text = (text || '').trim();
        if (!text) return { ok: false, error: '道具内容不能为空' };
        if (this._items.some(i => i.text === text)) return { ok: true, duplicated: true };
        this._items.push({ text, source });
        this._persist();
        this._emitUpdate();
        return { ok: true };
    },

    /** 移除线索：index 为 1 起始的序号（与 NPC 在 system prompt 中看到的编号一致） */
    removeClue(index) {
        const i = parseInt(index) - 1;
        if (isNaN(i) || i < 0 || i >= this._clues.length) {
            return { ok: false, error: `线索序号 ${index} 不存在（当前共 ${this._clues.length} 条线索）` };
        }
        const removed = this._clues.splice(i, 1)[0];
        this._persist();
        this._emitUpdate();
        return { ok: true, removed };
    },

    removeItem(index) {
        const i = parseInt(index) - 1;
        if (isNaN(i) || i < 0 || i >= this._items.length) {
            return { ok: false, error: `道具序号 ${index} 不存在（当前共 ${this._items.length} 件道具）` };
        }
        const removed = this._items.splice(i, 1)[0];
        this._persist();
        this._emitUpdate();
        return { ok: true, removed };
    },

    /* ========== 内部 ========== */

    _persist() {
        if (!this._scriptId) return;
        Store.set('inv_' + this._scriptId, { clues: this._clues, items: this._items });
        // 同步到云端（debounce 合并，登录用户生效）
        if (window.GameDataSync) GameDataSync.scheduleUpload();
    },

    _emitUpdate() {
        if (window.Events) Events.emit('inventory-updated', { scriptId: this._scriptId });
    },
};

window.GameInventory = GameInventory;

/* ===== NPC 系统指令：修改线索/道具面板 =====
 * 静默执行：成功返回 null（NpcBus.handle 视为无需回灌，不触发额外 AI 往返），
 * 下一轮 system prompt 注入更新后的清单，NPC 自然感知；失败抛错由 handle 回灌纠正。
 * 仅在剧本体验激活时可用。 */
if (window.NpcBus) {
    const needActive = () => {
        if (!GameInventory.isActive()) throw new Error('当前不在剧本体验中，线索/道具面板不可用');
    };
    NpcBus.register('add_clue', async (params) => {
        needActive();
        const r = GameInventory.addClue(params.content || params.text || '', 'NPC');
        if (!r.ok) throw new Error(r.error);
        NpcChat.addMessage('system', `[info:🔎 新线索已记录]`);
        return null;   // 静默成功
    });
    NpcBus.register('remove_clue', async (params) => {
        needActive();
        const r = GameInventory.removeClue(params.index || params.i);
        if (!r.ok) throw new Error(r.error);
        return null;
    });
    NpcBus.register('add_item', async (params) => {
        needActive();
        const r = GameInventory.addItem(params.content || params.text || '', 'NPC');
        if (!r.ok) throw new Error(r.error);
        NpcChat.addMessage('system', `[info:🎁 新道具已获得]`);
        return null;
    });
    NpcBus.register('remove_item', async (params) => {
        needActive();
        const r = GameInventory.removeItem(params.index || params.i);
        if (!r.ok) throw new Error(r.error);
        return null;
    });
}
