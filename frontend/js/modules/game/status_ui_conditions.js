/** AI剧本网 - 状态栏「失败/成功条件 UI」
 * 实时读取当前海龟汤剧本的胜利/失败条件（ConditionTracker.getRevealed，已过滤隐藏未满足条件），
 * 展示条件名 + 次数/阈值；隐藏条件达成后自动浮现（getRevealed 已处理），达成项金色高亮。 */
const StatusUiConditions = {
    id: 'conditions',
    // 名称/说明以 UiMeta 为真源，字面量只作兜底（见 status_ui_mode.js 的说明）。
    get name() {
        const m = (window.UiMeta && UiMeta.meta) ? UiMeta.meta('conditions') : null;
        return (m && m.name) || '失败/成功条件';
    },
    get desc() {
        const m = (window.UiMeta && UiMeta.meta) ? UiMeta.meta('conditions') : null;
        return (m && m.desc) || '实时显示当前海龟汤剧本的胜利/失败条件进度（条件名 + 次数/阈值）。隐藏条件达成后自动浮现。此卡只读，NPC 通过 [cond:] 标记推进条件，不直接修改。';
    },
    npcCmds: [],
    autoEvents: ['conditions-updated'],

    render(el) {
        const tracker = window.ConditionTracker;
        const endings = (tracker && tracker.getRevealed) ? tracker.getRevealed() : [];
        if (!endings || !endings.length) {
            el.innerHTML = '';
            return;
        }
        el.innerHTML = `
            <div class="status-card status-cond">
                <div class="status-cond-head">🎯 目标</div>
                ${endings.map(e => this._endingHtml(e)).join('')}
            </div>`;
    },

    _endingHtml(e) {
        const isWin = e.type === 'win';
        const icon = isWin ? '🏆' : '💀';
        const rows = (e.conditions || []).map(c => `
            <div class="status-cond-row ${c.met ? 'met' : ''}">
                <span class="status-cond-name">${Utils.escapeHtml(c.name)}</span>
                <span class="status-cond-progress">${c.count}/${c.threshold}</span>
            </div>`).join('');
        return `
            <div class="status-cond-group ${isWin ? 'win' : 'lose'}">
                <div class="status-cond-group-title">${icon} ${Utils.escapeHtml(e.name || (isWin ? '胜利' : '失败'))}</div>
                ${rows}
            </div>`;
    },

    update(el) { this.render(el); },
};

if (window.StatusBar) StatusBar.registerUi('conditions', StatusUiConditions);
window.StatusUiConditions = StatusUiConditions;
