/** AI剧本网 - 离线 NPC 引导引擎（无 API 无账号时启用）
 * ------------------------------------------------------------------
 *  不调用任何 AI、零 token、纯本地关键词匹配。
 *  规则表来自可编辑配置（npc_configs/shared/prompts/offline_guide.txt），
 *  由站长在管理面板「提示词-离线引导」栏目维护；缺失/非法时回退内置 DEFAULTS。
 *  每条规则可携带 highlight（UI 逻辑名），命中后自动触发引导高亮圆环。
 */
const OfflineNpc = {
    _fallbackIdx: 0,
    _config: null,       // 加载后的配置（opening/fallback/rules）
    _loading: null,      // 进行中的加载 Promise

    /* 内置回退：与 offline_guide.txt 默认内容一致（文件缺失/非法时兜底） */
    DEFAULTS: {
        opening: '我是 AI 剧本网的引导员。您当前未登录或未配置 API，没有接入 API 的情况下，我只能用内置引导陪你。\n[options:注册账号:创建账号，解锁收藏与上传剧本|获取API:配置密钥，解锁完整 AI 对话|免费开一局:游客免费体验一局海龟汤]',
        fallback: [
            '您处于离线状态（未配置 API），可以问我：怎么玩 / 注册 / 获取 API',
            '试试对我说：新手引导 / 推荐剧本 / 免费开始一局海龟汤',
            '我暂时只能做本地引导，可以说「获取API」了解如何解锁完整 AI 对话。',
        ],
        rules: [
            { keys: ['海龟汤怎么玩', '海龟汤规则', '海龟汤玩法', '海龟汤是什么', '海龟汤怎么猜'], reply: '海龟汤是一种情境推理猜谜：主持人给一个简短离奇的「谜面」，你通过不断提问（问题只能用「是/否/无关」回答）还原背后的真相「汤底」。提问时多从时间线、人物动机、物品用途等角度入手，逐步逼近真相。想玩一局，可在左侧「剧本区」选一个海龟汤剧本开始体验；建议先「获取API」解锁完整 AI 对话，体验更好。', highlight: 'board' },
            { keys: ['你好', '在吗', 'hi', 'hello', '嗨', '哈喽'], reply: '你好呀！我是 AI 剧本网的引导员。你可以对我说「新手引导」了解玩法，或「推荐剧本」去看看有哪些好玩的。', highlight: null },
            { keys: ['怎么玩', '帮助', '玩法', '新手', '引导', '教程'], reply: '咱们这有四种玩法：🐢海龟汤（情境猜谜，给谜面猜真相）、🐉DND（跑团冒险）、🐙COC（克苏鲁调查）、🎭剧本扮演（沉浸角色）。新手建议先从「海龟汤」开始，简单好上手。', highlight: 'board' },
            { keys: ['剧本', '推荐', '有什么', '看看', '逛逛', '作品'], reply: '左侧「剧本区」里有海龟汤、DND、COC、剧本扮演四大板块，点进去就能浏览和体验啦。', highlight: 'board' },
            { keys: ['海龟汤', '玩一局', '开始', '免费', '体验'], reply: '海龟汤是情境猜谜：作者给一个「谜面」，你通过提问推理出「真相」。去左侧「剧本区」选一个海龟汤试试吧！', highlight: 'board' },
            { keys: ['设置', 'api', 'key', '密钥', '接入'], reply: null, highlight: null },
            { keys: ['注册', '登录', '实名', '账号'], reply: '右上角可以注册或登录，登录后功能更完整（收藏、上传剧本、完整 AI 对话都需要登录）。', highlight: 'register' },
            { keys: ['打赏', '支持', '交流', 'qq', '贴吧', '群', '联系'], reply: '想交流或支持作者：点右上角「💬交流」可看 QQ 群（949510550）和百度贴吧；点左上角「💗打赏」可以请作者吃一顿早饭。', highlight: 'chat' },
        ],
    },

    _isGuest() {
        return !!(window.STATE && STATE.get && STATE.get('isGuest'))
            || !(window.Utils && Utils.getUserId && Utils.getUserId());
    },

    /** 确保配置已加载（幂等，失败回退 DEFAULTS） */
    async ensure() {
        if (this._config) return this._config;
        if (this._loading) return this._loading;
        this._loading = this._load().finally(() => { this._loading = null; });
        return this._loading;
    },

    async _load() {
        try {
            const prompts = await API.get('/npc/prompts?npc_id=shared');
            const p = (prompts || []).find(x => x.prompt_type === 'offline_guide' && x.content && x.content.trim());
            if (p) {
                const cfg = JSON.parse(p.content);
                this._config = {
                    opening: cfg.opening || this.DEFAULTS.opening,
                    fallback: (Array.isArray(cfg.fallback) && cfg.fallback.length) ? cfg.fallback : this.DEFAULTS.fallback,
                    rules: (Array.isArray(cfg.rules) && cfg.rules.length) ? cfg.rules : this.DEFAULTS.rules,
                };
                return this._config;
            }
        } catch (e) {
            console.warn('[OfflineNpc] 加载离线引导配置失败，使用内置回退', e);
        }
        this._config = this.DEFAULTS;
        return this._config;
    },

    /** 供管理面板保存后强制重载 */
    async reload() {
        this._config = null;
        return this.ensure();
    },

    /** 根据用户输入返回 { reply, highlight }（规则来自可编辑配置） */
    async answer(text) {
        const cfg = await this.ensure();
        const t = (text || '').toLowerCase();
        for (const rule of cfg.rules) {
            if (!rule || !Array.isArray(rule.keys)) continue;
            if (rule.keys.some(k => t.includes(String(k).toLowerCase()))) {
                // 「设置/API/Key」等 reply 为 null 的规则：动态分流（游客引导注册，登录引导配置）
                if (rule.reply == null) {
                    if (this._isGuest()) {
                        return { reply: '还没有配置 AI API Key 哦。想解锁完整的 AI 对话，需要注册后在「设置」里填入 API Key。推荐火山引擎（每个模型都有 50 万免费 tokens 额度），图文+视频教程手把手教你：[btn:📖 查看API获取教程:open_tutorial:volcengine]', highlight: 'register' };
                    }
                    return { reply: '在「⚙️设置 → AI 模型」标签页填入你的 API Key 和模型就能解锁完整对话。需要一步步的操作指引吗？[btn:📖 查看API获取教程:open_tutorial]', highlight: 'settings' };
                }
                return { reply: rule.reply, highlight: rule.highlight || null };
            }
        }
        const fb = cfg.fallback[this._fallbackIdx % cfg.fallback.length];
        this._fallbackIdx++;
        return { reply: fb, highlight: null };
    },

    /** 开场引导（无 AI 激活时推送）：仅说话，不触发引导光圈 */
    async greeting() {
        const cfg = await this.ensure();
        return { reply: cfg.opening, highlight: null };
    },
};

window.OfflineNpc = OfflineNpc;
