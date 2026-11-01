/** AI剧本网 - 账号初始化模块
 * 
 * 触发时机：
 *   1. 首次登录（Auth._onLoginSuccess）
 *   2. 退出登录（Auth.logout）
 *   3. 游客登录（Auth.guestLogin）
 *   4. 保存设置后（NpcChat.saveSettings）
 *   5. 网站初始化（DOMContentLoaded）
 *
 * 职责：
 *   - 根据当前账号状态（游客/账号/无token）选择初始化流程
 *   - 加载服务器 NPC 配置（音色/缩放/提示词路径）
 *   - 加载用户本地配置
 *   - 尝试激活 NPC（有 key → AI 模式，无 key → 无 AI 提示模式）
 *   - 应用窗口自适应缩放
 */
const AccountInit = {
    _initialized: false,
    _npcConfigs: {},  // 服务器返回的 NPC 配置 { "xiaoshuai": {scale, voice, portrait_url} }

    /** 主入口：账号初始化 */
    async init(reason = 'startup') {
        const token = STATE.get('token');
        const isGuest = STATE.get('isGuest');
        const user = STATE.get('user');

        console.log(`[AccountInit] 初始化触发，原因: ${reason}, token: ${!!token}, isGuest: ${isGuest}`);

        // 步骤0：账号切换（登录/登出/游客）先重置会话，清空上个账号残留的对话与分段
        if (['login', 'logout', 'guest'].includes(reason) && window.NpcChat && NpcChat.resetSession) {
            NpcChat.resetSession();
        }

        // 步骤1：加载用户本地配置
        this._loadLocalConfig();

        // 步骤2：加载服务器 NPC 配置（总是加载，游客也可用）
        await this._loadNpcConfigs();

        // 步骤3：应用 NPC 配置到 UI
        this._applyNpcConfig();

        // 步骤4：根据账号状态初始化 NPC
        if (token) {
            // 有 token（账号或游客）：尝试激活 NPC
            await this._activateNpc();
        } else {
            // 无 token：显示登录提示，并激活离线引导（OfflineNpc 本地回应，引导注册/获取 API）
            NpcChat.addSystemMessage('欢迎！请登录或注册后与 NPC 对话');
            NoAiModule.deactivate();   // 重置上个账号可能残留的离线引导状态
            NoAiModule.activate();     // 激活离线引导，NPC 可本地回应
        }

        // 步骤5：应用窗口自适应缩放
        this._applyWindowScale();

        // 步骤6：账号切换/刷新页面时重新发送 NPC 系统提示词（登录态组装，游客态跳过）
        if (window.NpcChat && NpcChat.refreshPrompt) NpcChat.refreshPrompt();

        this._initialized = true;
        Events.emit('account-init-complete', { reason, token: !!token, isGuest });
    },

    /** 加载用户本地配置（纯分账号隔离）
     *  - 每个账号（含游客）的配置独立存放在 Store（ts_<uid>_config）。
     *  - 账号切换时（登录/登出/游客）本方法都会被重新调用，载入对应账号的配置。
     *  - 一次性迁移：某账号首次进入且尚无独立配置时，从旧版全局 turtlesoup_config
     *    迁入一次；游客不继承其中的 API Key，避免账号间泄露。
     */
    _loadLocalConfig() {
        let perUser = null;
        try {
            if (window.Store) perUser = Store.get('config', null);
        } catch (e) { /* ignore */ }

        if (!perUser) {
            let legacy = {};
            try {
                const raw = localStorage.getItem('turtlesoup_config');
                if (raw) legacy = JSON.parse(raw);
            } catch (e) { /* ignore */ }
            perUser = { ...legacy };
            if (!STATE.get('user')) perUser.aiKey = '';   // 游客不继承他人 key
            try {
                if (window.Store) Store.set('config', perUser);
            } catch (e) { /* ignore */ }
        }

        // 一次性迁移：旧版单一 aiKey → 分 provider 的 aiKeys（归属当时选中的 provider）
        if (perUser.aiKey && perUser.aiKey.trim()) {
            perUser.aiKeys = perUser.aiKeys || {};
            const p = perUser.aiProvider || 'deepseek';
            if (!perUser.aiKeys[p]) perUser.aiKeys[p] = perUser.aiKey.trim();
            perUser.aiKey = '';
            try {
                if (window.Store) Store.set('config', perUser);
            } catch (e) { /* ignore */ }
        }

        STATE.set('config', { ...CONFIG.DEFAULT_CONFIG, ...perUser });
    },

    /** 从服务器加载 NPC 人格配置 */
    async _loadNpcConfigs() {
        try {
            const data = await API.get('/admin/npc-configs');
            this._npcConfigs = data.configs || {};
            // 服务器效果池（表情/动画定义），实时读取，前端不硬编码
            this._availableEmotions = data.available_emotions || [];
            this._availableActions = data.available_actions || [];
        } catch (e) {
            console.warn('[AccountInit] NPC 配置加载失败，使用默认值', e);
            this._npcConfigs = {};
            this._availableEmotions = [];
            this._availableActions = [];
        }
    },

    /** 获取指定 NPC 人格的配置 */
    getNpcConfig(npcId) {
        return this._npcConfigs[npcId] || {
            scale: 80, portrait_url: '',
            enabled_emotions: [], enabled_actions: [], emotion_effects: {},
            methods: [], emotion_methods: {},
        };
    },

    /** 解析某表情的最终效果（立绘 + 动画），作为 NpcUI/NpcAnim 的统一数据源。
     *  优先「方法池」：emotion_methods[emotion] → methods 中对应方法；
     *  回退旧版 emotion_effects[emotion]。fromMethod 标记是否为方法驱动（方法驱动时严格按站长设定，
     *  无动画即不播动画，不再回退硬编码默认动画）。 */
    getEmotionEffect(npcId, emotionId) {
        const cfg = this.getNpcConfig(npcId) || {};
        const methodId = (cfg.emotion_methods || {})[emotionId];
        if (methodId) {
            const m = (cfg.methods || []).find(x => x.id === methodId);
            if (m) return { portrait: m.portrait || '', anim: m.anim || '', prompt: m.prompt || '', name: m.name || '', fromMethod: true };
        }
        const fx = (cfg.emotion_effects || {})[emotionId] || {};
        return { portrait: fx.portrait || '', anim: fx.anim || '', prompt: fx.prompt || '', name: '', fromMethod: false };
    },

    /** 取该 NPC 的「表情→表现」映射（表情差异化可编辑配置：portrait/anim/prompt） */
    getNpcEmotionEffects(npcId) {
        if (!npcId) return {};
        const cfg = this._npcConfigs[npcId] || {};
        return cfg.emotion_effects || {};
    },

    /** 服务器效果池：表情与动画定义（id + name） */
    getAvailableDefs() {
        return { emotions: this._availableEmotions || [], actions: this._availableActions || [] };
    },

    /** 应用 NPC 配置到 UI */
    _applyNpcConfig() {
        // 缩放将在 _applyWindowScale 中统一处理
        // 音色在 NPC 对话时通过 getNpcConfig 获取
    },

    /** 尝试激活 NPC（检查 API Key） */
    async _activateNpc() {
        const hasKey = !!(window.AiClient && AiClient.currentKey());

        // 默认 NPC 已在 NpcChat.init() 中设置
        const npc = NpcChat.getCurrentNpc();
        if (!npc) return;

        // 应用 per-NPC 立绘 URL
        this._applyNpcPortrait(npc);

        // 恢复该账号 + 当前 NPC 的历史对话记录
        if (typeof NpcChat.loadHistory === 'function') NpcChat.loadHistory();

        if (hasKey) {
            NoAiModule.deactivate();   // 有 key：停用离线引导（修复上个账号/离线态残留的 active）
            await this._applyNpcConfigs(npc);
            NpcChat.addSystemMessage(`${npc.displayName} 已就绪，可以开始对话`);
            // 激活 NPC 时主动问好（结合玩家信息差异化打招呼）
            if (NpcChat.greetOnActivate) NpcChat.greetOnActivate();
        } else {
            NoAiModule.activate();
        }
    },

    /** 应用 per-NPC 立绘 */
    _applyNpcPortrait(npc) {
        const cfg = this.getNpcConfig(npc.id);
        NpcUI.renderPortrait(npc, cfg.portrait_url || '');
    },

    /** 应用 per-NPC 配置（音色、缩放） */
    async _applyNpcConfigs(npc) {
        const cfg = this.getNpcConfig(npc.id);
        // TTS 音色由服务器配置决定，存储在 getNpcConfig 中
        // 缩放通过 CSS 变量在 _applyWindowScale 中统一处理
        console.log(`[AccountInit] NPC ${npc.id} 配置:`, cfg);
    },

    /** 应用 NPC 立绘缩放（后台 scale 40~200，默认 80 → 1 倍）。
     *  CSS 同时缩放容器宽高并用 clamp 限制范围，窗口尺寸变化时自动适配。 */
    _applyWindowScale() {
        const apply = () => {
            const npc = (window.NpcChat && NpcChat.getCurrentNpc) ? NpcChat.getCurrentNpc() : null;
            const cfg = npc ? this.getNpcConfig(npc.id) : {};
            const scale = (parseInt(cfg.scale) || 80) / 80;
            document.documentElement.style.setProperty('--npc-scale', scale);
        };
        apply();
        if (!this._scaleEventBound && window.Events && Events.on) {
            Events.on('npc-changed', apply);
            this._scaleEventBound = true;
        }
    },
};

window.AccountInit = AccountInit;
