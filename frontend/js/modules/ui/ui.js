/** AI剧本网 - UI 通用组件模块 */
const UIModule = {
    // 确认对话框（可随时调用的通用确认弹窗模块）
    // 用法：await UIModule.confirm('内容')
    //       await UIModule.confirm('内容', '标题')                       // 向后兼容
    //       await UIModule.confirm('内容', { title, okText, cancelText }) // 完整自定义
    async confirm(message, options) {
        const opts = (typeof options === 'string') ? { title: options } : (options || {});
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'ui-overlay';
            overlay.innerHTML = `
                <div class="ui-confirm-dialog">
                    <h3>${Utils.escapeHtml(opts.title || '确认')}</h3>
                    <p>${Utils.escapeHtml(message)}</p>
                    <div class="ui-confirm-actions">
                        <button class="btn btn-outline ui-cancel-btn">${Utils.escapeHtml(opts.cancelText || '取消')}</button>
                        <button class="btn btn-primary ui-ok-btn">${Utils.escapeHtml(opts.okText || '确认')}</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            overlay.querySelector('.ui-cancel-btn').onclick = () => {
                overlay.remove();
                resolve(false);
            };
            overlay.querySelector('.ui-ok-btn').onclick = () => {
                overlay.remove();
                resolve(true);
            };
            overlay.onclick = (e) => {
                if (e.target === overlay) { overlay.remove(); resolve(false); }
            };
        });
    },

    // 输入对话框（用于填写驳回原因等可选文本输入）
    // 用法：const text = await UIModule.prompt('请填写驳回原因', { title, placeholder, okText })
    // 返回：确认时返回输入文本（trim 后），取消返回 null
    async prompt(message, options) {
        const opts = (typeof options === 'string') ? { title: options } : (options || {});
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'ui-overlay';
            overlay.innerHTML = `
                <div class="ui-confirm-dialog">
                    <h3>${Utils.escapeHtml(opts.title || '请输入')}</h3>
                    <p>${Utils.escapeHtml(message)}</p>
                    <textarea class="form-input ui-prompt-input" rows="3"
                        maxlength="${opts.maxlength || 300}"
                        placeholder="${Utils.escapeHtml(opts.placeholder || '')}"></textarea>
                    <div class="ui-confirm-actions">
                        <button class="btn btn-outline ui-cancel-btn">${Utils.escapeHtml(opts.cancelText || '取消')}</button>
                        <button class="btn btn-primary ui-ok-btn">${Utils.escapeHtml(opts.okText || '确认')}</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            const input = overlay.querySelector('.ui-prompt-input');
            const finish = (val) => { overlay.remove(); resolve(val); };
            overlay.querySelector('.ui-cancel-btn').onclick = () => finish(null);
            overlay.querySelector('.ui-ok-btn').onclick = () => finish(input.value.trim());
            overlay.onclick = (e) => { if (e.target === overlay) finish(null); };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(input.value.trim());
            });
            setTimeout(() => input.focus(), 0);
        });
    },

    // 加载指示器
    showLoading(container, message) {
        if (typeof container === 'string') container = document.getElementById(container);
        if (!container) return;
        container.innerHTML = `<div class="loading">${Utils.escapeHtml(message || '加载中...')}</div>`;
    },

    // 空状态
    showEmpty(container, message) {
        if (typeof container === 'string') container = document.getElementById(container);
        if (!container) return;
        container.innerHTML = `<div class="empty-state">${Utils.escapeHtml(message || '暂无数据')}</div>`;
    },

    // 错误状态
    showError(container, message) {
        if (typeof container === 'string') container = document.getElementById(container);
        if (!container) return;
        container.innerHTML = `<div class="empty-state" style="color:var(--danger)">❌ ${Utils.escapeHtml(message)}</div>`;
    },

    // 进度条
    createProgress(value, max) {
        const pct = Math.min(100, Math.max(0, (value / max) * 100));
        return `<div class="ui-progress"><div class="ui-progress-fill" style="width:${pct}%"></div><span>${Math.round(pct)}%</span></div>`;
    },

    // 标签云
    renderTags(tags, onClick) {
        if (!tags || tags.length === 0) return '';
        return tags.map(t => `<span class="ui-tag" onclick="${onClick ? `(${onClick})('${t}')` : ''}">${Utils.escapeHtml(t)}</span>`).join('');
    },

    // 星级评分组件
    renderStars(rating, maxStars, interactive, onChange) {
        maxStars = maxStars || 5;
        rating = rating || 0;
        let html = '<span class="ui-stars">';
        for (let i = 1; i <= maxStars; i++) {
            const filled = i <= rating;
            if (interactive) {
                html += `<span class="ui-star ${filled ? 'filled' : ''}" data-rating="${i}" style="cursor:pointer">${filled ? '★' : '☆'}</span>`;
            } else {
                html += `<span class="ui-star ${filled ? 'filled' : ''}">${filled ? '★' : '☆'}</span>`;
            }
        }
        html += '</span>';
        return html;
    },

    // 绑定星级点击事件
    bindStars(container, onChange) {
        if (!container || !onChange) return;
        container.querySelectorAll('.ui-star[data-rating]').forEach(star => {
            star.onclick = () => onChange(parseInt(star.dataset.rating));
            star.onmouseenter = () => {
                const r = parseInt(star.dataset.rating);
                const stars = container.querySelectorAll('.ui-star');
                stars.forEach((s, i) => {
                    s.textContent = i < r ? '★' : '☆';
                    s.classList.toggle('filled', i < r);
                });
            };
            star.onmouseleave = () => {
                // 恢复原始状态 - 不做处理，由渲染时决定
            };
        });
    }
};

window.UIModule = UIModule;
