/** AI剧本网 - 状态栏「血量条 UI」
 * 可自定义名称、最小/最大生命值；可增减/清零/补满生命值、增减上限。
 * 状态经 StatusBar.setData 持久化（本地 Store + 云端 API 双份，每用户一份）。
 * 所有能力 NPC 均可通过 [sys:hp_xxx] / [do:hp_xxx] 命令调用（首次调用自动显示血量条）。 */
const StatusUiHp = {
    id: 'hp',
    // 名称/说明以 UiMeta 为真源，字面量只作兜底（见 status_ui_mode.js 的说明）。
    // 注意 npcCmds **不走元数据**：命令清单必须与本文件真实实现一致，抄一份只会多一处会过期的地方。
    get name() {
        const m = (window.UiMeta && UiMeta.meta) ? UiMeta.meta('hp') : null;
        return (m && m.name) || '血量条';
    },
    get desc() {
        const m = (window.UiMeta && UiMeta.meta) ? UiMeta.meta('hp') : null;
        return (m && m.desc) || '玩家血量条。默认不显示，NPC 通过 hp_* 命令调用时自动显示并操作。';
    },
    npcCmds: [
        'hp_reset —— 初始化/重置血量至默认值（生命值 100/100，上限 100）',
        'hp_set:value=数字 —— 设置当前生命值',
        'hp_add:amount=数字(可负) —— 增减生命值',
        'hp_max:value=数字 —— 设置生命值上限',
        'hp_clear —— 生命值清零',
        'hp_fill —— 生命值补满',
        'hp_name:value=名字 —— 设置血量条名称',
    ],

    _def() {
        return { name: '生命值', min: 0, max: 100, value: 100 };
    },

    /** 当前状态：优先读持久化存档，缺字段用默认值补齐 */
    _state() {
        const s = (window.StatusBar ? StatusBar.getData('hp') : null) || {};
        return Object.assign(this._def(), s);
    },

    _save(s) {
        if (window.StatusBar) StatusBar.setData('hp', s);
    },

    render(el) {
        const s = this._state();
        const span = s.max > s.min ? (s.max - s.min) : 1;
        const pct = Math.max(0, Math.min(100, Math.round((s.value - s.min) / span * 100)));
        el.innerHTML = `
            <div class="status-card status-hp">
                <div class="status-hp-head">
                    <span class="status-hp-name">❤️ ${Utils.escapeHtml(s.name)}</span>
                    <span class="status-hp-num">${s.value} / ${s.max}</span>
                </div>
                <div class="status-hp-bar">
                    <div class="status-hp-fill" style="width:${pct}%"></div>
                </div>
            </div>`;
    },

    update(el) { this.render(el); },

    /* ========== 状态操作（前端代码可直接调用；NPC 命令同入口） ========== */

    setValue(v) {
        const s = this._state();
        s.value = this._clamp(parseInt(v) || 0, s);
        this._save(s); this._emit(); return { ok: true };
    },
    addValue(amount) {
        const s = this._state();
        s.value = this._clamp(s.value + (parseInt(amount) || 0), s);
        this._save(s); this._emit(); return { ok: true };
    },
    clear() {
        const s = this._state(); s.value = s.min;
        this._save(s); this._emit(); return { ok: true };
    },
    fill() {
        const s = this._state(); s.value = s.max;
        this._save(s); this._emit(); return { ok: true };
    },
    setMax(v) {
        const s = this._state();
        s.max = Math.max(s.min + 1, parseInt(v) || s.max);
        if (s.value > s.max) s.value = s.max;
        this._save(s); this._emit(); return { ok: true };
    },
    setName(name) {
        const s = this._state();
        s.name = (name || '生命值').trim();
        this._save(s); this._emit(); return { ok: true };
    },
    /** 初始化血量：重置为默认状态并保存（每用户一份存档，初始化即重置该存档）。 */
    reset() {
        this._save(this._def());
        this._emit(); return { ok: true };
    },

    _clamp(v, s) { return Math.max(s.min, Math.min(s.max, v)); },

    _emit() {
        if (window.Events) Events.emit('status-hp-updated', this._state());
        if (window.StatusBar) StatusBar.update('hp');
    },
};

if (window.StatusBar) StatusBar.registerUi('hp', StatusUiHp);

/* ===== NPC 命令：操作血量条 =====
 * 静默执行：成功返回 null（不回灌、不触发额外 AI 往返），失败抛错由 handle 回灌纠正。
 * 首次调用自动显示血量条（StatusBar.show）。 */
if (window.NpcBus) {
    const ensureShown = () => { if (window.StatusBar) StatusBar.show('hp'); };
    NpcBus.register('hp_set', async (p) => { ensureShown(); StatusUiHp.setValue(p.value); return null; });
    NpcBus.register('hp_add', async (p) => { ensureShown(); StatusUiHp.addValue(p.amount); return null; });
    NpcBus.register('hp_max', async (p) => { ensureShown(); StatusUiHp.setMax(p.value); return null; });
    NpcBus.register('hp_clear', async () => { ensureShown(); StatusUiHp.clear(); return null; });
    NpcBus.register('hp_fill', async () => { ensureShown(); StatusUiHp.fill(); return null; });
    NpcBus.register('hp_name', async (p) => { ensureShown(); StatusUiHp.setName(p.value || p.name); return null; });
    NpcBus.register('hp_reset', async () => { ensureShown(); StatusUiHp.reset(); return null; });
}

window.StatusUiHp = StatusUiHp;
