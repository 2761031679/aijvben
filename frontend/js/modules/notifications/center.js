/** AI剧本网 - 通知中心
 * 负责：① 红点徽标更新 ② 通知面板开关 ③ 通知列表渲染 ④ 已读处理
 *
 * 触发来源（后端 NotificationService 推送）：
 *   - 审核结果（通过/驳回）  → 通知作者
 *   （评论区已关闭，不再有评论通知）
 */
const NotificationCenter = {
    _open: false,
    _lastCount: null,   // 上次未读数，用于检测"新增通知"

    async updateBadge() {
        try {
            const data = await ScriptAPI.notificationUnreadCount();
            const badge = document.getElementById('bellBadge');
            const bell = document.getElementById('teaBell');
            if (!badge || !bell) return;
            const n = data.count || 0;
            // 检测到未读数增加 → 广播"新通知"事件（NpcBus 会把它转达给 NPC，不打断对话）
            if (this._lastCount != null && n > this._lastCount && window.Events) {
                Events.emit('notification-new', { title: `你有 ${n} 条未读站内通知`, count: n });
            }
            this._lastCount = n;
            if (n > 0) {
                badge.textContent = n > 99 ? '99+' : n;
                badge.style.display = 'inline-block';
                bell.classList.add('has-unread');
            } else {
                badge.style.display = 'none';
                bell.classList.remove('has-unread');
            }
        } catch (e) { /* 忽略 */ }
    },

    toggle() {
        this._open = !this._open;
        let panel = document.getElementById('notifPanel');
        if (this._open) {
            if (!panel) this._createPanel();
            this.load();
        } else if (panel) {
            panel.remove();
        }
    },

    _createPanel() {
        const panel = document.createElement('div');
        panel.id = 'notifPanel';
        panel.className = 'notif-panel';
        panel.innerHTML = `
            <div class="notif-head">
                <span>通知</span>
                <button class="btn btn-sm btn-outline" onclick="NotificationCenter.markAllRead()">全部已读</button>
                <span class="notif-close" onclick="NotificationCenter.toggle()">✕</span>
            </div>
            <div class="notif-body" id="notifBody"><div class="loading">加载中...</div></div>`;
        document.body.appendChild(panel);
    },

    async load(page = 1) {
        const body = document.getElementById('notifBody');
        if (!body) return;
        try {
            const data = await ScriptAPI.notifications(page, false);
            const list = data.notifications || [];
            if (list.length === 0) {
                body.innerHTML = '<div class="empty-state">暂无通知</div>';
                return;
            }
            body.innerHTML = list.map(n => `
                <div class="notif-item ${n.is_read ? '' : 'unread'}" data-id="${Utils.escapeAttr(n.id || '')}" data-link="${Utils.escapeAttr(n.link || '')}">
                    <div class="notif-title">${Utils.escapeHtml(n.title)}</div>
                    <div class="notif-body-text">${Utils.escapeHtml(n.body || '')}</div>
                    <div class="notif-time">${Utils.formatTime ? Utils.formatTime(n.created_at) : n.created_at}</div>
                </div>`).join('');

            // 点击走事件委托，不再把数据拼进 onclick。
            // 原来是 onclick="NotificationCenter.openLink('${n.id}', '${n.link}')" —— 裸拼进
            // 内联 JS 的字符串字面量里，而 escapeHtml 不转单引号：link 里出现一个 ' 就能闭合字符串、
            // 让后面的内容变成可执行代码（link 来自库里的通知数据，不是常量）。
            // 改成 data-* 承载数据（已 escapeAttr）+ 固定的事件通路，数据再也进不到代码里。
            if (body.dataset.notifBound !== '1') {
                body.dataset.notifBound = '1';
                body.addEventListener('click', (e) => {
                    const item = e.target.closest('.notif-item');
                    if (!item || !body.contains(item)) return;
                    this.openLink(item.dataset.id || '', item.dataset.link || '');
                });
            }
        } catch (e) {
            body.innerHTML = `<div class="loading">加载失败：${Utils.escapeHtml(e.message)}</div>`;
        }
    },

    /** 点击通知：先标记该条已读（修复：看完通知后小红点不消失），再跳转内容 */
    async openLink(id, link) {
        if (id) {
            try { await ScriptAPI.markNotificationRead(id); } catch (e) { /* 忽略 */ }
            this.updateBadge();   // 刷新红点/图标样式
        }
        this.toggle();
        if (link) {
            if (link.startsWith('/script/')) {
                if (window.showScriptDetail) showScriptDetail(link.replace('/script/', ''));
            } else {
                window.location.hash = link.replace('/', '');
            }
        }
    },

    async markAllRead() {
        try {
            await ScriptAPI.markNotificationRead('');
            await this.load();
            this.updateBadge();
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },
};

window.NotificationCenter = NotificationCenter;
