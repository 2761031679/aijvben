/**
 * NpcSfx — NPC 自定义录音包（音效）
 *
 * 为什么要有它：合成语音念「嗯」「哼」「唔？」这类极短的语气，怎么调都像机器；
 * 而玩家真正记住一个 NPC 的，往往就是那声「哼哦」。所以简单语句不走合成，
 * 直接播一段人录的短音（像 MC 村民那样）。
 *
 * 录音包放在服务器 npc_configs/<npc_id>/sfx/ 下，文件名前缀就是「桶」：
 *   happy_1.mp3 / happy_2.mp3 / question_1.mp3 / angry_1.mp3 / idle_1.mp3 ...
 * 同一个桶里有多条时随机挑一条，避免每次听见一模一样。
 *
 * 目录不存在或里面没有音频 → 这个 NPC 没有录音包（`has()` 为 false），
 * 前端据此把设置里的相关选项置灰 —— 不报错、不弹窗，就是没有。
 */
const NpcSfx = {
    _npcId: null,
    _pack: null,          // { npc_id, has_pack, files:[{name,bucket,url}] }
    _byBucket: {},        // bucket -> [url]
    _loading: null,
    _cache: {},           // npcId -> pack（一次会话内不重复问）
    _audio: null,         // 复用一个 Audio，避免每次播都新建对象

    /** 读某个 NPC 的录音包清单。同一 NPC 只请求一次（除非 force）。 */
    async load(npcId, opts) {
        const force = !!(opts && opts.force);
        if (!npcId) { this._npcId = null; this._pack = null; this._byBucket = {}; return null; }
        if (!force && this._cache[npcId]) {
            this._apply(npcId, this._cache[npcId]);
            return this._pack;
        }
        // 并发保护：切换 NPC 时可能被连点，避免同一 NPC 打两次
        if (this._loading && this._loading.id === npcId) return this._loading.p;
        const p = (async () => {
            try {
                const d = await API.get(`/npc/${npcId}/sfx`);
                this._cache[npcId] = d;
                this._apply(npcId, d);
                return d;
            } catch (e) {
                // 拿不到就当没有包：录音包是锦上添花，不能因为它报错挡住切人
                const empty = { npc_id: npcId, has_pack: false, files: [] };
                this._cache[npcId] = empty;
                this._apply(npcId, empty);
                console.warn('[NpcSfx] 读取录音包失败（按无录音包处理）', e);
                return empty;
            } finally {
                this._loading = null;
            }
        })();
        this._loading = { id: npcId, p };
        return p;
    },

    _apply(npcId, pack) {
        this._npcId = npcId;
        this._pack = pack || null;
        const by = {};
        for (const f of ((pack && pack.files) || [])) {
            (by[f.bucket] = by[f.bucket] || []).push(f.url);
        }
        this._byBucket = by;
        this._syncSettingsUI();
    },

    has() { return !!(this._pack && this._pack.has_pack); },
    buckets() { return Object.keys(this._byBucket); },
    count() { return (this._pack && this._pack.files || []).length; },

    /** 有没有这个桶；没有时退到 idle，再退到任意一条（宁可用同一个人别的声音，也不要沉默） */
    _pickUrl(bucket) {
        const b = this._byBucket;
        const pool = (b[bucket] && b[bucket].length) ? b[bucket]
            : (b.idle && b.idle.length) ? b.idle
            : null;
        if (pool) return pool[Math.floor(Math.random() * pool.length)];
        const all = Object.values(b).flat();
        if (!all.length) return null;
        return all[Math.floor(Math.random() * all.length)];
    },

    /** 播一个桶。返回是否真的播了（没包/被关掉返回 false，调用方据此决定要不要退回朗读）。 */
    play(bucket) {
        if (!this.has()) return false;
        const url = this._pickUrl(bucket);
        if (!url) return false;
        try {
            if (!this._audio) this._audio = new Audio();
            const cfg = (window.Utils && Utils.getConfig) ? Utils.getConfig() : {};
            const vol = Number(cfg.sfxVolume);
            this._audio.volume = isNaN(vol) ? 0.8 : Math.max(0, Math.min(1, vol));
            this._audio.src = url;
            // 音效是点缀，播不出来也不能影响对话推进
            this._audio.play().catch(() => {});
            return true;
        } catch (e) {
            return false;
        }
    },

    /** 从一段文本里看出该用哪个桶。
     *  优先看表情标记（[emotion:xxx]，NpcChat 的 _playFx 也用同一套），
     *  没有就看标点：问号=疑问、感叹=惊讶，其余算普通。 */
    bucketOf(text) {
        const t = text || '';
        const m = t.match(/\[\s*(?:emotion|表情)\s*[:：]\s*([^\]]+)\]/i);
        if (m) {
            const e = m[1].trim().toLowerCase();
            if (/happy|joy|smile|laugh|笑|开心|高兴/.test(e)) return 'happy';
            if (/sad|cry|sorrow|难|悲|哭/.test(e)) return 'sad';
            if (/anger|angry|mad|怒|生气/.test(e)) return 'angry';
            if (/surpris|shock|惊/.test(e)) return 'surprise';
            if (/question|confus|疑惑|困惑|问/.test(e)) return 'question';
            if (/sigh|叹/.test(e)) return 'sigh';
        }
        if (/[？?]/.test(t)) return 'question';
        if (/[！!]/.test(t)) return 'surprise';
        return 'idle';
    },

    /** 这段是不是「简单语句」——短、且没有需要念出来的信息量。
     *  长句子里塞音效只会显得吵，所以要朗读的句子交给朗读（或干脆不响）。 */
    isSimple(text) {
        const plain = (window.NpcDecoder && NpcDecoder.toPlainText) ? NpcDecoder.toPlainText(text || '') : (text || '');
        const s = plain.replace(/[\s\u3000]+/g, '');
        if (!s) return false;
        if (s.length > 12) return false;
        // 明确带问号的短句也算简单（「啊？」这种念出来最假）
        return true;
    },

    /** 给「这一段」决定要不要放音效。返回 true 表示已用音效代替朗读。 */
    playFor(text) {
        if (!this.has()) return false;
        if (!this.isSimple(text)) return false;
        return this.play(this.bucketOf(text));
    },

    /** 把录音包的有无反映到设置面板上：没有包就把开关置灰并说明原因。 */
    _syncSettingsUI() {
        const el = document.getElementById('cfgSfxEnabled');
        const hint = document.getElementById('cfgSfxHint');
        if (!el) return;
        if (this.has()) {
            el.disabled = false;
            if (hint) hint.textContent = `（当前 NPC 有 ${this.count()} 条录音）`;
        } else {
            el.disabled = true;
            if (hint) hint.textContent = '（当前 NPC 没有录音包，该选项不可用）';
        }
    },

    /** 当前 NPC 用的录音包（切人时由 NpcChat 调） */
    async forNpc(npcId) { return this.load(npcId); },
};
window.NpcSfx = NpcSfx;
