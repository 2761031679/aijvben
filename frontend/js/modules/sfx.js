/** AI剧本网 - 音效播放模块（SfxPlayer）
 * ------------------------------------------------------------------
 *  用 Web Audio API 播放短音效（发送/接收提示音）。
 *  关键：不走 <audio> 元素，因此不会进入浏览器的「媒体会话」（Media Session），
 *  移动端也就不会被拆成通知栏/锁屏的媒体控制小窗口。
 *
 *  音效文件：/static/audio/sfx/*.mp3，首次用户交互时预加载并解码为 AudioBuffer 缓存；
 *  播放用 AudioBufferSourceNode（短音效，播完即弃）。
 */
const SfxPlayer = {
    _ctx: null,
    _buffers: {},     // name -> AudioBuffer
    _loading: {},     // name -> Promise（防并发重复加载）

    SFX: {
        send: '/static/audio/sfx/send.mp3',        // 信息发送
        receive: '/static/audio/sfx/receive.mp3',  // 信息接收
    },

    _ensureCtx() {
        try {
            if (!this._ctx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                this._ctx = new AC();
            }
            if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
            return this._ctx;
        } catch (e) { return null; }
    },

    /** 预加载某个音效（幂等，失败静默） */
    async load(name) {
        const url = this.SFX[name];
        if (!url || this._buffers[name] || this._loading[name]) return;
        this._loading[name] = (async () => {
            try {
                const ctx = this._ensureCtx();
                if (!ctx) return;
                const resp = await fetch(url);
                const ab = await resp.arrayBuffer();
                const buf = await ctx.decodeAudioData(ab);
                this._buffers[name] = buf;
            } catch (e) {
                console.warn('[SfxPlayer] 音效加载失败:', name, (e && e.message) || e);
            } finally {
                this._loading[name] = null;
            }
        })();
        await this._loading[name];
    },

    /** 播放某个音效（未加载则先加载） */
    async play(name) {
        const ctx = this._ensureCtx();
        if (!ctx) return;
        if (!this._buffers[name]) await this.load(name);
        const buf = this._buffers[name];
        if (!buf) return;
        try {
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start(0);
        } catch (e) { /* 忽略 */ }
    },

    /** 预加载全部音效 */
    preloadAll() {
        Object.keys(this.SFX).forEach(n => this.load(n));
    },
};

window.SfxPlayer = SfxPlayer;

/* 首次用户交互时解锁 AudioContext（浏览器自动播放策略）并预加载音效 */
let _sfxUnlocked = false;
const _sfxUnlock = () => {
    if (_sfxUnlocked) return;
    _sfxUnlocked = true;
    ['pointerdown', 'touchstart', 'keydown'].forEach(ev => document.removeEventListener(ev, _sfxUnlock));
    if (window.SfxPlayer) SfxPlayer.preloadAll();
};
['pointerdown', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, _sfxUnlock));
