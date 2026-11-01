/** AI剧本网 - 全局响应式状态管理 */
const STATE = {
    _data: {
        token: null,
        user: null,
        isGuest: false,
        currentPage: 'home',
        currentBoard: null,
        currentScriptId: null,
        config: null,
        subscriptions: [],
        visibleCategories: [],
    },
    _listeners: {},

    init() {
        const saved = localStorage.getItem('turtlesoup_state');
        if (saved) {
            try {
                const d = JSON.parse(saved);
                if (d.token) this._data.token = d.token;
                if (d.user) this._data.user = d.user;
                if (d.isGuest) this._data.isGuest = d.isGuest;
            } catch (e) { /* ignore */ }
        }
        return Promise.resolve();
    },

    get(key) {
        return this._data[key];
    },

    set(key, val) {
        this._data[key] = val;
        if (key === 'token' || key === 'user' || key === 'isGuest') {
            const { token, user, isGuest } = this._data;
            localStorage.setItem('turtlesoup_state', JSON.stringify({ token, user, isGuest }));
        }
        this._emit(key, val);
    },

    on(key, fn) {
        if (!this._listeners[key]) this._listeners[key] = [];
        this._listeners[key].push(fn);
    },

    _emit(key, val) {
        (this._listeners[key] || []).forEach(fn => fn(val));
    }
};

window.STATE = STATE;
