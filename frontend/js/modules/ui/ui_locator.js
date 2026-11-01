/** AI剧本网 - UI 定位与引导高亮模块
 * ------------------------------------------------------------------
 *  UILocator：全局 UI 定位。逻辑名 → CSS 选择器 → 实时坐标。
 *    坐标从不硬编码、不缓存，每次 locate() 都调用 getBoundingClientRect()
 *    现算，窗口缩放/滚动/元素移位后自动保持最新（无死代码）。
 *  GuideHighlight：引导高亮圆环。在目标 UI 周围画一个呼吸金色圆环 +
 *    半透明遮罩挖洞聚焦，pointer-events:none 不挡点击，纯 CSS 动画零轮询。
 *
 *  数据复用：
 *    - 离线引导（OfflineNpc）用 highlight 字段触发；
 *    - NPC 动态箭头用 [guide:名称] 标记触发（markers.js 解析）；
 *    - UILocator.exportLayout() 打包注入 AI 提示词，让 AI 知道当前 UI 布局。
 */
const UILocator = {
    /** 逻辑名 → CSS 选择器（唯一的"表"，只存选择器，不存坐标） */
    TARGETS: {
        settings: '#btnSettingsLeft',
        voice: '#btnVoice',
        tool: '#btnToolPanel',
        login: '#teahouse-guest-btns .tea-user-btn[onclick*="login"]',
        register: '#teahouse-guest-btns .tea-user-btn[onclick*="register"]',
        home: '.forum-nav-inner .forum-nav-item[onclick*="home"]',
        board: '#scriptZoneGroup .forum-nav-group-toggle',
        reward: '#rewardBtn',
        chat: '#chatBtn',
    },

    /** 高亮前需先打开侧栏的目标（元素在侧栏内，收起时定位不到） */
    NEED_SIDEBAR: { home: true, board: true },

    /** 定位某 UI：返回 { el, rect, cx, cy } 或 null（元素不存在/不可见） */
    locate(name) {
        const sel = this.TARGETS[name];
        if (!sel) return null;
        let el;
        try { el = document.querySelector(sel); } catch (e) { return null; }
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (!r || (r.width === 0 && r.height === 0)) return null;  // 隐藏元素视为不可定位
        return { el, rect: r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    },

    /** 打包当前 UI 布局（供 AI 提示词注入 / 离线定位复用） */
    exportLayout() {
        const out = {};
        for (const name of Object.keys(this.TARGETS)) {
            const p = this.locate(name);
            out[name] = p ? { x: Math.round(p.cx), y: Math.round(p.cy), visible: true }
                          : { visible: false };
        }
        return out;
    },
};

const GuideHighlight = {
    _el: null,
    _timer: null,
    _dismissHandler: null,

    /** 高亮指定 UI，并可选弹提示文字 */
    show(name, label) {
        // 目标在侧栏内：先打开侧栏，等动画结束再定位
        if (UILocator.NEED_SIDEBAR[name] && window.openForumPanel) {
            openForumPanel();
        }
        setTimeout(() => this._render(name, label), 320);
        this._bindClickDismiss();
    },

    /** 用户任意点击：光圈立即消失，同时点击照常触发被点击的内容（点击穿透，不拦截）。 */
    _bindClickDismiss() {
        if (this._dismissHandler) document.removeEventListener('click', this._dismissHandler, true);
        this._dismissHandler = () => {
            this.hide();
            document.removeEventListener('click', this._dismissHandler, true);
            this._dismissHandler = null;
        };
        document.addEventListener('click', this._dismissHandler, true);
    },

    _render(name, label) {
        const p = UILocator.locate(name);
        if (!p) { this.hide(); return; }
        if (!this._el) {
            this._el = document.createElement('div');
            this._el.className = 'guide-ring';
            document.body.appendChild(this._el);
        }
        const pad = 6;
        this._el.style.left = (p.rect.left - pad) + 'px';
        this._el.style.top = (p.rect.top - pad) + 'px';
        this._el.style.width = (p.rect.width + pad * 2) + 'px';
        this._el.style.height = (p.rect.height + pad * 2) + 'px';
        this._el.style.display = 'block';
        if (label && window.FloatingHint) {
            FloatingHint.at(p.el, label, { position: 'top', duration: 4200 });
        }
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this.hide(), 4200);
    },

    hide() {
        if (this._el) this._el.style.display = 'none';
    },
};

window.UILocator = UILocator;
window.GuideHighlight = GuideHighlight;
