/** AI剧本网 - 上传 / 编辑剧本
 *  入口：「我的作品」页顶部「+ 上传剧本」→ navigateForum('upload')（新建）；
 *        作品卡片「✏️」→ navigateForum('upload', scriptId)（编辑模式，回填全部字段）。
 *  海龟汤内容：汤面/汤底 + 胜利/失败条件编辑器（必填）+ 任务条件编辑器（可选）
 *             + 主持指导词（可选，注入 NPC 主持提示词）。
 *
 *  条件编辑器设计：
 *   - 树形结构：结局（名称/备注/类型）→ 条件（名称/规则/次数/是否隐藏），
 *     按行整齐排列体现上下级；桌面端行式网格，移动端媒体查询切换为卡片式纵向排列。
 *   - 【DOM 即数据】：不做模型↔DOM 双向同步，增删直接操作 DOM（避免重渲染丢输入焦点），
 *     提交时 collectEndings()/collectTasks() 从 DOM 收集校验，编辑时 loadEndings()/loadTasks() 回填。
 *   - 结局/条件 id 稳定：编辑时保留原 id（NPC 条件标记 [cond:结局ID.条件ID] / [task:任务ID.条件ID] 引用它），
 *     新增行自动分配空闲 id（e1/e2…、t1/t2…、每个结局/任务内 c1/c2…）。
 *
 *  任务条件：原理与胜利/失败条件一致（NPC 监听并发送计数标记）；任务全部条件达成后
 *   由系统自动执行作者定义的效果：揭示线索 / 给予道具 / 给NPC发消息。
 *
 *  草稿缓存：表单内容变更自动保存到本地（Store，分账号），误关侧边栏后重新打开自动恢复；
 *   提交成功或主动取消（确认放弃）时清除草稿。
 */
