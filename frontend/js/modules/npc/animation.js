/** AI剧本网 - NPC 动画系统 (11种独立动画) */
const NpcAnim = {
    _emotionAnimMap: {
        jingyuniang: {
            default: { cls: '', loop: false },
            happy: { cls: 'hop2', loop: false },
            laugh: { cls: 'hop2', loop: false },
            wink: { cls: 'shiver2', loop: false },
            thinking: { cls: 'hop1', loop: false },
            surprised: { cls: 'shiver1', loop: false },
            sad: { cls: 'shrink', loop: false },
            grief: { cls: 'bigjump', loop: false },
            angry: { cls: 'damage', loop: false },
            closeeye: { cls: 'shrink', loop: false },
            mysterious: { cls: 'shiver-loop', loop: true },
            dazed: { cls: 'shiver1', loop: false },
        },
        xiaoshuai: {
            default: { cls: '', loop: false },
            happy: { cls: 'hop1', loop: false },
            laugh: { cls: 'hop1', loop: false },
            wink: { cls: 'shiver1', loop: false },
            thinking: { cls: 'hop-loop', loop: true },
            surprised: { cls: 'bigjump', loop: false },
            sad: { cls: 'shiver-loop', loop: true },
            grief: { cls: 'bigjump', loop: false },
            angry: { cls: 'damage', loop: false },
            closeeye: { cls: 'shrink', loop: false },
            mysterious: { cls: 'sink', loop: false },
        },
        xiaomei: {
            default: { cls: '', loop: false },
            happy: { cls: 'hop2', loop: false },
            laugh: { cls: 'hop2', loop: false },
            wink: { cls: 'shiver2', loop: false },
            thinking: { cls: 'hop1', loop: false },
            surprised: { cls: 'shiver1', loop: false },
            sad: { cls: 'shrink', loop: false },
            grief: { cls: 'bigjump', loop: false },
            angry: { cls: 'damage', loop: false },
            closeeye: { cls: 'shrink', loop: false },
            mysterious: { cls: 'shiver-loop', loop: true },
        },
        dagou: {
            default: { cls: '', loop: false },
            happy: { cls: 'bigjump', loop: false },
            laugh: { cls: 'bigjump', loop: false },
            wink: { cls: 'shiver1', loop: false },
            thinking: { cls: 'hop-loop', loop: true },
            surprised: { cls: 'grow', loop: false },
            sad: { cls: 'sink', loop: false },
            grief: { cls: 'sink', loop: false },
            angry: { cls: 'damage', loop: false },
            closeeye: { cls: 'shrink', loop: false },
            mysterious: { cls: 'shiver1', loop: false },
        },
    },
    _currentPid: 'jingyuniang',
    _activeLoops: {},

    triggerEmotion(npcId, emotion, target = 'teahouse-npc') {
        const fx = (window.AccountInit && AccountInit.getEmotionEffect) ? AccountInit.getEmotionEffect(npcId, emotion) : {};
        // 方法驱动：严格按站长设定——有动画则播（含 loop 判定），无动画则清掉动画（立绘由 NpcUI 切换）
        if (fx && fx.fromMethod) {
            if (fx.anim) {
                const loop = typeof fx.anim === 'string' && fx.anim.indexOf('loop') !== -1;
                this.play(npcId, fx.anim, loop, target);
            } else {
                this.clear(npcId, target);
            }
            return;
        }
        // 旧版/无方法：回退 emotion_effects.anim 或硬编码映射
        if (fx && fx.anim) {
            const loop = typeof fx.anim === 'string' && fx.anim.indexOf('loop') !== -1;
            this.play(npcId, fx.anim, loop, target);
            return;
        }
        const map = this._emotionAnimMap[npcId] || this._emotionAnimMap['jingyuniang'];
        const anim = map[emotion];
        if (!anim) { this.clear(npcId, target); return; }
        this.play(npcId, anim.cls, anim.loop, target);
    },

    play(npcId, className, loop = false, target = 'teahouse-npc') {
        if (!loop) this.clear(npcId, target);
        const el = document.getElementById(target);
        if (!el || !className) return;
        el.classList.add('anim-' + className);
        if (loop) {
            this._activeLoops[npcId] = className;
        }
    },

    clear(npcId, target = 'teahouse-npc') {
        const el = document.getElementById(target);
        if (!el) return;
        const classes = el.className.split(' ').filter(c => c.startsWith('anim-'));
        classes.forEach(c => el.classList.remove(c));
        delete this._activeLoops[npcId];
    },

    clearAll() {
        const el = document.getElementById('teahouse-npc');
        if (!el) return;
        const classes = el.className.split(' ').filter(c => c.startsWith('anim-'));
        classes.forEach(c => el.classList.remove(c));
        this._activeLoops = {};
    }
};

window.NpcAnim = NpcAnim;
