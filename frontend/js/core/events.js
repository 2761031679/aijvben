/** AI剧本网 - 事件总线 */
const Events = {
    _handlers: {},

    on(name, fn) {
        if (!this._handlers[name]) this._handlers[name] = [];
        this._handlers[name].push(fn);
    },

    off(name, fn) {
        if (!this._handlers[name]) return;
        this._handlers[name] = this._handlers[name].filter(h => h !== fn);
    },

    emit(name, data) {
        (this._handlers[name] || []).forEach(fn => fn(data));
    }
};
window.Events = Events;
