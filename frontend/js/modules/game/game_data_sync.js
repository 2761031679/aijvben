/** AI剧本网 - 游戏数据云同步（GameDataSync）
 * ------------------------------------------------------------------
 *  把各剧本的条件进度（cond_<scriptId>）与线索/道具（inv_<scriptId>）等本地
 *  游戏数据聚合后同步到云端（每用户一份 payload），与本地 Store 双份一致，
 *  实现换设备 / 清缓存后可续玩。
 *
 *  同步策略：
 *   - 上传：仅登录用户（游客仅本地），debounce 800ms 合并，减少请求频率；
 *   - 恢复：登录用户启动时云端为权威源（覆盖本地对应键），本地多余键保留兜底。
 *
 *  数据量极小（每剧本几百字节～几 KB），频率低（条件/道具变化时），对服务器
 *  几乎无损耗。
 */
const GameDataSync = {
    _timer: null,

    /** 收集本地所有 cond_* / inv_* 数据，聚合成 payload */
    collect() {
        const out = { conditions: {}, inventory: {} };
        const prefix = `ts_${Store.uid()}_`;
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key || !key.startsWith(prefix)) continue;
                const name = key.slice(prefix.length);
                let val = null;
                try { val = JSON.parse(localStorage.getItem(key)); } catch (e) { continue; }
                if (name.startsWith('cond_')) out.conditions[name.slice('cond_'.length)] = val;
                else if (name.startsWith('inv_')) out.inventory[name.slice('inv_'.length)] = val;
            }
        } catch (e) { /* ignore */ }
        return out;
    },

    /** 触发云端上传（debounce 合并） */
    scheduleUpload() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => this._upload(), 800);
    },

    async _upload() {
        if (STATE.get('isGuest')) return;   // 游客仅本地
        try {
            await API.put('/user/game-data-save', { payload: this.collect() });
        } catch (e) { /* 云端保存失败静默，下次变更重试 */ }
    },

    /** 启动时从云端恢复：覆盖本地对应键（本地多余键保留兜底） */
    async load() {
        if (STATE.get('isGuest')) return;
        try {
            const res = await API.get('/user/game-data-save');
            const payload = (res && res.payload) || {};
            const conditions = payload.conditions || {};
            const inventory = payload.inventory || {};
            for (const scriptId of Object.keys(conditions)) {
                try { Store.set('cond_' + scriptId, conditions[scriptId]); } catch (e) { /* ignore */ }
            }
            for (const scriptId of Object.keys(inventory)) {
                try { Store.set('inv_' + scriptId, inventory[scriptId]); } catch (e) { /* ignore */ }
            }
        } catch (e) { /* 云端读取失败，回退本地 */ }
    },
};

window.GameDataSync = GameDataSync;
