/** AI剧本网 - 分段叙述模块（NpcSegments）
 * ------------------------------------------------------------------
 *  职责：galgame 式分段（[SEGMENT] / 换行 / [do:指令]）的状态与纯逻辑，从 chat.js 剥离：
 *   - split()：把 NPC 回复切分为段 + 提取分段延迟指令（[do:] 是段边界，绑定到「下一段展示前」执行）；
 *   - 持有分段状态（parts / index / commands），供 chat.js 的渲染与推进逻辑读写；
 *   - 延迟指令的静默执行（失败经系统通道告知 NPC 纠正，文案见 system_texts.txt）。
 *
 *  渲染（打字机/气泡 DOM 操作）仍由 chat.js 负责；本模块不碰 DOM。
 */
const NpcSegments = {
    parts: [],        // 当前分段数组
    index: 0,         // 当前展示到第几段
    commands: null,   // { 段序号: [指令体...] }（[do:] 延迟指令）

    reset() {
        this.parts = [];
        this.index = 0;
        this.commands = null;
    },

    /** 是否存在尚未展示完的分段 */
    hasPending() {
        return this.parts.length > 0 && this.index < this.parts.length - 1;
    },

    /** 切分回复 + 提取分段延迟指令 [do:指令]（需求：NPC 把命令夹在两段输出之间，
     *  上一段输出完后该命令被调用，然后接着输出下一段）。
     *  [do:...] 本身也是一个段边界：它前面的文本成段，指令绑定到「下一段展示前」执行；
     *  末尾的 [do:] 绑定到 parts.length（全部段展示完后执行）。
     *  分隔符：① 显式 [SEGMENT] 标记；② 换行（\n，每个换行都切段，让长回复拆成短段分批展示）；③ [do:] 指令。
     *  切分逻辑已收敛到 NpcDecoder.split，本模块仅保留分段状态机与命令执行。
     *  返回 { parts: [段文本...], commands: { 段序号: [指令体...] } }。 */
    split(reply) {
        return NpcDecoder.split(reply);
    },

    /** 执行绑定到某段的延迟指令（静默：结果不回灌 AI；失败经系统通道告知 NPC 纠正） */
    runCommands(index) {
        if (!this.commands) return;
        const cmds = this.commands[index];
        if (!cmds) return;
        delete this.commands[index];
        cmds.forEach(cmd => this._exec(cmd));
    },

    /** 执行剩余全部延迟指令（单段回复 / 分段收尾时兜底） */
    runAllCommands() {
        if (!this.commands) return;
        Object.keys(this.commands).map(Number).sort((a, b) => a - b)
            .forEach(i => this.runCommands(i));
    },

    async _exec(cmd) {
        try {
            const r = await NpcBus.executeSilent(cmd);
            if (!r.ok && window.NpcBus) {
                NpcBus.push(SystemTexts.t('do_command.failed', { cmd, error: r.error }));
            }
        } catch (e) {
            if (window.NpcBus) NpcBus.push(SystemTexts.t('do_command.error', { cmd, error: e.message }));
        }
    },
};

window.NpcSegments = NpcSegments;
