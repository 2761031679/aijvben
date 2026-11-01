/** AI剧本网 - 管理面板：成就管理（AdminAchievements，v4.6c 新增）
 * ------------------------------------------------------------------
 *  站长制作成就并颁发：
 *   - auto：系统监控数据自动发放（rule_key 对应 user_stats 字段 + 阈值）
 *   - manual：站长手动颁发（按用户名/用户 ID）
 */
const AdminAchievements = {
    /** auto 成就可监控的字段（与后端 stats.py 白名单一致） */
    RULE_KEYS: [
        ['tokens_used', 'Token 消耗'], ['scripts_completed', '通关剧本数'],
        ['scripts_uploaded', '上传剧本数'], ['likes_received', '获得点赞'],
        ['dislikes_received', '获得点踩'], ['subs_received', '获得收藏'],
        ['coins', '金币数'], ['coins_spent', '消耗金币数'],
        ['achievement_points', '成就分'], ['exp', '经验'], ['level', '等级'],
        ['following_count', '关注数'], ['follower_count', '被关注数'],
    ],

    async render(container) {
        container.innerHTML = '<div class="loading">加载成就...</div>';
        try {
            const res = await API.get('/admin/achievements');
            this._renderList(container, res.achievements || []);
        } catch (e) {
            container.innerHTML = `<div class="loading">加载失败：${Utils.escapeHtml(e.message)}</div>`;
        }
    },

    _renderList(container, list) {
        const esc = s => Utils.escapeHtml(String(s ?? ''));
        // data-id 是属性位：esc（= escapeHtml）不转引号，属性值统一用 escapeAttr
        // （id 现在是数字，但别依赖这个巧合 —— 换个主键类型就漏了）。
        const rows = list.map(a => `
            <div class="setting-group" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="font-size:20px">${esc(a.icon)}</span>
                <b>${esc(a.name)}</b>
                <span class="text-muted" style="font-size:12px">+${esc(a.points)}分 ｜
                    ${a.trigger_type === 'auto' ? `自动：${esc(a.rule_key)} ≥ ${esc(a.threshold)}` : '手动颁发'}
                    ${a.enabled ? '' : ' ｜ 已停用'}</span>
                <span style="flex:1"></span>
                <button class="btn btn-sm" data-act="grant" data-id="${Utils.escapeAttr(a.id)}">颁发</button>
                <button class="btn btn-sm" data-act="toggle" data-id="${Utils.escapeAttr(a.id)}" data-enabled="${a.enabled ? 1 : 0}">${a.enabled ? '停用' : '启用'}</button>
                <button class="btn btn-sm btn-outline" data-act="del" data-id="${Utils.escapeAttr(a.id)}">删除</button>
            </div>`).join('');

        container.innerHTML = `
            <div class="setting-group">
                <h3 style="margin-top:0">🏅 新建成就</h3>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">
                    <input class="form-input" id="achName" placeholder="名称（必填）">
                    <input class="form-input" id="achIcon" placeholder="图标 emoji" value="🏅">
                    <input class="form-input" id="achPoints" type="number" placeholder="成就分" value="10">
                    <select class="form-input" id="achType">
                        <option value="manual">手动颁发</option>
                        <option value="auto">自动（监控数据）</option>
                    </select>
                    <select class="form-input" id="achRuleKey" style="display:none">
                        ${this.RULE_KEYS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}
                    </select>
                    <input class="form-input" id="achThreshold" type="number" placeholder="阈值" value="1" style="display:none">
                </div>
                <input class="form-input" id="achDesc" placeholder="描述" style="margin-top:8px">
                <div class="form-actions" style="margin-top:8px">
                    <button class="btn btn-primary btn-sm" id="achCreateBtn">创建成就</button>
                </div>
            </div>
            ${rows || '<div class="text-muted" style="padding:8px">暂无成就</div>'}`;

        // 类型切换：显示/隐藏自动字段
        const typeSel = container.querySelector('#achType');
        typeSel.addEventListener('change', () => {
            const auto = typeSel.value === 'auto';
            container.querySelector('#achRuleKey').style.display = auto ? '' : 'none';
            container.querySelector('#achThreshold').style.display = auto ? '' : 'none';
        });
        container.querySelector('#achCreateBtn').addEventListener('click', () => this._create(container));
        container.querySelectorAll('[data-act]').forEach(btn => {
            btn.addEventListener('click', () => this._action(container, btn));
        });
    },

    async _create(container) {
        const val = id => (container.querySelector(id).value || '').trim();
        const body = {
            name: val('#achName'),
            icon: val('#achIcon') || '🏅',
            points: parseInt(val('#achPoints')) || 10,
            description: val('#achDesc'),
            trigger_type: val('#achType'),
        };
        if (body.trigger_type === 'auto') {
            body.rule_key = val('#achRuleKey');
            body.threshold = Math.max(1, parseInt(val('#achThreshold')) || 1);
        }
        if (!body.name) { Utils.showToast('请填写成就名称', 'error'); return; }
        try {
            await API.post('/admin/achievements', body);
            Utils.showToast('成就已创建');
            this.render(container);
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    async _action(container, btn) {
        const id = btn.dataset.id;
        try {
            if (btn.dataset.act === 'grant') {
                const user = prompt('输入要颁发给的用户名或用户 ID：');
                if (!user) return;
                const r = await API.post(`/admin/achievements/${id}/grant`, { user });
                Utils.showToast(`已颁发给 ${r.user}`);
            } else if (btn.dataset.act === 'toggle') {
                await API.put(`/admin/achievements/${id}`, { enabled: btn.dataset.enabled !== '1' });
                this.render(container);
            } else if (btn.dataset.act === 'del') {
                if (!confirm('删除该成就？所有用户已获得的该成就记录也会一并删除。')) return;
                await API.delete(`/admin/achievements/${id}`);
                this.render(container);
            }
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },
};

window.AdminAchievements = AdminAchievements;
