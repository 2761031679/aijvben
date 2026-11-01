/** AI剧本网 - 管理面板 */
const AdminPanel = {
    _currentTab: 'stats',
    _npcData: null,       // GET /admin/npc-configs/management 缓存
    _promptCat: null,     // 提示词编辑页当前选中的分类 id
    _reviewSubTab: null,  // 跳转到审核页时自动展开的子 tab（如 logs）

    async render(container) {
        if (!Utils.isAdmin()) {
            container.innerHTML = '<div class="loading">需要管理员权限</div>';
            return;
        }
        let html = '<div class="admin-panel"><div class="admin-tabs">';
        const tabs = [
            { id: 'stats', label: '📊 统计' },
            { id: 'prompts', label: '📝 提示词' },
            { id: 'trends', label: '🔥 热梗库' },
            { id: 'npc-call', label: '🎭 立绘表情调用', owner: true },
            { id: 'model', label: '🤖 模型管理', owner: true },
            { id: 'free-trial', label: '🎁 免费活动', owner: true },
            { id: 'banners', label: '🖼 轮播海报' },
            { id: 'announcements', label: '📢 公告' },
            { id: 'site-settings', label: '⚙️ 站点设置' },
            { id: 'achievements', label: '🏅 成就' },
            { id: 'review', label: '🔍 审核' },
            // 举报处理本来就在「审核 → 举报管理」子 tab 里，但它对管理员太隐蔽（要先进审核页再点子 tab），
            // 所以单独给一个直达入口；渲染仍复用审核页的 _loadReview，不另写一套。
            { id: 'reports', label: '🚩 举报处理' },
            { id: 'deleted', label: '🗑 回收站' },
            { id: 'demo', label: '🧪 示例' },
        ];
        for (const t of tabs) {
            if (t.owner && !Utils.isOwner()) continue;   // 立绘表情调用面板仅站长可访问
            html += `<button class="admin-tab ${t.id === this._currentTab ? 'active' : ''}"
                onclick="AdminPanel.switchTab('${t.id}')">${t.label}</button>`;
        }
        html += '</div><div id="adminTabContent" class="admin-tab-content"></div></div>';
        container.innerHTML = html;
        this.loadTab(this._currentTab);
    },

    switchTab(tab) {
        // 离开「立绘与表情调用」面板：清除网页 NPC 上预览用的动画并恢复默认立绘
        if (this._currentTab === 'npc-call' && tab !== 'npc-call') {
            this._exitNpcCallPreview();
        }
        this._currentTab = tab;
        this.render(Router.getContentTarget());
    },

    async loadTab(tab) {
        const content = document.getElementById('adminTabContent');
        if (!content) return;
        switch (tab) {
            case 'stats': await this._loadStats(content); break;
            case 'prompts': await this._loadPromptEditor(content); break;
            case 'trends': await this._loadTrends(content); break;
            case 'npc-call': await this._renderNpcCall(content); break;
            case 'model': await this._loadModelAdmin(content); break;
            case 'free-trial': await this._loadFreeTrial(content); break;
            case 'banners': await this._loadBanners(content); break;
            case 'announcements': await this._loadAnnouncements(content); break;
            case 'site-settings': await this._loadSiteSettings(content); break;
            case 'reports':
                // 复用审核页：_loadReview 支持用 _reviewSubTab 一次性展开指定子 tab
                // （统计页卡片跳「审核打回记录」就是这么走的），这里直接点名 community=举报管理。
                this._reviewSubTab = 'community';
                await this._loadReview(content);
                break;
            case 'achievements': await AdminAchievements.render(content); break;
            case 'review': await this._loadReview(content); break;
            case 'deleted': await this._loadDeleted(content); break;
            case 'demo': await AdminDemo.render(content); break;
        }
    },

    /* ========== 统计 ========== */
    async _loadStats(container) {
        try {
            const stats = await API.get('/admin/stats');
            // 免费活动 Token 消耗 / 报错书 / 审核打回记录：仅站长可见（对应后端接口 require_owner）
            let tokenCard = '';
            let errorCards = '';
            if (Utils.isOwner()) {
                try {
                    const usage = await API.get('/admin/free-trial-usage');
                    tokenCard = `<div class="stat-card"><h3>🔢 ${this._formatTokens(usage.total_tokens || 0)}</h3><p>免费活动 Token 消耗（${usage.total_calls || 0} 次调用）</p></div>`;
                } catch (e) { /* 忽略 */ }
                errorCards = `
                    <div class="stat-card" style="cursor:pointer;" onclick="AdminPanel._showAiErrorReports()"><h3>📕 ${stats.ai_error_count || 0}</h3><p>报错书（点击查看）</p></div>
                    <div class="stat-card" style="cursor:pointer;" onclick="AdminPanel._openReviewLogs()"><h3>🛡 ${stats.npc_review_log_count || 0}</h3><p>审核打回记录（点击查看）</p></div>`;
            }
            container.innerHTML = `
                <div class="stats-grid">
                    <div class="stat-card"><h3>👥 ${stats.total_users}</h3><p>用户总数</p></div>
                    <div class="stat-card"><h3>📜 ${stats.total_scripts}</h3><p>剧本总数</p></div>
                    <div class="stat-card"><h3>⏳ ${stats.pending_reviews}</h3><p>待审核</p></div>
                    ${tokenCard}
                    ${errorCards}
                </div>`;
        } catch (e) { container.innerHTML = `<div class="loading">加载失败</div>`; }
    },

    /** 统计页「报错书」卡片：在当前 tab 内容区展示报错书查询表 */
    _showAiErrorReports() {
        const content = document.getElementById('adminTabContent');
        if (!content) return;
        this._renderAiErrorReports(content);
    },

    /** 统计页「审核打回记录」卡片：跳转到审核页并自动展开「审核打回记录」子 tab */
    _openReviewLogs() {
        this._currentTab = 'review';
        this._reviewSubTab = 'logs';
        this.render(Router.getContentTarget());
    },

    /** token 数值人性化缩写（1.2K / 3.4M） */
    _formatTokens(n) {
        n = Number(n) || 0;
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    },

    /* ========== 热梗/问好资源库管理 ========== */
    async _loadTrends(container) {
        container.innerHTML = '<div class="loading">加载热梗库...</div>';
        try {
            const res = await API.get('/admin/trends');
            this._trends = res.items || [];
            this._renderTrends(container);
        } catch (e) {
            container.innerHTML = `<div class="loading">加载失败: ${e.message}</div>`;
        }
    },

    _renderTrends(container) {
        const items = this._trends || [];
        const catName = { greeting: '问好', meme: '热梗', trend: '流行说法' };
        const rows = items.map(t => `
            <div style="display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--border-color);border-radius:8px;margin-bottom:8px;background:var(--card-bg,#1e1e2e);">
                <div style="flex:0 0 130px;"><strong>${Utils.escapeHtml(t.keyword)}</strong><br><span style="color:var(--text-secondary);font-size:12px;">${catName[t.category] || t.category}</span></div>
                <div style="flex:1;white-space:pre-wrap;">${Utils.escapeHtml(t.content)}</div>
                <div style="flex:0 0 auto;display:flex;gap:6px;">
                    <button class="btn btn-sm" onclick="AdminPanel._toggleTrend('${t.id}')">${t.enabled ? '停用' : '启用'}</button>
                    <button class="btn btn-sm btn-danger" onclick="AdminPanel._deleteTrend('${t.id}')">删除</button>
                </div>
            </div>`).join('');

        container.innerHTML = `
            <div style="margin-bottom:16px;">
                <h3>🔥 热梗/问好资源库</h3>
                <p style="color:var(--text-secondary);font-size:12px;">NPC 需要流行说法/热梗/问好方式时，通过 <code>[tool:get_trend:keyword=xxx]</code> 按需查询（RAG 式，不打包进提示词，避免 token 浪费）。</p>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
                    <input id="trendKeyword" class="form-input" placeholder="关键词（如：早八人、问好）" style="flex:1;min-width:140px;">
                    <select id="trendCategory" class="form-input" style="width:140px;">
                        <option value="trend">流行说法</option>
                        <option value="meme">热梗</option>
                        <option value="greeting">问好</option>
                    </select>
                </div>
                <textarea id="trendContent" class="form-input" placeholder="内容说明（热梗含义/用法/示例）" rows="2" style="width:100%;margin-bottom:8px;box-sizing:border-box;"></textarea>
                <button class="btn btn-primary" onclick="AdminPanel._addTrend()">➕ 新增条目</button>
            </div>
            <div>${rows || '<div class="loading">暂无条目，先在上方新增</div>'}</div>`;
    },

    async _addTrend() {
        const keyword = (document.getElementById('trendKeyword')?.value || '').trim();
        const category = document.getElementById('trendCategory')?.value || 'trend';
        const content = document.getElementById('trendContent')?.value || '';
        if (!keyword) { Utils.showToast('请填写关键词', 'error'); return; }
        try {
            await API.post('/admin/trends', { keyword, category, content, enabled: true });
            Utils.showToast('已新增');
            this._loadTrends(document.getElementById('adminTabContent'));
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    async _toggleTrend(id) {
        const t = (this._trends || []).find(x => x.id === id);
        if (!t) return;
        try {
            await API.put(`/admin/trends/${id}`, { enabled: !t.enabled });
            Utils.showToast('已更新');
            this._loadTrends(document.getElementById('adminTabContent'));
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    async _deleteTrend(id) {
        if (!confirm('确认删除该条目？')) return;
        try {
            await API.delete(`/admin/trends/${id}`);
            Utils.showToast('已删除');
            this._loadTrends(document.getElementById('adminTabContent'));
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    /* ========== 提示词编辑器（独立标签页：分类标签 + 大编辑区） ========== */
    async _loadPromptEditor(container) {
        container.innerHTML = '<div class="loading">加载提示词编辑器...</div>';
        try {
            if (!this._npcData) this._npcData = await API.get('/admin/npc-configs/management');
            this._renderPromptEditor(container);
        } catch (e) {
            container.innerHTML = `<div class="loading">加载失败: ${e.message}</div>`;
        }
    },

    /** 渲染提示词编辑器：顶部二级分类标签（各 NPC / 公用 / 审核）+ 内容区 */
    _renderPromptEditor(container) {
        const data = this._npcData;
        if (!data) { container.innerHTML = '<div class="loading">无数据</div>'; return; }
        const cats = [];
        for (const npc of (data.npcs || [])) {
            cats.push({ id: 'npc_' + npc.npc_id, label: '🎭 ' + (npc.display_name || npc.npc_id) });
        }
        cats.push({ id: 'shared', label: '📦 公用资源' });
        cats.push({ id: 'review', label: '🛡 审核 NPC' });

        if (!this._promptCat || !cats.some(c => c.id === this._promptCat)) {
            this._promptCat = cats.length ? cats[0].id : 'shared';
        }

        let html = '<div class="admin-tabs" style="flex-wrap:wrap;margin-bottom:16px;">';
        for (const c of cats) {
            html += `<button class="admin-tab ${c.id === this._promptCat ? 'active' : ''}"
                onclick="AdminPanel._switchPromptCat('${c.id}')">${c.label}</button>`;
        }
        html += '</div><div id="promptEditorContent"></div>';
        container.innerHTML = html;
        this._renderPromptCat(this._promptCat);
    },

    _switchPromptCat(catId) {
        this._promptCat = catId;
        this._renderPromptCat(catId);
    },

    /** 渲染某个分类下的提示词列表（大编辑区，等宽字体，可拖拽调整高度） */
    _renderPromptCat(catId) {
        const content = document.getElementById('promptEditorContent');
        if (!content) return;
        const data = this._npcData;
        let html = '';

        if (catId === 'shared') {
            const sharedPrompts = data.shared_prompts || [];
            html = '<div class="prompt-cat-list">';
            for (const pt of sharedPrompts) {
                if (pt.prompt_type === 'offline_guide') continue;  // 离线引导走结构化编辑
                const cat = pt.category || '';
                const uid = `prompt_shared__${pt.prompt_type}${cat ? '_' + cat : ''}`;
                html += this._promptEditorBlock(
                    `shared/${pt.prompt_type}${cat ? ' (' + cat + ')' : ''}`, uid, pt.content,
                    `AdminPanel._saveNpcPromptFile('shared','','${pt.prompt_type}','${cat}')`);
            }
            html += '</div>';
            // 离线引导：单开结构化编辑（触发关键词 + 回复，可增删）
            const og = sharedPrompts.find(p => p.prompt_type === 'offline_guide');
            if (og) html += this._offlineGuideEditor(og.content);
        } else if (catId === 'review') {
            html = '<div class="prompt-cat-list">' + this._promptEditorBlock(
                'review/review（审核协议，留空则仅用内置协议）', 'prompt__review', data.review_npc_prompt || '',
                `AdminPanel._saveNpcPromptFile('review','','review')`) + '</div>';
        } else {
            const npc = (data.npcs || []).find(n => 'npc_' + n.npc_id === catId);
            if (npc) {
                const pid = npc.personality_id;
                const prompts = npc.prompts || [];
                html = '<div class="prompt-cat-list">';
                for (const pt of prompts) {
                    html += this._promptEditorBlock(
                        pt.prompt_type, `prompt_${pid}_${pt.prompt_type}`, pt.content,
                        `AdminPanel._saveNpcPromptFile('${npc.npc_id}','${pid}','${pt.prompt_type}')`);
                }
                html += '</div>';
            }
        }
        content.innerHTML = html;
    },

    /** 生成单个提示词编辑块（大 textarea + 保存按钮） */
    _promptEditorBlock(label, id, content, saveCall) {
        return `
            <div class="prompt-editor-block" style="margin-bottom:16px;background:var(--card-bg,#1e1e2e);border:1px solid var(--border-color);border-radius:10px;padding:14px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <strong style="font-size:13px;color:var(--text-primary);">${label}</strong>
                    <button class="btn btn-sm btn-primary" onclick="${saveCall}">💾 保存</button>
                </div>
                <textarea class="form-input" id="${id}" rows="18" spellcheck="false"
                    style="width:100%;font-family:ui-monospace,SFMono-Regular,Consolas,'Courier New',monospace;font-size:13px;line-height:1.6;resize:vertical;">${Utils.escapeHtml(content || '')}</textarea>
            </div>`;
    },

    /* ========== 立绘与表情调用面板（仅站长） ========== */
    async _renderNpcCall(container) {
        if (!Utils.isOwner()) {
            container.innerHTML = '<div class="loading">仅站长可访问立绘与表情调用设置</div>';
            return;
        }
        container.innerHTML = '<div class="loading">加载中...</div>';
        let data;
        try {
            data = await API.get('/admin/npc-configs/management');
        } catch (e) {
            container.innerHTML = `<div class="loading">加载失败: ${e.message}</div>`;
            return;
        }
        const npcs = (data.npcs || []).map(n => ({ id: n.npc_id, name: n.display_name }));
        const emotions = data.available_emotions || [];
        const actions = data.available_actions || [];
        this._npcCallData = { npcs, emotions, actions };

        const options = npcs.map(n => `<option value="${n.id}">${n.name}</option>`).join('');
        container.innerHTML = `
            <div class="npc-call-panel">
                <h3>🎭 立绘与表情调用设置</h3>
                <p class="muted">选择 NPC：先在「方法池」定义若干方法（方法 = 一张立绘 + 一个动画），再到「表情绑定」为每个开放表情指定调用的方法。
                    保存后系统自动把方法打包成提示词喂给 AI；NPC 只能做出你勾选的表情，呈现的就是你设定的方法效果。</p>
                <div class="form-row">
                    <label>NPC</label>
                    <select id="npcCallSelect" class="form-input" onchange="AdminPanel._onNpcCallChange()">${options}</select>
                </div>
                <div id="npcCallBody"></div>
            </div>`;
        this._onNpcCallChange();
    },

    /** NPC 切换：加载该 NPC 的方法池 + 表情绑定 + 开放动画，渲染编辑界面 */
    async _onNpcCallChange() {
        const select = document.getElementById('npcCallSelect');
        if (!select) return;
        const npcId = select.value;
        const { emotions = [], actions = [] } = this._npcCallData || {};
        let cfg = {};
        try {
            const data = await API.get('/admin/npc-configs');
            cfg = (data.configs && data.configs[npcId]) || {};
        } catch (e) { /* 缺失则用默认 */ }
        // 拉取该 NPC 可用立绘文件（供方法卡片选择缩略图）
        let portraits = [];
        try {
            const pr = await API.get(`/admin/npc-configs/${npcId}/portraits`);
            portraits = pr.portraits || [];
        } catch (e) { /* 忽略 */ }
        if (!portraits.length) portraits = ['default.png'];

        // 编辑工作副本（保存前不落库）
        this._npcCallEdit = {
            npcId,
            emotions,
            actions,
            portraits,
            portraitUrl: cfg.portrait_url || '',
            scale: parseInt(cfg.scale) || 80,
            methods: (cfg.methods && cfg.methods.length)
                ? JSON.parse(JSON.stringify(cfg.methods))
                : [{ id: 'm_default', name: '默认', portrait: 'default.png', anim: '', prompt: '' }],
            emotionMethods: Object.assign({}, cfg.emotion_methods || {}),
            enabledEmotions: Array.isArray(cfg.enabled_emotions) ? cfg.enabled_emotions.slice() : emotions.map(e => e.id),
        };

        const enA = cfg.enabled_actions || actions.map(a => a.id);
        const actHtml = actions.map(a => `
            <label class="call-item">
                <input type="checkbox" data-kind="action" value="${a.id}" ${enA.includes(a.id) ? 'checked' : ''}>
                <span>${a.name}</span>
                <button class="btn btn-sm" onclick="AdminPanel._previewNpcAction('${npcId}','${a.id}')">调用</button>
            </label>
            <div class="muted small">${a.desc || ''}</div>`).join('');

        const body = document.getElementById('npcCallBody');
        body.innerHTML = `
            <div style="padding:12px 14px;margin-bottom:16px;border:1px solid var(--border);border-radius:10px;background:rgba(0,0,0,0.15);color:var(--text-secondary);font-size:13px;line-height:1.6;">
                👁 预览已直接作用于<b>右侧网页 NPC</b>：点选立绘、点方法/表情「预览」、点动画「调用」，网页上的 NPC 会实时切换立绘与动画；退出本页自动恢复。
            </div>

            <h4 class="npc-sub-h">⚙️ 立绘基础设置</h4>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;">
                <div class="setting-group">
                    <label>立绘 URL（留空用默认）</label>
                    <input type="text" id="npcPortraitInput" class="form-input"
                        value="${Utils.escapeHtml(this._npcCallEdit.portraitUrl)}" placeholder="留空使用默认">
                </div>
                <div class="setting-group">
                    <label>立绘缩放 (%)</label>
                    <input type="range" id="npcScaleInput" min="40" max="200" value="${this._npcCallEdit.scale}" style="padding:0;width:100%;"
                        oninput="AdminPanel._previewNpcScale(this.value)">
                    <span id="npcScaleInputVal" style="font-size:12px;color:var(--text-muted);">${this._npcCallEdit.scale}%</span>
                </div>
            </div>

            <h4 class="npc-sub-h">① 方法池 —— 每条方法 = 一张立绘 + 一个动画（可新建/删除，供表情复用）</h4>
            <div id="methodPool" class="method-pool"></div>
            <button class="btn btn-outline btn-sm" onclick="AdminPanel._addMethod()">＋ 新建方法</button>

            <h4 class="npc-sub-h">② 表情绑定 —— 勾选 NPC 可表达的表情，并为其指定调用的方法</h4>
            <div id="emotionBindList" class="emotion-bind-list"></div>

            <h4 class="npc-sub-h">③ 开放动画 —— 勾选后 NPC 才能用 [action:xxx] 主动播放</h4>
            <div class="call-list">${actHtml}</div>

            <div class="form-actions">
                <button class="btn btn-primary" onclick="AdminPanel._saveNpcCall('${npcId}')">保存设置</button>
            </div>`;
        this._renderMethodPool();
        this._renderEmotionBind();
        if (this._npcCallEdit.portraitUrl) NpcUI._setBg(this._npcCallEdit.portraitUrl, 'teahouse-npc');
        else this._setPreviewPortrait(npcId, 'default');
        this._previewNpcScale(this._npcCallEdit.scale);
    },

    /** 立绘缩略图地址 */
    _portraitThumbUrl(npcId, file) {
        return `/static/npc/teahouse/${npcId}/${file}`;
    },

    /** 渲染方法池卡片 */
    _renderMethodPool() {
        const st = this._npcCallEdit;
        const pool = document.getElementById('methodPool');
        if (!st || !pool) return;
        pool.innerHTML = st.methods.map((m, idx) => `
            <div class="method-card" data-idx="${idx}">
                <div class="method-head">
                    <input class="form-input method-name" data-idx="${idx}" value="${(m.name || '').replace(/"/g, '&quot;')}" placeholder="方法名，如：微笑立绘 / 微笑+跳跃">
                    <button class="btn btn-sm btn-danger" onclick="AdminPanel._deleteMethod(${idx})">删除</button>
                </div>
                <div class="method-row">
                    <span class="method-label">立绘</span>
                    <div class="portrait-grid">
                        ${st.portraits.map(p => `
                            <div class="portrait-cell ${m.portrait === p ? 'selected' : ''}" title="${p}"
                                 onclick="AdminPanel._pickPortrait(${idx},'${p}')"
                                 style="background-image:url('${this._portraitThumbUrl(st.npcId, p)}')"></div>
                        `).join('')}
                    </div>
                </div>
                <div class="method-row">
                    <span class="method-label">动画</span>
                    <select class="form-input method-anim" data-idx="${idx}">
                        <option value="">无动画</option>
                        ${st.actions.map(a => `<option value="${a.id}" ${m.anim === a.id ? 'selected' : ''}>${a.name}</option>`).join('')}
                    </select>
                    <button class="btn btn-sm" onclick="AdminPanel._previewMethod(${idx})">预览</button>
                </div>
            </div>
        `).join('');
    },

    /** 渲染表情绑定列表 */
    _renderEmotionBind() {
        const st = this._npcCallEdit;
        const list = document.getElementById('emotionBindList');
        if (!st || !list) return;
        list.innerHTML = st.emotions.map(e => {
            const enabled = st.enabledEmotions.includes(e.id);
            const bound = st.emotionMethods[e.id] || '';
            const opts = '<option value="">（不绑定方法）</option>'
                + st.methods.map(m => `<option value="${m.id}" ${bound === m.id ? 'selected' : ''}>${(m.name || m.id)}</option>`).join('');
            return `
            <div class="emotion-bind-row">
                <label class="call-item"><input type="checkbox" class="emo-enable" data-emo="${e.id}" ${enabled ? 'checked' : ''}><span>${e.name}</span></label>
                <select class="form-input emo-method" data-emo="${e.id}">${opts}</select>
                <button class="btn btn-sm" onclick="AdminPanel._previewEmotionMethod('${e.id}')">预览</button>
            </div>`;
        }).join('');
    },

    /** 把方法池当前 DOM 值同步回状态（结构性操作前调用，避免丢失未保存输入） */
    _syncMethodsFromDom() {
        const st = this._npcCallEdit;
        if (!st) return;
        document.querySelectorAll('#methodPool .method-card').forEach(card => {
            const idx = parseInt(card.getAttribute('data-idx'), 10);
            const m = st.methods[idx];
            if (!m) return;
            const nameEl = card.querySelector('.method-name');
            const animEl = card.querySelector('.method-anim');
            if (nameEl) m.name = nameEl.value;
            if (animEl) m.anim = animEl.value;
        });
    },

    /** 把表情绑定当前 DOM 值同步回状态 */
    _syncEmotionBindFromDom() {
        const st = this._npcCallEdit;
        if (!st) return;
        document.querySelectorAll('#emotionBindList .emo-method').forEach(sel => {
            st.emotionMethods[sel.getAttribute('data-emo')] = sel.value;
        });
        st.enabledEmotions = [...document.querySelectorAll('#emotionBindList .emo-enable:checked')].map(c => c.getAttribute('data-emo'));
    },

    _addMethod() {
        this._syncMethodsFromDom(); this._syncEmotionBindFromDom();
        const st = this._npcCallEdit;
        st.methods.push({ id: 'm' + Date.now(), name: '新方法', portrait: st.portraits[0] || 'default.png', anim: '', prompt: '' });
        this._renderMethodPool(); this._renderEmotionBind();
    },

    _deleteMethod(idx) {
        this._syncMethodsFromDom(); this._syncEmotionBindFromDom();
        const st = this._npcCallEdit;
        const removed = st.methods.splice(idx, 1)[0];
        if (removed) Object.keys(st.emotionMethods).forEach(k => { if (st.emotionMethods[k] === removed.id) delete st.emotionMethods[k]; });
        this._renderMethodPool(); this._renderEmotionBind();
    },

    _pickPortrait(idx, file) {
        this._syncMethodsFromDom(); this._syncEmotionBindFromDom();
        this._npcCallEdit.methods[idx].portrait = file;
        this._renderMethodPool(); this._renderEmotionBind();
        // 点选立绘后立即在网页 NPC 上预览该立绘（实时反馈）
        this._setPreviewPortrait(this._npcCallEdit.npcId, null, file);
    },

    /** 预览某条方法（切换立绘 + 播放动画）—— 作用在网页主场景 NPC 上 */
    _previewMethod(idx) {
        this._syncMethodsFromDom();
        const st = this._npcCallEdit;
        const m = st.methods[idx];
        if (!m) return;
        this._setPreviewPortrait(st.npcId, null, m.portrait);
        this._playPreviewAnim(st.npcId, m.anim);
    },

    /** 预览某表情当前绑定的方法效果 —— 作用在网页主场景 NPC 上 */
    _previewEmotionMethod(emotionId) {
        this._syncMethodsFromDom(); this._syncEmotionBindFromDom();
        const st = this._npcCallEdit;
        const m = st.methods.find(x => x.id === st.emotionMethods[emotionId]);
        if (!m) { this._setPreviewPortrait(st.npcId, emotionId); return; }
        this._setPreviewPortrait(st.npcId, null, m.portrait);
        this._playPreviewAnim(st.npcId, m.anim);
    },

    /** 播放预览动画到网页主场景 NPC（无动画则仅清除旧动画） */
    _playPreviewAnim(npcId, anim) {
        if (!window.NpcAnim) return;
        NpcAnim.clear(npcId, 'teahouse-npc');
        if (anim) NpcAnim.play(npcId, anim, (anim || '').indexOf('loop') !== -1, 'teahouse-npc');
    },

    _setPreviewPortrait(npcId, emotion, portraitFile) {
        const url = portraitFile
            ? this._portraitThumbUrl(npcId, portraitFile)
            : (window.NpcUI ? NpcUI._portraitUrl(npcId, emotion) : '');
        if (url && window.NpcUI) NpcUI._setBg(url, 'teahouse-npc');
    },

    /** 立绘缩放实时预览：同时更新编辑副本与 CSS 变量，保存前即可看到效果 */
    _previewNpcScale(value) {
        const scale = parseInt(value) || 80;
        if (this._npcCallEdit) this._npcCallEdit.scale = scale;
        const label = document.getElementById('npcScaleInputVal');
        if (label) label.textContent = scale + '%';
        document.documentElement.style.setProperty('--npc-scale', scale / 80);
    },

    _previewNpcAction(npcId, actionId) {
        this._playPreviewAnim(npcId, actionId);
    },

    /** 退出立绘表情调用面板：清除网页 NPC 预览动画，恢复当前对话 NPC 的默认立绘 */
    _exitNpcCallPreview() {
        if (window.NpcAnim) NpcAnim.clearAll();
        const npc = (window.NpcChat && NpcChat.getCurrentNpc) ? NpcChat.getCurrentNpc() : null;
        if (npc && window.NpcUI) {
            const cfg = (window.AccountInit && AccountInit.getNpcConfig) ? AccountInit.getNpcConfig(npc.id) : {};
            NpcUI.renderPortrait(npc, (cfg && cfg.portrait_url) || '');
            if (window.AccountInit && AccountInit._applyWindowScale) AccountInit._applyWindowScale();
        }
    },

    async _saveNpcCall(npcId) {
        this._syncMethodsFromDom(); this._syncEmotionBindFromDom();
        const st = this._npcCallEdit;
        const body = document.getElementById('npcCallBody');
        const enabledActions = [...body.querySelectorAll('input[data-kind="action"]:checked')].map(i => i.value);
        try {
            await API.put(`/admin/npc-configs/${npcId}`, {
                enabled_emotions: st.enabledEmotions,
                enabled_actions: enabledActions,
                methods: st.methods,
                emotion_methods: st.emotionMethods,
                portrait_url: document.getElementById('npcPortraitInput')?.value || '',
                scale: parseInt(document.getElementById('npcScaleInput')?.value || 80),
            });
            await AccountInit._loadNpcConfigs();
            AccountInit._applyWindowScale();
            const current = (window.NpcChat && NpcChat.getCurrentNpc) ? NpcChat.getCurrentNpc() : null;
            if (current && current.id === npcId) AccountInit._applyNpcPortrait(current);
            Utils.showToast('已保存');
        } catch (e) {
            Utils.showToast('保存失败: ' + (e.message || e), 'error');
        }
    },

    /* ========== 模型管理（仅站长，管理免费海龟汤 AI 模型） ========== */
    async _loadModelAdmin(container) {
        if (!Utils.isOwner()) {
            container.innerHTML = '<div class="loading">仅站长可访问模型管理</div>';
            return;
        }
        container.innerHTML = '<div class="loading">加载中...</div>';
        try {
            const cfg = await API.get('/admin/free-ai-config');
            const providers = ['deepseek', 'volcengine', 'minimax', 'qwen'];
            container.innerHTML = `
            <div class="model-admin-panel">
                <h3>🤖 模型管理 <span style="font-size:12px;color:var(--text-muted);">（仅站长：配置免费海龟汤使用的 AI 模型与密钥）</span></h3>
                <p class="muted" style="font-size:13px;margin-top:6px;">密钥保存在服务器端，前端仅显示掩码；密钥输入框留空则沿用已保存的密钥。</p>
                <div class="setting-group">
                    <label>服务商 Provider</label>
                    <select id="freeAiProvider" class="form-input">
                        ${providers.map(p => `<option value="${p}" ${cfg.provider === p ? 'selected' : ''}>${p}</option>`).join('')}
                    </select>
                </div>
                <div class="setting-group">
                    <label>模型名（火山引擎可填接入点 ID ep-xxx）</label>
                    <input type="text" id="freeAiModel" class="form-input" value="${Utils.escapeHtml(cfg.model || '')}" placeholder="如 deepseek-v4-flash">
                </div>
                <div class="setting-group">
                    <label>API Base URL（可选，留空用默认端点）</label>
                    <input type="text" id="freeAiBaseUrl" class="form-input" value="${Utils.escapeHtml(cfg.base_url || '')}" placeholder="留空使用默认">
                </div>
                <div class="setting-group">
                    <label>API Key（留空不修改）</label>
                    <input type="text" id="freeAiKey" class="form-input" placeholder="${cfg.api_key_masked ? '已保存：' + Utils.escapeHtml(cfg.api_key_masked) : '请输入密钥'}">
                </div>
                <div class="setting-group">
                    <label>免费额度上限（元／每人每天，0 = 不限）</label>
                    <input type="number" min="0" step="0.1" id="freeAiBudget" class="form-input" value="${Number(cfg.budget_rmb != null ? cfg.budget_rmb : 10)}">
                </div>
                <p class="muted" style="font-size:12px;margin-top:-4px;">
                    按真实花费算，不是按次数：每次调用后端会拿上游回的 prompt/completion token 折算成元。
                    今日全站已花 <b>${Number(cfg.today_cost || 0).toFixed(2)} 元</b>。
                    单价（元／百万 token）：缓存未命中 ${Number((cfg.price_per_m||{}).input_miss || 0)} ／ 命中 ${Number((cfg.price_per_m||{}).input_hit || 0)} ／ 输出 ${Number((cfg.price_per_m||{}).output || 0)}。
                    换模型记得改单价，否则算出来的花费只是看着像。
                </p>
                <button class="btn btn-primary" onclick="AdminPanel._saveModelAdmin()">💾 保存配置</button>
            </div>`;
        } catch (e) {
            container.innerHTML = `<div class="loading">加载失败: ${e.message}</div>`;
        }
    },

    async _saveModelAdmin() {
        try {
            await API.put('/admin/free-ai-config', {
                provider: document.getElementById('freeAiProvider')?.value || 'deepseek',
                model: document.getElementById('freeAiModel')?.value || '',
                base_url: document.getElementById('freeAiBaseUrl')?.value || '',
                api_key: document.getElementById('freeAiKey')?.value || '',
                budget_rmb: Number(document.getElementById('freeAiBudget')?.value || 0),
            });
            Utils.showToast('模型配置已保存');
        } catch (e) {
            Utils.showToast(e.message, 'error');
        }
    },

    /* ========== 免费体验活动（仅站长） ========== */
    async _loadFreeTrial(container) {
        if (!Utils.isOwner()) {
            container.innerHTML = '<div class="loading">仅站长可配置免费活动</div>';
            return;
        }
        container.innerHTML = '<div class="loading">加载中...</div>';
        try {
            const cfg = await API.get('/admin/free-trial-config');
            container.innerHTML = `
            <div class="model-admin-panel">
                <h3>🎁 免费体验活动 <span style="font-size:12px;color:var(--text-muted);">（仅站长：控制游客/账号免费体验额度）</span></h3>
                <p class="muted" style="font-size:13px;margin-top:6px;">活动可随时手动关闭，也可设置起止时间定时关闭。游客按 IP 计次，登录账号可设为无限次。</p>
                <div class="setting-group">
                    <label class="call-item"><input type="checkbox" id="ftEnabled" ${cfg.enabled ? 'checked' : ''}><span>启用免费活动</span></label>
                </div>
                <div class="setting-group">
                    <label>游客免费次数（未登录，按 IP 计）</label>
                    <input type="number" id="ftIpLimit" class="form-input" min="0" value="${cfg.ip_limit}">
                </div>
                <div class="setting-group">
                    <label class="call-item"><input type="checkbox" id="ftUserUnlimited" ${cfg.user_unlimited ? 'checked' : ''}
                        onchange="document.getElementById('ftUserLimit').disabled=this.checked"><span>登录账号免费无限次</span></label>
                </div>
                <div class="setting-group">
                    <label>账号免费次数（取消「无限」时生效）</label>
                    <input type="number" id="ftUserLimit" class="form-input" min="0" value="${cfg.user_limit}" ${cfg.user_unlimited ? 'disabled' : ''}>
                </div>
                <div class="setting-group" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                    <div><label>定时开始（留空=立即）</label><input type="datetime-local" id="ftStart" class="form-input" value="${this._toLocalInput(cfg.start_at)}"></div>
                    <div><label>定时结束（留空=不限）</label><input type="datetime-local" id="ftEnd" class="form-input" value="${this._toLocalInput(cfg.end_at)}"></div>
                </div>
                <button class="btn btn-primary" onclick="AdminPanel._saveFreeTrial()">💾 保存活动配置</button>
            </div>`;
        } catch (e) {
            container.innerHTML = `<div class="loading">加载失败: ${e.message}</div>`;
        }
    },

    /** 后端 ISO 时间 → datetime-local 本地值 */
    _toLocalInput(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    },

    async _saveFreeTrial() {
        try {
            const startVal = document.getElementById('ftStart')?.value || '';
            const endVal = document.getElementById('ftEnd')?.value || '';
            await API.put('/admin/free-trial-config', {
                enabled: document.getElementById('ftEnabled')?.checked,
                ip_limit: parseInt(document.getElementById('ftIpLimit')?.value || 0, 10),
                user_unlimited: document.getElementById('ftUserUnlimited')?.checked,
                user_limit: parseInt(document.getElementById('ftUserLimit')?.value || 0, 10),
                start_at: startVal ? new Date(startVal).toISOString() : '',
                end_at: endVal ? new Date(endVal).toISOString() : '',
            });
            Utils.showToast('免费活动配置已保存');
        } catch (e) {
            Utils.showToast(e.message, 'error');
        }
    },

    /* ========== 首页轮播海报（管理员/站长） ========== */
    async _loadBanners(container) {
        if (!Utils.isAdmin()) {
            container.innerHTML = '<div class="loading">需要管理员权限</div>';
            return;
        }
        container.innerHTML = '<div class="loading">加载中...</div>';
        try {
            this._bannerCfg = await API.get('/admin/banners');
            this._renderBannerEditor(container);
        } catch (e) {
            container.innerHTML = `<div class="loading">加载失败: ${e.message}</div>`;
        }
    },

    _renderBannerEditor(container) {
        const cfg = this._bannerCfg || { enabled: true, interval: 4000, banners: [] };
        const banners = Array.isArray(cfg.banners) ? cfg.banners : [];
        const rows = banners.map((b, i) => this._bannerRow(i, b)).join('');
        container.innerHTML = `
        <div class="model-admin-panel">
            <h3>🖼 首页轮播海报 <span style="font-size:12px;color:var(--text-muted);">（管理员/站长：海报池为空时不展示）</span></h3>
            <p class="muted" style="font-size:13px;margin-top:6px;">海报展示在侧边栏「首页」顶部，自动轮播，点击跳转对应链接。图片可本地上传或填写外链 URL。</p>
            <div class="setting-group" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;">
                <label class="call-item"><input type="checkbox" id="bnEnabled" ${cfg.enabled ? 'checked' : ''}><span>启用海报模块</span></label>
                <label style="font-size:13px;">轮播间隔
                    <input type="number" id="bnInterval" class="form-input" style="width:90px;display:inline-block;margin:0 0 0 6px;"
                        min="1.5" step="0.5" value="${cfg.interval / 1000}"> 秒</label>
            </div>
            <div id="bannerRows">${rows}</div>
            <div style="display:flex;gap:10px;margin-top:12px;">
                <button class="btn btn-outline" onclick="AdminPanel._addBannerRow()">＋ 新增海报</button>
                <button class="btn btn-primary" onclick="AdminPanel._saveBanners()">💾 保存海报配置</button>
            </div>
        </div>`;
    },

    _bannerRow(i, b = {}) {
        return `
        <div class="banner-row" style="background:var(--bg-card,#1e1e2e);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <strong style="font-size:13px;">海报 ${i + 1}</strong>
                <button class="btn btn-sm" onclick="this.closest('.banner-row').remove()">✕ 删除</button>
            </div>
            <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end;">
                <div>
                    <label style="font-size:12px;color:var(--text-secondary);">图片 URL</label>
                    <input class="bn-image form-input" placeholder="https://... 或点右侧上传后自动填入" value="${Utils.escapeHtml(b.image || '')}">
                </div>
                <div>
                    <button class="btn btn-outline btn-sm" onclick="AdminPanel._pickBannerFile(${i})">📤 上传</button>
                    <input type="file" id="bnFile${i}" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none;"
                        onchange="AdminPanel._uploadBannerFile(${i}, this)">
                </div>
            </div>
            <label style="font-size:12px;color:var(--text-secondary);display:block;margin-top:8px;">跳转链接</label>
            <input class="bn-link form-input" placeholder="https://...（可留空，留空则点击不跳转）" value="${Utils.escapeHtml(b.link || '')}">
            <label style="font-size:12px;color:var(--text-secondary);display:block;margin-top:8px;">标题（可选）</label>
            <input class="bn-title form-input" placeholder="活动标题" value="${Utils.escapeHtml(b.title || '')}">
        </div>`;
    },

    _pickBannerFile(i) {
        document.getElementById('bnFile' + i)?.click();
    },

    async _uploadBannerFile(i, input) {
        const file = input.files && input.files[0];
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        try {
            const res = await API.upload('/admin/upload-banner', fd);
            const imgInput = input.closest('.banner-row')?.querySelector('.bn-image');
            if (imgInput) imgInput.value = res.url || '';
            Utils.showToast('图片已上传');
        } catch (e) {
            Utils.showToast('上传失败: ' + (e.message || e), 'error');
        }
    },

    _addBannerRow() {
        const wrap = document.getElementById('bannerRows');
        if (!wrap) return;
        const idx = wrap.querySelectorAll('.banner-row').length;
        wrap.insertAdjacentHTML('beforeend', this._bannerRow(idx));
    },

    async _saveBanners() {
        const banners = [];
        document.querySelectorAll('#bannerRows .banner-row').forEach((row) => {
            const image = row.querySelector('.bn-image')?.value || '';
            const link = row.querySelector('.bn-link')?.value || '';
            const title = row.querySelector('.bn-title')?.value || '';
            if (image.trim()) banners.push({ image: image.trim(), link: link.trim(), title: title.trim() });
        });
        try {
            await API.put('/admin/banners', {
                enabled: document.getElementById('bnEnabled')?.checked,
                interval: Math.round(parseFloat(document.getElementById('bnInterval')?.value || 4) * 1000),
                banners,
            });
            Utils.showToast('轮播海报已保存');
        } catch (e) {
            Utils.showToast(e.message, 'error');
        }
    },

    /** 保存单个提示词到文件 */
    async _saveNpcPromptFile(npcId, pid, promptType, cat = '') {
        // 关键：以 npcId==='shared' 判定共享/私有，而不是按 pid 真值。
        // 茶馆 NPC 的 personality_id 为空字符串（pid=''），若按 pid 判定会把私有提示词误当成 shared，
        // 去取 prompt_shared__X 这个不存在的编辑框而静默保存失败（soul 等无 shared 同名文件的提示词）。
        const elId = (npcId === 'shared')
            ? `prompt_shared__${promptType}${cat ? '_' + cat : ''}`
            : `prompt_${pid}_${promptType}`;
        const el = document.getElementById(elId);
        if (!el) {
            Utils.showToast(`保存失败：找不到编辑框 ${elId}`, 'error');
            console.error('[AdminPanel] 保存提示词失败：找不到编辑框', { elId, npcId, pid, promptType, cat });
            return;
        }
        try {
            // 共享 game_mode 必须带上 category，否则会写错文件 / 覆盖其它类型（#8 修复）
            await API.put(`/admin/npc-configs/${npcId}/prompts/${promptType}`, {
                content: el.value,
                category: cat || '',
            });
            Utils.showToast(`提示词 ${promptType}${cat ? ' (' + cat + ')' : ''} 已保存`);
            // 保存后立即刷新 NPC 提示词缓存，让对话马上采用最新内容（无需切换账号/刷新页面）
            if (window.NpcChat && NpcChat.refreshPrompt) NpcChat.refreshPrompt();
        } catch (e) {
            Utils.showToast(e.message, 'error');
        }
    },

    /* ========== 离线引导结构化编辑 ========== */
    /** 渲染离线引导编辑器：opening + fallback + rules（关键词/回复/高亮，可增删） */
    _offlineGuideEditor(content) {
        let cfg = { opening: '', fallback: [], rules: [] };
        try { cfg = JSON.parse(content || '{}'); } catch (e) { /* 非法 JSON 按空处理 */ }
        const opening = cfg.opening || '';
        const fallback = (Array.isArray(cfg.fallback) ? cfg.fallback : []).join('\n');
        const rules = (Array.isArray(cfg.rules) ? cfg.rules : []);
        const rulesHtml = rules.map((r, i) => this._offlineRuleRow(i, r)).join('');

        return `
            <div class="prompt-editor-block" style="margin-bottom:16px;background:var(--card-bg,#1e1e2e);border:1px solid var(--border-color);border-radius:10px;padding:14px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <strong style="font-size:13px;color:var(--text-primary);">shared/offline_guide（离线引导 · 结构化编辑）</strong>
                    <button class="btn btn-sm btn-primary" onclick="AdminPanel._saveOfflineGuide()">💾 保存</button>
                </div>
                <p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px;">无 API 无账号时的本地关键词引导。规则按顺序匹配，命中即返回；回复留空表示动态分流（如设置/API 引导）。</p>
                <label style="font-size:12px;color:var(--text-secondary);display:block;margin:8px 0 4px;">开场白 opening</label>
                <textarea id="og_opening" class="form-input" rows="3" spellcheck="false">${Utils.escapeHtml(opening)}</textarea>
                <label style="font-size:12px;color:var(--text-secondary);display:block;margin:8px 0 4px;">兜底回复 fallback（每行一条，命中不了规则时轮换）</label>
                <textarea id="og_fallback" class="form-input" rows="4" spellcheck="false">${Utils.escapeHtml(fallback)}</textarea>
                <label style="font-size:12px;color:var(--text-secondary);display:block;margin:8px 0 4px;">关键词规则 rules（先匹配的优先）</label>
                <div id="og_rules">${rulesHtml}</div>
                <button class="btn btn-sm" onclick="AdminPanel._addOfflineRule()">＋ 新增规则</button>
            </div>`;
    },

    /** 单条离线规则行 */
    _offlineRuleRow(i, r = {}) {
        return `
            <div class="og-rule" style="display:grid;grid-template-columns:1fr 2fr 0.7fr auto;gap:6px;margin-bottom:8px;align-items:start;">
                <input class="og-keys form-input" placeholder="关键词，逗号分隔" value="${Utils.escapeHtml((r.keys || []).join(','))}" style="font-size:12px;">
                <textarea class="og-reply form-input" rows="2" placeholder="回复内容（留空=动态分流）" style="font-size:12px;">${Utils.escapeHtml(r.reply || '')}</textarea>
                <input class="og-hl form-input" placeholder="高亮(可选)" value="${Utils.escapeHtml(r.highlight || '')}" style="font-size:12px;">
                <button class="btn btn-sm" onclick="this.closest('.og-rule').remove()">✕</button>
            </div>`;
    },

    /** 新增一条空规则行 */
    _addOfflineRule() {
        const wrap = document.getElementById('og_rules');
        if (wrap) {
            const idx = wrap.querySelectorAll('.og-rule').length;
            wrap.insertAdjacentHTML('beforeend', this._offlineRuleRow(idx));
        }
    },

    /** 读取表单组装 JSON，写回 offline_guide.txt */
    async _saveOfflineGuide() {
        const opening = (document.getElementById('og_opening')?.value || '').trim();
        const fallback = (document.getElementById('og_fallback')?.value || '')
            .split('\n').map(s => s.trim()).filter(Boolean);
        const rules = [];
        document.querySelectorAll('#og_rules .og-rule').forEach(row => {
            const keys = (row.querySelector('.og-keys')?.value || '')
                .split(/[,，]/).map(s => s.trim()).filter(Boolean);
            const reply = (row.querySelector('.og-reply')?.value || '').trim();
            const highlight = (row.querySelector('.og-hl')?.value || '').trim();
            if (keys.length) rules.push({ keys, reply: reply || null, highlight: highlight || null });
        });
        const content = JSON.stringify({ opening, fallback, rules }, null, 2);
        try {
            await API.put('/admin/npc-configs/shared/prompts/offline_guide', { content, category: '' });
            Utils.showToast('离线引导已保存');
            if (window.OfflineNpc && OfflineNpc.reload) OfflineNpc.reload();
            if (window.NpcChat && NpcChat.refreshPrompt) NpcChat.refreshPrompt();
        } catch (e) {
            Utils.showToast(e.message, 'error');
        }
    },

    /* ========== 公告管理（列表 / 发布 / 编辑 / 软删除） ========== */
    //
    // 后端能力（backend/routers/admin.py + services/site_service.py，均需管理员）：
    //   POST   /api/admin/announcements        {title, content, is_pinned}
    //   PUT    /api/admin/announcements/{id}   {title?, content?, is_pinned?}
    //   DELETE /api/admin/announcements/{id}   软删除（is_deleted=True + deleted_at）
    // 列表读公开的 GET /api/announcements?page=1（置顶优先、已排除删除）；
    // 已删除的那部分从 GET /api/admin/deleted/items 取（回收站本来就走这条），一起显示。
    //
    // 两点如实说清，不假装有：
    //   1) schema 只有 title / content / is_pinned 三个字段，**没有「是否发布/可见」**这一维。
    //      公告写进去就是公开可见的，所以表单里不摆一个关不掉任何东西的开关。
    //   2) **没有恢复接口**：软删之后只能由运维直接改库。删除按钮旁边把这句写出来。
    _annFormOpen: false,   // 表单是否展开
    _annEditing: null,     // null=新建；对象=正在编辑的公告
    _annList: [],          // 最近一次拉到的在线公告（编辑按钮按 id 回查用）

    async _loadAnnouncements(container) {
        if (!Utils.isAdmin()) {
            container.innerHTML = '<div class="loading">需要管理员权限</div>';
            return;
        }
        this._annFormOpen = false;
        this._annEditing = null;
        container.innerHTML = `
        <div class="model-admin-panel">
            <h3>📢 公告管理 <span style="font-size:12px;color:var(--text-muted);">（发布 / 编辑 / 软删除）</span></h3>
            <p class="muted" style="font-size:13px;margin-top:6px;">
                公告发布后对全站可见，置顶的排在最前。删除是<b>软删除</b>（记录进「🗑 回收站」），
                <b>后端没有恢复接口</b>——要恢复只能由运维直接改库，删之前看清楚。
            </p>
            <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
                <button class="btn btn-primary" onclick="AdminPanel._openAnnForm()">＋ 新建公告</button>
                <button class="btn btn-outline" onclick="AdminPanel._reloadAnnList()">↻ 刷新列表</button>
            </div>
            <div id="adminAnnForm"></div>
            <div id="adminAnnList" style="margin-top:12px;"><div class="loading">加载中...</div></div>
        </div>`;
        this._renderAnnForm();
        await this._reloadAnnList();
    },

    /** 打开表单：传公告对象=编辑，不传=新建 */
    _openAnnForm(ann) {
        this._annEditing = ann || null;
        this._annFormOpen = true;
        this._renderAnnForm();
        const el = document.getElementById('adminAnnTitle');
        if (el && el.focus) el.focus();
    },

    _closeAnnForm() {
        this._annFormOpen = false;
        this._annEditing = null;
        this._renderAnnForm();
    },

    /** 编辑按钮只传 id：避免把整条公告 JSON 塞进 onclick 属性里（引号一多就炸） */
    _editAnnById(id) {
        const ann = (this._annList || []).find(a => a.id === id);
        if (ann) this._openAnnForm(ann);
    },

    _renderAnnForm() {
        const box = document.getElementById('adminAnnForm');
        if (!box) return;
        if (!this._annFormOpen) { box.innerHTML = ''; return; }
        const a = this._annEditing || {};
        const editing = !!a.id;
        // textarea 里也用 escapeHtml：实体在 textarea 里会自动解回原文，不会丢换行
        box.innerHTML = `
        <div class="banner-row" style="background:var(--bg-card,#1e1e2e);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <strong style="font-size:13px;">${editing ? '✎ 编辑公告' : '＋ 新建公告'}</strong>
                <button class="btn btn-sm" onclick="AdminPanel._closeAnnForm()">✕ 取消</button>
            </div>
            <label style="font-size:12px;color:var(--text-secondary);">标题（必填，≤200 字）</label>
            <input id="adminAnnTitle" class="form-input" maxlength="200" placeholder="公告标题"
                value="${Utils.escapeHtml(a.title || '')}">
            <label style="font-size:12px;color:var(--text-secondary);display:block;margin-top:8px;">正文（必填，≤10000 字，换行会保留）</label>
            <textarea id="adminAnnContent" class="form-input" rows="8" maxlength="10000"
                placeholder="公告内容">${Utils.escapeHtml(a.content || '')}</textarea>
            <label class="call-item" style="margin-top:8px;">
                <input type="checkbox" id="adminAnnPinned" ${a.is_pinned ? 'checked' : ''}><span>置顶</span>
            </label>
            <div style="margin-top:10px;">
                <button class="btn btn-primary" onclick="AdminPanel._saveAnn()">💾 ${editing ? '保存修改' : '发布公告'}</button>
            </div>
        </div>`;
    },

    async _saveAnn() {
        const title = (document.getElementById('adminAnnTitle')?.value || '').trim();
        const content = (document.getElementById('adminAnnContent')?.value || '').trim();
        const isPinned = !!document.getElementById('adminAnnPinned')?.checked;
        // 先按后端 schema 的长度限制在本页拦一次：省掉一趟必然 422 的请求，也让人看得见原因
        if (!title) return Utils.showToast('标题不能为空', 'error');
        if (title.length > 200) return Utils.showToast('标题超过 200 字', 'error');
        if (!content) return Utils.showToast('正文不能为空', 'error');
        if (content.length > 10000) return Utils.showToast('正文超过 10000 字', 'error');
        const editingId = this._annEditing && this._annEditing.id;
        try {
            if (editingId) {
                await API.put('/admin/announcements/' + encodeURIComponent(editingId),
                    { title, content, is_pinned: isPinned });
                Utils.showToast('公告已更新');
            } else {
                await API.post('/admin/announcements', { title, content, is_pinned: isPinned });
                Utils.showToast('公告已发布');
            }
        } catch (e) {
            // 失败要说清是哪一步失败：静默 return 会让人以为已经存上了
            return Utils.showToast('保存失败：' + (e.message || e), 'error');
        }
        this._annFormOpen = false;
        this._annEditing = null;
        this._renderAnnForm();
        await this._reloadAnnList();
    },

    async _deleteAnn(id, title) {
        const ask = window.UIModule && UIModule.confirm
            ? await UIModule.confirm(`确定删除公告「${title || id}」吗？软删除后没有恢复接口。`, { title: '删除公告', okText: '删除' })
            : window.confirm(`确定删除公告「${title || id}」吗？`);
        if (!ask) return;
        try {
            await API.delete('/admin/announcements/' + encodeURIComponent(id));
            Utils.showToast('公告已删除');
            await this._reloadAnnList();
        } catch (e) {
            Utils.showToast('删除失败：' + (e.message || e), 'error');
        }
    },

    async _reloadAnnList() {
        const box = document.getElementById('adminAnnList');
        if (!box) return;
        box.innerHTML = '<div class="loading">加载中...</div>';
        let live = [], dead = [];
        try {
            const data = await API.get('/announcements?page=1');
            live = (data && data.announcements) || [];
        } catch (e) {
            box.innerHTML = `<div class="loading">加载失败: ${Utils.escapeHtml(e.message || '')}</div>`;
            return;
        }
        try {
            const del = await API.get('/admin/deleted/items');
            dead = (del && del.announcements) || [];
        } catch (e) {
            // 回收站取不到不影响在线列表（某些部署下这条接口权限更严）
        }
        this._annList = live;
        if (!live.length && !dead.length) {
            box.innerHTML = '<div class="empty-state">还没有公告，点上面「＋ 新建公告」发第一条</div>';
            return;
        }
        const rowHtml = (a, isDead) => `
            <div class="banner-row" style="background:var(--bg-card,#1e1e2e);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:10px;">
                <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap;">
                    <strong style="font-size:13px;">${a.is_pinned ? '📌 ' : ''}${Utils.escapeHtml(a.title || '（无标题）')}
                        ${isDead ? '<span style="font-size:12px;color:var(--text-muted);">🗑 已删除</span>' : ''}</strong>
                    <span class="muted" style="font-size:12px;">${Utils.escapeHtml(String(a.created_at || ''))}</span>
                </div>
                <div style="font-size:13px;margin-top:6px;color:var(--text-secondary);white-space:pre-wrap;">${Utils.escapeHtml(String(a.content || '').slice(0, 300))}</div>
                <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;">
                    ${isDead
                        ? '<span class="muted" style="font-size:12px;">软删除不可恢复（后端没有恢复接口）</span>'
                        : `<button class="btn btn-outline btn-sm" onclick="AdminPanel._editAnnById('${Utils.escapeHtml(String(a.id || ''))}')">✎ 编辑</button>
                           <button class="btn btn-sm" onclick="AdminPanel._deleteAnn('${Utils.escapeHtml(String(a.id || ''))}', '${Utils.escapeHtml(String(a.title || '').replace(/'/g, ''))}')">🗑 删除</button>`}
                    <span class="muted" style="font-size:12px;">作者：${Utils.escapeHtml(String(a.author || '—'))}</span>
                </div>
            </div>`;
        box.innerHTML = live.map(a => rowHtml(a, false)).join('')
            + (dead.length ? `<h4 style="margin:16px 0 0;font-size:13px;">🗑 已删除（回收站）</h4>` + dead.map(a => rowHtml(a, true)).join('') : '');
    },

    /* ========== 站点设置（可视化编辑器） ========== */
    //
    // 读写接口：GET /api/admin/site-settings（后端经 _public_setting_value 剔除密钥字段）、
    //           PUT /api/admin/site-settings/{key} body {"value": <对象|数组|字符串>}（需管理员）
    //
    // 三条必须守住的边界：
    //   1) free_ai_config 的 api_key **不在这条 GET 的返回里**（字段被整条删掉，不是打码）。
    //      拿 GET 的结果去 PUT 它 = 把整条配置覆盖成没有密钥的版本，密钥当场丢。
    //      所以这一项在本页只给指路（去「🤖 模型管理」），不给保存按钮。
    //   2) 兜底再判一次：值里出现 **** 打码或 api_key_masked 字段，本次保存直接拒绝——
    //      打码值不是真值，写回去等于毁掉密钥。
    //   3) 后端 body 类型是 dict|list|str，裸数字/布尔会被 422 挡回；而这套设置里本来也没有
    //      独立的开关型键（开关都长在结构里，如 home_banners.enabled），所以只按「列表」和
    //      「JSON 结构」两类渲染，不给不存在的类型造控件。
    // 另外：一个键一张卡、各有各的保存按钮，避免「改了三处、点一次保存、错一处全废」。
    _siteSettings: null,

    _SITE_SETTING_SPEC: {
        visible_categories: {
            label: '可见分类', type: 'list', optionsKey: 'categories',
            hint: '首页分类栏读它（app.js 写入 STATE.visibleCategories）。清空 = 前端一个分类都拿不到。',
        },
        visible_npcs: {
            label: '可见 NPC', type: 'list',
            hint: '预留项：当前前后端都没有代码读它，改了不会有效果（本意是控制哪些 NPC 露出来）。',
        },
        hidden_scripts: {
            label: '隐藏剧本 id', type: 'list',
            hint: '预留项：当前没有代码读它，改了不会有效果（本意是在列表里藏掉指定剧本）。',
        },
        edge_tts_voice_map: {
            label: '音色别名 → edge 音色 id', type: 'json', expect: 'object',
            hint: '预留项：聊天用的是设置里直选的 voiceId，没有读这张别名表（将来做「音色风格」下拉时才用得上）。',
        },
        npc_layout: {
            label: 'NPC 默认布局', type: 'json', expect: 'object',
            hint: '预留项：桌宠位置与尺寸（right/top 单位 vh、size 百分比、frame_w/frame_h 像素）。',
        },
        npc_layouts: {
            label: 'NPC 独立布局覆盖', type: 'json', expect: 'object',
            hint: '预留项：按 NPC id 覆盖 npc_layout；默认 {} 表示全部走默认布局。',
        },
        desk_layout: {
            label: '桌面高度', type: 'json', expect: 'object',
            hint: '预留项：{height_vh} 是桌面占视口高度的百分比。',
        },
        bgm_config: {
            label: 'BGM 背景音乐', type: 'json', expect: 'object',
            hint: '真在用：bgm.js 读 files（曲目列表）/ base_url / default_volume（0-100）/ scenes（场景 → BGM id）。',
        },
        home_banners: {
            label: '首页轮播海报', type: 'link', target: 'banners', targetLabel: '🖼 轮播海报',
            hint: '已有独立 tab（接口 /admin/banners）：启停、轮播间隔、增删海报、上传图片都在那里。',
        },
        free_trial_config: {
            label: '免费体验活动', type: 'link', target: 'free-trial', targetLabel: '🎁 免费活动',
            hint: '已有独立 tab（接口 /admin/free-trial-config，仅站长）：开关、IP/账号额度、起止时间。',
        },
        free_ai_config: {
            label: '免费海龟汤 AI（含密钥）', type: 'locked',
            hint: '这一页不能写：GET 返回里 api_key 已被后端整条剔除，通用保存会把密钥抹掉。请去「🤖 模型管理」。',
        },
        free_trial_quota: {
            label: '免费额度用量计数', type: 'locked',
            hint: '运行时计数（每个 IP / 账号已用几次），由调用自动累加；手改只会把额度算错。',
        },
        free_trial_usage: {
            label: '免费 AI token 统计', type: 'locked',
            hint: '免费通道累计 token 消耗与调用次数，自动累加。',
        },
        npc_personality_configs: {
            label: 'NPC 立绘配置（DB 兜底副本）', type: 'locked',
            hint: '以文件系统 npc_configs/ 为准，DB 里这份只是兜底，改它不生效。请用「🎭 立绘表情调用」。',
        },
    },

    async _loadSiteSettings(container) {
        if (!Utils.isAdmin()) {
            container.innerHTML = '<div class="loading">需要管理员权限</div>';
            return;
        }
        container.innerHTML = `
        <div class="model-admin-panel">
            <h3>⚙️ 站点设置 <span style="font-size:12px;color:var(--text-muted);">（逐项可视化编辑）</span></h3>
            <p class="muted" style="font-size:13px;margin-top:6px;">
                每张卡单独保存。库里还没存过的键，这里显示的是后端默认值，保存一次才落库。
                已有独立 tab 的项（轮播海报、免费活动）这里只给入口，不重复做第二套编辑。
            </p>
            <div id="adminSiteSettings" style="margin-top:12px;"><div class="loading">加载中...</div></div>
        </div>`;
        await this._reloadSiteSettings();
    },

    async _reloadSiteSettings() {
        const box = document.getElementById('adminSiteSettings');
        if (!box) return;
        box.innerHTML = '<div class="loading">加载中...</div>';
        try {
            this._siteSettings = (await API.get('/admin/site-settings')) || {};
        } catch (e) {
            box.innerHTML = `<div class="loading">加载失败: ${Utils.escapeHtml(e.message || '')}</div>`;
            return;
        }
        const keys = this._siteCardOrder(Object.keys(this._siteSettings));
        if (!keys.length) { box.innerHTML = '<div class="empty-state">没有可显示的设置项</div>'; return; }
        box.innerHTML = keys.map(k => this._siteCard(k, this._siteSettings[k])).join('');
    },

    /** 排序：可编辑（列表 → JSON）→ 未登记的键 → 另有入口 → 只读，改起来顺手的排前面 */
    _siteCardOrder(keys) {
        const rank = (k) => {
            const t = (this._SITE_SETTING_SPEC[k] || {}).type;
            if (t === 'list') return 0;
            if (t === 'json') return 1;
            if (t === undefined) return 2;
            if (t === 'link') return 3;
            return 4;
        };
        return keys.slice().sort((a, b) => rank(a) - rank(b));
    },

    _siteCard(key, value) {
        const spec = this._SITE_SETTING_SPEC[key] || {
            label: key, type: 'json', expect: 'object',
            hint: '未登记的键（后端新加、前端还没登记）：按 JSON 编辑，保存前会校验语法。',
        };
        const badge = { list: '列表', json: 'JSON', link: '另有入口', locked: '只读' }[spec.type] || 'JSON';
        let body = '';
        if (spec.type === 'list') {
            const arr = Array.isArray(value) ? value : [];
            const options = spec.optionsKey === 'categories'
                ? Object.keys((window.CONFIG && CONFIG.CATEGORY_NAMES) || {})
                    .map(id => ({ id, label: CONFIG.CATEGORY_NAMES[id] }))
                : [];
            const optsHtml = options.length ? `
                <div class="muted" style="font-size:12px;margin-top:8px;">已知可选值（点一下直接加）：</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
                    ${options.map(o => `<button class="btn btn-sm btn-outline"
                        onclick="AdminPanel._siteAddChip('${key}','${Utils.escapeHtml(o.id)}')">${Utils.escapeHtml(o.label)}</button>`).join('')}
                </div>` : '';
            body = `
                <div id="siteChips_${key}" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
                    ${arr.map(v => this._siteChipHtml(String(v))).join('')}
                </div>
                <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;">
                    <input id="siteListInput_${key}" class="form-input" style="max-width:280px;" placeholder="输入一个值，回车或点＋添加"
                        onkeydown="if(event.key==='Enter'){event.preventDefault();AdminPanel._siteAddChip('${key}')}">
                    <button class="btn btn-outline btn-sm" onclick="AdminPanel._siteAddChip('${key}')">＋ 添加</button>
                </div>${optsHtml}`;
        } else if (spec.type === 'json') {
            const text = typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value, null, 2);
            body = `
                <textarea id="siteJson_${key}" class="form-input" rows="8" spellcheck="false"
                    style="margin-top:8px;font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre;">${Utils.escapeHtml(text || '')}</textarea>`;
        } else if (spec.type === 'link') {
            body = `
                <div style="margin-top:8px;">
                    <button class="btn btn-outline btn-sm" onclick="AdminPanel.switchTab('${spec.target}')">→ 去「${Utils.escapeHtml(spec.targetLabel || spec.target)}」改</button>
                </div>`;
        } else {
            body = `<pre class="muted" style="margin:8px 0 0;white-space:pre-wrap;word-break:break-all;font-size:12px;">${Utils.escapeHtml(JSON.stringify(value === undefined ? null : value, null, 2) || '')}</pre>`;
        }
        const actions = (spec.type === 'list' || spec.type === 'json') ? `
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
                <button class="btn btn-primary btn-sm" onclick="AdminPanel._saveSiteSetting('${key}')">💾 保存这一项</button>
                ${spec.type === 'json' ? `<button class="btn btn-outline btn-sm" onclick="AdminPanel._formatSiteJson('${key}')">校验 / 格式化</button>` : ''}
                <button class="btn btn-sm" onclick="AdminPanel._reloadSiteSettings()">↻ 放弃改动并重载</button>
            </div>` : '';
        return `
        <div class="banner-row" id="siteCard_${key}" style="background:var(--bg-card,#1e1e2e);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:12px;">
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap;">
                <strong style="font-size:13px;">${Utils.escapeHtml(spec.label || key)}</strong>
                <span class="muted" style="font-size:12px;"><code>${Utils.escapeHtml(key)}</code> · ${badge}</span>
            </div>
            <div class="muted" style="font-size:12px;margin-top:4px;">${spec.hint}</div>
            ${body}${actions}
        </div>`;
    },

    _siteChipHtml(v) {
        const safe = Utils.escapeHtml(String(v));
        return `<span class="site-chip" data-value="${safe}"
            style="display:inline-flex;align-items:center;gap:6px;background:var(--bg-input,#2a2a3a);border:1px solid var(--border);border-radius:14px;padding:3px 8px;font-size:12px;">
            ${safe}<a href="javascript:void(0)" onclick="this.parentNode.remove()"
                style="color:var(--text-muted);text-decoration:none;">✕</a></span>`;
    },

    /** 加一个列表值：带 value=点已知选项，不带 value=读输入框 */
    _siteAddChip(key, value) {
        const wrap = document.getElementById('siteChips_' + key);
        if (!wrap) return;
        let v = value;
        if (v === undefined || v === null) {
            const input = document.getElementById('siteListInput_' + key);
            v = input ? input.value.trim() : '';
            if (input) input.value = '';
        }
        v = String(v || '').trim();
        if (!v) return;
        const dup = Array.from(wrap.querySelectorAll('.site-chip'))
            .some(n => (n.getAttribute('data-value') || '') === v);
        if (dup) return Utils.showToast('这个值已经在列表里了', 'error');
        wrap.insertAdjacentHTML('beforeend', this._siteChipHtml(v));
    },

    _siteReadChips(key) {
        const wrap = document.getElementById('siteChips_' + key);
        if (!wrap) return [];
        return Array.from(wrap.querySelectorAll('.site-chip'))
            .map(n => (n.getAttribute('data-value') || '').trim())
            .filter(v => v);
    },

    /** 值里有没有打码痕迹 —— 打码值不是真值，写回去等于毁掉原密钥 */
    _siteHasMask(value) {
        if (typeof value === 'string') return value.indexOf('****') >= 0;
        if (value && typeof value === 'object') {
            return Object.keys(value).some(k => k === 'api_key_masked' || this._siteHasMask(value[k]));
        }
        return false;
    },

    _formatSiteJson(key) {
        const ta = document.getElementById('siteJson_' + key);
        if (!ta) return;
        try {
            const obj = JSON.parse(ta.value || 'null');
            ta.value = JSON.stringify(obj, null, 2);
            Utils.showToast('JSON 语法没问题');
        } catch (e) {
            Utils.showToast('JSON 语法错误：' + e.message, 'error');
        }
    },

    async _saveSiteSetting(key) {
        const spec = this._SITE_SETTING_SPEC[key] || { type: 'json', expect: 'object' };
        let value;
        if (spec.type === 'list') {
            value = this._siteReadChips(key);
        } else if (spec.type === 'json') {
            const ta = document.getElementById('siteJson_' + key);
            try {
                value = JSON.parse(ta ? ta.value : '');
            } catch (e) {
                return Utils.showToast('JSON 语法错误，未保存：' + e.message, 'error');
            }
            // 后端 body 只收 dict|list|str：裸数字、布尔、null 会被 422 挡回来，先在这里讲清楚
            if (value === null || typeof value !== 'object') {
                return Utils.showToast('这一项必须是 JSON 对象 {...} —— 后端只接受对象/数组/字符串', 'error');
            }
            if (spec.expect === 'object' && Array.isArray(value)) {
                return Utils.showToast('这一项必须是 JSON 对象 {...}，不是数组', 'error');
            }
        } else {
            return;   // link / locked 本来就没有保存按钮
        }
        if (this._siteHasMask(value)) {
            return Utils.showToast('值里含 **** 打码（真实密钥不在前端），这一项不能从这里写回，请去对应页面改', 'error');
        }
        try {
            await API.put('/admin/site-settings/' + encodeURIComponent(key), { value });
        } catch (e) {
            return Utils.showToast('保存失败：' + (e.message || e), 'error');
        }
        Utils.showToast('已保存：' + key);
        // 只重画这一张卡：重载整页会把其它卡上还没保存的改动一起冲掉
        try {
            const fresh = (await API.get('/admin/site-settings')) || {};
            this._siteSettings = fresh;
            const card = document.getElementById('siteCard_' + key);
            if (card) card.outerHTML = this._siteCard(key, fresh[key]);
        } catch (e) {
            // 重画失败不影响「已经保存成功」这个事实
        }
    },
    /* ========== 审核 ========== */
    async _loadReview(container) {
        container.innerHTML = `
            <div class="review-tabs" style="margin-bottom:12px;">
                <button class="board-tab" id="panelReviewTabSystem" onclick="AdminPanel._switchReviewTab('system')">站长审核</button>
                <button class="board-tab" id="panelReviewTabReviewed" onclick="AdminPanel._switchReviewTab('reviewed')">已审核</button>
                <button class="board-tab" id="panelReviewTabCommunity" onclick="AdminPanel._switchReviewTab('community')">举报管理</button>
                <button class="board-tab" id="panelReviewTabLogs" onclick="AdminPanel._switchReviewTab('logs')">🛡 审核打回记录</button>
                <button class="board-tab" id="panelReviewTabIssues" onclick="AdminPanel._switchReviewTab('issues')">🐞 问题反馈</button>
            </div>
            <div id="panelReviewContent"></div>`;
        // 支持从统计页「审核打回记录」卡片跳转而来：一次性展开对应子 tab
        const sub = this._reviewSubTab || 'system';
        this._reviewSubTab = null;
        this._switchReviewTab(sub);
    },

    _switchReviewTab(tab) {
        const sys = document.getElementById('panelReviewTabSystem');
        const rwd = document.getElementById('panelReviewTabReviewed');
        const com = document.getElementById('panelReviewTabCommunity');
        const log = document.getElementById('panelReviewTabLogs');
        const issue = document.getElementById('panelReviewTabIssues');
        if (sys) sys.classList.toggle('active', tab === 'system');
        if (rwd) rwd.classList.toggle('active', tab === 'reviewed');
        if (com) com.classList.toggle('active', tab === 'community');
        if (log) log.classList.toggle('active', tab === 'logs');
        if (issue) issue.classList.toggle('active', tab === 'issues');
        this._renderReviewTab(tab);
    },

    async _renderReviewTab(tab) {
        const content = document.getElementById('panelReviewContent');
        if (!content) return;
        if (tab === 'logs') { await this._renderReviewLogs(content); return; }
        if (tab === 'issues') { await this._renderIssueReports(content); return; }
        content.innerHTML = '<div class="loading">加载中...</div>';
        try {
            const urls = {
                system: '/review/queue/system',
                reviewed: '/review/queue/reviewed',
                community: '/review/queue/community',
            };
            const data = await API.get(urls[tab]);
            const items = data.scripts || [];
            if (!items.length) { content.innerHTML = '<div class="empty-state">暂无内容</div>'; return; }
            content.innerHTML = items.map(s => this._reviewItemHtml(s, tab)).join('');
        } catch (e) { content.innerHTML = `<div class="loading">加载失败</div>`; }
    },

    _reviewItemHtml(s, tab) {
        const ai = s.ai_review
            ? `<div class="ai-review-box"><b>🤖 AI初审</b>：${Utils.escapeHtml(s.ai_review.decision)}（风险${s.ai_review.score}） ${s.ai_review.suggestion ? Utils.escapeHtml(s.ai_review.suggestion) : ''}</div>`
            : '';
        let actions;
        if (tab === 'system') {
            actions = `<div class="review-actions">
                   <button class="btn btn-success btn-sm" onclick="AdminPanel._reviewAction('${s.id}','approve')">通过</button>
                   <button class="btn btn-danger btn-sm" onclick="AdminPanel._reviewAction('${s.id}','reject')">驳回</button>
               </div>`;
        } else if (tab === 'community') {
            const reports = (s.reports || []).map(r => `
                <div class="ai-review-box">
                    <b>🚩 举报</b>：${Utils.escapeHtml(r.reason || '（未填写原因）')}（举报人：${Utils.escapeHtml(r.username || '匿名')}）
                    ${r.ai_decision ? `<div style="margin-top:4px;">🤖 AI 判定：${Utils.escapeHtml(r.ai_decision)}${r.ai_score ? `（风险${r.ai_score}）` : ''}${r.ai_suggestion ? ' — ' + Utils.escapeHtml(r.ai_suggestion) : ''}</div>` : ''}
                </div>`).join('');
            const v = (s.votes && s.votes.stat) || { ban: 0, keep: 0, neutral: 0, total: 0 };
            const users = (s.votes && s.votes.users) || { ban: [], keep: [], neutral: [] };
            const voteHtml = `<div class="ai-review-box"><b>🗳 投票</b>：同意封禁 ${v.ban} · 不同意 ${v.keep} · 中立 ${v.neutral}
                <div style="margin-top:4px;font-size:12px;color:var(--text-secondary);">
                    支持：${(users.ban || []).join('、') || '无'} ｜ 反对：${(users.keep || []).join('、') || '无'} ｜ 中立：${(users.neutral || []).join('、') || '无'}
                </div></div>`;
            if (s.flagged) {
                actions = `${reports}${voteHtml}<div class="review-actions">
                       <button class="btn btn-danger btn-sm" onclick="AdminPanel._reportReviewAction('${s.id}','uphold')">采纳举报·封禁</button>
                       <button class="btn btn-success btn-sm" onclick="AdminPanel._reportReviewAction('${s.id}','dismiss')">驳回举报·恢复</button>
                   </div>`;
            } else {
                actions = `${reports}<div class="ai-review-box">⏳ 已 ${s.report_count || 0} 次举报（未达阈值 3 次，暂不下架），等待更多举报后再由站长判决</div>`;
            }
        } else {
            actions = `<div class="review-result ${s.review_status}">${s.review_status === 'approved' ? '✅ 已通过' : '❌ 已驳回'}${s.review_status === 'rejected' && s.review_reason ? `：${Utils.escapeHtml(s.review_reason)}` : ''}</div>`;
        }
        return `
            <div class="review-item">
                <h4>${Utils.escapeHtml(s.title)}</h4>
                <p>${Utils.escapeHtml((s.story || '').substring(0, 200))}...</p>
                ${ai}
                ${actions}
            </div>`;
    },

    async _reviewAction(id, action) {
        try {
            let reason = '';
            if (action === 'reject') {
                reason = await UIModule.prompt('填写不通过原因（可选，将展示给作者）', {
                    title: '驳回作品', placeholder: '不通过原因...', okText: '确认驳回',
                });
                if (reason === null) return; // 用户取消驳回
            }
            await API.post(`/review/${id}/admin-review`, { action, reason });
            Utils.showToast(action === 'approve' ? '已通过' : '已驳回');
            this._renderReviewTab('system');
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    async _reportReviewAction(id, action) {
        try {
            let reason = '';
            if (action === 'uphold') {
                reason = await UIModule.prompt('填写下架原因（可选，将展示给作者）', {
                    title: '采纳举报下架', placeholder: '下架原因...', okText: '确认下架',
                });
                if (reason === null) return; // 用户取消
            }
            await API.post(`/review/${id}/report-review`, { action, reason });
            Utils.showToast(action === 'uphold' ? '已采纳举报并下架' : '已驳回举报并恢复');
            this._renderReviewTab('community');
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    /* ========== 审核打回记录（仅站长，排查审核误伤） ========== */
    async _renderReviewLogs(content) {
        content.innerHTML = '<div class="loading">加载中...</div>';
        try {
            const data = await API.get('/admin/npc-review-logs');
            const logs = data.logs || [];
            if (!logs.length) { content.innerHTML = '<div class="empty-state">暂无审核打回记录</div>'; return; }
            content.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <span style="font-size:13px;color:var(--text-secondary);">共 ${data.total} 条记录（用于排查审核误伤）</span>
                    <button class="btn btn-sm btn-danger" onclick="AdminPanel._clearReviewLogs()">🗑 清空全部</button>
                </div>
                ${logs.map(l => this._reviewLogItemHtml(l)).join('')}`;
        } catch (e) { content.innerHTML = `<div class="loading">加载失败: ${e.message}</div>`; }
    },

    _reviewLogItemHtml(l) {
        return `
            <div class="review-item">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <b>第 ${l.round} 轮驳回 · ${Utils.escapeHtml(l.npc_id || '未知')} · ${Utils.escapeHtml(l.created_at || '')}</b>
                    <button class="btn btn-sm btn-danger" onclick="AdminPanel._deleteReviewLog('${l.id}')">删除</button>
                </div>
                <div class="ai-review-box"><b>🔍 修改建议</b>：${Utils.escapeHtml(l.suggestion || '（无）')}</div>
                <details style="margin-top:6px;">
                    <summary style="cursor:pointer;font-size:12px;color:var(--text-secondary);">对话上下文（点击展开）</summary>
                    <pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.6;margin-top:8px;background:var(--bg-primary);padding:10px;border-radius:8px;color:var(--text-primary);">${Utils.escapeHtml(l.transcript || '（无）')}</pre>
                </details>
                <details style="margin-top:6px;">
                    <summary style="cursor:pointer;font-size:12px;color:var(--text-secondary);">待审回复（点击展开）</summary>
                    <pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.6;margin-top:8px;background:var(--bg-primary);padding:10px;border-radius:8px;color:var(--text-primary);">${Utils.escapeHtml(l.raw_reply || '（无）')}</pre>
                </details>
            </div>`;
    },

    async _deleteReviewLog(id) {
        try {
            await API.delete(`/admin/npc-review-logs/${id}`);
            Utils.showToast('已删除');
            this._renderReviewTab('logs');
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    async _clearReviewLogs() {
        const ok = await UIModule.confirm('确定清空全部审核打回记录吗？', { title: '清空记录', okText: '清空' });
        if (!ok) return;
        try {
            await API.delete('/admin/npc-review-logs');
            Utils.showToast('已清空');
            this._renderReviewTab('logs');
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    /* ========== NPC 问题反馈（仅站长） ========== */
    async _renderIssueReports(content) {
        content.innerHTML = '<div class="loading">加载中...</div>';
        try {
            const data = await API.get('/admin/npc-issue-reports');
            const reports = data.reports || [];
            if (!reports.length) { content.innerHTML = '<div class="empty-state">暂无问题反馈</div>'; return; }
            content.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <span style="font-size:13px;color:var(--text-secondary);">共 ${data.total} 条反馈（NPC 上报问题，用于修复 bug）</span>
                    <button class="btn btn-sm btn-danger" onclick="AdminPanel._clearIssueReports()">🗑 清空全部</button>
                </div>
                ${reports.map(r => this._issueReportItemHtml(r)).join('')}`;
        } catch (e) { content.innerHTML = `<div class="loading">加载失败: ${e.message}</div>`; }
    },

    _issueReportItemHtml(r) {
        const srcLabel = r.source === 'review' ? '审核驳回' : 'NPC 主动上报';
        return `
            <div class="review-item">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <b>${srcLabel} · ${Utils.escapeHtml(r.npc_id || '未知')} · ${Utils.escapeHtml(r.created_at || '')}</b>
                    <button class="btn btn-sm btn-danger" onclick="AdminPanel._deleteIssueReport('${r.id}')">删除</button>
                </div>
                <div class="ai-review-box"><b>🐞 反馈理由</b>：${Utils.escapeHtml(r.reason || '（无）')}</div>
                <details style="margin-top:6px;">
                    <summary style="cursor:pointer;font-size:12px;color:var(--text-secondary);">对话上下文（点击展开）</summary>
                    <pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.6;margin-top:8px;background:var(--bg-primary);padding:10px;border-radius:8px;color:var(--text-primary);">${Utils.escapeHtml(r.transcript || '（无）')}</pre>
                </details>
            </div>`;
    },

    async _deleteIssueReport(id) {
        try {
            await API.delete(`/admin/npc-issue-reports/${id}`);
            Utils.showToast('已删除');
            this._renderReviewTab('issues');
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    async _clearIssueReports() {
        const ok = await UIModule.confirm('确定清空全部问题反馈吗？', { title: '清空反馈', okText: '清空' });
        if (!ok) return;
        try {
            await API.delete('/admin/npc-issue-reports');
            Utils.showToast('已清空');
            this._renderReviewTab('issues');
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    /* ========== AI 对话报错书（仅站长，排查 AI 调用故障） ========== */
    async _renderAiErrorReports(content) {
        content.innerHTML = '<div class="loading">加载中...</div>';
        try {
            const data = await API.get('/admin/ai-error-reports');
            const reports = data.reports || [];
            if (!reports.length) {
                content.innerHTML = '<div class="empty-state">暂无报错书</div>';
                return;
            }
            content.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <span style="font-size:13px;color:var(--text-secondary);">共 ${data.total} 条报错书（AI 调用故障记录）</span>
                    <span>
                        <button class="btn btn-sm" onclick="AdminPanel._showStats()">← 返回统计</button>
                        <button class="btn btn-sm btn-danger" onclick="AdminPanel._clearAiErrorReports()">🗑 清空全部</button>
                    </span>
                </div>
                ${reports.map(r => this._aiErrorReportItemHtml(r)).join('')}`;
        } catch (e) { content.innerHTML = `<div class="loading">加载失败: ${e.message}</div>`; }
    },

    _aiErrorReportItemHtml(r) {
        const typeLabel = {
            empty_content: '空内容', timeout: '超时', network: '网络错误', api_error: 'API 错误',
        }[r.error_type] || (r.error_type || '未知');
        return `
            <div class="review-item">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <b>${typeLabel} · ${Utils.escapeHtml(r.provider || '-')} · ${Utils.escapeHtml(r.model || '-')} · ${Utils.escapeHtml(r.kind || '-')} · ${Utils.escapeHtml(r.created_at || '')}</b>
                    <button class="btn btn-sm btn-danger" onclick="AdminPanel._deleteAiErrorReport('${r.id}')">删除</button>
                </div>
                <div class="ai-review-box"><b>📕 错误信息</b>：${Utils.escapeHtml(r.message || '（无）')}</div>
            </div>`;
    },

    async _deleteAiErrorReport(id) {
        try {
            await API.delete(`/admin/ai-error-reports/${id}`);
            Utils.showToast('已删除');
            this._showAiErrorReports();
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    async _clearAiErrorReports() {
        const ok = await UIModule.confirm('确定清空全部报错书吗？', { title: '清空报错书', okText: '清空' });
        if (!ok) return;
        try {
            await API.delete('/admin/ai-error-reports');
            Utils.showToast('已清空');
            this._showAiErrorReports();
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    /** 返回统计页卡片 */
    _showStats() {
        this.loadTab('stats');
    },

    /* ========== 回收站 ========== */
    async _loadDeleted(container) {
        try {
            const data = await API.get('/admin/deleted/items');
            let html = '<div class="deleted-list">';
            html += '<h4>🗑 已删除的剧本</h4>';
            const scripts = data.scripts || [];
            if (scripts.length === 0) {
                html += '<p class="text-muted">暂无已删除剧本</p>';
            } else {
                html += scripts.map(s => `
                <div class="deleted-item">
                    <strong>${Utils.escapeHtml(s.title || '无标题')}</strong>
                    <span class="text-muted">删除时间：${Utils.formatTime(s.deleted_at)}</span>
                    <span class="text-muted">操作人：${Utils.escapeHtml(s.deleted_by || '?')}</span>
                </div>`).join('');
            }
            html += '<h4 style="margin-top:20px;">📢 已删除的公告</h4>';
            const anns = data.announcements || [];
            if (anns.length === 0) {
                html += '<p class="text-muted">暂无已删除公告</p>';
            } else {
                html += anns.map(a => `
                <div class="deleted-item">
                    <strong>${Utils.escapeHtml(a.title || '无标题')}</strong>
                    <span class="text-muted">删除时间：${Utils.formatTime(a.deleted_at)}</span>
                </div>`).join('');
            }
            html += '</div>';
            container.innerHTML = html;
        } catch (e) { container.innerHTML = `<div class="loading">加载失败</div>`; }
    }
};

window.AdminPanel = AdminPanel;
