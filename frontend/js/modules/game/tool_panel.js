/** AI剧本网 - 底部工具面板（ToolPanel）
 * ------------------------------------------------------------------
 *  入口：聊天输入框左侧的记事本按钮（📋）→ toggle()，面板从底部上滑展开。
 *
 *  职责：
 *   - 非剧本体验时：面板为空白，提示「此为工具面板，仅在剧本体验时生效」；
 *   - 剧本体验时：按当前剧本类型（海龟汤/DND/COC/剧本扮演）调用对应
 *     HUD 模块填充内容（HUD 注册中心 registerHud），未实现的类型显示制作中提示。
 *
 *  内容刷新：
 *   - 打开面板时按当前状态渲染；
 *   - 监听 experience-started / experience-ended / conditions-updated 事件实时刷新；
 *   - 收场复位：Experience.end() 会调 resetForExperienceEnd()，把面板内容落回默认文案
 *     （experience-ended 事件早于体验态复位发出，光靠事件重渲染会把上一局 HUD 又画一遍）。
 */
const ToolPanel = {
    _open: false,
    _inited: false,
    _huds: {},   // category -> { render(container), refresh?() }

    /** 注册某剧本类型的面板内容模块 */
    registerHud(category, hud) {
        this._huds[category] = hud;
    },

    /** 懒初始化：建 DOM + 订阅事件（首次 toggle 时执行） */
    init() {
        if (this._inited) return;
        this._inited = true;
        this._ensureDom();
        if (window.Events) {
            Events.on('experience-started', () => this._refreshContent());
            Events.on('experience-ended', () => this._refreshContent());
            Events.on('conditions-updated', () => this._refreshHud());
            Events.on('inventory-updated', () => this._refreshHud());   // 线索/道具面板变化
            // 标题的中文名以 UiMeta 为真源（/api/host/ui-meta）——它是异步到的，
            // 晚到就把已经建好的标题改一下，别让玩家对着启动那一刻的兜底文案
            Events.on('ui-meta-loaded', () => this._syncTitle());
        }
    },

    /** 面板标题文案：优先 UiMeta 给的名字（NPC 认知与界面同一份），拿不到回落「工具面板」 */
    _titleText() {
        const label = (window.UiMeta && UiMeta.targetLabel)
            ? UiMeta.targetLabel('tool', '工具面板')
            : '工具面板';
        return '🛠 ' + label;
    },

    /** 元数据晚到时同步标题（DOM 还没建就什么都不做，建的时候会取一次） */
    _syncTitle() {
        const el = document.getElementById('toolPanelTitle');
        if (el) el.textContent = this._titleText();
    },

    _ensureDom() {
        if (document.getElementById('toolPanel')) return;
        const overlay = document.createElement('div');
        overlay.id = 'toolPanelOverlay';
        overlay.className = 'tool-panel-overlay';
        overlay.onclick = () => this.close();
        const panel = document.createElement('div');
        panel.id = 'toolPanel';
        panel.className = 'tool-panel';
        panel.innerHTML = `
            <div class="tool-panel-head">
                <span class="tool-panel-title" id="toolPanelTitle">${Utils.escapeHtml(this._titleText())}</span>
                <button type="button" class="tool-panel-close" title="关闭">✕</button>
            </div>
            <div class="tool-panel-body" id="toolPanelBody"></div>`;
        panel.querySelector('.tool-panel-close').onclick = () => this.close();
        document.body.appendChild(overlay);
        document.body.appendChild(panel);
    },

    toggle() {
        this.init();
        this._open ? this.close() : this.open();
    },

    open() {
        this.init();
        this._renderContent();
        document.getElementById('toolPanel').classList.add('open');
        document.getElementById('toolPanelOverlay').classList.add('open');
        this._open = true;
    },

    close() {
        const panel = document.getElementById('toolPanel');
        const overlay = document.getElementById('toolPanelOverlay');
        if (panel) panel.classList.remove('open');
        if (overlay) overlay.classList.remove('open');
        this._open = false;
    },

    isOpen() { return this._open; },

    /* ========== 内部 ========== */

    /** 复位到默认态 —— 由 Experience.end() 经各 HUD 的 resetForExperienceEnd() 调用。
     *  为什么不能让事件自己搞定：experience-ended 是在 Experience._isActive 复位**之前**
     *  发出的，事件处理里重渲染时 isActive 还是 true，只会把上一局的 HUD 再画一遍；
     *  所以「落回默认」必须是显式动作、且不参考当前体验状态。
     *  只重置内容、不替玩家关面板：面板开合由玩家（或 toggle）决定。
     *  幂等：面板没建过（DOM 不存在）直接返回，重复调用结果一致。 */
    resetForExperienceEnd() {
        this._renderBlank();
    },

    /** 按当前体验状态整体渲染内容 */
    _renderContent() {
        const inExp = window.Experience && Experience.isActive && Experience.isActive();
        if (!inExp) {
            this._renderBlank();
            return;
        }
        const body = document.getElementById('toolPanelBody');
        if (!body) return;
        const script = Experience.currentScript ? Experience.currentScript() : null;
        const cat = (script && script.category) || '';
        const hud = this._huds[cat];
        if (hud && hud.render) {
            hud.render(body);
        } else {
            const name = CONFIG.CATEGORY_NAMES[cat] || cat || '未知';
            body.innerHTML = `<div class="tool-panel-blank">「${Utils.escapeHtml(name)}」类型的工具面板正在制作中，敬请期待。</div>`;
        }
    },

    /** 面板的默认态（非体验中）文案：只此一份，_renderContent 与复位共用 */
    _renderBlank() {
        const body = document.getElementById('toolPanelBody');
        if (!body) return;
        body.innerHTML = `<div class="tool-panel-blank">此为工具面板，仅在剧本体验时生效。<br>开始一次剧本体验后，这里会显示对应的游戏工具。</div>`;
    },

    /** 体验状态变化时：面板开着才重渲染 */
    _refreshContent() {
        if (this._open) this._renderContent();
    },

    /** 条件计数变化时：只刷新 HUD 的条件区（不重排整个面板，保留汤面滚动位置） */
    _refreshHud() {
        if (!this._open) return;
        const inExp = window.Experience && Experience.isActive && Experience.isActive();
        if (!inExp) return;
        const script = Experience.currentScript ? Experience.currentScript() : null;
        const hud = this._huds[(script && script.category) || ''];
        if (hud && hud.refresh) hud.refresh();
    },
};

window.ToolPanel = ToolPanel;
