/** AI剧本网 - UI 元数据单一真源（UiMeta）
 * ------------------------------------------------------------------
 *  「工具面板叫什么名字」「血量条那张卡片怎么跟 NPC 解释」「界面上的目标点位有哪些」
 *  这三类文字原来散落在三处：status_ui_*.js 的 id/name/desc/npcCmds、tool_panel.js 的标题、
 *  以及后端 prompt_env_service.py 给 NPC 看的那一份。**前端改个卡片名，NPC 的认知不会跟着变**，
 *  于是 NPC 说「点血条」而界面上写着「血量」。
 *
 *  现在真源在后端 `/api/host/ui-meta`（见 task-2），前端启动拉一次、内存缓存，
 *  所有写死的元数据降级为**兜底常量**：拉不到（老后端 404 / 网络断 / 服务重启）时
 *  界面与 NPC 认知仍然一致，行为退回「和改之前一模一样」，不会因为新端点缺失而白屏。
 *
 *  故意做的事只有三件：
 *   1) 拉一次 + 缓存（并发调用共用同一个 promise，不会打出一串请求）；
 *   2) 归一化：后端 status_uis 里的字段是 `npc_cmds`，前端历史字段是 `npcCmds`，两种都吃；
 *   3) 提供 ui-meta-loaded 事件，让已经渲染过的 DOM 能补一次。
 *  拉失败**不打扰玩家**（不 toast）：元数据缺失不影响玩，只是文案回落——只在 console 留一行。
 */
