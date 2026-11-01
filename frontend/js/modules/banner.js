/** AI剧本网 - 首页轮播海报模块
 *  数据来自 /api/site-settings 的 home_banners 配置（站长/管理员后台可编辑）。
 *  banners 为空数组或 enabled=false 时，不渲染海报模块。 */
const Banner = {
    _timer: null,
    _index: 0,
    _count: 0,

    /**
     * 挂载轮播到指定容器。
     * @param {HTMLElement} container 容器节点
     * @param {object} config { enabled, interval, banners:[{image,link,title}] }
     */
    mount(container, config) {
        if (!container) return;
        this._clear();
        const cfg = config || {};
        const banners = Array.isArray(cfg.banners) ? cfg.banners.filter(b => b && (b.image || '').trim()) : [];
        if (!cfg.enabled || !banners.length) {
            container.innerHTML = '';
            return;
        }
        this._count = banners.length;
        const interval = Math.max(1500, parseInt(cfg.interval, 10) || 4000);

        const slides = banners.map((b) => {
            const link = (b.link || '').trim();
            const title = (b.title || '').trim();
            const img = `<img src="${Utils.escapeHtml(b.image)}" alt="${Utils.escapeHtml(title || '活动海报')}" loading="lazy"
                onerror="this.closest('.banner-slide').style.display='none'">`;
            if (!link) return `<div class="banner-slide">${img}</div>`;
            const external = /^https?:\/\//i.test(link);
            const attrs = external ? 'target="_blank" rel="noopener noreferrer"' : '';
            return `<a class="banner-slide" href="${Utils.escapeHtml(link)}" ${attrs}${title ? ` title="${Utils.escapeHtml(title)}"` : ''}>${img}</a>`;
        }).join('');

        const dots = banners.length > 1
            ? `<div class="banner-dots">${banners.map((_, i) =>
                `<span class="banner-dot ${i === 0 ? 'active' : ''}" data-i="${i}"></span>`).join('')}</div>`
            : '';

        container.innerHTML = `
            <div class="banner-carousel">
                <div class="banner-track">${slides}</div>
                ${dots}
            </div>`;

        container.querySelectorAll('.banner-dot').forEach((dot) => {
            dot.addEventListener('click', () => this._go(parseInt(dot.getAttribute('data-i'), 10)));
        });

        if (banners.length > 1) {
            this._timer = setInterval(() => this._go((this._index + 1) % this._count), interval);
        }
    },

    _go(i) {
        const track = document.querySelector('.banner-carousel .banner-track');
        if (!track) return;
        this._index = ((i % this._count) + this._count) % this._count;
        track.style.transform = `translateX(-${this._index * 100}%)`;
        document.querySelectorAll('.banner-carousel .banner-dot').forEach((d) => {
            d.classList.toggle('active', parseInt(d.getAttribute('data-i'), 10) === this._index);
        });
    },

    _clear() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        this._index = 0;
        this._count = 0;
    },
};

window.Banner = Banner;
