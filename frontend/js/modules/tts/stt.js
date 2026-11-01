/** AI剧本网 - 语音识别（STT）模块
 *
 *  直接使用服务端 Vosk 离线识别（/api/stt）：
 *  前端用 AudioContext 采集 PCM → 打包 WAV → 上传服务器识别。
 *
 *  不再使用浏览器 Web Speech API（SpeechRecognition）：
 *  其语音识别走 Google/Apple 云端，国内必然被墙，无法使用。
 *
 *  用户全程无需下载任何数据包；离线模型部署在服务器。
 */
const STT = {
    _stream: null,        // 麦克风流
    _audioCtx: null,      // AudioContext
    _source: null,
    _processor: null,
    _chunks: null,        // Float32Array 分段
    _sampleRate: null,
    _onResult: null,
    _recording: false,
    _autoStopTimer: null,

    isListening() { return this._recording; },

    /** 切换录音：开始 / 停止（停止后回调 onResult(text)） */
    async toggle(onResult) {
        if (this._recording) { await this.stop(); return; }
        this._onResult = onResult || null;
        await this._startServer();
    },

    /** 停止录音（若在录音中）并触发识别 */
    async stop() {
        if (this._stream || this._audioCtx) await this._finishServer();
        this._recording = false;
        this._clearAutoStop();
        this._setButtonActive(false);
    },

    /* ========== 服务端 Vosk 录音 ========== */
    async _startServer() {
        try {
            this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            this._recording = false;
            if (window.Utils) Utils.showToast('未授权麦克风，无法录音', 'error');
            return;
        }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        try {
            this._audioCtx = new Ctx({ sampleRate: 16000 });  // 对齐 Vosk 16kHz 模型
        } catch (e) {
            this._audioCtx = new Ctx();
        }
        this._sampleRate = this._audioCtx.sampleRate;
        this._source = this._audioCtx.createMediaStreamSource(this._stream);
        this._processor = this._audioCtx.createScriptProcessor(4096, 1, 1);
        this._chunks = [];
        this._processor.onaudioprocess = (e) => {
            this._chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        };
        this._source.connect(this._processor);
        this._processor.connect(this._audioCtx.destination);
        this._recording = true;
        this._setButtonActive(true);
        if (window.Utils) Utils.showToast('正在录音，再次点击语音按钮结束（最长 15 秒）', 'info');
        // 自动停止，避免用户忘点
        this._autoStopTimer = setTimeout(() => this.stop(), 15000);
    },

    async _finishServer() {
        const chunks = this._chunks || [];
        const sampleRate = this._sampleRate || 16000;
        this._clearAutoStop();
        // 断开采集
        if (this._processor) { try { this._processor.disconnect(); } catch (e) {} this._processor = null; }
        if (this._source) { try { this._source.disconnect(); } catch (e) {} this._source = null; }
        if (this._audioCtx) { try { this._audioCtx.close(); } catch (e) {} this._audioCtx = null; }
        if (this._stream) { this._stream.getTracks().forEach(t => t.stop()); this._stream = null; }

        if (!chunks.length) { if (window.Utils) Utils.showToast('未录到声音，请重试', 'warn'); return; }
        const merged = mergeFloat32(chunks);
        const wav = pcmToWav(merged, sampleRate);
        try {
            // 后端 /api/stt 使用 File 参数（multipart/form-data），故用 FormData 上传，
            // 不能发 raw audio/wav（否则后端解析请求体失败返回 422）。
            const formData = new FormData();
            formData.append('file', wav, 'audio.wav');
            const res = await fetch('/api/stt', { method: 'POST', body: formData });
            if (!res.ok) throw new Error('识别服务不可用 (' + res.status + ')');
            const data = await res.json();
            if (data.text) this._emit(data.text);
            else if (window.Utils) Utils.showToast('未能识别语音，请重试', 'warn');
        } catch (e) {
            if (window.Utils) Utils.showToast(e.message || '语音识别失败', 'error');
        }
    },

    _emit(text) {
        this._recording = false;
        this._setButtonActive(false);
        if (this._onResult) { const cb = this._onResult; this._onResult = null; cb(text); }
    },

    _clearAutoStop() {
        if (this._autoStopTimer) { clearTimeout(this._autoStopTimer); this._autoStopTimer = null; }
    },

    _setButtonActive(active) {
        const btn = document.getElementById('btnVoice');
        if (btn) {
            btn.classList.toggle('recording', active);
            btn.style.color = active ? '#ff6b6b' : '';
        }
    },
};

/** 合并 Float32Array 分段 */
function mergeFloat32(chunks) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const merged = new Float32Array(len);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return merged;
}

/** Float32 PCM → 16-bit 单声道 WAV Blob */
function pcmToWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([view], { type: 'audio/wav' });
}

window.STT = STT;
