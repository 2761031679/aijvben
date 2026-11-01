/** AI剧本网 - 共享常量 */
const CONFIG = {
    CATEGORY_NAMES: {
        'hai-gui-tang': '海龟汤',
        'dnd': 'DND',
        'coc': 'COC',
        'ju-ben-ban-yan': '剧本扮演',
    },
    CATEGORY_ICONS: {
        'hai-gui-tang': '🐢',
        'dnd': '🐉',
        'coc': '🐙',
        'ju-ben-ban-yan': '🎭',
    },
    ROLE_BADGES: {
        owner: { label: '站长', cls: 'badge-owner' },
        admin: { label: '管理员', cls: 'badge-admin' },
        normal: { label: '用户', cls: 'badge-user' },
        guest: { label: '游客', cls: 'badge-guest' },
    },
    GAME_THEMES: {
        'hai-gui-tang': { bg: '#1a1a2e', accent: '#e94560' },
        'dnd': { bg: '#2d1f0e', accent: '#d4a017' },
        'coc': { bg: '#0f1a0f', accent: '#2e8b57' },
        'ju-ben-ban-yan': { bg: '#1a0a2e', accent: '#9b59b6' },
    },
    DEFAULT_CONFIG: {
        aiProvider: 'deepseek',
        aiModel: 'deepseek-v4-flash',
        aiKey: '',
        aiKeys: {},     // 分 provider 缓存的 API Key：{ deepseek: '...', volcengine: '...' }
        aiModels: {},   // 分 provider 缓存的模型名（自由输入，火山可填接入点 ID）
        ttsMode: '0',
        // 说话方式（同时只能生效一种）：'off' 静音 / 'blip' 说话音 / 'sfx' NPC 录音包 / 'tts' 合成朗读。
        // 这是唯一的人声开关，取代了以前的 voiceEnabled / blipEnabled / sfxEnabled 三个独立布尔。
        // 旧配置读进来时由 NpcChat._speechModeOf() 自动迁移，不需要用户手动改。
        speechMode: 'blip',
        // 朗读引擎（只在 speechMode='tts' 时有意义）：
        //   server  = 服务端微软 edge 语音（/api/tts），8 个站内音色只有它认，但机房 IP 常被拒；
        //   browser = 浏览器内置 Web Speech API，音色看系统、不联网。
        ttsEngine: 'server',
        blipPitch: 1.0,       // 说话音基频倍率：0.7 低 / 1.0 中 / 1.4 高
        blipSpeed: 1.15,      // 说话音语速倍率：0.8 慢 / 1.0 中 / 1.3 快
        blipWave: 'triangle', // 波形：triangle 软 / square 清脆 / sine 闷
        fontSize: 18,
        fontFamily: 'system',      // 字体：system / noto / wenkai
        fontBold: false,           // 正文加粗
        lineHeight: 1.6,           // 行高
        letterSpacing: 0,          // 字间距（px）
        typewriterSpeed: 30,
        volume: 80,
        voiceVolume: 80,
        // 下面三个是 speechMode 的旧形态，只为「读老配置」和「给没更新的旧页面」保留，
        // 新代码一律看 speechMode；saveSettings 会顺手同步一份，别在这里加逻辑。
        voiceEnabled: false,
        blipEnabled: true,
        sfxEnabled: false,
        sfxVolume: 0.8,       // 录音包音量 0~1
        sttProvider: 'vosk',  // 语音识别引擎（下拉从后端 /api/stt/providers 动态读取）
        textColor: '#e2e8f0',
        defaultNpc: 'jingyuniang',
        reviewNpcEnabled: true,   // 审核 NPC 复核：默认开启（关闭时设置中会提示风险）
        autoAdvanceNext: true,    // 分段对话自动播放下一段：默认开启（否则分段回复的最后几段需手动点击/空格推进，易被误认为"被吞掉"）
        bgmEnabled: false,        // BGM 背景音乐开关：**默认关闭**（进站不自动放音乐，需要的玩家自己开）
        bgmVolume: 50,            // BGM 音量 0-100（用户覆盖服务器默认音量）
        bgmScenes: {},            // 用户覆盖的场景映射，如 { main: 'default', turtle_soup: 'turtle_soup' }
    },
    // 模型建议列表内置默认值（回退用）；运行时会被 /static/config/ai_models.json 覆盖（见 ai_client.js loadRemoteConfig）
    AI_MODELS: {
        deepseek: [
            { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash (1M上下文)' },
            { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
        ],
        minimax: [
            { id: 'MiniMax-M3', name: 'MiniMax-M3 (旗舰, 1M上下文)' },
            { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7' },
            { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax-M2.7 高速版' },
            { id: 'MiniMax-M2.5', name: 'MiniMax-M2.5' },
        ],
        qwen: [
            { id: 'qwen3.8-max', name: '千问3.8 Max (旗舰, 2.4T参数)' },
            { id: 'qwen3.7-plus', name: '千问3.7 Plus (均衡)' },
            { id: 'qwen3.7-flash', name: '千问3.7 Flash (轻量极速)' },
        ],
        volcengine: [
            { id: 'doubao-seed-2-1-turbo-260628', name: '火山引擎 Seed 2.1 Turbo' },
            { id: 'doubao-seed-2-1-pro-260628', name: '火山引擎 Seed 2.1 Pro' },
            { id: 'doubao-seed-2-1-lite-260628', name: '火山引擎 Seed 2.1 Lite' },
            { id: 'doubao-seed-evolving', name: '火山引擎 Seed Evolving (持续进化)' },
        ],
    },
    NPC_LIST: [
        { id: 'jingyuniang', name: 'deepseek鲸鱼娘', personalityId: '', displayName: 'deepseek鲸鱼娘' },
        { id: 'xiaoshuai', name: '小帅', personalityId: '', displayName: '小帅' },
        { id: 'xiaomei', name: '小美', personalityId: '', displayName: '小美' },
        { id: 'dagou', name: '大狗', personalityId: '', displayName: '大狗' },
    ],
    PERSONALITY_NAMES: { 'jingyuniang': 'deepseek鲸鱼娘', 'xiaoshuai': '小帅', 'xiaomei': '小美', 'dagou': '大狗' },
    TTS_VOICES: [
        { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女）' },
        { id: 'zh-CN-XiaoyiNeural', name: '晓伊（女）' },
        { id: 'zh-CN-YunxiNeural', name: '云希（男）' },
        { id: 'zh-CN-YunjianNeural', name: '云健（男）' },
        { id: 'zh-CN-YunyangNeural', name: '云扬（男）' },
        { id: 'zh-CN-YunxiaNeural', name: '云夏（男）' },
        { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓蓓·辽宁（女）' },
        { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮·陕西（女）' },
    ],
};

window.CONFIG = CONFIG;
