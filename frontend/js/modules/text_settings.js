/** AI剧本网 - 文字设置模块（TextSettings）
 * ------------------------------------------------------------------
 *  读取用户配置，把「字号 / 字体 / 加粗 / 行高 / 字间距 / 文字颜色」应用到
 *  CSS 变量（--app-font-size 等），全局生效。
 *
 *  字体：默认系统字体（零额外加载）；用户选择中文字体时按需动态加载对应 webfont，
 *  全部为免费可商用字体（思源黑体 / 霞鹜文楷）。
 */
const TextSettings = {
    FONTS: {
        system: {
            name: '系统默认',
            css: "'Segoe UI', system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
            urls: [],
        },
        noto: {
            name: '思源黑体（可商用）',
            css: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
            urls: [
                'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.0.18/400.css',
                'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.0.18/700.css',
            ],
        },
        wenkai: {
            name: '霞鹜文楷（可商用）',
            css: "'LXGW WenKai', 'PingFang SC', 'Microsoft YaHei', sans-serif",
            urls: ['https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/style.css'],
        },
    },
    _loaded: {},

    /** 读取配置并应用到 CSS 变量 */
    apply() {
        const c = (window.Utils && Utils.getConfig) ? Utils.getConfig() : {};
        const size = parseInt(c.fontSize) || 16;
        const font = this.FONTS[c.fontFamily] || this.FONTS.system;
        const weight = c.fontBold ? 600 : 400;
        const lh = parseFloat(c.lineHeight) || 1.6;
        const ls = parseFloat(c.letterSpacing) || 0;
        const color = c.textColor || '#e2e8f0';

        const root = document.documentElement;
        root.style.setProperty('--app-font-size', size + 'px');
        root.style.setProperty('--app-font-family', font.css);
        root.style.setProperty('--app-font-weight', weight);
        root.style.setProperty('--app-line-height', lh);
        root.style.setProperty('--app-letter-spacing', ls + 'px');
        root.style.setProperty('--text-primary', color);

        this._ensureFont(font);
    },

    /** 按需动态加载字体 CSS（幂等） */
    _ensureFont(font) {
        (font.urls || []).forEach(url => {
            if (this._loaded[url]) return;
            this._loaded[url] = true;
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = url;
            document.head.appendChild(link);
        });
    },

    /** 检测浏览器是否对网页文字做了缩放（Android「文本缩放」/系统字体大小等）。
     *  用一个 100px 的探针元素，实测渲染高度；若偏离 100px 说明被浏览器/系统缩放。 */
    detectBrowserScaling() {
        try {
            const probe = document.createElement('div');
            probe.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;font-size:100px;line-height:1;font-family:sans-serif;';
            probe.textContent = '测';
            document.body.appendChild(probe);
            const h = probe.getBoundingClientRect().height;
            document.body.removeChild(probe);
            const scale = Math.round(h);
            return { scaled: Math.abs(scale - 100) > 1, scale };
        } catch (e) {
            return { scaled: false, scale: 100 };
        }
    },
};

window.TextSettings = TextSettings;
