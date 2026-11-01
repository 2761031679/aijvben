/** AI剧本网 - 状态栏框架（StatusBar）
 * ------------------------------------------------------------------
 *  左上角（打赏按钮下方）的可扩展「状态栏 UI 系统」。剧本体验期间用于展示
 *  模式状态 / 血量条 / 失败成功条件 等状态卡。
 *
 *  设计要点：
 *   - registerUi(id, ui) 注册 UI 模块，ui 含：
 *       id / name / desc（说明，打包给 NPC）/ render(el, data) / update(el)（可选）
 *       / autoEvents（订阅的 Events 名，触发自动 update）/ npcCmds（NPC 可调用命令说明）
 *   - show(id) / hide(id) / update(id, data) / clear() 控制显示与刷新；所有 UI 默认隐藏。
 *   - 状态数据（UI 的持久化状态）经 setData/getData 读写，实时同步「本地 Store + 云端 API」双份，
 *     每用户仅一份存档（登录用户云端为权威源，游客仅本地）。
 */
const StatusBar = {
    _root: null,
    _uis: {},        // id -> ui 模块
    _visible: {},    // id -> true（当前显示）
    _data: {},       // 持久化状态 {uiId: data}
    _persistTimer: null,
    _inited: false,

    /** 注册状态栏 UI 模块；autoEvents 在注册时即订阅（事件触发时仅当该 UI 可见才刷新） */
    registerUi(id, ui) {
        this._uis[id] = ui;
        this._hookUiMeta();
        if (ui.autoEvents && window.Events) {
            (ui.autoEvents || []).forEach(ev => {
                Events.on(ev, () => { if (this._visible[id]) this._refresh(id); });
            });
        }
    },

    /** 懒初始化：建容器 + 加载持久化状态 */
    init() {
        if (this._inited) return;
        this._inited = true;
        this._ensureDom();
        this._loadData();
    },

    /** 启动时加载持久化状态：登录用户云端优先（本地兜底），游客仅本地 */
    async _loadData() {
        let local = {};
        try { local = Store.get('status_bar', {}) || {}; } catch (e) { local = {}; }
        this._data = local;
        if (!STATE.get('isGuest')) {
            try {
                const res = await API.get('/user/status-bar-save');
                const cloud = (res && res.payload) || {};
                if (cloud && Object.keys(cloud).length) {
                    this._data = cloud;                 // 云端为权威源
                    try { Store.set('status_bar', cloud); } catch (e) { /* ignore */ }
                }
            } catch (e) { /* 云端读取失败，回退本地 */ }
        }
    },

    /** 创建容器：固定在左上角打赏按钮下方（打赏按钮已贴边，故状态栏竖向堆叠其下） */
    _ensureDom() {
        if (document.getElementById('statusBar')) { this._root = document.getElementById('statusBar'); return; }
        const root = document.createElement('div');
        root.id = 'statusBar';
        root.className = 'status-bar';
        document.body.appendChild(root);
        this._root = root;
    },

    /** 显示某 UI：渲染其容器并执行 render */
    show(id) {
        this.init();
        const ui = this._uis[id];
        if (!ui) return;
        this._visible[id] = true;
        this._ensureUiDom(id);
        this._render(id);
    },

    /** 隐藏某 UI */
    hide(id) {
        this._visible[id] = false;
        const el = document.getElementById('statusUi_' + id);
        if (el) el.style.display = 'none';
    },

    /** 清空所有 UI（退出体验时统一调用，保证任何退出路径都清理） */
    clear() {
        this._visible = {};
        const root = this._root || document.getElementById('statusBar');
        if (root) root.innerHTML = '';
    },

    /** 复位到默认态 —— 由 Experience.end() 调用（收场/结算/NPC 退出各路径都会经过它）。
     *  为什么 clear() 不够：clear() 只把容器 innerHTML 清空，管不住两样残留——
     *   ① 各 UI 的**持久化状态**：血量存档还停在上局的残血值，下局开局就不是默认血量；
     *   ② 清空之后只要有逻辑再调一次 show()/update()，_ensureUiDom 会把卡片重新建出来，
     *      于是收场后状态栏又「活」回来，玩家得刷新页面才干净（用户实测的现象）。
     *  这里一次做三件：血量存档回默认 → 可见表与容器清空 → 物理摘掉所有状态卡节点。
     *  幂等：状态栏没建过、DOM 已经空、重复调用都安全，不报错也不改变结果。 */
    resetForExperienceEnd() {
        // ① 血量存档复位，下次开局从默认值开始。
        //    这一步会 emit status-hp-updated 并回调 update('hp')，所以必须排在清 DOM 之前：
        //    顺序反了就是在「节点已被删掉」的情况下白渲染一遍。
        if (window.StatusUiHp && StatusUiHp.reset) {
            try { StatusUiHp.reset(); } catch (e) { console.warn('[StatusBar] 血量复位失败', e && e.message); }
        }
        // ② 可见表 + 容器（clear 已兼容 _root 还没建立的场景）
        this.clear();
        // ③ 按 id 再摘一遍残留节点：_root 与实际 DOM 万一漂移过（容器被别处替换过），
        //    ② 只能清到 _root 那一棵；这里按真实 DOM 兜底。
        const stale = document.querySelectorAll('#statusBar .status-ui');
        for (let i = 0; i < stale.length; i++) stale[i].remove();
    },

    /** 更新某 UI（重新渲染，可传 data） */
    update(id, data) {
        this._render(id, data);
    },

    /* ========== 持久化状态 ========== */

    /** 读取某 UI 的持久化状态 */
    getData(id, def = null) {
        return this._data[id] != null ? this._data[id] : def;
    },

    /** 写入某 UI 的持久化状态：立即写本地 + debounce 写云端 */
    setData(id, data) {
        this._data[id] = data;
        try { Store.set('status_bar', this._data); } catch (e) { /* ignore */ }
        this._scheduleCloudSave();
    },

    _scheduleCloudSave() {
        if (this._persistTimer) clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => this._saveCloud(), 800);
    },

    async _saveCloud() {
        if (STATE.get('isGuest')) return;   // 游客仅本地
        try { await API.put('/user/status-bar-save', { payload: this._data }); }
        catch (e) { /* 云端保存失败静默，下次变更重试 */ }
    },

    /** 供 PromptBuilder 注入：所有已注册 UI 的说明 + 可调用命令清单。
     *  名称/说明优先取 UiMeta（单一真源，服务端那份就是 NPC 看到的那份），拿不到才落到模块上的兜底；
     *  npcCmds 反之优先取**模块自己的**——命令清单必须与真实实现一致，抄到元数据里只会过期。 */
    describeForNpc() {
        return Object.values(this._uis).map(u => {
            const meta = (window.UiMeta && UiMeta.statusUi) ? UiMeta.statusUi(u.id) : null;
            return {
                id: u.id,
                name: (meta && meta.name) || u.name,
                desc: (meta && meta.desc) || u.desc || '',
                npcCmds: (u.npcCmds && u.npcCmds.length) ? u.npcCmds : ((meta && meta.npcCmds) || []),
            };
        });
    },

    /* ========== 内部 ========== */

    /** 元数据是异步到的（UiMeta 启动才去拉）：到了就把已经显示着的卡片重画一遍，
     *  否则玩家会一直看着「脚本加载那一刻的兜底文案」，直到下一次 update 才更新。
     *  只挂一次 —— 每注册一个 UI 就挂一遍，事件一响就把同一张卡渲染 N 次。 */
    _hookUiMeta() {
        if (this._metaHooked || !window.Events) return;
        this._metaHooked = true;
        Events.on('ui-meta-loaded', () => {
            Object.keys(this._visible || {}).forEach((id) => {
                if (!this._visible[id]) return;
                try { this.update(id); }
                catch (e) { console.warn('[StatusBar] 元数据到达后重渲染失败', id, e && e.message); }
            });
        });
    },

    _ensureUiDom(id) {
        if (document.getElementById('statusUi_' + id)) return;
        const el = document.createElement('div');
        el.id = 'statusUi_' + id;
        el.className = 'status-ui';
        el.style.display = 'none';
        (this._root || document.getElementById('statusBar')).appendChild(el);
    },

    _render(id, data) {
        const ui = this._uis[id];
        const el = document.getElementById('statusUi_' + id);
        if (!ui || !el) return;
        el.style.display = 'block';
        if (ui.render) ui.render(el, data);
    },

    _refresh(id) {
        if (!this._visible[id]) return;
        const ui = this._uis[id];
        const el = document.getElementById('statusUi_' + id);
        if (ui && el && ui.update) ui.update(el);
    },
};

window.StatusBar = StatusBar;
