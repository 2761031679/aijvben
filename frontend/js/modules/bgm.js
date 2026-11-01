/** AI剧本网 - BGM 背景音乐模块
 *  - 从服务器 bgm_config（/api/site-settings）读取 BGM 文件列表 + 场景映射 + 默认音量；
 *  - 用户本地配置（Store config）可覆盖「场景→BGM」映射与音量；
 *  - 场景切换：主界面(main) 播默认、海龟汤体验(turtle_soup) 播海龟汤 BGM；
 *  - PC 左下角黑胶唱片 UI（点击暂停/播放，🎵 按钮切换 BGM）；手机端隐藏播放器。 */
const BgmPlayer = {
    _cfg: null,          // 服务器 bgm_config
    _files: [],          // BGM 文件列表 [{id,name,file}]
    _audio: null,        // HTML5 Audio（懒加载）
    _currentScene: 'main',
    _currentId: null,
    _currentFile: null,
    _enabled: true,
    _volume: 50,
    _userScenes: {},     // 用户覆盖的场景映射

    FALLBACK_FILES: [
        { id: 'default', name: 'Daydream', file: 'BGM-默认.mp3' },
        { id: 'turtle_soup', name: 'Cloud in a Cup', file: 'BGM-海龟汤.mp3' },
        { id: 'mischief', name: 'Little Devil', file: 'BGM-小恶作剧.mp3' },
        { id: 'happy', name: "Dawn's Trumpet", file: 'BGM-欢快.mp3' },
    ],

    /** 初始化：拉服务器配置 + 用户配置，渲染 UI，绑定场景切换 */
    async init() {
        try {
            const site = await API.get('/site-settings');
            this._cfg = site.bgm_config || null;
        } catch (e) { this._cfg = null; }

        this._files = (this._cfg && Array.isArray(this._cfg.files) && this._cfg.files.length)
            ? this._cfg.files : this.FALLBACK_FILES;

        const config = Utils.getConfig();
        const defVol = (this._cfg && this._cfg.default_volume) || 50;
        this._volume = Math.max(0, Math.min(100, parseInt(config.bgmVolume != null ? config.bgmVolume : defVol) || 0));
        this._enabled = config.bgmEnabled !== false;
        this._userScenes = config.bgmScenes || {};

        this._audio = new Audio();
        this._audio.loop = true;
        this._audio.volume = this._volume / 100;
        this._audio.preload = 'none';

        this._renderUI();
        this._bindScene();

        // 浏览器自动播放策略：首次用户交互后开始播放（若当前应播放）
        const unlock = () => {
            if (this._enabled && this._currentId && this._audio.paused) {
                this._audio.play().catch(() => {});
            }
        };
        ['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, unlock, { once: true }));

        this.playScene('main');
    },

    /* ========== 播放控制 ========== */

    /** 场景对应 BGM id：用户覆盖优先，其次服务器 scenes，最后 main */
    _sceneBgmId(scene) {
        if (this._userScenes && this._userScenes[scene]) return this._userScenes[scene];
        const scenes = (this._cfg && this._cfg.scenes) || { main: 'default', turtle_soup: 'turtle_soup' };
        return scenes[scene] || 'default';
    },

    /** 按场景播放对应 BGM */
    playScene(scene) {
        this._currentScene = scene || 'main';
        this.play(this._sceneBgmId(this._currentScene));
    },

    /** 播放指定 BGM id */
    play(id) {
        const f = this._files.find(x => x.id === id);
        if (!f) return;
        this._currentId = id;
        if (this._currentFile !== f.file) {
            this._currentFile = f.file;
            const base = (this._cfg && this._cfg.base_url) || '/static/audio/bgm/';
            this._audio.src = base + encodeURIComponent(f.file);
        }
        if (this._enabled) this._audio.play().catch(() => {});
        this._renderUI();
    },

    /** 暂停 / 播放切换 */
    toggle() {
        if (this._audio.paused) {
            this._audio.play().catch(() => {});
        } else {
            this._audio.pause();
        }
        this._renderUI();
    },

    /** 设置音量 0-100 */
    setVolume(v) {
        this._volume = Math.max(0, Math.min(100, parseInt(v) || 0));
        this._audio.volume = this._volume / 100;
    },

    /** 启用 / 禁用 */
    setEnabled(enabled) {
        this._enabled = !!enabled;
        if (!enabled) this._audio.pause();
        else if (this._currentId) this._audio.play().catch(() => {});
        this._renderUI();
    },

    /** 用户手动切换当前场景的 BGM，并写入本地配置 */
    switchBgm(id) {
        this._userScenes[this._currentScene] = id;
        const config = Utils.getConfig();
        config.bgmScenes = this._userScenes;
        if (window.Store) Store.set('config', config);
        STATE.set('config', config);
        this.play(id);
    },

    /* ========== UI ========== */

    _renderUI() {
        const root = document.getElementById('bgmPlayer');
        if (!root) return;
        const f = this._files.find(x => x.id === this._currentId);
        const name = f ? f.name : 'BGM';
        const playing = this._enabled && !this._audio.paused;
        root.innerHTML = `
            <div class="bgm-disc ${playing ? 'playing' : ''}" onclick="BgmPlayer.toggle()" title="暂停 / 播放">
                <div class="bgm-disc-hole"></div>
            </div>
            <span class="bgm-name" onclick="BgmPlayer._toggleMenu()" title="点击切换 BGM">${Utils.escapeHtml(name)}</span>
            <div class="bgm-menu-list" style="display:none;">
                ${this._files.map(x => `
                    <div class="bgm-menu-item ${x.id === this._currentId ? 'active' : ''}" onclick="BgmPlayer.switchBgm('${x.id}')">${Utils.escapeHtml(x.name)}</div>`).join('')}
            </div>`;
    },

    _toggleMenu() {
        const list = document.querySelector('#bgmPlayer .bgm-menu-list');
        if (list) list.style.display = list.style.display === 'none' ? 'block' : 'none';
    },

    /* ========== 场景切换 ========== */

    _bindScene() {
        if (!window.GameState) return;
        GameState.onEnter(GameState.EXPERIENCE, () => {
            const cat = (window.Experience && Experience.currentScript) ? Experience.currentScript().category : '';
            this.playScene(cat === 'hai-gui-tang' ? 'turtle_soup' : 'main');
        });
        GameState.onExit(GameState.EXPERIENCE, () => {
            this.playScene('main');
        });
    },
};

window.BgmPlayer = BgmPlayer;
