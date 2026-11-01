// ============================================================
// FloatingHint — 浮动文字提示模块
// ============================================================
// 用法:
//   FloatingHint.show(msg, { position: 'top'|'center'|'bottom' })       — 在屏幕底部弹出
//   FloatingHint.at(targetEl, msg, { position: 'top'|'bottom' })         — 相对元素弹出
//   FloatingHint.bindDoubleClickClose(modalEl, onClose, msg)              — 弹窗双击空白处关闭
//   FloatingHint.hide()                                                   — 立即移除提示
//   FloatingHint.warnNoNpc()                                              — 快捷调用
// ============================================================

const FloatingHint = (() => {
    let currentEl = null;
    let currentTimer = null;

    function remove() {
        if (currentEl) {
            currentEl.remove();
            currentEl = null;
        }
        if (currentTimer) {
            clearTimeout(currentTimer);
            currentTimer = null;
        }
    }

    /**
     * 在屏幕中央/顶部/底部显示浮动提示
     * @param {string} msg - 提示文字
     * @param {object} [opts]
     * @param {string} [opts.position='center'] - top / center / bottom
     * @param {number} [opts.duration=2200] - 自动消失毫秒
     * @param {string} [opts.bg] - 自定义背景色
     */
    function show(msg, opts = {}) {
        remove();
        const position = opts.position || 'center';
        const duration = opts.duration || 2200;
        const el = document.createElement('div');
        el.className = 'floating-hint';
        el.textContent = msg;

        const styleEl = el.style;
        if (position === 'top') {
            styleEl.top = '20%';
            styleEl.bottom = 'auto';
        } else if (position === 'bottom') {
            styleEl.top = 'auto';
            styleEl.bottom = '40px';
        } else {
            styleEl.top = '50%';
            styleEl.bottom = 'auto';
        }
        if (opts.bg) styleEl.background = opts.bg;

        document.body.appendChild(el);
        currentEl = el;
        currentTimer = setTimeout(remove, duration);
    }

    /**
     * 在指定元素附近弹出提示
     * @param {HTMLElement} target - 锚定元素
     * @param {string} msg - 提示文字
     * @param {object} [opts]
     * @param {string} [opts.position='bottom'] - top / bottom / left / right
     * @param {number} [opts.duration=2200]
     */
    function at(target, msg, opts = {}) {
        if (!target) return show(msg, opts);
        remove();
        const position = opts.position || 'bottom';
        const duration = opts.duration || 2200;
        const rect = target.getBoundingClientRect();
        const el = document.createElement('div');
        el.className = 'floating-hint floating-hint-anchor';
        el.textContent = msg;
        const s = el.style;
        s.position = 'fixed';
        if (position === 'top') {
            s.top = (rect.top - 36) + 'px';
            s.left = (rect.left + rect.width / 2) + 'px';
            s.transform = 'translateX(-50%)';
        } else if (position === 'left') {
            s.top = (rect.top + rect.height / 2) + 'px';
            s.left = (rect.left - 8) + 'px';
            s.transform = 'translate(-100%, -50%)';
        } else if (position === 'right') {
            s.top = (rect.top + rect.height / 2) + 'px';
            s.left = (rect.right + 8) + 'px';
            s.transform = 'translateY(-50%)';
        } else {
            s.top = (rect.bottom + 8) + 'px';
            s.left = (rect.left + rect.width / 2) + 'px';
            s.transform = 'translateX(-50%)';
        }
        document.body.appendChild(el);
        currentEl = el;
        currentTimer = setTimeout(remove, duration);
    }

    /**
     * 弹窗空白处双击关闭：第一次点击空白 → 提示，3 秒内第二次点击 → 关闭
     * @param {HTMLElement} modalEl - 弹窗背景元素（.modal）
     * @param {function} onClose - 第二次点击时触发的关闭回调
     * @param {string} [hintMsg] - 自定义提示文字
     */
    function bindDoubleClickClose(modalEl, onClose, hintMsg) {
        if (!modalEl) return;
        const tracker = {};
        modalEl.addEventListener('click', e => {
            if (e.target !== modalEl) return;
            const now = Date.now();
            if (!tracker[modalEl.id] || (now - tracker[modalEl.id]) > 3000) {
                tracker[modalEl.id] = now;
                show(hintMsg || '💡 再次点击空白处即可关闭窗口', { position: 'bottom' });
                return;
            }
            delete tracker[modalEl.id];
            if (typeof onClose === 'function') onClose();
        });
    }

    /** 快捷：无可用 NPC 提示 */
    function warnNoNpc() {
        show('当前没有可用的 NPC', { position: 'center' });
    }

    return { show, at, hide: remove, bindDoubleClickClose, warnNoNpc };
})();
