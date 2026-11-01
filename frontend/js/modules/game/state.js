/** AI剧本网 - 网页状态机（GameState）
 * ------------------------------------------------------------------
 *  网页唯一状态来源。状态即提示词：任何状态变更自动触发系统提示词重组
 *  （NpcChat.refreshPrompt），并打印测试信息到控制台，便于调试。
 *
 *  三种状态（每种状态对应一套提示词配方，见 PromptBuilder._STATE_RECIPE）：
 *   - default    默认：未打开侧边栏、未在剧本体验中。NPC 为网页陪伴机器人。
 *   - browsing   剧本浏览：侧边栏打开，玩家正在浏览剧本库。
 *   - experience 剧本体验：玩家正在体验某剧本，NPC 作为主持人。
 *
 *  状态转移规则：
 *   - default  ↔ browsing：侧边栏打开 / 关闭（app.js）
 *   - default / browsing → experience：开始剧本体验（Experience）
 *   - experience → 进入体验前的状态：退出体验 / 结算面板弹出（returnFromExperience）
 *   - 体验态不被侧边栏开关打断（打开侧边栏时若处于体验态，状态保持 experience）
 *
 *  扩展：onEnter / onExit 可注册状态钩子（如 HUD 收起、面板刷新）。
 */
const GameState = {
    DEFAULT: 'default',
    EXPERIENCE: 'experience',
    BROWSING: 'browsing',

    _state: 'default',
    _meta: {},               // 附带信息（experience 时含 scriptId/title/mode）
    _returnState: 'default', // 进入体验前的状态（体验结束/结算后恢复）
    _enterHooks: {},         // state -> [fn(state, prev)]
    _exitHooks: {},          // state -> [fn(prev, next)]

    get() { return this._state; },
    is(s) { return this._state === s; },
    meta() { return this._meta; },

    /** 注册状态进入 / 离开钩子 */
    onEnter(state, fn) { (this._enterHooks[state] = this._enterHooks[state] || []).push(fn); },
    onExit(state, fn) { (this._exitHooks[state] = this._exitHooks[state] || []).push(fn); },

    /** 切换状态。
     * @param {string} state   目标状态（非法值忽略并告警）
     * @param {Object} meta    附带信息（调试用）
     * @param {string} trigger 触发来源（测试信息中打印，如 sidebar_open / experience_start / settlement）
     */
    set(state, meta = {}, trigger = 'unspecified') {
        if (![this.DEFAULT, this.EXPERIENCE, this.BROWSING].includes(state)) {
            console.warn('[GameState] 非法状态，已忽略:', state);
            return;
        }
        const prev = this._state;
        if (state === prev) {
            // 同状态重复设置：仅更新 meta，不触发钩子与提示词重组
            this._meta = meta || this._meta;
            return;
        }
        // 进入体验时记录来源状态（退出/结算后恢复）
        if (state === this.EXPERIENCE) this._returnState = prev;

        (this._exitHooks[prev] || []).forEach(fn => {
            try { fn(prev, state); } catch (e) { console.error('[GameState] exit 钩子异常', e); }
        });

        this._state = state;
        this._meta = meta || {};
        console.log(`[GameState] ${prev} → ${state}（trigger: ${trigger}）`, this._meta);

        (this._enterHooks[state] || []).forEach(fn => {
            try { fn(state, prev); } catch (e) { console.error('[GameState] enter 钩子异常', e); }
        });

        if (window.Events) Events.emit('gamestate-changed', { prev, state, meta: this._meta, trigger });

        // 状态即提示词：状态变更后重组系统提示词（异步，不阻塞调用方）。
        // 注意：进入体验时调用方须先准备好主持数据（Experience._hostData）再切状态。
        if (window.NpcChat && NpcChat.refreshPrompt) NpcChat.refreshPrompt();
    },

    /** 结束体验（玩家退出 / 结算面板弹出）时调用：恢复到进入体验前的状态 */
    returnFromExperience(trigger) {
        const target = (this._returnState && this._returnState !== this.EXPERIENCE)
            ? this._returnState : this.DEFAULT;
        this.set(target, {}, trigger || 'experience_end');
    },
};

window.GameState = GameState;
