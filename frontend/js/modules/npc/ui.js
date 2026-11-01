/** AI剧本网 - NPC UI 渲染（立绘 / 气泡） */
const NpcUI = {
    // 立绘映射：NPC id → 表情 → 文件名（文件位于 /static/npc/teahouse/{npcId}/ 下）
    // 在此自由更改「某表情调用哪张立绘」，即可实现「调用对应立绘（可更改被调用的立绘）」。
    PORTRAIT_MAP: {
        jingyuniang: {
            default: 'default.png', happy: 'happy.png', laugh: 'laugh.png', wink: 'wink.png',
            thinking: 'thinking.png', surprised: 'surprised.png', sad: 'sad.png', grief: 'sad.png',
            angry: 'angry.png', closeeye: 'closeeye.png', mysterious: 'default.png', dazed: 'dazed.png',
        },
        xiaoshuai: {
            default: 'default.png', happy: 'smile.png', laugh: 'laugh.png', wink: 'wink.png',
            thinking: 'think.png', surprised: 'surprise.png', sad: 'sad.png', grief: 'grief.png',
            angry: 'angry.png', closeeye: 'closeeye.png', mysterious: 'default.png',
        },
        xiaomei: {
            default: 'default.png', happy: 'smile.png', laugh: 'laugh.png', wink: 'wink.png',
            thinking: 'think.png', surprised: 'surprise.png', sad: 'sad.png', grief: 'grief.png',
            angry: 'angry1.png', closeeye: 'closeeye.png', mysterious: 'default.png',
        },
        dagou: {
            default: 'default.png', happy: 'smile.png', laugh: 'laugh.png', wink: 'wink.png',
            thinking: 'think.png', surprised: 'surprise.png', sad: 'sad.png', grief: 'grief.png',
            angry: 'angry.png', closeeye: 'closeeye.png', mysterious: 'default.png',
        },
    },
    _clickBound: false,

    _portraitBase(npcId) { return `/static/npc/teahouse/${npcId}/`; },

    _portraitUrl(npcId, emotion) {
        const fx = (window.AccountInit && AccountInit.getEmotionEffect) ? AccountInit.getEmotionEffect(npcId, emotion) : {};
        const file = (fx && fx.portrait)
                  || (this.PORTRAIT_MAP[npcId] && this.PORTRAIT_MAP[npcId][emotion])
                  || 'default.png';
        return this._portraitBase(npcId) + file;
    },

    /** 渲染 NPC 默认立绘（优先 portraitUrl，否则用映射的 default） */
    renderPortrait(npc, portraitUrl) {
        const nameDisplay = document.getElementById('npcNameDisplay');
        if (nameDisplay) nameDisplay.textContent = npc.displayName || npc.name;
        const url = portraitUrl || this._portraitUrl(npc.id, 'default');
        this._setBg(url);
        this._bindClick();
    },

    /** 切换到某表情对应的立绘（可在 PORTRAIT_MAP 中更改被调用的立绘） */
    setEmotionPortrait(npcId, emotion, target = 'teahouse-npc') {
        this._setBg(this._portraitUrl(npcId, emotion), target);
    },

    _setBg(url, target = 'teahouse-npc') {
        const el = document.getElementById(target);
        if (el && url) el.style.backgroundImage = `url('${url}')`;
    },

    /** 绑定「鼠标点击 NPC 立绘」→ 发出 clickNpc 信号
     *  注：当前版本 NPC 点击交互暂不启用（产品决策），故此处不绑定，
     *      仅预留接口，后续如需启用取消下方注释即可。 */
    _bindClick() {
        if (this._clickBound) return;
        this._clickBound = true;
        // const el = document.getElementById('teahouse-npc');
        // if (el) {
        //     el.style.cursor = 'pointer';
        //     el.addEventListener('click', () => {
        //         if (window.NpcBus && NpcBus.clickNpc) NpcBus.clickNpc();
        //     });
        // }
    },

    renderBubble(role, text) {
        return NpcChat._renderBubble({ role, text, time: new Date() });
    },

    /** 居中系统信息（无气泡，黑色文字） */
    addInfoMessage(text) {
        NpcChat.addMessage('system', `[info:${text}]`);
    },
};

window.NpcUI = NpcUI;
