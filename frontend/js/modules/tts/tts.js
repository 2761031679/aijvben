/** AI剧本网 - TTS 语音合成模块 */
const TTS = {
    _audio: null,
    _currentU: null,     // 当前浏览器 utterance（供 stop() 摘除回调，避免级联跳段）
    _stoppedAt: 0,       // 上次手动 stop 时间戳（规避 cancel 后立即 speak 的浏览器竞态）
    _isPlaying: false,

    /**
     * 朗读文本。引擎由设置 ttsEngine 决定（默认值见 CONFIG.DEFAULT_CONFIG.ttsEngine）：
     *  - 'server' ：使用服务端微软语音（/api/tts，默认）—— 站内 NPC 音色配置只对它生效
     *  - 'browser'：使用浏览器内置 Web Speech API（无需服务器联网，支持中文）
     * 服务端不可用时一律自动回退到浏览器朗读，用户听感不中断。
     */
    /**
     * 朗读文本（排队渲染：并发请求会进入队列串行播放，避免叠加/打断）。
     * 引擎由设置 ttsEngine 决定（默认值见 CONFIG.DEFAULT_CONFIG.ttsEngine）：
     *  - 'server' ：服务端微软语音（/api/tts，默认）—— 站内 NPC 音色配置只对它生效
     *  - 'browser'：浏览器内置 Web Speech API（无需服务器联网，支持中文）
     * 服务端不可用时一律自动回退到浏览器朗读，用户听感不中断。
     */
    async speak(text, voiceId, onEnded) {
        if (!text || !text.trim()) { if (onEnded) onEnded(); return; }
        this._queue = this._queue || [];
        this._queue.push({ text, voiceId, onEnded });
        this._pump();
    },

    /** 串行消费语音队列 */
    async _pump() {
        if (this._pumping) return;
        const item = this._queue && this._queue.shift();
        if (!item) { this._pumping = false; return; }
        this._pumping = true;
        const done = () => {
            this._pumping = false;
            try { item.onEnded && item.onEnded(); } catch (e) { console.error('[TTS] onEnded', e); }
            setTimeout(() => this._pump(), 30);   // 段间轻微停顿，听感更自然
        };
        // 兜底值跟 CONFIG.DEFAULT_CONFIG.ttsEngine 保持一致（'server'）：
        // 这里再兜一次，是为了 Utils 还没就绪时也不至于悄悄退回浏览器内置语音。
        const engine = (typeof Utils !== 'undefined' && Utils.getConfig) ? (Utils.getConfig().ttsEngine || 'server') : 'server';
        // 本页若已判定「服务端语音不可用」（连续失败过），直接走浏览器：
        // 否则每句台词都要先撞一次必然失败的请求再退回，白等一个来回、还刷提示。
        // 问一次服务端「你到底能不能合成」（GET /api/tts/health，结果本页缓存）。
        // 光看设置项不够：服务端可能没装 edge_tts，或连不上微软（2026-10 就出过一次
        // 微软回 403、握手直接失败）。没有这一步，每个用户每天第一次朗读都要先白撞失败。
        const useServer = engine === 'server' && !this._serverDown && (await this._serverUsable());
        try {
            if (useServer) {
                this._speakServer(item.text, item.voiceId, done)
                    .catch((err) => {
                        this._noteServerFailure(err);
                        this._speakBrowser(item.text, item.voiceId, done);
                    });
            } else {
                this._speakBrowser(item.text, item.voiceId, done);
            }
        } catch (e) {
            Utils.showToast(e.message, 'error');
            done();
        }
    },

    /**
     * 服务端语音此刻到底能不能用（本页缓存一次，不重复问）。
     * 探针本身失败（断网、后端没起）一律当「不可用」，让朗读退回浏览器，
     * 而不是让用户点了朗读没反应。
     * @returns {Promise<boolean>}
     */
    async _serverUsable() {
        if (this._healthOk !== undefined) return this._healthOk;
        try {
            const res = await fetch('/api/tts/health', { cache: 'no-store' });
            if (!res.ok) { this._healthOk = false; return false; }
            const data = await res.json();
            this._healthOk = !!data.available;
            if (!this._healthOk) {
                console.warn('[TTS] 服务端语音不可用，本次会话改用浏览器朗读（原因：' + (data.reason || '未知') + '）');
            }
        } catch (e) {
            this._healthOk = false;
        }
        return this._healthOk;
    },

    /** 主动问一次服务端语音可用性（设置面板的「重新检测」用）。force=true 忽略缓存。 */
    async probeServer(force) {
        if (force) { this._healthOk = undefined; this._serverDown = false; }
        return await this._serverUsable();
    },

    /** 清掉本页的服务端语音结论（用户换网络/站长修好之后，不必刷新页面） */
    resetServerHealth() {
        this._healthOk = undefined;
        this._serverDown = false;
    },

    /**
     * 服务端语音失败后的降级判定（由 _pump 的 catch 调用）。
     * 为什么需要它：默认引擎是 server 之后，服务端一旦不可用（例如没装 edge_tts，
     * /api/tts 直接回 503），每句台词都会失败一次——不收敛就会变成「每句话一个报错提示
     * + 一次毫无意义的白等往返」。这里连续 2 次失败就判定本页不可用，之后的台词直接走浏览器。
     * 只做本页内存标记，不落盘：刷新页面或改设置就重新给服务端一次机会。
     * @returns {boolean} 是否已计入降级判定
     */
    _noteServerFailure(err) {
        // 自动播放被浏览器拦下（NotAllowedError）、播放中途被打断（AbortError）都不是
        // 「服务端坏了」，只是这一次没能播出来：照旧退回浏览器朗读，但不计入降级判定，
        // 否则用户一次没点过页面就永久失去服务端音色。
        const name = err && err.name;
        if (name === 'NotAllowedError' || name === 'AbortError') {
            Utils.showToast('服务端语音失败，改用浏览器朗读', 'warn');
            return false;
        }
        this._serverFails = (this._serverFails || 0) + 1;
        if (this._serverFails < 2) {
            Utils.showToast('服务端语音失败，改用浏览器朗读', 'warn');
            return true;
        }
        if (!this._serverDown) {
            this._serverDown = true;
            console.warn('[TTS] 服务端语音连续失败，本次会话改用浏览器朗读（刷新页面或改设置可重试）：', err && err.message);
            Utils.showToast('服务端语音不可用，本次会话改用浏览器朗读', 'warn');
        }
        return true;
    },

    /** 服务端微软语音（依赖服务器可访问微软 TTS 接口） */
    async _speakServer(text, voiceId, onEnded) {
        this._isPlaying = true;
        const config = (typeof Utils !== 'undefined' && Utils.getConfig) ? Utils.getConfig() : {};
        const volume = (config.voiceVolume != null ? config.voiceVolume : 80) / 100;
        const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: voiceId || CONFIG.TTS_VOICES[0]?.id }),
        });
        if (!res.ok) throw new Error(`TTS 请求失败 (${res.status})`);
        this._serverFails = 0;   // 这一句拿到了音频，说明服务端是好的，失败计数清零
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        this._audio = new Audio(url);
        this._audio.volume = Math.max(0, Math.min(1, volume));
        this._audio.onended = () => {
            this._isPlaying = false;
            URL.revokeObjectURL(url);
            if (onEnded) onEnded();
        };
        this._audio.onerror = () => {
            this._isPlaying = false;
            URL.revokeObjectURL(url);
            Utils.showToast('语音播放失败', 'error');
            if (onEnded) onEnded();
        };
        await this._audio.play();
    },

    /** 浏览器内置语音（Web Speech API，离线可用、支持中文） */
    _speakBrowser(text, voiceId, onEnded) {
        const synth = window.speechSynthesis;
        if (!synth) {
            this._isPlaying = false;
            Utils.showToast('当前浏览器不支持语音合成', 'error');
            if (onEnded) onEnded();
            return;
        }
        try {
            this._isPlaying = true;
            const config = (typeof Utils !== 'undefined' && Utils.getConfig) ? Utils.getConfig() : {};
            const volume = (config.voiceVolume != null ? config.voiceVolume : 80) / 100;
            const u = new SpeechSynthesisUtterance(text);
            u.lang = 'zh-CN';
            u.volume = volume;
            const v = this._pickBrowserVoice(voiceId);
            if (v) u.voice = v;

            // 记录当前 utterance，stop() 时可摘除其回调，避免 cancel 触发 onEnded 造成级联跳段
            this._currentU = u;

            // ✅ 用标志位防止重复回调
            let called = false;
            const done = () => {
                if (called) return;
                called = true;
                this._isPlaying = false;
                if (this._currentU === u) this._currentU = null;
                if (onEnded) onEnded();
            };

            u.onend = done;
            u.onerror = () => {
                Utils.showToast('浏览器语音播放失败', 'error');
                done();
            };

            // ✅ 不 cancel()，让队列自然播放，避免打断前一个语音。
            // 但若刚被 stop() 取消过，浏览器对「cancel 后立即 speak」存在丢弃 utterance 的竞态，
            // 这里加极短延时，确保下一段语音能正常起播。
            const gap = Date.now() - (this._stoppedAt || 0);
            if (gap < 150) setTimeout(() => synth.speak(u), 150 - gap);
            else synth.speak(u);
        } catch (e) {
            this._isPlaying = false;
            Utils.showToast(e.message, 'error');
            if (onEnded) onEnded();
        }
    },

    /** 读取浏览器本地可用的中文音色列表（处理 getVoices 异步加载）。
     *  返回 [{ id: voiceURI, name }]，供设置页「朗读音色」下拉（浏览器引擎）使用。 */
    async listBrowserVoices() {
        const synth = window.speechSynthesis;
        if (!synth) return [];
        let vs = synth.getVoices() || [];
        if (!vs.length) {
            await new Promise((resolve) => {
                let done = false;
                const finish = () => { if (!done) { done = true; resolve(); } };
                synth.addEventListener('voiceschanged', finish, { once: true });
                setTimeout(finish, 300);
            });
            vs = synth.getVoices() || [];
        }
        const zh = vs.filter(v => v.lang && v.lang.toLowerCase().startsWith('zh'));
        return (zh.length ? zh : vs).map(v => ({ id: v.voiceURI || v.name, name: v.name || v.voiceURI }));
    },

    /** 选择浏览器中匹配的音色：voiceURI/name 精确匹配 → 模糊匹配 → 中文兜底 */
    _pickBrowserVoice(voiceId) {
        const synth = window.speechSynthesis;
        if (!synth) return null;
        const vs = synth.getVoices() || [];
        if (!vs.length) return null;
        const kw = (voiceId || '').toLowerCase();
        let m = null;
        if (kw) {
            m = vs.find(v => (v.voiceURI && v.voiceURI.toLowerCase() === kw) || (v.name && v.name.toLowerCase() === kw));
            if (!m) m = vs.find(v => (v.voiceURI && v.voiceURI.toLowerCase().includes(kw)) || (v.name && v.name.toLowerCase().includes(kw)));
        }
        if (!m) m = vs.find(v => v.lang && v.lang.toLowerCase().startsWith('zh'));
        return m || vs[0];
    },

    stop() {
        this._queue = [];
        this._pumping = false;
        this._stoppedAt = Date.now();
        // 关键：手动停止前摘除当前 utterance / audio 的回调，避免 cancel/pause 触发 onEnded。
        // 否则自动播放模式下，stop() 会被误判为「本段读完」而级联推进到末段（点一下播完全部）。
        if (this._currentU) {
            try { this._currentU.onend = null; this._currentU.onerror = null; } catch (e) {}
            this._currentU = null;
        }
        if (this._audio) {
            try { this._audio.onended = null; this._audio.onerror = null; this._audio.pause(); this._audio.currentTime = 0; } catch (e) {}
            this._audio = null;
        }
        if (window.speechSynthesis) {
            try { window.speechSynthesis.cancel(); } catch (e) {}
        }
        this._isPlaying = false;
    },

    async getVoices() {
        try {
            return await API.get('/tts/voices');
        } catch (e) {
            return CONFIG.TTS_VOICES || [];
        }
    },

    isPlaying() {
        return this._isPlaying;
    }
};

window.TTS = TTS;
