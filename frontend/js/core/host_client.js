/** AI剧本网 - 主持通道客户端（HostClient）
 * ------------------------------------------------------------------
 *  `/api/host/*` 的**唯一出口**。这些调用原来散在两处：
 *   - modules/game/game.js  开房 / 心跳 / 结算相位 / 解说完成 / 收场
 *   - modules/npc/chat.js   每轮取主持上下文（拿 system prompt）
 *  各自写超时、各自猜错误码，于是同一个 410 在一处被当成「这一场结束了」，
 *  在另一处被当成「网络抖动」重试 —— 谁坏了说不清。
 *
 *  本模块只做三件事，别的一律不做（不重试、不补证、不降级，那些是调用方的决定）：
 *   1) 统一超时：AbortController，默认 15 秒；取上下文给 30 秒（要现拼整段提示词）。
 *   2) 统一错误码映射：契约 §9.3 的错误体是 `detail = {code, message}`，
 *      HTTP 状态码只说明粗类，`code` 才说明「该重试还是该收场」。抛出的 Error 带：
 *        err.status  HTTP 状态码（连不上/超时为 0）
 *        err.code    契约错误码（network_error / timeout 由本地填）
 *        err.message 人话（直接能给玩家看的）
 *        err.serverMessage 服务端原话（排查用，比人话具体）
 *        err.unreachable  服务端没给出可用答复（连不上 / 超时 / 5xx / 契约版本对不上）
 *        err.contract     契约版本对不上（也是不可达的一种，M30b 要降级）
 *   3) 统一凭证：X-Host-Token = 本场主持证；Authorization = 登录态 JWT。
 *
 *  为什么不复用 core/api.js 发这几个请求（别改回去）：
 *   `API._request` 会把错误体的 detail 压成一句话，对象 detail 会变成
 *   "[object Object]"，**code 就丢了**。而「相位冲突(409)」「证过期(410)」「太快了(429)」
 *   在前端的处置完全不同（能重试 / 只能收场 / 该退避），丢掉 code 就只能靠正则猜。
 *   凭证口径仍与 API 模块同一套（同一个 STATE.token、同样的 hostToken 参数名），
 *   401 也照旧**不登出**：主持端点的 401 是「这一场没有主持证」，不是「登录失效」，
 *   所以这里没有 noAuthLogout 开关 —— 它天生不会顺手把玩家登出。
 */
