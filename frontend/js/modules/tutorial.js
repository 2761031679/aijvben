/** AI剧本网 - API 获取教程模块（Tutorial）
 * ------------------------------------------------------------------
 *  职责：加载 /static/config/tutorials.json 教程数据，按「模型(provider) + 设备端(手机/电脑)」
 *  用通用模板渲染教程弹窗：图文步骤 + 「前往注册」跳转 + 居中「视频教程」按钮（跳转抖音）。
 *
 *  入口：
 *   - 设置弹窗「获取 API」按钮（NpcChat.openApiTutorial → Tutorial.open）
 *   - 对话中的按钮标记 [btn:文字:open_tutorial:provider]（NpcMarkers 渲染、chat.js 事件委托）
 *   - 离线引导回复中的同款按钮标记（offline_guide.txt）
 *
 *  数据驱动：新增模型或修改教程内容只需改 tutorials.json，无需改代码。
 *  JSON 加载失败时回退内置 DEFAULTS，保证教程功能始终可用。
 */
const Tutorial = {
    _config: null,      // 加载后的教程数据 { provider: {name, signupUrl, videoUrl, desktop, mobile} }
    _loading: null,
    _provider: null,    // 当前展示的模型
    _device: 'desktop', // 当前展示的设备端（desktop / mobile）

    /* 内置回退（JSON 缺失/非法时兜底：保证功能可用，内容精简） */
    DEFAULTS: {
        volcengine: {
            name: '火山引擎',
            signupUrl: 'https://signin.volcengine.com/auth/signup',
            videoUrl: 'https://www.douyin.com/user/self?from_tab_name=main&modal_id=7688805607654100239',
            desktop: { title: '火山引擎 API 获取教程（电脑端）', steps: [{ text: '打开火山引擎注册页，用手机号注册账号并完成个人实名认证；进入控制台后点击左上角「三」菜单进入「火山方舟」，在「模型广场」选择模型并点击「立即体验」；创建 API Key 并开通模型后，把 API Key 与模型 ID 填入本站设置即可。详见视频教程。', image: '' }], videoUrl: 'https://www.douyin.com/user/self?from_tab_name=main&modal_id=7688805607654100239' },
            mobile: { title: '火山引擎 API 获取教程（手机端）', steps: [{ text: '手机端操作流程与电脑端一致：注册 → 实名认证 → 火山方舟 → 模型广场 → 创建 API Key。推荐观看视频教程。', image: '' }], videoUrl: 'https://www.douyin.com/user/self?from_tab_name=main&modal_id=7688805607654100239' },
        },
    },

    /* ========== 设备判断 ========== */
    isMobile() {
        const ua = navigator.userAgent || '';
        if (/Android|iPhone|iPod|Mobile|HarmonyOS/i.test(ua)) return true;
        // 新版 iPad 的 UA 伪装成 Macintosh，用多点触控兜底
        if (/iPad|Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;
        return false;
    },

    /* ========== 配置加载 ========== */
    async ensure() {
        if (this._config) return this._config;
        if (this._loading) return this._loading;
        this._loading = this._load().finally(() => { this._loading = null; });
        return this._loading;
    },

    async _load() {
        try {
            const res = await fetch('/static/config/tutorials.json?_=' + Date.now(), { cache: 'no-store' });
            if (res.ok) {
                const data = await res.json();
                if (data && typeof data === 'object' && Object.keys(data).length) {
                    this._config = data;
                    return this._config;
                }
            }
        } catch (e) {
            console.warn('[Tutorial] 教程配置加载失败，使用内置回退:', e.message);
        }
        this._config = this.DEFAULTS;
        return this._config;
    },

    /** 供管理/调试强制重载 */
    async reload() {
        this._config = null;
        return this.ensure();
    },

    /* ========== 打开与渲染 ========== */
    /** 打开教程弹窗。provider 省略时取用户当前设置的 AI 提供商 */
    async open(provider) {
        const cfg = Utils.getConfig();
        this._provider = provider || cfg.aiProvider || 'deepseek';
        this._device = this.isMobile() ? 'mobile' : 'desktop';
        await this.ensure();
        this._render();
        Utils.openModal('tutorialModal');
    },

    close() {
        Utils.closeModal('tutorialModal');
    },

    /** 手动切换设备端标签 */
    switchDevice(device) {
        this._device = device === 'mobile' ? 'mobile' : 'desktop';
        this._render();
    },

    _render() {
        const body = document.getElementById('tutorialBody');
        if (!body) return;
        const t = (this._config || {})[this._provider] || (this._config || {})[this._provider === 'volcengine' ? 'deepseek' : 'volcengine'] || Object.values(this._config || {})[0];
        if (!t) { body.innerHTML = '<div class="tutorial-empty">教程暂未收录，敬请期待。</div>'; return; }

        const side = t[this._device] || t.desktop || {};
        const deviceName = this._device === 'mobile' ? '手机端' : '电脑端';
        const esc = s => Utils.escapeHtml(String(s ?? ''));

        // 设备切换标签
        const deviceTabs = `
            <div class="tutorial-device-tabs">
                <button class="tutorial-device-tab${this._device === 'desktop' ? ' active' : ''}" onclick="Tutorial.switchDevice('desktop')">🖥 电脑端</button>
                <button class="tutorial-device-tab${this._device === 'mobile' ? ' active' : ''}" onclick="Tutorial.switchDevice('mobile')">📱 手机端</button>
            </div>`;

        // 「前往注册」跳转按钮（signupUrl 有值时展示在标题下方）
        const signupBtn = t.signupUrl
            // href/src 同样是属性位：esc 不转引号，链接里一个 " 就能给 <a> 挂上额外属性，
            // 所以属性值统一 escapeAttr（内容文本仍用 esc）
            ? `<div class="tutorial-signup-row"><a class="tutorial-signup-btn" href="${Utils.escapeAttr(t.signupUrl)}" target="_blank" rel="noopener noreferrer">🚀 前往注册（打开 ${esc(t.name)} 官网）</a></div>`
            : '';

        // 图文步骤
        const steps = (side.steps || []).map((s, i) => `
            <div class="tutorial-step">
                <div class="tutorial-step-head"><span class="tutorial-step-no">${i + 1}</span><span class="tutorial-step-text">${esc(s.text)}</span></div>
                ${s.image ? `<img class="tutorial-step-img" src="${Utils.escapeAttr(s.image)}" alt="步骤${i + 1}配图" loading="lazy" onerror="this.style.display='none'">` : ''}
            </div>`).join('');

        // 视频按钮（居中，点击新标签页跳转抖音）
        const videoBtn = side.videoUrl
            ? `<div class="tutorial-video-row"><a class="tutorial-video-btn" href="${Utils.escapeAttr(side.videoUrl)}" target="_blank" rel="noopener noreferrer">▶ 视频教程（抖音）</a></div>`
            : '';

        body.innerHTML = `
            <h2 class="tutorial-title">📖 ${esc(side.title || `API 获取教程 · ${t.name || ''} · ${deviceName}`)}</h2>
            ${deviceTabs}
            ${signupBtn}
            ${videoBtn}
            <div class="tutorial-steps">${steps || '<div class="tutorial-empty">教程内容整理中，敬请期待。</div>'}</div>`;
    },
};

window.Tutorial = Tutorial;
