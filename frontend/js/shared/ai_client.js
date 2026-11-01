/** AI剧本网 - AI 调用客户端（共享模块）
 *
 * 职责：统一的 OpenAI 兼容 /chat/completions 调用（DeepSeek / MiniMax / 千问 / 豆包），
 * 使用用户在设置中配置的同一套 provider / key / model，
 * 供网页 NPC（NpcChat）与审核 NPC（NpcReview）双开对话复用，避免重复实现。
 *
 * key / model 均按 provider 分槽缓存（config.aiKeys / config.aiModels），
 * 切换 provider 不会把 key 串用到错误的模型上。
 *
 * 降级通道：浏览器直连失败（CORS / 网络层错误，fetch 抛异常）时，
 * 自动改走后端 /api/ai/proxy 代理转发（key 走请求头透传，服务器不存储）。
 */
const AiClient = {
    /** 各 provider 端点表（内置默认值，作为 /static/config/ai_models.json 加载失败时的回退；
     *  正常运行时会被 loadRemoteConfig() 用 JSON 配置覆盖）。
     *  rm = 角色名映射（四家均为 OpenAI 兼容小写 system/user/assistant；
     *  MiniMax chatcompletion_v2 官方文档同样使用小写角色名，且 API Key 与域名严格匹配：
     *  minimaxi.com 控制台申请的 key 必须调 api.minimaxi.com）。
     *  注意：与后端 routers/ai_proxy.py 的 PROVIDER_URLS 白名单保持一致。 */

    /** 当前可用 provider 白名单。千问(qwen)/MiniMax 暂时关闭（未调整好，2026-08-22），
     *  DeepSeek 与火山引擎(volcengine) 可用。旧配置若指向已关闭模型，endpoint()/currentKey() 会强制回退。 */
    AVAILABLE_PROVIDERS: ['deepseek', 'volcengine'],

    /** AI 请求默认超时（毫秒）。AI 正常回复约 5-10 秒，15 秒是宽松上限：超过说明
     *  可能挂起/异常。超过则中止 fetch 并抛「响应超时」，避免 _isLoading 卡死、后续消息被拦截。
     *  具体请求可通过 complete(messages, { timeout }) 按次覆盖（如「检测重试」用更长超时）。 */
    TIMEOUT: 15000,

    /** 必须走后端代理的 provider（端点不允许浏览器 CORS 直连，如火山方舟）。
     *  直连必然触发 CORS 失败再降级，直接走代理省一次往返、消除等待。 */
    _PROXY_ONLY_PROVIDERS: ['volcengine'],

    ENDPOINTS: {
        deepseek:   { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-v4-flash', rm: { system: 'system', user: 'user', assistant: 'assistant' } },
        minimax:    { url: 'https://api.minimaxi.com/v1/text/chatcompletion_v2', model: 'MiniMax-M3', rm: { system: 'system', user: 'user', assistant: 'assistant' } },
        qwen:       { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen3.8-max', rm: { system: 'system', user: 'user', assistant: 'assistant' } },
        volcengine: { url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'doubao-seed-2-1-turbo-260628', rm: { system: 'system', user: 'user', assistant: 'assistant' } },
    },

    /** 从 /static/config/ai_models.json 拉取可配置模型表（单一数据源，前后端共用）。
     *  加载成功则覆盖 ENDPOINTS 默认模型/URL 与 CONFIG.AI_MODELS 建议列表；
     *  失败（离线/JSON 非法）保持代码内置默认值，不影响使用。 */
    async loadRemoteConfig() {
        try {
            const res = await fetch('/static/config/ai_models.json?_=' + Date.now(), { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            const providers = data && data.providers;
            if (!providers || typeof providers !== 'object') return;
            for (const [p, cfg] of Object.entries(providers)) {
                if (!cfg || typeof cfg !== 'object') continue;
                const ep = this.ENDPOINTS[p];
                if (ep) {
                    if (cfg.url) ep.url = cfg.url;
                    if (cfg.defaultModel) ep.model = cfg.defaultModel;
                }
                if (window.CONFIG && Array.isArray(cfg.models) && cfg.models.length) {
                    const models = cfg.models.filter(m => m && m.id);
                    if (models.length) CONFIG.AI_MODELS[p] = models;
                }
            }
            // 设置弹窗若已打开，刷新模型建议列表
            if (window.NpcChat && typeof NpcChat._updateModelList === 'function') {
                NpcChat._updateModelList();
            }
        } catch (e) {
            console.warn('[AiClient] 模型配置加载失败，使用内置默认值:', e.message);
        }
    },

    /** 当前用户配置对应的端点（含角色名映射 rm）。
     *  模型优先级：分 provider 缓存 aiModels[provider] → 旧版全局 aiModel → 端点默认。 */
    endpoint() {
        const config = Utils.getConfig();
        let provider = config.aiProvider || 'deepseek';
        if (!this.AVAILABLE_PROVIDERS.includes(provider)) provider = 'deepseek';
        const ep = this.ENDPOINTS[provider] || this.ENDPOINTS.deepseek;
        const model = (config.aiModels && config.aiModels[provider]) || config.aiModel || ep.model;
        return { url: ep.url, model, rm: ep.rm, provider };
    },

    /** 当前 provider 的 API Key（分 provider 缓存 aiKeys[provider]，回退旧版全局 aiKey） */
    currentKey() {
        const config = Utils.getConfig();
        let provider = config.aiProvider || 'deepseek';
        if (!this.AVAILABLE_PROVIDERS.includes(provider)) provider = 'deepseek';
        const key = config.aiKeys && config.aiKeys[provider];
        return ((key && key.trim()) || (config.aiKey || '').trim());
    },

    /** 发送聊天请求。直连失败（网络层）自动降级后端代理。
     * @param {Array}  messages 已按当前 provider 角色名归一化后的消息数组
     * @param {Object} [opts]    { maxTokens, temperature }
     * @returns {Promise<{content: string, ep: Object}>} AI 回复文本与所用端点
     * @throws Error 无 key 或 provider 返回错误（message 含 provider 真实错误原因）
     */
    async complete(messages, opts = {}) {
        const apiKey = this.currentKey();
        if (!apiKey) throw new Error('请先在设置中配置 AI API Key');
        const ep = this.endpoint();
        const body = {
            model: ep.model,
            messages,
            max_tokens: opts.maxTokens || 1024,
            temperature: (opts.temperature != null) ? opts.temperature : 0.6,
        };
        const timeout = opts.timeout || this.TIMEOUT;
        // 火山方舟等不支持 CORS 的 provider：跳过直连，直接走代理（避免必然失败的一次往返）
        if (this._PROXY_ONLY_PROVIDERS.includes(ep.provider)) {
            return await this._requestProxy(apiKey, body, ep, timeout);
        }
        try {
            return await this._request(ep.url, apiKey, body, ep, timeout);
        } catch (e) {
            // 浏览器层面直连失败（CORS / 断网，fetch 未拿到响应）→ 降级后端代理
            if (e && e._networkFailure) {
                console.warn('[AiClient] 直连失败，降级后端代理:', e.message);
                return await this._requestProxy(apiKey, body, ep, timeout);
            }
            throw e;
        }
    },

    /** 浏览器直连 provider 端点 */
    async _request(url, apiKey, body, ep, timeout) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout || this.TIMEOUT);
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
        } catch (e) {
            clearTimeout(timer);
            if (e && e.name === 'AbortError') throw new Error('AI 响应超时，请稍后重试');
            e._networkFailure = true;   // 标记网络层失败（区别于 HTTP 错误响应）
            throw e;
        }
        clearTimeout(timer);
        if (!res.ok) throw new Error(await this._readError(res));
        const data = await res.json();
        this._reportUsage(data.usage);   // 直连链路：token 消耗上报（v4.6c）
        return { content: data.choices?.[0]?.message?.content || '', ep };
    },

    /** 降级通道：经后端 /api/ai/proxy 转发（key 走 X-AI-Key 请求头透传，服务器不存储）。
     *  带登录态 Authorization：服务端会从响应体提取 token 消耗计入统计（此处不再重复上报）。 */
    async _requestProxy(apiKey, body, ep, timeout) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout || this.TIMEOUT);
        let res;
        try {
            const headers = {
                'Content-Type': 'application/json',
                'X-AI-Key': apiKey,
            };
            const token = (window.STATE && STATE.get('token')) || '';
            if (token) headers['Authorization'] = `Bearer ${token}`;
            res = await fetch('/api/ai/proxy', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    provider: ep.provider,
                    model: body.model,
                    messages: body.messages,
                    max_tokens: body.max_tokens,
                    temperature: body.temperature,
                }),
                signal: ctrl.signal,
            });
        } catch (e) {
            clearTimeout(timer);
            if (e && e.name === 'AbortError') throw new Error('AI 响应超时，请稍后重试');
            throw new Error('AI 直连失败，且后端代理也不可用（请检查网络连接）');
        }
        clearTimeout(timer);
        if (!res.ok) throw new Error(await this._readError(res));
        const data = await res.json();
        return { content: data.choices?.[0]?.message?.content || '', ep };
    },

    /** token 消耗上报（fire-and-forget，只发数字不发内容；失败静默，不影响对话） */
    _reportUsage(usage) {
        try {
            if (!usage || !window.API || !window.STATE || !STATE.get('token')) return;
            const total = usage.total_tokens
                || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
            if (!total) return;
            API.post('/user/stats/usage', {
                prompt_tokens: usage.prompt_tokens || 0,
                completion_tokens: usage.completion_tokens || 0,
                total_tokens: total,
            }).catch(() => {});
        } catch (e) { /* 上报失败静默 */ }
    },

    /** 读取错误响应中的真实原因（兼容 provider 原生 {error} 与 FastAPI {detail} 两种格式） */
    async _readError(res) {
        let detail = '';
        try {
            const j = await res.json();
            detail = j.detail || (j.error && (j.error.message || JSON.stringify(j.error))) || JSON.stringify(j);
        } catch (e) { /* 忽略解析失败 */ }
        // 401/403 是「钥匙不行」，不是「模型不行」，原始英文（Authentication Fails…）没人看得懂，
        // 而且人看到它第一反应会是「网站坏了」。这里翻成人话并指出去哪改。
        const tail = (String(detail).match(/\*{4}(\w+)/) || [])[1] || '';
        if (res.status === 401 || res.status === 403) {
            return `你的 API Key${tail ? '（尾号 ****' + tail + '）' : ''}无效，AI 平台拒绝了它。`
                + '到「设置 → 模型」换成有效的 Key；或者把这个 Key 清空，剧本体验时会改走站点的免费通道。'
                + `\n原始回应：${detail}`;
        }
        return `AI API 错误 (${res.status}): ${detail}`;
    },

    /** 统一报错书上报：AI 调用出错、重试无效后 fire-and-forget 落库（失败静默，不阻断对话）。
     *  供各 AI 调用环节（网页 NPC / 审核 NPC / 举报 AI 审核 / 免费接口）复用。
     * @param {Object} info { error_type, provider, model, message, kind, npc_id }
     *   error_type 传 'auto' 或不传时按 message 自动归类：timeout / network / api_error。
     */
    reportError({ error_type = 'auto', provider = '', model = '', message = '', kind = '', npc_id = '' } = {}) {
        try {
            if (!window.API) return;
            let type = error_type;
            if (type === 'auto' || !type) {
                const msg = String(message || '');
                if (/超时|timeout|timed\s*out/i.test(msg)) type = 'timeout';
                else if (/网络|fetch|failed\s*to\s*fetch|CORS|abort/i.test(msg)) type = 'network';
                else type = 'api_error';
            }
            window.API.post('/npc/ai-error-report', {
                npc_id: npc_id || '',
                error_type: type,
                provider: provider || '',
                model: model || '',
                message: String(message || '').slice(0, 500),
                kind: kind || '',
            }).catch(() => {});
        } catch (e) { /* 上报失败静默，不阻断对话 */ }
    },
};

window.AiClient = AiClient;

// 启动即拉取可配置模型表（异步覆盖内置默认值；complete() 仅在用户交互后调用，届时已加载完成）
AiClient.loadRemoteConfig();