const HostClient = {
    BASE: '/api/host',

    /** 默认超时（毫秒） */
    TIMEOUT: 15000,
    /** 取主持上下文的超时：服务端要现拼整段提示词 + 查库，比别的端点慢得多 */
    TIMEOUT_CONTEXT: 30000,

    /** 契约版本（改 bundle 结构要跟着改，见契约 §2） */
    CONTRACT: 'aijuben.context/1.3',

    /** 契约错误码 → 人话。**只写玩家能看懂的话**，别把 code 漏给玩家 */
    /**
     * 实测（2026-11，本机后端）与契约文本的出入，别按文本改回去：
     * 收场后拿旧证取 context 是 403 capability_denied（不是 410）；410 只在「证自身失效」出现；
     * 伪造证是 401 no_actor；对已收场的一局再调 settling 是 409 session_phase_conflict；start 返回的 phase 是 hosting。
     */
    _CODE_MESSAGES: {
        no_actor: '未登录，或这张主持证已经失效',
        capability_denied: '这一场已经结束，或者不属于这张证',
        session_phase_conflict: '这一场现在的相位不能做这个动作',
        session_not_idle: '上一场还没结束，先收场再开新的',
        host_token_expired: '这一场已经结束了',
        rate_limited: '操作太快了，稍等一下再试',
        contract_mismatch: '前端与服务的契约版本对不上，刷新页面再试',
        script_not_found: '剧本不存在或已不可体验',
        script_not_approved: '这本剧本还没过审，暂时不能开体验',
        unknown_host_error: '主持通道出错了',
    },

    /** 没有 code 时的兜底（老端点 / 网关层的错） */
    _STATUS_MESSAGES: {
        400: '请求内容不对（契约版本或参数不匹配）',
        401: '未登录，或这张主持证已经失效',
        403: '这一场已经结束，或者不属于这张证',
        404: '剧本不存在或已不可体验',
        409: '相位不对，这个动作现在做不了',
        410: '这一场已经结束了',
        423: '这本剧本还没过审，暂时不能开体验',
        429: '操作太快了，稍等一下再试',
    },

    /* ========== 对外方法 ========== */

    /** 开一场主持会话。返回 {session_id, phase, host_token, expires_at} */
    start(scriptId, opts) {
        if (!scriptId) return Promise.reject(this._mkError(400, 'script_not_found', '缺少剧本 ID'));
        const body = { script_id: scriptId };
        if (opts && opts.npcId) body.npc_id = opts.npcId;
        return this._request('POST', '/session/start', body, opts);
    },

    /** 查某一场的相位快照（会话主人凭登录身份也能查） */
    get(sessionId, opts) {
        if (!sessionId) return Promise.reject(this._mkError(400, 'capability_denied', '缺少会话 ID'));
        return this._request('GET', '/session/' + encodeURIComponent(sessionId), undefined, opts);
    },

    /** 心跳续期：超时判的是「安静了多久」，所以出长解说时要定期报活 */
    heartbeat(sessionId, opts) {
        if (!sessionId) return Promise.reject(this._mkError(400, 'capability_denied', '缺少会话 ID'));
        return this._request('POST', '/session/' + encodeURIComponent(sessionId) + '/heartbeat', {}, opts);
    },

    /** 取主持上下文（含 system_prompt / prompt_hash）。payload 见契约 §4 */
    context(payload, opts) {
        const body = Object.assign({}, payload || {});
        // 契约版本必须带：不带服务端就不知道按哪一版拼
        if (!body.contract) body.contract = this.CONTRACT;
        return this._request('POST', '/context', body,
            Object.assign({ timeout: this.TIMEOUT_CONTEXT }, opts || {}));
    },

    /** 声明「结局成立了，进入结算相位」 */
    settling(sessionId, opts) {
        if (!sessionId) return Promise.reject(this._mkError(400, 'capability_denied', '缺少会话 ID'));
        return this._request('POST', '/session/' + encodeURIComponent(sessionId) + '/settling', {}, opts);
    },

    /** 声明「结局解说说完了」（调早了就是切半句那个老问题） */
    narrated(sessionId, opts) {
        if (!sessionId) return Promise.reject(this._mkError(400, 'capability_denied', '缺少会话 ID'));
        return this._request('POST', '/session/' + encodeURIComponent(sessionId) + '/narrated', {}, opts);
    },

    /** 收场。参数既收 {session_id, reason}，也收 (sessionId, reason) 的散装写法 */
    end(input, reasonOrOpts, maybeOpts) {
        let payload = {};
        let opts = maybeOpts;
        if (input && typeof input === 'object') {
            payload = { session_id: input.session_id || input.id, reason: input.reason || 'aborted' };
            if (reasonOrOpts && typeof reasonOrOpts === 'object') opts = reasonOrOpts;
        } else {
            payload = { session_id: input, reason: (typeof reasonOrOpts === 'string' ? reasonOrOpts : '') || 'aborted' };
        }
        if (!payload.session_id) return Promise.reject(this._mkError(400, 'capability_denied', '缺少会话 ID'));
        return this._request('POST', '/session/end', payload, opts);
    },

    /** 宿主状态：带主持证看本场相位，不带只看「服务活着」 */
    status(opts) { return this._request('GET', '/status', undefined, opts); },

    /** 这个错误是不是「服务端不可达」（连不上 / 超时 / 5xx / 契约版本对不上）。
     *  M30b 的降级判据就靠它 —— 别在调用方各写一套正则去猜。 */
    isUnreachable(err) {
        return !!(err && err.host && err.unreachable);
    },

    /* ========== 内部 ========== */

    /** 构造带契约字段的 Error（所有对外错误都从这里出） */
    _mkError(status, code, message, extra) {
        const err = new Error(message || this._CODE_MESSAGES[code] || ('主持通道请求失败 (' + (status || 0) + ')'));
        err.host = true;                 // 主持通道的错：聊天管线靠它区分「主持不可用」与其他错
        err.status = status || 0;
        err.code = code || '';
        err.contract = code === 'contract_mismatch';
        // 「不可达」= 服务端没给出可用答复。四种同一种处置（M30b：降级 + 打标，不许静默）：
        // 连不上 / 超时 / 5xx / 契约版本对不上（服务端可能已经是新版或旧版，照它拼会胡言乱语）。
        err.unreachable = !status || status >= 500 || err.contract;
        if (extra) Object.assign(err, extra);
        return err;
    },

    /** 请求头：登录态 JWT + 本场主持证（契约 §7.4 允许只带其中一个） */
    _headers(hostToken, hasBody) {
        const headers = {};
        if (hasBody) headers['Content-Type'] = 'application/json';
        const token = (window.STATE && STATE.get) ? STATE.get('token') : null;
        if (token) headers['Authorization'] = 'Bearer ' + token;
        if (hostToken) headers['X-Host-Token'] = hostToken;
        return headers;
    },

    /** 统一请求：超时 / 解析 / 错误码映射都在这一个地方 */
    async _request(method, path, body, opts) {
        const o = opts || {};
        const timeout = o.timeout || this.TIMEOUT;
        const hasBody = (body !== undefined && method !== 'GET');
        const init = {
            method,
            headers: this._headers(o.hostToken, hasBody),
            cache: 'no-store',       // 同 API 模块：禁用启发式缓存，别让相位读到旧答复
        };
        if (hasBody) init.body = JSON.stringify(body);

        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        let timer = null;
        if (ctrl) {
            init.signal = ctrl.signal;
            timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, timeout);
        }

        let res;
        try {
            res = await fetch(this.BASE + path, init);
        } catch (e) {
            // 超时与真断线在 fetch 层长得一样（都是 AbortError / TypeError），只有本地能分清
            const timedOut = !!(e && (e.name === 'AbortError' || /aborted|timeout/i.test(e.message || '')));
            throw this._mkError(0, timedOut ? 'timeout' : 'network_error',
                timedOut
                    ? ('主持通道超时（' + Math.round(timeout / 1000) + ' 秒没有响应）')
                    : '连不上主持通道（网络断了，或服务正在重启）',
                { cause: e });
        } finally {
            if (timer) clearTimeout(timer);
        }

        let data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (res.ok) return data || {};

        // 契约 §9.3：detail = {code, message}；更老的端点可能还是字符串
        const detail = data && data.detail;
        const code = (detail && typeof detail === 'object') ? (detail.code || '') : '';
        const serverMsg = (detail && typeof detail === 'object')
            ? (detail.message || '')
            : (typeof detail === 'string' ? detail : '');
        const human = this._CODE_MESSAGES[code] || this._STATUS_MESSAGES[res.status] || serverMsg
            || ('主持通道请求失败 (' + res.status + ')');
        // 服务端原话往往比人话具体（例：「开体验会话的次数已用尽（20/20）」比「太快了」有用），
        // 拼在人话后面，别让玩家只看到一句「太快了」猜不到原因。
        const message = (serverMsg && serverMsg !== human) ? (human + '：' + serverMsg) : human;
        throw this._mkError(res.status, code || 'unknown_host_error', message, { serverMessage: serverMsg });
    },
};

