/** AI剧本网 - SPA 路由 */
const Router = {
    _routes: {},
    _beforeEach: null,

    init(routes, beforeEach) {
        this._routes = routes;
        this._beforeEach = beforeEach || null;
        window.addEventListener('hashchange', () => this._handle());
        this._handle();
    },

    navigate(page, param) {
        window.location.hash = param ? `#${page}/${param}` : `#${page}`;
    },

    _handle() {
        const hash = window.location.hash.replace('#', '') || 'home';
        const [page, ...args] = hash.split('/');
        const param = args.join('/');

        if (this._beforeEach && this._beforeEach(page, param) === false) return;

        STATE.set('currentPage', page);
        const handler = this._routes[page];
        if (handler) {
            handler(param);
        } else if (this._routes['home']) {
            this._routes['home']();
        }
    },

    getContentTarget() {
        return document.getElementById('forumContent') || document.body;
    }
};

window.Router = Router;