const ScriptUpload = {
    /** 已选标签（去重） */
    _tags: [],
    /** 当前选中的剧本类型 */
    _category: 'hai-gui-tang',
    /** 站点已有标签（供选择） */
    _knownTags: [],
    /** 编辑模式：剧本 id（null = 新建） */
    _editId: null,
    /** 结局 id 自增序号（loadEndings 时同步到已有最大值） */
    _eidSeq: 0,
    /** 任务 id 自增序号 */
    _tidSeq: 0,
    /** 草稿防抖计时器 */
    _draftTimer: null,

    /** 任务完成效果类型（与后端 normalize_tasks 的 TASK_EFFECT_TYPES 一致） */
    EFFECT_TYPES: [
        { value: 'reveal_clue', label: '🔎 揭示线索', hint: '任务完成后，把该内容作为线索揭示到玩家的线索面板' },
        { value: 'give_item', label: '🎁 给予道具', hint: '任务完成后，把该内容作为道具放入玩家的道具面板' },
        { value: 'npc_message', label: '📨 给NPC发消息', hint: '任务完成后，把该内容作为系统消息发送给主持人 NPC' },
    ],

    /** 页面渲染入口（由 loadPage 调用；editId 存在时为编辑模式） */
    async render(container, editId) {
        this._tags = [];
        this._category = 'hai-gui-tang';
        this._editId = null;
        this._eidSeq = 0;
        this._tidSeq = 0;
        this._container = container;

        // 编辑模式：拉取完整剧本（作者/管理员经权限门控可见汤底与条件表）
        let editData = null;
        if (editId) {
            try {
                const d = await ScriptAPI.detail(editId);
                if (d && d.id) editData = d;
            } catch (e) {
                Utils.showToast('加载剧本失败：' + e.message, 'error');
            }
            if (!editData) Utils.showToast('未能加载剧本，已切换为新建模式', 'info');
        }
        if (editData) {
            this._editId = editData.id;
            this._category = editData.category || 'hai-gui-tang';
            this._tags = (editData.tags || []).map(t => (typeof t === 'string' ? t : t && t.tag)).filter(Boolean);
        }

        container.innerHTML = `
        <div class="upload-page">
            <button class="upload-help-btn" title="帮助：汤面/汤底/条件说明与 Markdown 语法" onclick="ScriptUpload.showHelp()">?</button>
            <h2>${this._editId ? '✏️ 编辑剧本' : '📤 上传剧本'}</h2>
            <div class="upload-section">
                <h3>基本信息</h3>
                <label class="form-label">剧本名 <span class="required">*</span></label>
                <input id="upTitle" class="form-input" maxlength="200" placeholder="给你的剧本起个名字" autocomplete="off">

                <label class="form-label">剧本类型 <span class="required">*</span></label>
                <div class="upload-cat-grid" id="upCatGrid">
                    ${Object.entries(CONFIG.CATEGORY_NAMES).map(([k, v]) => `
                        <div class="upload-cat-card ${k === this._category ? 'active' : ''}" data-cat="${k}"
                             onclick="ScriptUpload.selectCategory('${k}')">
                            <span class="cat-icon">${CONFIG.CATEGORY_ICONS[k] || ''}</span>
                            <span>${v}</span>
                        </div>`).join('')}
                </div>

                <label class="form-label">剧本简介（可选）</label>
                <textarea id="upSynopsis" class="form-input" rows="2" placeholder="一句话介绍你的剧本，将展示在详情页" autocomplete="off"></textarea>

                <label class="form-label">剧本标签（可新建）</label>
                <div class="upload-tags-editor" id="upTagsEditor"></div>
                <div class="upload-tags-known" id="upKnownTags"><span class="text-muted">加载已有标签中...</span></div>

                <label class="form-label">难度（1-5）</label>
                <select id="upDifficulty" class="form-input">
                    ${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${'★'.repeat(n)}</option>`).join('')}
                </select>
            </div>
            <div class="upload-section" id="upContentPanel"></div>
            <div class="upload-actions">
                <button class="btn btn-primary" id="upSubmitBtn" onclick="ScriptUpload.submit()">${this._editId ? '保存修改' : '提交审核'}</button>
                <button class="btn btn-outline" onclick="ScriptUpload.cancel()">取消</button>
            </div>
        </div>`;
        this._renderTagsEditor();
        this._renderContentPanel();
        this._loadKnownTags();
        if (editData) this._prefill(editData);
        this._bindDraft();
        this._restoreDraft();
    },

    /** 编辑模式回填（值经 element.value 赋值，天然防属性注入） */
    _prefill(d) {
        document.getElementById('upTitle').value = d.title || '';
        document.getElementById('upSynopsis').value = d.synopsis || '';
        document.getElementById('upDifficulty').value = d.difficulty || 3;
        if (this._category === 'hai-gui-tang') {
            const story = document.getElementById('upStory');
            const exp = document.getElementById('upExplanation');
            const guide = document.getElementById('upHostGuide');
            if (story) story.value = d.story || '';
            if (exp) exp.value = d.explanation || '';
            if (guide) guide.value = d.host_guide || '';
            this.loadEndings(d.endings || '');
            this.loadTasks(d.tasks || '');
        }
    },

    /** 取消：有内容时先确认，确认放弃则清除草稿 */
    async cancel() {
        const hasContent = (document.getElementById('upTitle')?.value || '').trim()
            || (document.getElementById('upStory')?.value || '').trim();
        if (hasContent && window.UIModule && UIModule.confirm) {
            const ok = await UIModule.confirm('确定放弃当前编辑的内容吗？未提交的修改将丢失。', { title: '放弃编辑', okText: '放弃' });
            if (!ok) return;
        }
        this._clearDraft();
        navigateForum('my-works');
    },

    /** 切换剧本类型 → 重渲染内容面板 */
    selectCategory(cat) {
        this._category = cat;
        document.querySelectorAll('.upload-cat-card').forEach(el =>
            el.classList.toggle('active', el.dataset.cat === cat));
        this._renderContentPanel();
        this._saveDraftSoon();
    },

    /** 按类型渲染内容面板 */
    _renderContentPanel() {
        const panel = document.getElementById('upContentPanel');
        const btn = document.getElementById('upSubmitBtn');
        if (!panel) return;
        if (this._category === 'hai-gui-tang') {
            panel.innerHTML = `
                <h3>海龟汤内容</h3>
                <label class="form-label">汤面（谜面/故事）<span class="required">*</span></label>
                <textarea id="upStory" class="form-input" rows="6" placeholder="玩家看到的谜面描述..." autocomplete="off"></textarea>
                <label class="form-label">汤底（真相/答案）<span class="required">*</span></label>
                <textarea id="upExplanation" class="form-input" rows="6" placeholder="完整的真相解答，仅通关玩家与主持人 NPC 可见..." autocomplete="off"></textarea>
                <div class="endings-editor-head">
                    <label class="form-label">胜利/失败条件 <span class="required">*</span></label>
                    <span class="text-muted endings-editor-tip">必填，至少一个结局；系统按条件自动判定胜负并结算（胜利优先）；隐藏条件在玩家达成前不可见</span>
                </div>
                <div class="endings-editor" id="upEndingsEditor"></div>
                <div class="endings-add-row">
                    <button type="button" class="btn btn-sm btn-outline" onclick="ScriptUpload.addEnding('win')">🏆 + 胜利结局</button>
                    <button type="button" class="btn btn-sm btn-outline" onclick="ScriptUpload.addEnding('lose')">💀 + 失败结局</button>
                </div>
                <div class="endings-editor-head">
                    <label class="form-label">任务条件（可选）</label>
                    <span class="text-muted endings-editor-tip">与胜利/失败条件同理：NPC 监听并计数，任务全部条件达成后自动执行你设置的效果</span>
                </div>
                <div class="endings-editor" id="upTasksEditor"></div>
                <div class="endings-add-row">
                    <button type="button" class="btn btn-sm btn-outline" onclick="ScriptUpload.addTask()">📋 + 添加任务</button>
                </div>
                <label class="form-label">主持指导词（可选）</label>
                <textarea id="upHostGuide" class="form-input" rows="3" maxlength="2000" autocomplete="off"
                    placeholder="写给主持人 NPC 的指导：主持风格、节奏、注意事项等，会组合进 NPC 的主持提示词中"></textarea>`;
            if (btn) btn.disabled = false;
        } else {
            const name = CONFIG.CATEGORY_NAMES[this._category] || this._category;
            panel.innerHTML = `
                <div class="upload-wip">
                    <div class="upload-wip-icon">🚧</div>
                    <p>「${Utils.escapeHtml(name)}」类型剧本的上传功能正在制作中，敬请期待。</p>
                </div>`;
            if (btn) btn.disabled = true;
        }
    },

    /* ========== 胜利/失败条件编辑器（DOM 即数据） ========== */

    /** 添加一个结局块；data 存在时为回填（编辑模式） */
    addEnding(type, data) {
        const ed = document.getElementById('upEndingsEditor');
        if (!ed) return;
        const eid = (data && data.id) || this._nextEid();
        const block = document.createElement('div');
        block.className = `ending-block ending-${type}`;
        block.dataset.eid = eid;
        block.dataset.type = type;
        block.innerHTML = `
            <div class="ending-head">
                <span class="ending-type-icon">${type === 'win' ? '🏆' : '💀'}</span>
                <input class="form-input ending-name" placeholder="结局名称，如：真相大白 / 全员遇难" maxlength="50" autocomplete="off">
                <input class="form-input ending-note" placeholder="备注：影响 NPC 对该结局的解说（可选）" maxlength="200" autocomplete="off">
                <button type="button" class="btn btn-sm btn-outline ending-del" title="删除结局">✕</button>
            </div>
            <div class="ending-conds"></div>
            <button type="button" class="btn btn-sm btn-outline cond-add">+ 添加条件</button>`;
        block.querySelector('.ending-del').onclick = () => { block.remove(); this._saveDraftSoon(); };
        block.querySelector('.cond-add').onclick = () => { this.addCondition(block); this._saveDraftSoon(); };
        ed.appendChild(block);
        if (data) {
            block.querySelector('.ending-name').value = data.name || '';
            block.querySelector('.ending-note').value = data.note || '';
            (data.conditions || []).forEach(c => this.addCondition(block, c));
        }
        // 新建结局默认带一个空条件行
        if (!data || !(data.conditions || []).length) this.addCondition(block);
    },

    /** 在结局块内添加一个条件行；data 存在时为回填（保留原条件 id） */
    addCondition(block, data) {
        const list = block.querySelector('.ending-conds');
        if (!list) return;
        const cid = (data && data.id) || this._nextCid(block);
        const row = document.createElement('div');
        row.className = 'cond-row';
        row.dataset.cid = cid;
        row.innerHTML = `
            <span class="cond-index">${list.children.length + 1}</span>
            <input class="form-input cond-name" placeholder="条件名" maxlength="50" autocomplete="off">
            <input class="form-input cond-rule" placeholder="触发规则（NPC 据此判定）" maxlength="300" autocomplete="off">
            <input class="form-input cond-threshold" type="number" min="1" max="99" value="1" title="次数：触发满此次数才算达成">
            <label class="cond-hidden" title="隐藏：玩家达成前不在条件面板显示"><input type="checkbox">隐藏</label>
            <button type="button" class="btn btn-sm btn-outline cond-del" title="删除条件">✕</button>`;
        row.querySelector('.cond-del').onclick = () => { row.remove(); this._reindexConds(block); this._saveDraftSoon(); };
        list.appendChild(row);
        if (data) {
            row.querySelector('.cond-name').value = data.name || '';
            row.querySelector('.cond-rule').value = data.rule || '';
            row.querySelector('.cond-threshold').value = data.threshold || 1;
            row.querySelector('.cond-hidden input').checked = !!data.hidden;
        }
    },

    /** 分配空闲结局 id（e1/e2…，跳过已被占用的） */
    _nextEid() {
        let n = ++this._eidSeq;
        while (document.querySelector(`.ending-block[data-eid="e${n}"]`)) n = ++this._eidSeq;
        return 'e' + n;
    },

    /** 分配结局块内空闲条件 id（c1/c2…） */
    _nextCid(block) {
        let n = 1;
        while (block.querySelector(`.cond-row[data-cid="c${n}"]`)) n++;
        return 'c' + n;
    },

    /** 删除条件后重排序号显示 */
    _reindexConds(block) {
        [...block.querySelectorAll('.cond-row')].forEach((r, i) => {
            r.querySelector('.cond-index').textContent = i + 1;
        });
    },

    /** 从 DOM 收集条件行（结局/任务共用） */
    _collectCondRows(block, ownerName) {
        const conditions = [];
        for (const row of block.querySelectorAll('.cond-row')) {
            const cname = row.querySelector('.cond-name').value.trim();
            const rule = row.querySelector('.cond-rule').value.trim();
            const threshold = Math.max(1, parseInt(row.querySelector('.cond-threshold').value) || 1);
            const hidden = row.querySelector('.cond-hidden input').checked;
            if (!cname || !rule) throw new Error(`「${ownerName}」有条件未填写名称或触发规则`);
            conditions.push({ id: row.dataset.cid, name: cname, rule, threshold, hidden });
        }
        return conditions;
    },

    /** 从 DOM 收集条件表 → endings 数组（含作者侧校验，失败抛错） */
    collectEndings() {
        const ed = document.getElementById('upEndingsEditor');
        if (!ed) return [];
        const endings = [];
        for (const block of ed.querySelectorAll('.ending-block')) {
            const name = block.querySelector('.ending-name').value.trim();
            const note = block.querySelector('.ending-note').value.trim();
            if (!name) throw new Error('有结局未填写名称');
            const conditions = this._collectCondRows(block, `结局「${name}」`);
            if (!conditions.length) throw new Error(`结局「${name}」至少需要一个条件`);
            endings.push({ id: block.dataset.eid, name, type: block.dataset.type, note, conditions });
        }
        return endings;
    },

    /** 编辑模式：把已有 endings（JSON 字符串或数组）解析回表单行（保留原 id） */
    loadEndings(src) {
        let endings = [];
        if (Array.isArray(src)) endings = src;
        else {
            try {
                const p = JSON.parse(src || '');
                if (p && Array.isArray(p.endings)) endings = p.endings;
            } catch (e) { /* 非法 JSON 按无条件表处理 */ }
        }
        for (const e of endings) {
            // 同步 id 序号，避免与已有 id 冲突
            const m = /^e(\d+)$/.exec(e.id || '');
            if (m) this._eidSeq = Math.max(this._eidSeq, parseInt(m[1]));
            this.addEnding(e.type === 'lose' ? 'lose' : 'win', e);
        }
    },

    /* ========== 任务条件编辑器（原理同胜利/失败条件；完成后自动执行效果） ========== */

    /** 添加一个任务块；data 存在时为回填 */
    addTask(data) {
        const ed = document.getElementById('upTasksEditor');
        if (!ed) return;
        const tid = (data && data.id) || this._nextTid();
        const block = document.createElement('div');
        block.className = 'ending-block task-block';
        block.dataset.tid = tid;
        block.innerHTML = `
            <div class="ending-head">
                <span class="ending-type-icon">📋</span>
                <input class="form-input task-name" placeholder="任务名称，如：查明死者的真实身份" maxlength="50" autocomplete="off">
                <input class="form-input task-note" placeholder="备注（可选）" maxlength="200" autocomplete="off">
                <button type="button" class="btn btn-sm btn-outline task-del" title="删除任务">✕</button>
            </div>
            <div class="task-effect-row">
                <select class="form-input task-effect-type" title="任务全部条件达成后自动执行的效果">
                    ${this.EFFECT_TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('')}
                </select>
                <input class="form-input task-effect-payload" placeholder="效果内容：线索/道具文本，或发给 NPC 的消息" maxlength="300" autocomplete="off">
            </div>
            <div class="ending-conds"></div>
            <button type="button" class="btn btn-sm btn-outline cond-add">+ 添加条件</button>`;
        block.querySelector('.task-del').onclick = () => { block.remove(); this._saveDraftSoon(); };
        block.querySelector('.cond-add').onclick = () => { this.addCondition(block); this._saveDraftSoon(); };
        ed.appendChild(block);
        if (data) {
            block.querySelector('.task-name').value = data.name || '';
            block.querySelector('.task-note').value = data.note || '';
            const effect = data.effect || {};
            block.querySelector('.task-effect-type').value = effect.type || 'reveal_clue';
            block.querySelector('.task-effect-payload').value = effect.payload || '';
            (data.conditions || []).forEach(c => this.addCondition(block, c));
        }
        if (!data || !(data.conditions || []).length) this.addCondition(block);
    },

    /** 分配空闲任务 id（t1/t2…） */
    _nextTid() {
        let n = ++this._tidSeq;
        while (document.querySelector(`.task-block[data-tid="t${n}"]`)) n = ++this._tidSeq;
        return 't' + n;
    },

    /** 从 DOM 收集任务表 → tasks 数组（含作者侧校验，失败抛错） */
    collectTasks() {
        const ed = document.getElementById('upTasksEditor');
        if (!ed) return [];
        const validTypes = this.EFFECT_TYPES.map(t => t.value);
        const tasks = [];
        for (const block of ed.querySelectorAll('.task-block')) {
            const name = block.querySelector('.task-name').value.trim();
            const note = block.querySelector('.task-note').value.trim();
            if (!name) throw new Error('有任务未填写名称');
            const conditions = this._collectCondRows(block, `任务「${name}」`);
            if (!conditions.length) throw new Error(`任务「${name}」至少需要一个条件`);
            const etype = block.querySelector('.task-effect-type').value;
            const payload = block.querySelector('.task-effect-payload').value.trim();
            if (!validTypes.includes(etype)) throw new Error(`任务「${name}」的效果类型无效`);
            if (!payload) throw new Error(`任务「${name}」未填写效果内容`);
            tasks.push({ id: block.dataset.tid, name, note, conditions, effect: { type: etype, payload } });
        }
        return tasks;
    },

    /** 编辑模式：把已有 tasks（JSON 字符串或数组）解析回表单行（保留原 id） */
    loadTasks(src) {
        let tasks = [];
        if (Array.isArray(src)) tasks = src;
        else {
            try {
                const p = JSON.parse(src || '');
                if (p && Array.isArray(p.tasks)) tasks = p.tasks;
            } catch (e) { /* 非法 JSON 按无任务处理 */ }
        }
        for (const t of tasks) {
            const m = /^t(\d+)$/.exec(t.id || '');
            if (m) this._tidSeq = Math.max(this._tidSeq, parseInt(m[1]));
            this.addTask(t);
        }
    },

    /* ========== 草稿缓存（误关侧边栏不丢内容） ========== */

    /** 草稿键：新建 / 编辑分开（Store 分账号） */
    _draftKey() { return this._editId ? `upload_draft_${this._editId}` : 'upload_draft_new'; },

    /** 绑定草稿自动保存：输入/勾选/结构变化均触发（防抖；容器复用，只绑一次） */
    _bindDraft() {
        if (!this._container || this._draftBound) return;
        this._draftBound = true;
        const onInput = () => this._saveDraftSoon();
        this._container.addEventListener('input', onInput);
        this._container.addEventListener('change', onInput);
    },

    _saveDraftSoon() {
        clearTimeout(this._draftTimer);
        this._draftTimer = setTimeout(() => this._saveDraft(), 400);
    },

    /** 宽容收集当前表单（不校验必填，残缺行跳过），写入本地草稿 */
    _saveDraft() {
        if (!this._container || !document.getElementById('upTitle')) return;
        const tolerantConds = (block) => [...block.querySelectorAll('.cond-row')].map(row => ({
            id: row.dataset.cid,
            name: row.querySelector('.cond-name').value.trim(),
            rule: row.querySelector('.cond-rule').value.trim(),
            threshold: Math.max(1, parseInt(row.querySelector('.cond-threshold').value) || 1),
            hidden: row.querySelector('.cond-hidden input').checked,
        }));
        const endings = [...document.querySelectorAll('#upEndingsEditor .ending-block')].map(block => ({
            id: block.dataset.eid, type: block.dataset.type,
            name: block.querySelector('.ending-name').value.trim(),
            note: block.querySelector('.ending-note').value.trim(),
            conditions: tolerantConds(block),
        }));
        const tasks = [...document.querySelectorAll('#upTasksEditor .task-block')].map(block => ({
            id: block.dataset.tid,
            name: block.querySelector('.task-name').value.trim(),
            note: block.querySelector('.task-note').value.trim(),
            conditions: tolerantConds(block),
            effect: {
                type: block.querySelector('.task-effect-type').value,
                payload: block.querySelector('.task-effect-payload').value.trim(),
            },
        }));
        const draft = {
            category: this._category,
            title: document.getElementById('upTitle').value,
            synopsis: document.getElementById('upSynopsis').value,
            difficulty: parseInt(document.getElementById('upDifficulty').value) || 3,
            tags: [...this._tags],
            story: document.getElementById('upStory')?.value || '',
            explanation: document.getElementById('upExplanation')?.value || '',
            host_guide: document.getElementById('upHostGuide')?.value || '',
            endings, tasks,
        };
        if (window.Store) Store.set(this._draftKey(), draft);
    },

    /** 有草稿时恢复（新建/编辑均生效；编辑模式下草稿覆盖服务端数据——草稿更新） */
    _restoreDraft() {
        if (!window.Store) return;
        const draft = Store.get(this._draftKey(), null);
        if (!draft || typeof draft !== 'object') return;
        const hasContent = draft.title || draft.story || draft.explanation
            || (draft.endings && draft.endings.length) || (draft.tasks && draft.tasks.length);
        if (!hasContent) return;
        // 类型可能与当前渲染不一致：先切类型（会重渲染内容面板），再回填
        if (draft.category && draft.category !== this._category) this.selectCategory(draft.category);
        if (this._category !== 'hai-gui-tang') return;
        document.getElementById('upTitle').value = draft.title || '';
        document.getElementById('upSynopsis').value = draft.synopsis || '';
        document.getElementById('upDifficulty').value = draft.difficulty || 3;
        this._tags = Array.isArray(draft.tags) ? draft.tags.filter(Boolean) : [];
        this._renderTagsEditor();
        const story = document.getElementById('upStory');
        const exp = document.getElementById('upExplanation');
        const guide = document.getElementById('upHostGuide');
        if (story) story.value = draft.story || '';
        if (exp) exp.value = draft.explanation || '';
        if (guide) guide.value = draft.host_guide || '';
        // 条件表：清空编辑器再按草稿重建（编辑模式下 _prefill 可能已加载过服务端条件）
        const ed = document.getElementById('upEndingsEditor');
        const td = document.getElementById('upTasksEditor');
        if (ed) ed.innerHTML = '';
        if (td) td.innerHTML = '';
        this._eidSeq = 0;
        this._tidSeq = 0;
        this.loadEndings(draft.endings || []);
        this.loadTasks(draft.tasks || []);
        Utils.showToast('已恢复上次未提交的草稿', 'info');
    },

    _clearDraft() {
        clearTimeout(this._draftTimer);
        if (window.Store) Store.set(this._draftKey(), null);
    },

    /* ========== 帮助浮层 ========== */

    /** 上传帮助：汤面/汤底/条件说明 + Markdown 语法教学 */
    showHelp() {
        const old = document.getElementById('uploadHelpOverlay');
        if (old) { old.remove(); return; }
        const overlay = document.createElement('div');
        overlay.id = 'uploadHelpOverlay';
        overlay.className = 'ui-overlay';
        overlay.innerHTML = `
            <div class="ui-confirm-dialog upload-help-dialog">
                <h3>📖 上传帮助</h3>
                <div class="help-body">
                    <h4>汤面 / 汤底</h4>
                    <p><b>汤面</b>：玩家看到的谜面故事，公开可见。</p>
                    <p><b>汤底</b>：完整的真相解答，仅通关的玩家与主持人 NPC 可见。</p>
                    <h4>胜利 / 失败条件（必填）</h4>
                    <p>一个剧本至少需要一个结局；可以有多个胜利结局和失败结局，每个结局由若干条件组成：</p>
                    <p>· <b>触发规则</b>：主持人 NPC 据此判定玩家是否达成该条件；</p>
                    <p>· <b>次数</b>：规则触发满此次数后条件才算达成（默认 1 次）；</p>
                    <p>· <b>隐藏</b>：玩家达成前，该条件不对玩家揭示；</p>
                    <p>· <b>备注</b>：写在结局上，影响 NPC 对该结局的解说。</p>
                    <p>某结局的全部条件达成时，系统自动判定胜负并弹出结算面板（胜利优先于失败）。</p>
                    <h4>任务条件（可选）</h4>
                    <p>任务与胜利/失败条件同理：NPC 监听条件规则并计数，任务的<b>全部条件</b>达成后任务完成，
                       系统自动执行你设置的效果：</p>
                    <p>· <b>揭示线索</b>：把效果内容作为线索放入玩家的线索面板；</p>
                    <p>· <b>给予道具</b>：把效果内容作为道具放入玩家的道具面板；</p>
                    <p>· <b>给NPC发消息</b>：把效果内容作为系统消息发给主持人 NPC（玩家不可见）。</p>
                    <h4>主持指导词（可选）</h4>
                    <p>写给主持人 NPC 的指导（主持风格、节奏、注意事项等），会组合进 NPC 的主持提示词中，玩家不可见。</p>
                    <h4>Markdown 语法（汤面 / 汤底 / 条件文本均支持）</h4>
                    <p>**粗体** ｜ *斜体* ｜ \`行内代码\`</p>
                    <p># 标题（行首，支持 # ## ###）</p>
                    <p>- 列表项（行首，连续多行自动成列表）</p>
                    <p>&gt; 引用（行首）</p>
                    <p>颜色：{#ff4444}红色文字{/} —— 花括号内为 3 或 6 位十六进制颜色</p>
                </div>
                <div class="ui-confirm-actions">
                    <button class="btn btn-primary help-close-btn">知道了</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.help-close-btn').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    },

    /* ========== 标签编辑 ========== */

    /** 标签编辑区（已选 chips + 输入新建） */
    _renderTagsEditor() {
        const ed = document.getElementById('upTagsEditor');
        if (!ed) return;
        ed.innerHTML = `
            ${this._tags.map(t => `
                <span class="tag-chip upload-tag" onclick="ScriptUpload.removeTag('${Utils.escapeHtml(t)}')">
                    ${Utils.escapeHtml(t)} ✕
                </span>`).join('')}
            <input id="upTagInput" class="upload-tag-input" placeholder="输入标签后回车新建" maxlength="20" autocomplete="off">`;
        const input = document.getElementById('upTagInput');
        if (input) {
            input.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.addTag(input.value);
                }
            };
        }
    },

    /** 加载站点已有标签供点选 */
    async _loadKnownTags() {
        const box = document.getElementById('upKnownTags');
        try {
            const res = await ScriptAPI.allTags();
            this._knownTags = (res && res.tags) || [];
            if (!box) return;
            if (!this._knownTags.length) { box.innerHTML = '<span class="text-muted">站点暂无标签</span>'; return; }
            box.innerHTML = '<span class="text-muted">点击添加：</span>' + this._knownTags.slice(0, 30).map(t => `
                <span class="tag-chip upload-tag-pick" onclick="ScriptUpload.addTag('${Utils.escapeHtml(t.tag)}')">${Utils.escapeHtml(t.tag)}</span>
            `).join('');
        } catch (e) {
            if (box) box.innerHTML = '<span class="text-muted">标签加载失败</span>';
        }
    },

    addTag(tag) {
        tag = (tag || '').trim();
        if (!tag) return;
        if (this._tags.includes(tag)) { Utils.showToast('标签已存在', 'info'); return; }
        if (this._tags.length >= 10) { Utils.showToast('标签最多 10 个', 'error'); return; }
        this._tags.push(tag);
        this._renderTagsEditor();
        this._saveDraftSoon();
    },

    removeTag(tag) {
        this._tags = this._tags.filter(t => t !== tag);
        this._renderTagsEditor();
        this._saveDraftSoon();
    },

    /* ========== 提交 ========== */

    /** 提交（新建走 upload 落库草稿；编辑模式走 update 保存） */
    async submit() {
        if (this._category !== 'hai-gui-tang') {
            return Utils.showToast('该类型正在制作中，暂无法上传', 'info');
        }
        const title = (document.getElementById('upTitle').value || '').trim();
        const story = (document.getElementById('upStory').value || '').trim();
        const explanation = (document.getElementById('upExplanation').value || '').trim();
        if (!title) return Utils.showToast('请填写剧本名', 'error');
        if (!story) return Utils.showToast('请填写汤面', 'error');
        if (!explanation) return Utils.showToast('请填写汤底', 'error');

        // 收集胜利/失败条件（必填：至少一个结局；作者侧校验，失败直接提示并中止）
        let endingsJson = '';
        try {
            const endings = this.collectEndings();
            if (!endings.length) return Utils.showToast('请至少设置一个胜利/失败结局及其条件', 'error');
            endingsJson = JSON.stringify({ endings });
        } catch (e) {
            return Utils.showToast(e.message, 'error');
        }

        // 收集任务条件（可选）
        let tasksJson = '';
        try {
            const tasks = this.collectTasks();
            if (tasks.length) tasksJson = JSON.stringify({ tasks });
        } catch (e) {
            return Utils.showToast(e.message, 'error');
        }

        const data = {
            title,
            category: this._category,
            synopsis: (document.getElementById('upSynopsis').value || '').trim(),
            tags: this._tags,
            difficulty: parseInt(document.getElementById('upDifficulty').value) || 3,
            story,
            explanation,
            endings: endingsJson,
            tasks: tasksJson,
            host_guide: (document.getElementById('upHostGuide')?.value || '').trim(),
        };
        const btn = document.getElementById('upSubmitBtn');
        try {
            if (btn) btn.disabled = true;
            if (this._editId) {
                await ScriptAPI.update(this._editId, data);
                // 编辑保存后若剧本状态为 draft/rejected，自动重新提交审核
                try {
                    const detail = await ScriptAPI.detail(this._editId);
                    if (detail && (detail.review_status === 'draft' || detail.review_status === 'rejected')) {
                        await ReviewModule.submitForReview({ script_id: this._editId });
                    }
                } catch (e) { /* 提交审核失败不阻断保存流程 */ }
                Utils.showToast('保存成功');
            } else {
                const result = await ScriptAPI.create(data);
                // 创建后自动提交审核（AI 初审 → 管理员复审）
                if (result && result.id) {
                    try {
                        await ReviewModule.submitForReview({ script_id: result.id });
                    } catch (e) { /* 提交审核失败不阻断创建流程 */ }
                }
                Utils.showToast('上传成功，已进入审核流程');
            }
            this._clearDraft();
            navigateForum('my-works');
        } catch (e) {
            Utils.showToast(e.message || '保存失败', 'error');
            if (btn) btn.disabled = false;
        }
    },
};

window.ScriptUpload = ScriptUpload;