/* ========== 降级留痕（M30b） ========== */

/**
 * 记一次「主持通道降级」。降级 = 玩家还能继续玩，但条件判定 / 提示词已经不是服务端那份了。
 * 这种状态**不能悄无声息**：
 *   - 玩家侧：由调用方插系统消息 + 把输入还回去（不在这里做）；
 *   - 运营侧：**真的上报**。`window.__hostDegraded` 只给当场排查的人看，控制台里
 *     没人天天盯着 —— 审计 M3 的原话是「留了钩子但没人接线，等于没有」。
 *     所以这里顺手 POST `/api/log/client-event`，落进 access_logs（action=M30b降级）。
 *
 * 只记账：不弹窗、不抛错、不重试 —— 降级本身已经是「还能玩」的兜底，再吓玩家一次没有意义。
 * reason 用人话短句（'连不上主持通道' / '提示词与服务端不一致' / '取上下文超时'）。
 */
HostClient.noteDegraded = function (reason) {
    const ledger = (window.__hostDegraded = window.__hostDegraded || {
        count: 0, reasons: {}, first: null, last: null,
    });
    const key = String(reason || 'unknown').trim() || 'unknown';
    const at = new Date().toISOString();
    ledger.count += 1;
    ledger.reasons[key] = (ledger.reasons[key] || 0) + 1;
    if (!ledger.first) ledger.first = { reason: key, at: at };
    ledger.last = { reason: key, at: at };
    if (window.console) console.warn('[HostClient] 主持通道降级（第 ' + ledger.count + ' 次）：' + key);
    // 上报：fire-and-forget，任何失败都不影响玩家（端点永远 204）。
    // 每局最多报 5 次，避免一局里疯狂降级把日志刷满。
    if (ledger.count <= 5 && typeof fetch === 'function') {
        try {
            fetch('/api/log/client-event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: 'host_degraded', reason: key, count: ledger.count,
                    path: (window.location && location.pathname) || '',
                    state: (window.GameState && typeof GameState.get === 'function'
                        ? GameState.get() : ''),
                }),
                keepalive: true,
            }).catch(function () {});
        } catch (e) { /* 上报失败无所谓 */ }
    }
    return ledger;
};

window.HostClient = HostClient;