const UiMeta = {
    ENDPOINT: '/api/host/ui-meta',
    CONTRACT: 'aijuben.context/1.3',

    /** 兜底：界面目标点位的中文名。镜像 backend/services/prompt_env_service.py 的 UI_TARGETS。
     *  这是**显示名**（NPC 与提示语里怎么说），不是 CSS 选择器 —— 选择器在 modules/ui/ui_locator.js。 */
    _LOCAL_TARGETS: {
        settings: '设置',
        voice: '语音',
        tool: '工具面板',
        login: '登录',
        register: '注册',
        home: '主页',
        board: '剧本区',
        reward: '打赏',
        chat: '对话',
    },

    /** 兜底：状态卡元数据。镜像 prompt_env_service.py 的 STATUS_UIS（顺序 mode → hp → conditions）。
     *  npcCmds 留空是有意的：真正的命令清单由 status_ui_*.js 的实现提供（底下 _liveStatusUi），
     *  这里再抄一份 7 条 hp_* 说明只会多一个会过期的副本。 */
    _LOCAL_STATUS_UIS: [
        { id: 'mode', name: '模式状态', npcCmds: [],
          desc: '显示当前正在游玩的剧本类型。玩家点击此卡可退出当前剧本体验（由玩家操作，非 NPC 命令）。' },
        { id: 'hp', name: '血量条', npcCmds: [],
          desc: '玩家血量条。默认不显示，NPC 通过 hp_* 命令调用时自动显示并操作。' },
        { id: 'conditions', name: '失败/成功条件', npcCmds: [],
          desc: '实时显示当前海龟汤剧本的胜利/失败条件进度（条件名 + 次数/阈值）。隐藏条件达成后自动浮现。此卡只读，NPC 通过 [cond:] 标记推进条件，不直接修改。' },
    ],

    /** 缓存。source: 'local' | 'server' */
    _cache: {
        targets: null,       // {id: label}
        statusUis: null,     // [{id, name, desc, npcCmds}]
        emotions: null,
        animations: null,
        source: 'local',
        loaded: false,
        error: null,
    },
    _promise: null,

    /* ========== 对外 ========== */

    /** 拉一次元数据（幂等：并发调用共用同一个 promise）。force=true 才重新拉。
     *  永不 reject —— 调用方不该为了元数据写 try/catch。 */
    init(force) {
        if (!force && this._promise) return this._promise;
        const self = this;
        this._promise = fetch(this.ENDPOINT, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                self._apply(data);
                self._cache.source = 'server';
                self._cache.loaded = true;
                self._cache.error = null;
                if (window.Events) Events.emit('ui-meta-loaded', { source: 'server' });
                return self._cache;
            })
            .catch(function (err) {
                // 端点还没上线（当前后端就是这种情况）/ 网络断 / 服务重启 —— 都走兜底，不吵玩家
                self._cache.loaded = true;
                self._cache.error = (err && err.message) || 'unreachable';
                if (window.console) {
                    console.info('[UiMeta] 元数据没能从服务端取到，使用内置兜底：' + self._cache.error);
                }
                if (window.Events) Events.emit('ui-meta-loaded', { source: 'local', error: self._cache.error });
                return self._cache;
            });
        return this._promise;
    },

    /** 把服务端数据塞进缓存（形状不对的字段一律忽略，别让脏数据顶掉兜底） */
    _apply(data) {
        const d = data || {};
        const targets = this._normTargets(d.ui_targets || d.uiTargets);
        if (targets) this._cache.targets = targets;
        const list = d.status_uis || d.statusUis;
        if (Array.isArray(list) && list.length) {
            const arr = [];
            for (let i = 0; i < list.length; i++) {
                const it = list[i] || {};
                const id = String(it.id || '').trim();
                if (!id) continue;
                arr.push({
                    id: id,
                    name: it.name || '',
                    desc: it.desc || it.description || '',
                    // 后端字段是 npc_cmds，前端历史字段是 npcCmds —— 两种都吃
                    npcCmds: Array.isArray(it.npc_cmds) ? it.npc_cmds
                        : (Array.isArray(it.npcCmds) ? it.npcCmds : []),
                });
            }
            if (arr.length) this._cache.statusUis = arr;
        }
        if (d.emotions) this._cache.emotions = d.emotions;
        if (d.animations) this._cache.animations = d.animations;
    },

    /** 归一化目标点位：吃 {id:label} 也吃 [{id,label}]，都不认就返回 null（保持兜底） */
    _normTargets(raw) {
        if (!raw) return null;
        const out = {};
        let n = 0;
        if (Array.isArray(raw)) {
            for (let i = 0; i < raw.length; i++) {
                const it = raw[i] || {};
                const id = String(it.id || it.key || '').trim();
                const label = it.label || it.name || it.title || '';
                if (id && label) { out[id] = String(label); n++; }
            }
        } else if (typeof raw === 'object') {
            Object.keys(raw).forEach(function (k) {
                const v = raw[k];
                if (typeof v === 'string' && v) { out[k] = v; n++; }
                else if (v && typeof v === 'object') {
                    const label = v.label || v.name || v.title || '';
                    if (label) { out[k] = String(label); n++; }
                }
            });
        }
        return n ? out : null;
    },

    /** 目标点位表 {id: 显示名}。服务端那份**逐项叠加**在兜底之上：
     *  服务端只回 3 个点位时，另外 6 个仍叫它们本来的名字，不会退化成 id（'board'）。 */
    targets() {
        const merged = Object.assign({}, this._LOCAL_TARGETS);
        const server = this._cache.targets;
        if (server) {
            Object.keys(server).forEach(k => { if (server[k]) merged[k] = server[k]; });
        }
        return merged;
    },

    /** 某个点位的显示名（拿不到就用 fallback，最终退到 id 本身） */
    targetLabel(id, fallback) {
        return this.targets()[id] || fallback || id;
    },

    /** 状态卡元数据列表 [{id, name, desc, npcCmds}]，顺序沿用服务端（默认 mode→hp→conditions） */
    statusUis() {
        const self = this;
        const serverList = this._cache.statusUis;
        const ids = (serverList && serverList.length)
            ? serverList.map(function (it) { return it.id; })
            : this._LOCAL_STATUS_UIS.map(function (it) { return it.id; });
        return ids.map(function (id) { return self.statusUi(id); });
    },

    /** 某一张卡的元数据（服务端那份 + 模块提供的命令清单，合并成最终结果）。
     *  name/desc 走 meta()（绝不回读模块自身，防「模块问 UiMeta、UiMeta 又问模块」的死循环）；
     *  npcCmds 优先服务端，其次**正在运行的那份实现**（命令清单必须与真实行为一致）。 */
    statusUi(id) {
        const base = this.meta(id);
        const live = this._liveStatusUi(id);
        let npcCmds = base.npcCmds;
        if ((!npcCmds || !npcCmds.length) && live && Array.isArray(live.npcCmds)) npcCmds = live.npcCmds;
        return { id: id, name: base.name, desc: base.desc, npcCmds: npcCmds || [] };
    },

    /** 只读「真源那份」元数据：服务端优先，否则 UiMeta 自带的兜底常量。
     *  **不读模块上的字段** —— 模块的 name/desc 反过来是问这里要的，互相读会转圈。 */
    meta(id) {
        const serverList = this._cache.statusUis || [];
        let server = null;
        for (let i = 0; i < serverList.length; i++) {
            if (serverList[i].id === id) { server = serverList[i]; break; }
        }
        const local = this._localStatusUi(id);
        return {
            id: id,
            name: (server && server.name) || (local && local.name) || id,
            desc: (server && server.desc) || (local && local.desc) || '',
            npcCmds: (server && server.npcCmds) || [],
        };
    },

    /** 正在运行的实现（status_ui_*.js 注册到 window 的那份），没有就 null */
    _liveStatusUi(id) {
        const name = 'StatusUi' + id.charAt(0).toUpperCase() + id.slice(1);
        const mod = window[name];
        if (mod && mod.id === id) return mod;
        if (window.StatusBar && StatusBar._uis && StatusBar._uis[id]) return StatusBar._uis[id];
        return null;
    },

    _localStatusUi(id) {
        for (let i = 0; i < this._LOCAL_STATUS_UIS.length; i++) {
            if (this._LOCAL_STATUS_UIS[i].id === id) return this._LOCAL_STATUS_UIS[i];
        }
        return null;
    },

    /** 情绪 / 动画词表（暂未在界面上用到，先给出口，别让调用方自己去摸缓存） */
    emotions() { return this._cache.emotions || {}; },
    animations() { return this._cache.animations || {}; },

    /** 诊断用：数据是从服务端来的还是兜底 */
    info() {
        return { source: this._cache.source, loaded: this._cache.loaded, error: this._cache.error };
    },
};

window.UiMeta = UiMeta;

/** 启动拉一次。UI 元数据只是文案，晚一点拿到也不影响玩，所以放在 DOMContentLoaded 之后，
 *  不和首屏渲染争同一个时间片。 */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { UiMeta.init(); });
} else {
    UiMeta.init();
}
