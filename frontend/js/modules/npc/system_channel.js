/** AI剧本网 - 系统通道模块（NpcSystemChannel）
 * ------------------------------------------------------------------
 *  职责：处理 NPC 回复中的系统通道指令（[tool:] / [sys:]），把结果回灌给 NPC
 *  让其继续生成，直至产出面向用户的最终回答。从 chat.js 剥离（核心管线只编排）。
 *
 *  关键：工具交换（NPC 的 [tool:] 请求 + 系统返回的真实数据）以 _toolExchange 消息
 *  落入 chat._messages（不渲染、不持久化），否则下一轮对话 AI 看不到自己查过的数据，
 *  只能凭记忆编造（"牧羊女"事件根因）；审核 NPC 也能据此核对是否忠实转述工具结果。
 *
 *  回灌模板文案见 npc_configs/shared/prompts/system_texts.txt（SystemTexts）。
 */
const NpcSystemChannel = {
    /** 多轮系统交互：NPC 可连续向系统请求数据，直至产出最终回答。
     *  NPC 与系统之间的往返内容不会展示给用户，仅显示"正在查询"提示。
     * @param {Object} chat    NpcChat 实例（读写 _messages/_msgId、调 _callAI）
     * @param {Array}  prompts 当前提示词列表
     * @param {string} reply   NPC 当前回复
     * @returns {Promise<string>} 最终回复
     */
    async resolve(chat, prompts, reply) {
        let guard = 0;
        let sysResult = await NpcBus.handle(reply);
        while (sysResult != null && guard++ < NpcBus.MAX_ROUNDS) {
            chat._messages.push({ role: 'npc', text: reply, time: new Date(), _id: ++chat._msgId, _toolExchange: true });
            chat.addSystemMessage(this._loadingText(reply));
            chat._messages.push({
                role: 'user', time: new Date(), _id: ++chat._msgId, _toolExchange: true,
                text: SystemTexts.t('channel.tool_result', { result: sysResult }),
            });
            // userInput 传空：工具结果已在 history 末尾，避免重复附加
            reply = await chat._callAI(prompts, '', '工具结果回灌');
            sysResult = await NpcBus.handle(reply);
        }
        return reply;
    },

    /** 工具/系统指令执行期间的用户提示文案：查看历史 → 「NPC 正在回想…」，其余 → 「正在为你查询网站信息…」 */
    _loadingText(reply) {
        if (/\[(?:tool|sys):(?:history|recall_history|recall)\b/i.test(reply || '')) return 'NPC 正在回想…';
        return '正在为你查询网站信息…';
    },
};

window.NpcSystemChannel = NpcSystemChannel;
