/** AI剧本网 - NPC 问题反馈模块（ReportIssue）
 * ------------------------------------------------------------------
 *  NPC 反馈问题的统一入口：经「玩家同意」后落库，供站长在管理面板查看。
 *
 *  触发源：
 *   1. 审核 NPC 驳回网页 NPC 回复时自动触发（review_npc.js，source=review）；
 *   2. NPC 主动调用 [sys:report_issue:reason=xxx]（source=npc_report）。
 *
 *  同意机制（本地 Store 分账号记录）：
 *   - 用户同意一次 → 记为 granted，之后所有反馈静默落库（不再询问）；
 *   - 用户不同意 → 记跳过 10 次，10 次内静默跳过，满 10 次后再次询问。
 */
const ReportIssue = {
    CONSENT_KEY: 'issue_report_consent',   // 'granted' = 已同意
    SKIP_KEY: 'issue_report_skip',         // 剩余静默跳过次数
    SKIP_WINDOW: 10,
    _asking: false,                         // 弹窗互斥（避免多条反馈同时弹窗）

    /** 触发反馈：按同意状态决定落库 / 跳过 / 询问 */
    async trigger(reason, context, source) {
        const consent = Store.get(this.CONSENT_KEY, '');
        if (consent === 'granted') {
            this._submit(reason, context, source);
            return;
        }
        const skip = parseInt(Store.get(this.SKIP_KEY, 0)) || 0;
        if (skip > 0) {
            Store.set(this.SKIP_KEY, skip - 1);   // 静默跳过并递减
            return;
        }
        this._askConsent(reason, context, source);
    },

    /** 弹窗征求玩家同意：同意 → 记 granted 并落库；不同意 → 记跳过 10 次 */
    async _askConsent(reason, context, source) {
        if (this._asking) return;
        this._asking = true;
        try {
            const ok = await UIModule.confirm(
                'AI 主持人遇到了一点问题，需要收集一些信息来帮助我们修复。是否同意上报这段对话与问题详情？（仅用于修复 bug，站长可见）',
                { title: '问题反馈', okText: '同意上报', cancelText: '暂不' }
            );
            if (ok) {
                Store.set(this.CONSENT_KEY, 'granted');
                this._submit(reason, context, source);
            } else {
                Store.set(this.SKIP_KEY, this.SKIP_WINDOW);
            }
        } catch (e) {
            /* 弹窗异常静默 */
        } finally {
            this._asking = false;
        }
    },

    /** 落库（fire-and-forget，失败静默） */
    _submit(reason, context, source) {
        const npc = (window.NpcChat && NpcChat.getCurrentNpc) ? NpcChat.getCurrentNpc() : null;
        try {
            API.post('/npc/issue-report', {
                npc_id: npc ? npc.id : '',
                reason: reason || '',
                transcript: context || '',
                source: source || 'npc_report',
            }).catch(() => {});
        } catch (e) { /* 静默 */ }
    },

    /** 收集最近对话上下文（NPC 主动上报用） */
    collectContext() {
        const msgs = (window.NpcChat && NpcChat._messages) || [];
        return msgs.slice(-8).map(m => `${m.role === 'user' ? '【用户】' : '【NPC】'}${m.text}`).join('\n');
    },
};

window.ReportIssue = ReportIssue;

/* NPC 主动上报：[sys:report_issue:reason=具体原因]。
 * fire-and-forget：不回灌、不阻塞 NPC 回复展示；弹窗异步弹出。 */
if (window.NpcBus) {
    NpcBus.register('report_issue', async (params) => {
        const reason = params.reason || params.content || '';
        const context = ReportIssue.collectContext();
        ReportIssue.trigger(reason, context, 'npc_report');
        return null;
    });
}
