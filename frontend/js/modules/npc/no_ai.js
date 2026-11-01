/** AI剧本网 - 无 AI 模块
 *
 *  当用户未配置 API Key 时，激活此模块。
 *  职责：
 *    - 在聊天框推送离线开场引导（OfflineNpc）
 *    - 输入框保持可用，用户输入走 OfflineNpc 本地关键词回应（chat.js 里判断）
 *    - 引导用户配置 API Key / 注册
 */
const NoAiModule = {
    _active: false,
    _keyPlaceholderShown: false,

    /** 激活无 AI 模式 */
    activate() {
        if (this._active) return;
        this._active = true;
        this._showPrompt();
        this._armInputGuard();
    },

    /** 停用无 AI 模式（用户配置了 Key 后） */
    deactivate() {
        if (!this._active) return;
        this._active = false;
        this._keyPlaceholderShown = false;   // 重置，下次激活可重新显示开场引导
        this._disarmInputGuard();
    },

    /** 检查并自动切换模式 */
    check() {
        const hasKey = !!(window.AiClient && AiClient.currentKey());
        if (hasKey) {
            this.deactivate();
        } else {
            this.activate();
        }
    },

    /** 在聊天框推送开场引导（以 NPC 身份）。
     *  统一交给 NpcChat.greetOnActivate：免费 AI 优先（问海龟汤经验），失败回退离线开场白。 */
    _showPrompt() {
        if (this._keyPlaceholderShown) return;
        this._keyPlaceholderShown = true;

        // 清除旧的无 AI 提示
        NpcChat._messages = NpcChat._messages.filter(m => !m._noAiHint);
        NpcChat._renderMessages();

        if (window.NpcChat && NpcChat.greetOnActivate) NpcChat.greetOnActivate();
    },

    /** 输入框保持可用：placeholder 提示可输入关键词（本地引导，不阻止输入） */
    _armInputGuard() {
        const input = document.getElementById('companionChatInput');
        if (input) {
            input.placeholder = '试试输入：新手引导 / 推荐剧本 / 获取API';
        }
    },

    /** 恢复默认占位符 */
    _disarmInputGuard() {
        const input = document.getElementById('companionChatInput');
        if (input) input.placeholder = '与 NPC 对话...';
    },

    /** 是否处于无 AI 模式 */
    isActive() {
        return this._active;
    },
};

window.NoAiModule = NoAiModule;
