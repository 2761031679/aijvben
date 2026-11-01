/** AI剧本网 - 消息标记处理模块（NpcMarkers）
 * ------------------------------------------------------------------
 *  职责：渲染期标记处理的薄封装——HTML/纯文本生成逻辑已收敛到 NpcDecoder，
 *  本模块只负责「按 allowFx 触发副作用（动画/表情/引导高亮）」。
 *  - process()：生成气泡 HTML（委托 NpcDecoder.toHtml）+ 按需触发表情动画；
 *  - toTypingText() / convertAnswers() / emotionId()：直接委托 NpcDecoder。
 *  保持 window.NpcMarkers 接口不变，供既有调用点无缝迁移。
 */
const NpcMarkers = {
    EMOTION_KW: NpcDecoder.EMOTION_KW,
    ANSWER_TEXT: NpcDecoder.ANSWER_TEXT,

    emotionId(raw) {
        return NpcDecoder.emotionId(raw);
    },

    convertAnswers(text) {
        return NpcDecoder.convertAnswers(text);
    },

    /** 统一处理消息内功能标记并生成 HTML（动画/工具/选项/分段/系统通道/空行折叠）。
     * @param {string} text    原始文本
     * @param {Object} msg     消息对象（选项选中态等；可为 null）
     * @param {boolean} allowFx 为真时才触发表情/动画（仅最新一条且非历史恢复）
     * @param {string} npcId   当前 NPC id（触发动画用）
     */
    process(text, msg, allowFx, npcId) {
        const nid = npcId || 'jingyuniang';
        const html = NpcDecoder.toHtml(text, msg, nid);
        if (allowFx) {
            const fx = NpcDecoder.extractFx(text);
            fx.emotions.forEach(e => {
                const emo = NpcDecoder.emotionId(e);
                NpcAnim.triggerEmotion(nid, emo);
                if (window.NpcUI) NpcUI.setEmotionPortrait(nid, emo);   // 单段回复也切换表情立绘
            });
            fx.actions.forEach(a => NpcAnim.play(nid, a, false));
            fx.guides.forEach(name => {
                if (window.GuideHighlight) GuideHighlight.show(name);
            });
            if (msg) msg._fxDone = true;
        }
        return html;
    },

    toTypingText(text) {
        return NpcDecoder.toTypingText(text);
    },
};

window.NpcMarkers = NpcMarkers;
