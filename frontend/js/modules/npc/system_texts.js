/** AI剧本网 - 系统文案模块（SystemTexts）
 * ------------------------------------------------------------------
 *  职责：所有「会进入 AI 对话流」的系统文案（系统通道模板、体验回执、条件系统提示等）
 *  统一从 npc_configs/shared/prompts/system_texts.txt 读取（站长可在管理面板编辑），
 *  代码内不再硬编码。文件缺失/非法 JSON 时回退到 FALLBACK（与默认文件内容一致）。
 *
 *  用法：SystemTexts.t('channel.tool_result', { result: '...' })
 *   - path 为点分路径；{var} 占位符自动替换，缺失的变量保留原样。
 *   - t() 为同步：首次使用前需 await SystemTexts.ensure()（已在 NpcChat.refreshPrompt 挂钩）；
 *     未加载时自动使用 FALLBACK，永不阻塞。
 */
const SystemTexts = {
    _data: null,        // 解析后的 system_texts.txt 内容（null = 未加载）
    _loading: null,     // 进行中的加载 Promise（防并发重复请求）

    /** 内置回退：与 npc_configs/shared/prompts/system_texts.txt 默认内容保持一致。
     *  仅当文件缺失 / 非合法 JSON / 键缺失时兜底，正常情况下以文件为准。 */
    FALLBACK: {
        channel: {
            tool_result: '[系统返回]\n{result}\n\n请基于以上真实数据回答用户，不要复述查询过程，也不要再输出任何 [tool:] 或 [sys:] 标记（除非确实还需继续查询）。',
            system_notify: '[系统通知]\n{result}\n\n请以你的身份，自然地把上述信息转达或回应给用户；若你判断无需打扰用户，仅回复 [sys:ignore]。',
            review_revise: '[系统通知]\n审核员认为你上一条回复存在问题，修改建议如下：\n{suggestion}\n\n请按修改建议重新生成你的回复（直接输出修正后的完整回复内容，不要提及审核）。注意：原回复中的功能标记必须按需要保留——[emotion:]、[action:]，以及条件标记 [cond:结局ID.条件ID] 与 [task:任务ID.条件ID] 一旦丢失系统将无法计数；若原回复中判定条件达成，重写时必须原样带上对应标记。',
        },
        experience: {
            open: '[系统通知] 玩家已确认开始剧本体验《{title}》。请你以主持人身份开场。',
            no_id: '缺少剧本 ID',
            switching: '系统正在切换剧本，请稍候再试（不要重复调用 start_experience）',
            already: '《{title}》已在体验中，你已经是该剧本主持人，请继续主持，不要重复调用 start_experience。',
            cooldown: '玩家近期已取消过这个剧本的体验邀请。除非玩家主动明确要求玩这个剧本，否则不要再调用 start_experience 邀请它；可以推荐其他剧本或询问玩家想玩什么。',
            switch_rejected: '玩家拒绝了切换剧本的邀请。请继续主持当前剧本，或询问玩家的想法。',
            load_failed: '开启剧本体验失败：剧本不存在或加载失败',
            cancelled: '玩家取消了剧本体验。你可以询问玩家原因，或推荐其他剧本（短期内不要再主动邀请这个剧本）。',
            started: '已开启剧本体验《{title}》。你现在是该剧本主持人，主持规则与剧本内容已注入系统提示，请开始主持。',
        },
        conditions: {
            invalid_cond: '系统提示：你发送的条件标记 {marks} 在当前剧本的条件表中不存在，已被忽略。请严格使用条件表中的「结局ID.条件ID」。',
            cond_met: '系统提示：条件「{cond}」（结局《{ending}》）已达成（{threshold}/{threshold}），该条件已对玩家揭示。其余未满足条件请继续按规则判定。',
            settle: '系统通知：玩家已达成{result}结局《{ending}》，游戏{result}。{note}请结合结局备注与剧情，以主持人身份为玩家解说这个结局。结算面板已由系统自动展示，你不要再去触发结算，也不要再发送条件标记。',
            invalid_task: '系统提示：你发送的任务标记 {marks} 在当前剧本的任务条件表中不存在，已被忽略。请严格使用任务条件表中的「任务ID.条件ID」。',
            task_progress: '系统提示：任务「{task}」的条件「{cond}」已达成。请继续按任务规则判定其余条件。',
            task_npc_message: '系统消息（任务「{task}」完成的触发效果，作者预设）：{payload}',
            task_done: '系统提示：任务「{task}」的全部条件已达成，任务完成。{note}该任务的完成效果已由系统自动执行，你无需重复操作，也不要再发送该任务的 [task:] 标记。',
        },
        do_command: {
            failed: '系统提示：你的分段指令 [do:{cmd}] 执行失败：{error}。请按正确格式修正，或放弃该指令继续主持。',
            error: '系统提示：你的分段指令 [do:{cmd}] 执行出错：{error}。',
        },
        notification: {
            push: '站内通知：{summary}',
        },
        greeting: {
            activate: '[系统通知] 你已被激活，现在是开场时刻。上次对话时间：{last_time}。未完成剧本：{pending}。请根据「开场规则」自己决定开场说什么（每次尽量不同，别套固定句式），若判断无需打扰玩家也可回复 [sys:ignore]。',
        },
    },

    /** 确保已加载（幂等，可重复调用；失败静默回退 FALLBACK） */
    async ensure() {
        if (this._data) return;
        if (this._loading) return this._loading;
        this._loading = this._load().finally(() => { this._loading = null; });
        return this._loading;
    },

    /** 管理面板保存提示词后强制重载 */
    async reload() {
        this._data = null;
        await this.ensure();
    },

    async _load() {
        try {
            const prompts = await API.get('/npc/prompts?npc_id=shared');
            const p = (prompts || []).find(x => x.prompt_type === 'system_texts' && x.content && x.content.trim());
            if (p) {
                try {
                    this._data = JSON.parse(p.content);
                    console.log('[SystemTexts] 系统文案已从 system_texts.txt 加载');
                    return;
                } catch (e) {
                    console.warn('[SystemTexts] system_texts.txt 非合法 JSON，使用内置回退', e);
                }
            } else {
                console.warn('[SystemTexts] 未找到 system_texts.txt（或为空），使用内置回退');
            }
        } catch (e) {
            console.warn('[SystemTexts] 加载失败，使用内置回退', e);
        }
        this._data = {};
    },

    /** 取文案并替换 {var} 占位符；文件缺失该键时回退 FALLBACK，再缺失返回路径本身并告警 */
    t(path, vars = {}) {
        const lookup = (root) => path.split('.').reduce(
            (o, k) => (o && typeof o === 'object') ? o[k] : undefined, root);
        let v = this._data ? lookup(this._data) : undefined;
        if (typeof v !== 'string' || !v) v = lookup(this.FALLBACK);
        if (typeof v !== 'string') {
            console.warn('[SystemTexts] 缺失文案:', path);
            return path;
        }
        return v.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
    },
};

window.SystemTexts = SystemTexts;
