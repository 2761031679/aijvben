/** AI剧本网 - 剧本体验模块（Experience）
 * ------------------------------------------------------------------
 *  职责：把「开始体验剧本」编排为一个可复用流程，两个入口统一走确认弹窗：
 *   1) 玩家点击剧本卡片/详情页的「开始体验」按钮 → Experience.start(scriptId)
 *   2) NPC 在对话中输出 [sys:start_experience:script_id=xx] → NpcBus → Experience.npcStart(scriptId)
 *
 *  核心：_prepare() 负责
 *   - 开一场主持会话（拿到主持证）并拉取剧本内容：【条件表】拿得到，【汤底正文】不再下发；
 *   - _activatePrepared() 组装浏览器侧仍需的那点数据（_hostData，只有条件表），
 *     把 GameState 置为 experience，并激活条件追踪引擎（ConditionTracker）。
 *  此后每一轮对话，NpcChat 都会带着主持证去 POST /api/host/context，由**服务端**拼好
 *  整段系统提示词发回来——汤底全程不出服务器，所以浏览器里翻不到它。
 *
 *  状态审查（防 NPC 输出途中切换剧本导致上下文错乱）：
 *   - NPC 正在输出 → toast 拦截（仅玩家入口）；
 *   - 切换途中再次触发 → 互斥锁拦截；
 *   - 体验进行中换剧本 → 弹窗确认后才替换。
 *
 *  取消冷却：NPC 邀请被玩家取消后，同一剧本 3 轮对话内不再自动弹窗
 *  （玩家主动强烈要求时 NPC 可再次调用，届时仍由玩家在弹窗中决定）。
 */
/** 剧本板块 → 体验模式（与后端 host_session_service.MODE_BY_CATEGORY 同口径）。
 *  只用于界面显示与事件负载；主持人提示词由服务端按同一张表决定，两边别各写一套。 */
const _MODE_BY_CATEGORY = {
    'hai-gui-tang': 'turtle_soup',
    'dnd': 'dnd',
    'coc': 'coc',
    'ju-ben-ban-yan': 'script_acting',
};
function _modeOf(category) {
    return _MODE_BY_CATEGORY[category] || category || '';
}

