/**
 * BlipVoice —— NPC「说话音」：一个字一个短音，像游戏角色咕哝（Animal Crossing / 桌宠那种）
 *
 * 为什么要有它：
 *   录音包有人录的最好听，但它只适合短句，长段剧情没有那么多录音；
 *   合成朗读又要联网、要音色、还会被机房 IP 拦（微软 403）。
 *   而「每字一下」这条路**纯 Web Audio**，不联网、不要音色、不要任何音频文件，
 *   跟着打字机一个字符一个短音，长段也能一路念到底，延迟为 0。
 *
 * 相对「每字新建两个振荡器」的做法，这里的优化：
 *   1) 音色**预渲染成 AudioBuffer**，一个音只新建一个 BufferSource（几百个字也不卡、不堆积节点）；
 *   2) 音高抖动**烘进多份 buffer**，播放时不做任何随机运算，只要挑一份；
 *   3) 只在音高/波形变了才重建 buffer（默认一次会话一次）；
 *   4) 单音时长按语速自适应 —— 语速很快时音更短，避免前一个音还没收尾下一个就来了（糊成一团）；
 *   5) 有 cancel()：换 NPC、发新消息、断开时立刻停，不会留下一串尾音；
 *   6) 自动处理浏览器自动播放策略：首次点击解锁 + 切回标签页时 resume。
 *
 * 与「录音包音效」的分工：录音包管**短句的语气**（嗯、哼），这里管**把正文念出来**。
 */
