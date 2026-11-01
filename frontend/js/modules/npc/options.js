/** AI剧本网 - NPC 选项交互模块
 *
 * 职责：处理用户点击 NPC 通过 [options:A|B|C] 给出的选择题。
 *   - 事件委托监听选项按钮点击（兼容 _renderMessages 的 innerHTML 重绘）
 *   - 记录选择并触发视觉反馈（选项前打勾 ✔）
 *   - 将选项内容作为用户消息发送给 NPC
 *
 * 状态（选中项）保存在 chat.js 的消息对象上，本模块保持无状态，避免重绘丢状态。
 */
const NpcOptions = {
    /* ========== 初始化 ========== */
    init() {
        const container = document.getElementById('chatBubblesContainer');
        if (!container) return;
        // 事件委托：选项按钮由 _renderMessages 动态生成，必须用委托
        container.addEventListener('click', (e) => this._onSelect(e));
        console.log('[NpcOptions] 选项交互模块已初始化');
    },

    /* ========== 点击处理 ========== */
    _onSelect(e) {
        const btn = e.target.closest('.option-btn');
        if (!btn || btn.disabled) return;

        // 阻止冒泡到分段推进的监听器（同元素、同事件）
        e.stopPropagation();
        e.stopImmediatePropagation();

        const bubble = btn.closest('.chat-bubble-npc');
        if (!bubble) return;
        const msgId = parseInt(bubble.dataset.msgId, 10);
        const optionText = btn.dataset.option;
        if (isNaN(msgId) || !optionText) return;

        // 记录选择（幂等：已选过则不再发送）
        const newlySelected = NpcChat.selectOption(msgId, optionText);
        if (newlySelected) {
            NpcChat.sendOption(optionText);
        }
    },
};

window.NpcOptions = NpcOptions;
