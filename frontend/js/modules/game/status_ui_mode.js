/** AI剧本网 - 状态栏「模式状态 UI」
 * 开启体验时显示「正在游玩 XXX（海龟汤/DND/COC/剧本扮演）」，点击弹出退出确认。
 * 退出顺序：先更新状态栏（隐藏本 UI），再调用 Experience.end 退出模块。 */
const StatusUiMode = {
    id: 'mode',
    // 卡片名与说明的真源在 UiMeta（/api/host/ui-meta —— 就是 NPC 看到的那一份），
    // 这里只留兜底：UiMeta.meta() 拿不到服务端数据时会回落它自带的常量，再往下才是这两句字面量。
    // 用 getter 而不是字段：元数据是异步到的，字段会在脚本加载那一刻就被定死成兜底文案。
    get name() {
        const m = (window.UiMeta && UiMeta.meta) ? UiMeta.meta('mode') : null;
        return (m && m.name) || '模式状态';
    },
    get desc() {
        const m = (window.UiMeta && UiMeta.meta) ? UiMeta.meta('mode') : null;
        return (m && m.desc) || '显示当前正在游玩的剧本类型。玩家点击此卡可退出当前剧本体验（由玩家操作，非 NPC 命令）。';
    },
    npcCmds: [],

    render(el) {
        const script = (window.Experience && Experience.currentScript) ? Experience.currentScript() : null;
        const cat = (script && script.category) || '';
        const catName = (window.CONFIG && CONFIG.CATEGORY_NAMES[cat]) || cat || '剧本';
        el.innerHTML = `
            <div class="status-card status-mode" onclick="StatusUiMode._onClick()" title="点击退出当前剧本">
                <span class="status-mode-icon">🎭</span>
                <span class="status-mode-text">正在游玩 ${Utils.escapeHtml(catName)}</span>
                <span class="status-mode-exit">退出 ›</span>
            </div>`;
    },

    async _onClick() {
        const script = (window.Experience && Experience.currentScript) ? Experience.currentScript() : null;
        const title = (script && script.title) || '当前剧本';
        const ok = await UIModule.confirm(`确定要退出剧本《${title}》吗？`, { title: '退出剧本', okText: '退出体验' });
        if (!ok) return;
        // ① 先更新状态栏（隐藏模式状态 UI）② 再调用退出模块
        if (window.StatusBar) StatusBar.hide('mode');
        if (window.Experience && Experience.end) Experience.end('player_exit');
    },
};

if (window.StatusBar) StatusBar.registerUi('mode', StatusUiMode);
window.StatusUiMode = StatusUiMode;