const BlipVoice = {
    _ctx: null,
    _master: null,
    _bufs: null,          // 预渲染的几份音（已经带好各自的音高抖动）
    _bufKey: '',          // 当前 buffer 对应的「音高|波形」，变了才重建
    _unlocked: false,
    _live: [],            // 正在响的 source（用于 cancel 与清账）
    _lastAt: 0,           // 上一声的时间，用来做最小间隔保护

    /** 读设置；缺项给默认值。全部集中在这里，别处不要再散读 config。 */
    cfg() {
        const c = (window.Utils && Utils.getConfig) ? Utils.getConfig() : {};
        return {
            pitch: num(c.blipPitch, 1.0),                       // 0.7 低 / 1.0 中 / 1.4 高
            speed: num(c.blipSpeed, 1.15),                       // 0.8 慢 / 1.0 中 / 1.3 快（默认偏快）
            wave: c.blipWave || 'triangle',                      // triangle 软 / square 清脆 / sine 闷
            volume: clamp(num(c.voiceVolume, 80) / 100, 0, 1) * 0.9,
            gapMs: num(c.blipGapMs, 0),                          // 0 = 跟打字机走，不额外等
        };
    },

    /** Web Audio 可用性（老浏览器 / 被策略禁掉时返回 false，调用方应退回无朗读） */
    available() {
        return !!(window.AudioContext || window.webkitAudioContext);
    },

    /** 懒建 AudioContext。第一次调用时浏览器可能还没给「播放许可」，先建出来等解锁。 */
    _ensure() {
        if (!this.available()) return false;
        if (!this._ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            try {
                this._ctx = new AC();
                this._master = this._ctx.createGain();
                this._master.gain.value = 1;
                this._master.connect(this._ctx.destination);
            } catch (e) {
                console.warn('[BlipVoice] 无法创建 AudioContext', e);
                return false;
            }
        }
        if (this._ctx.state === 'suspended') {
            // 没解锁之前 resume() 会被静默拒绝，不报错；交给 unlock() 再试
            this._ctx.resume().catch(() => {});
        }
        return true;
    },

    /** 首次用户手势里调用一次（脚本加载时自动挂在 document 上，见文件末尾） */
    unlock() {
        if (!this._ensure()) return;
        this._ctx.resume().then(() => { this._unlocked = true; }).catch(() => {});
        // 解锁的同时把音色烤好，第一次真正要出声时不用等
        this._buildBuffers();
    },

    /** 预渲染 6 份短音：同一基频、各自带一点音高抖动（jitter 烘进 buffer，播放时零运算） */
    _buildBuffers() {
        if (!this._ensure()) return;
        const { pitch, wave } = this.cfg();
        const key = pitch.toFixed(3) + '|' + wave;
        if (this._bufKey === key && this._bufs) return;
        const sr = this._ctx.sampleRate;
        const base = 620 * pitch;
        // 单音时长：短到听起来是「一下」，又不至于变成咔哒声
        const durSec = 0.038;
        const n = Math.max(8, Math.floor(sr * durSec));
        const out = [];
        const JITTER = 0.08;
        for (let k = 0; k < 6; k++) {
            const jitter = 1 + (Math.random() * 2 - 1) * JITTER;
            const f0 = base * jitter;
            const buf = this._ctx.createBuffer(1, n, sr);
            const d = buf.getChannelData(0);
            const attackN = Math.max(1, Math.floor(sr * 0.003));   // 3ms 起音，防爆音
            for (let i = 0; i < n; i++) {
                const t = i / n;
                const env = Math.exp(-4.2 * t);                    // 收尾
                const atk = i < attackN ? i / attackN : 1;
                const f = f0 * (1 - 0.18 * t);                     // 尾巴往下掉一点，听着不像蜂鸣
                const ph = 2 * Math.PI * f * (i / sr);
                let s;
                if (wave === 'square') s = Math.sin(ph) >= 0 ? 1 : -1;
                else if (wave === 'sine') s = Math.sin(ph);
                else s = (2 / Math.PI) * Math.asin(Math.sin(ph));  // triangle
                d[i] = s * env * atk * 0.20;
            }
            out.push(buf);
        }
        this._bufs = out;
        this._bufKey = key;
    },

    /** 清掉已经响完的 source，别让数组无限长 */
    _prune() {
        const now = this._now();
        this._live = this._live.filter(s => s._endAt > now);
    },

    _now() { return this._ctx ? this._ctx.currentTime : 0; },

    /** 响一声。返回这一声的时长（毫秒）；没准备好返回 0。 */
    blip(opts) {
        if (!this._ensure()) return 0;
        // 还没拿到播放许可（用户一次都没点过页面）时直接不出声：
        // 此时排进去的每一句都只是挂在暂停的时钟上，等解锁那一刻会「噼里啪啦」一起炸出来。
        // 用户反正也听不见，不如丢掉。
        if (this._ctx.state !== 'running') {
            this._ctx.resume().catch(() => {});
            return 0;
        }
        this._buildBuffers();
        if (!this._bufs || !this._bufs.length) return 0;

        const cfg = this.cfg();
        const minGap = 0.018;                       // 最小间隔：防止极快打字时糊成一片噪音
        const now = this._now();
        if (now - this._lastAt < minGap) return 0;

        const src = this._ctx.createBufferSource();
        src.buffer = this._bufs[(Math.random() * this._bufs.length) | 0];
        // 每声再随机一点音量，机械感立刻少一半
        const g = this._ctx.createGain();
        g.gain.value = cfg.volume * (0.85 + Math.random() * 0.3);
        src.connect(g).connect(this._master);
        const dur = src.buffer.duration;
        src.start();
        src._endAt = now + dur;
        this._live.push(src);
        src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) {} };
        this._lastAt = now;
        if (this._live.length > 24) this._prune();
        return dur * 1000;
    },

    /** 给一个字符决定要不要响：标点、空白只「换气」不出声。 */
    blipFor(ch) {
        if (!ch) return 0;
        if (/[\s\u3000，。！？、,.!?…~—：；「」『』（）()《》〈〉【】\-—]/.test(ch)) return 0;
        return this.blip();
    },

    /**
     * 一口气把 text 念完（不打字机时用）。
     * @returns 大约多久念完（毫秒），可直接用来排「读完自动下一段」
     */
    speak(text, opts) {
        const cfg = this.cfg();
        const speed = num(opts && opts.speed, cfg.speed);
        const plain = this._plain(text);
        if (!plain) return 0;
        this._ensure();
        this._buildBuffers();

        // 每字节奏：基础 55ms，按 speed 缩。极快（speed>=1.3）约 30ms/字。
        const perCharMs = Math.max(16, Math.round(55 / speed));
        let t = 12;                                  // 稍微延后一点，避开当前这一帧
        const total = [];
        const chars = Array.from(plain);
        let voiced = 0;
        for (let i = 0; i < chars.length; i++) {
            const ch = chars[i];
            const isPunct = /[\s\u3000，。！？、,.!?…~—：；「」『』（）()《》〈〉【】\-—]/.test(ch);
            if (isPunct) {
                // 标点 = 换气：句末停久一点，逗号短促
                t += /[。！？.!?]/.test(ch) ? perCharMs * 2.2 : perCharMs * 0.8;
                continue;
            }
            total.push(t);
            voiced++;
            t += perCharMs;
            // 长句每 8~12 字停一拍，否则一口气念完没有喘息，听感很赶
            if (voiced % 10 === 0) t += perCharMs * 1.2;
        }
        if (!total.length) return 0;
        // 逐声排程（Web Audio 的时间轴精度远高于 setTimeout）
        const startAt = this._now() + 0.012;
        for (const ms of total) {
            this._scheduleAt(startAt + ms / 1000);
        }
        return t;
    },

    _scheduleAt(when) {
        if (!this._ctx || !this._bufs) return;
        const cfg = this.cfg();
        const src = this._ctx.createBufferSource();
        src.buffer = this._bufs[(Math.random() * this._bufs.length) | 0];
        const g = this._ctx.createGain();
        g.gain.value = cfg.volume * (0.85 + Math.random() * 0.3);
        src.connect(g).connect(this._master);
        src.start(when);
        src._endAt = when + src.buffer.duration;
        this._live.push(src);
        src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) {} };
        if (this._live.length > 64) this._prune();
    },

    /** 立刻闭嘴：换 NPC、来新消息、离开页面都该调 */
    cancel() {
        const now = this._now();
        for (const s of this._live) {
            try { s.stop(now); } catch (e) {}
        }
        this._live = [];
        this._lastAt = 0;
    },

    /** 去标记、去控制字符，只留能念的字（NpcDecoder 在时优先用它，保证与气泡里看到的一致） */
    _plain(text) {
        if (window.NpcDecoder && NpcDecoder.toPlainText) {
            text = NpcDecoder.toPlainText(text || '');
        }
        return String(text || '').replace(/[\u0000-\u001f]+/g, ' ').trim();
    },

    /** 试听（设置面板里点「试听」按钮时用） */
    preview(text) {
        this.unlock();
        this.cancel();
        return this.speak(text || '今天也辛苦啦');
    },
};

function num(v, d) { const n = Number(v); return isNaN(n) ? d : n; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 浏览器要求「先有一次用户交互」才允许出声：这里挂一次性监听自动解锁。
// 不用 {once:true} 是因为有的浏览器在 AudioContext 没建好前会把首次手势吃掉，
// 用「成功了才摘监听」更稳。
(function () {
    const tryUnlock = () => {
        BlipVoice.unlock();
        if (BlipVoice._unlocked || BlipVoice._ctx) {
            document.removeEventListener('pointerdown', tryUnlock, true);
            document.removeEventListener('keydown', tryUnlock, true);
        }
    };
    document.addEventListener('pointerdown', tryUnlock, true);
    document.addEventListener('keydown', tryUnlock, true);
    // 切回标签页时 AudioContext 常被挂起，回来要主动叫醒
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && BlipVoice._ctx && BlipVoice._ctx.state === 'suspended') {
            BlipVoice._ctx.resume().catch(() => {});
        }
    });
})();

window.BlipVoice = BlipVoice;
