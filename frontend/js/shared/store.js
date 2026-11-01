/**
 * 分账号本地存储模块 (Store)
 * ------------------------------------------------------------------
 * 统一管理「按账号隔离」的本地数据（localStorage）。
 * 每个账号（登录用户 / 游客）拥有独立的存储命名空间，键格式为：
 *      ts_<uid>_<name>
 * 其中 uid 取当前登录用户 id；未登录（游客）统一为 'guest'。
 *
 * 用途：
 *   - 用户设置配置文件（config）分账号存储
 *   - NPC 对话历史（chat_<npcId>）分账号存储
 *   - 其他需要按账号隔离的本地数据
 *
 * 说明：本模块只负责「读 / 写 / 删」，具体业务键名由各模块自行约定。
 */
const Store = {
    /** 当前账号标识（登录用户 id，游客为 'guest'） */
    uid() {
        try {
            const user = STATE.get('user');
            return user && user.id ? String(user.id) : 'guest';
        } catch (e) {
            return 'guest';
        }
    },

    /** 生成带账号命名空间的键 */
    _key(name) {
        return `ts_${this.uid()}_${name}`;
    },

    /** 读取（JSON 反序列化），失败或不存在返回 def */
    get(name, def = null) {
        try {
            const raw = localStorage.getItem(this._key(name));
            return raw != null ? JSON.parse(raw) : def;
        } catch (e) {
            return def;
        }
    },

    /** 写入（JSON 序列化） */
    set(name, val) {
        try {
            localStorage.setItem(this._key(name), JSON.stringify(val));
            return true;
        } catch (e) {
            console.warn('[Store] 写入失败:', name, e.message);
            return false;
        }
    },

    /** 删除当前账号下的某项 */
    remove(name) {
        try {
            localStorage.removeItem(this._key(name));
        } catch (e) { /* ignore */ }
    },

    /** 判断当前账号是否存在某项 */
    has(name) {
        return localStorage.getItem(this._key(name)) != null;
    },
};

window.Store = Store;