const Experience = {
    _scriptId: null,
    _isActive: false,
    _scriptData: null,
    _hostData: null,
    _mode: '',
    _switching: false,        // 体验切换互斥锁（防止替换途中重复触发导致状态错乱）
    _hostSession: null,       // 本场主持会话 {scriptId, id, token, expiresAt}；没开成时为 null
    _hostTimer: null,         // 心跳定时器（把「安静了多久」推走，防止长解说被自己的超时掐断）
    _cancelCooldown: {},      // scriptId -> 剩余冷却轮数（NPC 邀请被玩家取消后）
    // 本场会话的序号：每激活一次 +1、每收场一次 +1。
    // 用途：结算流程会 await 很久（等 NPC 把结局讲完），如果玩家中途点了「再来一次」
    // 开了新的一场，那次等待结束后不能再对「新的一场」做收场动作——否则新场刚开就被拆掉。
    // 谁发起的收场，就只收自己那一场：拿序号比一下即可。
    _sessionSeq: 0,

    /** 进入剧本体验（不做状态审查、不弹确认，供内部/兼容调用）。返回 {ok,title,mode,error}。幂等。 */
    async begin(scriptId) {
        if (!scriptId) return { ok: false, error: '缺少剧本 ID' };
        if (this._isActive && this._scriptId === scriptId && this._scriptData) {
            return { ok: true, title: this._scriptData.title, mode: this._mode, already: true };
        }
        const prepared = await this._prepare(scriptId);
        if (!prepared) return { ok: false, error: '剧本不存在或加载失败' };
        this._activatePrepared(prepared);
        return { ok: true, title: prepared.script.title, mode: prepared.mode };
    },

    /** 玩家点击「开始体验」入口：状态审查 → 确认弹窗 → 进入体验并让 NPC 以主持人身份开场 */
    async start(scriptId) {
        if (window.NpcChat && NpcChat._isLoading) {
            Utils.showToast('操作太快，请等 NPC 输出完再尝试', 'info');
            return;
        }
        if (this._switching) {
            Utils.showToast('操作太快，剧本切换中，请稍候', 'info');
            return;
        }
        if (this._isActive && this._scriptId === scriptId) {
            Utils.showToast('已在体验该剧本中', 'info');
            return;
        }
        if (this._isActive) {
            const cur = (this._scriptData && this._scriptData.title) || '未命名剧本';
            const ok = await UIModule.confirm(
                `当前正在体验《${cur}》，确定要结束并切换到新剧本吗？`,
                { title: '切换剧本', okText: '切换' }
            );
            if (!ok) return;
        }

        this._switching = true;
        try {
            if (window.SystemTexts) await SystemTexts.ensure();
            const prepared = await this._prepare(scriptId);
            if (!prepared) { Utils.showToast('开启剧本体验失败：剧本不存在或加载失败', 'error'); return; }

            // 开始前确认（与 NPC 邀请共用确认弹窗模块）
            const ok = await UIModule.confirm(
                `即将开始体验《${prepared.script.title}》，NPC 将作为主持人带你游玩。`,
                { title: '开始剧本体验', okText: '开始体验' }
            );
            if (!ok) return;

            // 先关闭论坛侧栏面板（触发 browsing→default），再激活体验：
            // 保证状态机的「来源状态」记录为 default，体验结束后恢复正确
            const panel = document.getElementById('forumPanel');
            if (panel && panel.classList.contains('open') && window.closeForumPanel) window.closeForumPanel();

            this._activatePrepared(prepared);

            // NPC 首次发言触发器（极简版：状态本身已由提示词重组承载，这里只触发开场；
            // 文案见 npc_configs/shared/prompts/system_texts.txt experience.open）
            NpcBus.push(SystemTexts.t('experience.open', { title: prepared.script.title }), { immediate: true });
        } finally {
            this._switching = false;
        }
    },

    /** NPC 调用入口（[sys:start_experience]）：确认弹窗 + 取消冷却 + 取消回执。
     *  返回给 NPC 的系统通道文本（NPC 据此继续主持或调整推荐）。 */
    async npcStart(scriptId) {
        if (window.SystemTexts) await SystemTexts.ensure();
        if (!scriptId) return SystemTexts.t('experience.no_id');
        if (this._switching) return SystemTexts.t('experience.switching');
        if (this._isActive && this._scriptId === scriptId) {
            return SystemTexts.t('experience.already', { title: (this._scriptData || {}).title || scriptId });
        }
        // 冷却：玩家近期取消过该剧本的邀请
        if ((this._cancelCooldown[scriptId] || 0) > 0) {
            return SystemTexts.t('experience.cooldown');
        }

        this._switching = true;
        try {
            // 体验中换剧本：先经玩家确认
            if (this._isActive) {
                const cur = (this._scriptData && this._scriptData.title) || '未命名剧本';
                const okSwitch = await UIModule.confirm(
                    `NPC 想结束当前剧本《${cur}》并开启新剧本，是否同意？`,
                    { title: '切换剧本', okText: '切换' }
                );
                if (!okSwitch) {
                    this._setCooldown(scriptId);
                    return SystemTexts.t('experience.switch_rejected');
                }
            }

            const prepared = await this._prepare(scriptId);
            if (!prepared) return SystemTexts.t('experience.load_failed');

            const ok = await UIModule.confirm(
                `NPC 邀请你体验剧本《${prepared.script.title}》，是否开始？`,
                { title: '剧本体验', okText: '开始体验' }
            );
            if (!ok) {
                this._setCooldown(scriptId);
                return SystemTexts.t('experience.cancelled');
            }

            this._activatePrepared(prepared);
            return SystemTexts.t('experience.started', { title: prepared.script.title });
        } finally {
            this._switching = false;
        }
    },

    /** 结束体验：恢复到进入体验前的状态（状态机自动重组提示词）。
     * @param {string} trigger 触发来源（experience_exit 玩家退出 / settlement 结算弹出） */
    end(trigger) {
        this._sessionSeq = (this._sessionSeq || 0) + 1;   // 收场：序号也前进，旧流程的等待结果一律作废
        const wasActive = this._isActive;
        const endedScriptId = this._scriptId;
        // 核心状态先复位：任何消息渲染/事件监听异常都不能把体验卡在 active，
        // 否则下次开始会一直提示「已在体验该剧本中」。
        this._isActive = false;
        if (wasActive) {
            try { NpcChat.addMessage('system', '[info:🎬 体验结束，NPC 已退出主持人模式]'); }
            catch (e) { console.warn('[Experience] 结束消息渲染失败', e); }
            try { if (window.Events) Events.emit('experience-ended', { scriptId: endedScriptId }); }
            catch (e) { console.warn('[Experience] 结束事件监听失败', e); }
        }
        // 上下文隔断：退出剧本时，隔断点推进到当前，隔断副本区域的所有对话（回到网页面板不串台，UI 历史不受影响）
        if (window.NpcChat) NpcChat._contextBreakId = (NpcChat._msgId || 0);
        // 持久化隔断时刻：刷新后 loadHistory 按时间戳重新定位隔断点
        if (window.Store) Store.set('context_break_at', Date.now());
        this._scriptId = null;
        this._scriptData = null;
        this._hostData = null;
        this._mode = '';
        // 正常退出体验：清除「上次体验剧本」记录，不再视为「未完成」
        if (window.Store) Store.remove('last_experience_script');
        if (window.ConditionTracker) ConditionTracker.deactivate();
        if (window.GameInventory) GameInventory.deactivate();
        // 退出剧本时初始化血量（重置血量存档，下次开局从默认值开始）
        if (window.StatusUiHp) StatusUiHp.reset();
        // 状态栏：统一清理隐藏所有 UI（结算/主动退出/切换剧本/NPC 退出 各路径都经此覆盖）
        if (window.StatusBar) StatusBar.clear();
        // 结束这一场的主持会话。trigger==='settled' 才会走 settled 分支
        // （服务端要求「已在结算相位 + 解说讲完」两条同时成立，缺一条会 409 退回）。
        this._closeHostSession(trigger === 'settled' ? 'settled' : 'aborted');
        // 状态变更：回到进入体验前的状态（状态机自动重组提示词并打印测试信息）
        if (window.GameState) GameState.returnFromExperience(trigger || 'experience_exit');
        // 面板类 UI 复位：上面 StatusBar.clear() 管的是「状态栏那几条」，
        // 管不到海龟汤 HUD（剩余提问数、条件进度条）与其它体验态专属面板，
        // 所以以前收场后 HUD 还挂在屏幕上，得刷新页面才消失。
        // 这两个复位函数由各自模块提供，缺了也不能让收场流程炸掉，故用可选调用。
        try {
            if (window.TurtleSoupHud && TurtleSoupHud.resetForExperienceEnd) TurtleSoupHud.resetForExperienceEnd();
            if (window.StatusBar && StatusBar.resetForExperienceEnd) StatusBar.resetForExperienceEnd();
        } catch (e) { console.warn('[Experience] HUD 复位失败', e && e.message); }
        console.log('[Experience] 结束剧本体验');
    },

    /** 结算面板「再来一次」：把这一场收干净，再用同一本剧本开一场全新的。
     *
     *  为什么不能直接调 start()：start() 开头有「已在体验该剧本中」的拦截，
     *  而结算面板弹出时这一场**还没结束**（结束要等 NPC 把结局讲完），
     *  于是点「再来一次」只会关掉面板，什么都不发生——以前就是这个表现。
     *
     *  这里绕开那个拦截：先主动收场（end），再重新 prepare（顺带换一张新主持证），
     *  然后激活并触发开场白。不弹确认框——玩家已经明确点了「再来一次」。
     *  @returns {Promise<{ok:boolean,title?:string,mode?:string,error?:string}>}
     */
    async restart(scriptId) {
        const sid = scriptId || this._scriptId;
        if (!sid) return { ok: false, error: '缺少剧本 ID' };
        if (this._switching) return { ok: false, error: '正在切换剧本，请稍候' };
        this._switching = true;
        try {
            if (window.SystemTexts) await SystemTexts.ensure();
            // 先把旧的一场收掉：撤销旧主持证、清状态栏与 HUD、退出体验态。
            // 不做这一步，新一场会在「上一场还活着」的基础上叠加，出现两个主持证、条件计数翻倍。
            if (this._isActive) this.end('aborted');

            const prepared = await this._prepare(sid);
            if (!prepared) return { ok: false, error: '剧本不存在或加载失败' };

            this._activatePrepared(prepared);
            NpcBus.push(SystemTexts.t('experience.open', { title: prepared.script.title }), { immediate: true });
            return { ok: true, title: prepared.script.title, mode: prepared.mode };
        } catch (e) {
            console.warn('[Experience] 重新开始失败', e && e.message);
            return { ok: false, error: (e && e.message) || '重新开始失败' };
        } finally {
            this._switching = false;
        }
    },

    isActive() { return this._isActive; },

    /** 当前会话序号（见 _sessionSeq 注释）。结算流程用来判断「我等的还是不是同一场」。 */
    sessionSeq() { return this._sessionSeq || 0; },

    /* ===== 本场主持会话（合同 §9.2 / §7.4） ===== */

    /** 手上这张主持证还有效吗（服务端 4 小时封顶；本地按 expiresAt 判，缺字段就当有效） */
    _hostTokenLive() {
        const h = this._hostSession;
        if (!h || !h.token) return false;
        if (h.expiresAt && Date.parse(h.expiresAt) <= Date.now()) return false;
        return true;
    },

    /** 开一场主持会话，拿主持证；同一剧本已开过就复用。返回主持证（失败返回 null） */
    async _openHostSession(scriptId) {
        // 复用必须连有效期一起判：只比 scriptId 会把一张已过期的证原样交回去，
        // 于是「补证」等于没补，玩家此后每一轮都撞 401，只能刷页面（审计 必改-1）。
        if (this._hostSession && this._hostSession.scriptId === scriptId && this._hostTokenLive()) {
            return this._hostSession.token;
        }
        // 开房失败后不每轮重试：连续撞 429 只会多一次往返（审计 建议-2）
        if (this._hostOpenFailedAt && Date.now() - this._hostOpenFailedAt < 30000) {
            // 冷却期也必须出声：上一轮「静默失败」的坑就是从这种空 return 里长出来的（审计 N2）
            console.warn('[Experience] 开房失败冷却中，剩 %ds 才重试',
                Math.ceil((30000 - (Date.now() - this._hostOpenFailedAt)) / 1000));
            return null;
        }
        await this._closeHostSession('aborted');
        try {
            const r = await HostClient.start(scriptId);
            this._hostSession = {
                scriptId, id: r.session_id, token: r.host_token, expiresAt: r.expires_at,
            };
            this._hostOpenFailedAt = 0;
            this._startHeartbeat();
            console.log('[Experience] 已开主持会话', { sessionId: r.session_id, expiresAt: r.expires_at });
            return r.host_token;
        } catch (e) {
            // 开不出来不拦着玩家体验，但要留下明确痕迹：汤底/条件表会是空的，结算不会触发
            console.warn('[Experience] 开主持会话失败——本轮拿不到汤底与条件表，条件结算将空转', e);
            // 降级留痕：这一局玩家还能玩，但条件判定是空转的（M30b）
            HostClient.noteDegraded('开主持会话失败（' + ((e && e.code) || 'error') + '）');
            this._hostSession = null;
            this._hostOpenFailedAt = Date.now();
            return null;
        }
    },

    /** 结束主持会话。失败也不抛：会话闲置 5 分钟服务端会自己收掉 */
    async _closeHostSession(reason) {
        this._stopHeartbeat();
        const h = this._hostSession;
        this._hostSession = null;
        if (!h) return;
        try {
            await HostClient.end({ session_id: h.id, reason: reason || 'aborted' }, { hostToken: h.token });
        } catch (e) {
            console.warn('[Experience] 结束主持会话失败（服务端会按闲置超时自行收掉）', e);
        }
    },

    /** 心跳：超时判定看的是「安静了多久」，不是「一次请求多久」，所以要定期报活 */
    _startHeartbeat() {
        this._stopHeartbeat();
        this._hostTimer = setInterval(() => {
            const h = this._hostSession;
            if (!h) return;
            const beat = async (attempt = 0) => {
                try {
                    await HostClient.heartbeat(h.id, { hostToken: h.token });
                } catch (e) {
                    // 部署重启窗口的瞬时 502/503/504 做短退避重试；仍同一场才补发。
                    // 502/503/504 是部署重启窗口；status 0 是连不上/超时（HostClient 标的）。
                    // 两者都是瞬时的，值得短退避重试一次；其余（410 已收场、403 证不对）重试也没用。
                    const transient = e && (!e.status || [502, 503, 504].includes(e.status));
                    if (transient && attempt < 2) {
                        setTimeout(() => { if (this._hostSession === h) beat(attempt + 1); }, 2000 * (attempt + 1));
                        return;
                    }
                    console.warn('[Experience] 主持心跳失败', e);
                }
            };
            beat();
        }, 60000);
    },

    _stopHeartbeat() {
        if (this._hostTimer) { clearInterval(this._hostTimer); this._hostTimer = null; }
    },

    /** 声明「结局成立了，进入结算相位」。条件系统判定那一刻调一次 */
    async beginSettling() {
        const h = this._hostSession;
        if (!h) return false;
        try {
            await HostClient.settling(h.id, { hostToken: h.token });
            return true;
        } catch (e) {
            console.warn('[Experience] 进入结算相位失败（结算会退回 aborted）', e);
            return false;
        }
    },

    /** 声明「结局解说说完了」。只在解说真正讲完之后调 —— 调早了就是切半句那个老问题 */
    async markNarrated() {
        const h = this._hostSession;
        if (!h) return false;
        try {
            await HostClient.narrated(h.id, { hostToken: h.token });
            return true;
        } catch (e) {
            console.warn('[Experience] 标记解说完成失败', e);
            return false;
        }
    },
    currentScriptId() { return this._scriptId; },
    currentMode() { return this._mode; },
    /** 当前体验剧本的完整数据（供工具面板 HUD 等读取汤面/条件表） */
    currentScript() { return this._scriptData; },

    /** 本场主持会话（给 NpcChat 取提示词用）：{scriptId, id, token, expiresAt} 或 null。
     *  证过期就返回 null —— 过期的证递上去只会换回一个 410，之后每一轮对话都报错，
     *  人要刷新页面才能恢复（审计 A3）。 */
    hostSession() {
        if (!this._hostTokenLive()) return null;
        const h = this._hostSession;
        return { scriptId: h.scriptId, id: h.id, token: h.token, expiresAt: h.expiresAt };
    },

    /** 丢掉手上这张主持证（服务端说「这一场已经结束」时用）。
     *  只清本地：服务端那边这一场已经结束了，再发一次 end 也只会被拒，失败照旧吞掉。
     *  清完之后 ensureHostSession() 会开**新的一局**——不然前端还拿着一张死证，
     *  每一轮都撞 403/410，玩家只能刷页面。 */
    async dropHostSession(reason) {
        console.warn('[Experience] 丢掉本地主持证（这一场在服务端已经结束了），下次取上下文时重开');
        try { await this._closeHostSession(reason || 'aborted'); }
        catch (e) { /* _closeHostSession 自己就吞了，这里只兜底 */ }
    },

    /** 现场补一张主持证（证过期/开房失败后用）。成功返回 token，失败返回 null。 */
    async ensureHostSession(scriptId) {
        try {
            return await this._openHostSession(scriptId || this._scriptId);
        } catch (e) {
            console.warn('[Experience] 补开主持会话失败', e && e.message);
            return null;
        }
    },

    /** 继续上次未完成的剧本体验（[sys:resume_experience]）。
     *  优先本地记录的「上次体验剧本」（游客/未登录也可用），其次登录用户的后端未完成剧本列表。
     *  重新激活体验后，状态栏 UI / 条件进度 / 线索道具 / BGM 由 _activatePrepared 自动复原。 */
    async resumeLast() {
        let scriptId = window.Store ? Store.get('last_experience_script', '') : '';
        if (!scriptId && !STATE.get('isGuest')) {
            try {
                const sessions = await API.get('/user/play-sessions');
                if (sessions && sessions.length) scriptId = sessions[0].script_id;
            } catch (e) { /* 忽略 */ }
        }
        if (!scriptId) return '当前没有未完成的剧本体验，无法继续';
        if (this._isActive && this._scriptId === scriptId) {
            return `《${this._scriptData ? this._scriptData.title : scriptId}》正在体验中，请继续主持，无需重复开启`;
        }
        const r = await this.begin(scriptId);
        if (!r.ok) return '继续体验失败：' + (r.error || '剧本不存在或加载失败');
        return `已继续体验《${r.title}》，主持规则与剧本内容已重新注入，请从上次停下的地方继续主持`;
    },

    /* ========== 内部 ========== */

    /** 拉取剧本完整内容 + 引导/模式提示词（不落状态）；失败返回 null */
    async _prepare(scriptId) {
        // 0. 先开这一场的主持会话，拿到主持证。
        //    「拿汤底的钥匙是正在主持这一场」，不是「登录过」（合同 §10.1）——
        //    所以必须先把会话开出来，否则下面的剧本详情只会回公开字段，
        //    汤底与条件表全空，结算系统会静默空转（以前就是这个状态）。
        const hostToken = await this._openHostSession(scriptId);

        // 1. 拉取剧本完整内容（NPC 可信代理视角，含汤底/条件表）；失败回退公开详情
        let script = null;
        try {
            const resp = await ScriptAPI.npcScriptDetail(scriptId, hostToken);
            script = resp && resp.script;
        } catch (e) { /* 回退 */ }
        if (!script) {
            // 测试信息：拿不到完整内容时条件表/汤底缺失，结算系统将空转（结算 BUG 排查入口）
            console.warn('[Experience] npcScriptDetail 失败，回退公开详情——条件表/汤底可能缺失，结算系统将无法工作', { scriptId });
            try { script = await ScriptAPI.detail(scriptId); } catch (e) { /* 忽略 */ }
        }
        if (!script) return null;

        // 2. 模式（只用于界面显示与事件）。
        //    以前这里还要拉一份「引导 + 模式提示词」，那是为了在前端拼提示词；
        //    提示词搬到服务端之后，那段数据没人用了，接口也删了（用户要求）。
        return { script, mode: _modeOf(script.category) };
    },

    /** 组合主持上下文 + 置状态 + 激活条件引擎（两个入口共用） */
    _activatePrepared(prepared) {
        const { script, mode } = prepared;
        this._scriptId = script.id || this._scriptId;
        this._scriptData = script;
        this._mode = mode;
        this._hostData = this._buildHostData(script);
        this._isActive = true;
        this._sessionSeq = (this._sessionSeq || 0) + 1;   // 新的一场：序号前进
        // 上下文隔断：进入新剧本时，隔断点推进到「玩家发起体验」这一句之前，
        // 只保留发起体验的意图与新剧本对话（上个剧本 / 网页面板闲聊不再进入上下文，UI 历史不受影响）
        if (window.NpcChat) NpcChat._contextBreakId = Math.max(0, (NpcChat._msgId || 0) - 1);
        // 持久化隔断时刻：刷新后 loadHistory 按时间戳重新定位隔断点（_id 会重新编号，不能存绝对 _id）
        if (window.Store) Store.set('context_break_at', Date.now());
        // 记录「当前体验的剧本」，供 [sys:resume_experience] 继续上次体验恢复；
        // 正常退出（end）会清除，只有「未完成就关闭页面」的情况才保留
        if (window.Store) Store.set('last_experience_script', this._scriptId);
        // 状态变更（状态机自动重组提示词并打印测试信息；注意须在 _hostData 就绪后切换）
        if (window.GameState) GameState.set(GameState.EXPERIENCE, { scriptId: this._scriptId, title: script.title, mode }, 'experience_start');

        // 条件系统：激活计数器（剧本无 endings/tasks 条件表时内部空转，兼容旧剧本）
        if (window.ConditionTracker) {
            ConditionTracker.activate(this._scriptId, this._hostData.script.endings, this._hostData.script.tasks);
        }
        // 线索/道具面板：激活（已结算剧本重进自动清零开新周目）
        if (window.GameInventory) {
            GameInventory.activate(this._scriptId);
        }
        // 开始剧本前初始化血量（重置血量存档为默认值，避免上一局的数值带入本局）
        if (window.StatusUiHp) StatusUiHp.reset();

        NpcChat.addMessage('system', `[info:📖 开始体验剧本：《${script.title}》]`);
        // 状态栏：显示模式状态 UI；海龟汤额外显示失败/成功条件 UI（血量条按需由 NPC 命令触发）
        if (window.StatusBar) {
            StatusBar.show('mode');
            if (script.category === 'hai-gui-tang') StatusBar.show('conditions');
        }
        if (window.Events) Events.emit('experience-started', { scriptId: this._scriptId, title: script.title, mode, category: script.category });
        console.log('[Experience] 进入剧本体验', { scriptId: this._scriptId, mode });
    },

    /** 只保留浏览器还用得到的那部分剧本数据。
     *
     *  以前这里还会拼「引导 + 模式提示词」并填充占位符，那是给前端组装提示词用的；
     *  现在提示词由服务端拼（`POST /api/host/context`），汤底也不再下发到浏览器，
     *  所以 guide / modePrompt / 占位符填充全部删除。
     *  剩下 `endings` / `tasks` 是**条件表**，浏览器要靠它判定玩家识破了没有。 */
    _buildHostData(script) {
        const sid = script.id || this._scriptId || '';
        // 胜利/失败条件表（JSON 字符串 → 对象）；旧剧本无此字段时为空数组，走旧结束条件逻辑
        let endings = [];
        try {
            const parsed = JSON.parse(script.endings || '');
            if (parsed && Array.isArray(parsed.endings)) endings = parsed.endings;
        } catch (e) { /* 非法 JSON 按无条件表处理 */ }
        // 任务条件表（JSON 字符串 → 对象）；无任务时为空数组
        let tasks = [];
        try {
            const parsed = JSON.parse(script.tasks || '');
            if (parsed && Array.isArray(parsed.tasks)) tasks = parsed.tasks;
        } catch (e) { /* 非法 JSON 按无任务处理 */ }
        // 测试信息：无条件表时结算系统空转（旧剧本走 ending_condition 模式规则，属预期）
        if (!endings.length) {
            console.warn('[Experience] 该剧本无胜利/失败条件表（endings 为空），条件结算系统空转', { scriptId: sid });
        }
        return {
            script: {
                id: sid,
                title: script.title || '',
                categoryName: CONFIG.CATEGORY_NAMES[script.category] || script.category || '',
                story: script.story || '',
                ending_condition: script.ending_condition || '',
                endings,
                tasks,
                // explanation / host_guide 不再出现在这里：汤底已经不发给浏览器，
                // 留着这两个字段只会永远是空串，骗后来读代码的人。
            },
        };
    },

    /** 记录一次取消冷却（3 轮对话） */
    _setCooldown(scriptId) {
        if (scriptId) this._cancelCooldown[scriptId] = 3;
    },

    /** 每完成一轮用户对话由 NpcChat 调用：冷却计数 -1 */
    _tickCooldown() {
        for (const k of Object.keys(this._cancelCooldown)) {
            if (this._cancelCooldown[k] > 0) this._cancelCooldown[k]--;
        }
    },

    /** 给剧本卡片/详情页提供「开始体验」按钮 HTML */
    renderStartButton(scriptId) {
        return `<button class="btn btn-success btn-sm" onclick="event.stopPropagation();Experience.start('${scriptId}')">🎮 开始体验</button>`;
    },
};

