/** AI剧本网 - 工具函数 */
const Utils = {
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /** 属性上下文转义：`<div title="${x}">` 这类位置必须用它，不能拿 escapeHtml 顶。
     *
     *  为什么不能混用：escapeHtml 靠 textContent → innerHTML，浏览器只保证转义 & < >，
     *  双引号 / 单引号原样留着；而属性值恰恰是被引号框住的，内容里出现一个 " 就能提前闭合
     *  属性，再接一个 onmouseover=… 就是可执行的注入（内联 onclick 里拼单引号同理）。
     *  所以这里显式转 & " ' < > 五个字符。
     *
     *  & 只在「不是既有字符实体开头」时才转，是为了幂等：调用点常常是已经过 escapeHtml
     *  的文本（如 NPC 解码器先整体转义、再拼进属性），无条件转 & 会得到 &amp;amp;，
     *  界面直接把 &amp; 当字面量显示出来。已经成型的实体保持不动，重复转义也不再膨胀。 */
    escapeAttr(text) {
        return String(text ?? '')
            .replace(/&(?!#?[a-zA-Z0-9]+;)/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },

    formatTime(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleString('zh-CN');
    },

    debounce(fn, delay = 300) {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    },

    getUserId() {
        const user = STATE.get('user');
        return user ? user.id : null;
    },

    isAdmin() {
        const user = STATE.get('user');
        return user && (user.role === 'admin' || user.role === 'owner');
    },

    isOwner() {
        const user = STATE.get('user');
        return user && user.role === 'owner';
    },

    showToast(msg, type = 'info') {
        const toast = document.getElementById('toast');
        if (!toast) return;
        toast.textContent = msg;
        toast.className = `toast toast-${type}`;
        toast.style.display = 'block';
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
    },

    openModal(id) {
        const el = document.getElementById(id);
        if (el) { el.style.display = 'flex'; this._bindOutsideClose(el, id); }
    },

    closeModal(id) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    },

    // 弹窗外双击关闭（3秒内两次点击空白处）
    _outsideTimers: {},
    _bindOutsideClose(el, id) {
        if (el.dataset.outsideBound === 'true') return;
        el.dataset.outsideBound = 'true';
        el.addEventListener('click', (e) => {
            if (e.target !== el) return; // 只响应弹窗背景层（空白处）
            const now = Date.now();
            const prev = this._outsideTimers[id] || 0;
            if (now - prev < 3000) {
                // 3秒内第二次点击 → 关闭
                this.closeModal(id);
                delete this._outsideTimers[id];
            } else {
                // 第一次点击 → 提示
                this._outsideTimers[id] = now;
                this.showToast('再次点击空白处关闭', 'info');
            }
        });
    },

    /** 读取当前账号配置（纯分账号隔离）
     *  优先取内存态 STATE.config（由 AccountInit._loadLocalConfig 按账号载入）；
     *  STATE 未就绪时回退到当前账号的 Store 独立配置。
     *  不再读取旧版全局 turtlesoup_config，避免账号间（尤其是游客）互相继承 API Key。
     */
    getConfig() {
        const c = STATE.get('config');
        if (c) return { ...CONFIG.DEFAULT_CONFIG, ...c };
        let perUser = {};
        try {
            if (window.Store) perUser = Store.get('config', {}) || {};
        } catch (e) { /* ignore */ }
        return { ...CONFIG.DEFAULT_CONFIG, ...perUser };
    },
};

window.Utils = Utils;