/* ===== NPC 系统指令：开始体验 =====
 * 流程（v4.3 起）：NPC 判断玩家想玩某剧本 → 直接调用 [sys:start_experience] →
 *   系统弹窗与玩家确认（玩家取消会回执给 NPC，且同剧本进入 3 轮冷却）→
 *   确认后系统注入主持上下文，NPC 开始主持。
 * 结算不再由 NPC 触发：条件系统（ConditionTracker）统计条件标记并自动结算，
 * 故不再注册 show_settlement 指令。 */
if (window.NpcBus) {
    NpcBus.register('start_experience', async (params) => {
        const scriptId = params.script_id || params.id || params.script;
        return Experience.npcStart(scriptId);
    });

    // NPC 主动结束体验：[sys:end_experience] 或 [do:end_experience]。
    // 静默执行（返回 null），NPC 可在同一回复里对玩家说结束语。
    NpcBus.register('end_experience', async () => {
        if (Experience.isActive()) Experience.end('npc_exit');
        return null;
    });

    // 继续上次未完成的剧本体验：[sys:resume_experience]。
    // 系统自动重新激活体验（状态栏 UI / 条件进度 / 线索道具 / BGM 复原），返回回执给 NPC 继续主持。
    NpcBus.register('resume_experience', async () => {
        return Experience.resumeLast();
    });
}

// 向后兼容旧引用
window.Experience = Experience;
window.GameEngine = Experience;
