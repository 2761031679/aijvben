/** AI剧本网 - 管理面板：NPC 对话示例（读取主界面真实对话 + 原始回复/系统信息调试）
 *
 * 设计：
 *   - 对话记录直接镜像主界面 NpcChat（同一份 _messages / NpcHistory），在示例里发消息 = 在主界面发消息；
 *   - 调试视图：未解码的 AI 原始回复、网站发往 AI 的系统信息（系统提示词 + 系统通道回灌）；
 *   - 「当前系统提示词/状态」面板：显示登录态/网页状态/剧本类型，并支持手动触发 refreshPrompt，
 *     用于验证「切换账号 / 刷新页面时是否重新激活 NPC」。
 */
const AdminDemo = {
    _msgId: 0,
    _sessionLog: [],   // 累积所有回合的 API 调用：{ provider, model, url, request_messages, response, error? }

    render(container) {
        const npcs = NpcChat.getNpcs();
        const curIdx = NpcChat.getCurrentNpcIndex();
        const options = npcs.map((n, i) =>
            `<option value="${i}">${Utils.escapeHtml(n.displayName || n.name || n.id)}</option>`
        ).join('');

        container.innerHTML = `
            <div class="demo-wrap">
                <h3>🧪 NPC 对话示例</h3>
                <p class="text-muted">对话记录与主界面完全同步（在此发消息 = 在主界面发消息）。下方可查看未解码的 AI 原始回复与网站发去的系统信息。</p>

                <div class="setting-group">
                    <label>选择 NPC</label>
                    <select id="demoNpcSelect" class="form-input" onchange="AdminDemo._onNpcChange(this.value)">${options}</select>
                </div>

                <div class="demo-panel">
                    <div class="demo-panel-head">
                        <h4>💬 主界面对话记录（实时同步）</h4>
                        <button class="btn btn-sm btn-outline" onclick="AdminDemo._renderMainChat()">刷新</button>
                    </div>
                    <div id="demoMainChat" class="chat-bubbles demo-mainchat"></div>
                </div>

                <div class="demo-panel">
                    <div class="demo-panel-head">
                        <h4>🧠 当前系统提示词 / 状态</h4>
                        <button class="btn btn-sm btn-outline" onclick="AdminDemo._refreshAndRender()">重新激活（refreshPrompt）</button>
                    </div>
                    <div id="demoState" class="demo-state"></div>
                    <pre id="demoSysPrompt" class="demo-sysprompt">（加载中…）</pre>
                </div>

                <div class="tea-input-row" style="margin-top:14px;">
                    <input type="text" id="demoInput" class="tea-input" placeholder="输入消息，回车发送（等同主界面发送）"
                           onkeydown="if(event.key==='Enter')AdminDemo._send()">
                    <button class="tea-send-btn" onclick="AdminDemo._send()">发送</button>
                </div>

                <div class="demo-panel">
                    <div class="demo-panel-head">
                        <h4>📦 发往 AI 的上下文（API 真实收发记录，原文）</h4>
                        <button class="btn btn-sm btn-outline" onclick="AdminDemo._renderApiLog()">刷新</button>
                    </div>
                    <div id="demoCtxState" class="demo-state"></div>
                    <div id="demoCtxLog" class="demo-full-log"><span class="text-muted">（暂无 API 调用记录，发送消息后显示）</span></div>
                </div>

                <div class="demo-panel">
                    <h4>🤖 AI 原始回复（发送后累积，未解码）</h4>
                    <div id="demoFullLog" class="demo-full-log"><span class="text-muted">（发送消息后显示）</span></div>
                </div>

                <div class="setting-group">
                    <label>🎬 动画测试（集成自动画模块）</label>
                    <div id="demoAnimBtns" class="anim-buttons"></div>
                </div>
            </div>`;

        const sel = document.getElementById('demoNpcSelect');
        if (sel) sel.value = String(curIdx);
        // 新的 API 收发记录产生时自动刷新「发往 AI 的上下文」面板（无论消息从主界面还是此处发出）
        if (!this._apiLogBound) {
            this._apiLogBound = true;
            window.addEventListener('npc-api-log', () => {
                if (document.getElementById('demoCtxLog')) this._renderApiLog();
            });
        }
        this._renderAnimBtns();
        this._renderMainChat();
        this._renderSysPrompt();
        this._renderApiLog();
    },

    _onNpcChange(index) {
        NpcChat.switchNpc(parseInt(index, 10));  // 同步真实 NPC（立绘/动画一致）
        this._renderAnimBtns();
        this._renderMainChat();
        this._renderSysPrompt();
        this._renderApiLog();
    },

    _renderAnimBtns() {
        const box = document.getElementById('demoAnimBtns');
        if (!box) return;
        const pid = NpcChat._currentNpc?.id;
        const map = (NpcAnim._emotionAnimMap && NpcAnim._emotionAnimMap[pid]) || {};
        let html = '';
        for (const [emotion] of Object.entries(map)) {
            const label = Utils.escapeHtml(emotion);
            html += `<button class="btn btn-sm btn-outline" onclick="NpcAnim.triggerEmotion('${pid}','${emotion}')">${label}</button>`;
        }
        html += `<button class="btn btn-sm btn-outline" onclick="NpcAnim.clear('${pid}')">清除动画</button>`;
        box.innerHTML = html || '<span class="text-muted">该 NPC 暂无动画配置</span>';
    },

    /** 镜像主界面对话记录（与主界面共用同一份 NpcChat._messages） */
    _renderMainChat() {
        const box = document.getElementById('demoMainChat');
        if (!box) return;
        const msgs = (NpcChat._messages || []).slice(-60);
        if (!msgs.length) { box.innerHTML = '<span class="text-muted">（暂无对话）</span>'; return; }
        box.innerHTML = msgs.map(m => NpcChat._renderBubble(m)).join('');
        box.scrollTop = box.scrollHeight;
    },

    /** 渲染当前系统提示词 + 状态（登录态/网页状态/剧本类型），用于验证重新激活 */
    async _renderSysPrompt() {
        const stateBox = document.getElementById('demoState');
        const pre = document.getElementById('demoSysPrompt');
        if (!pre) return;
        try {
            const webState = (window.GameState && GameState.get) ? GameState.get() : 'default';
            const isGuest = STATE.get('isGuest');
            const cat = (webState === 'experience' && window.Experience && Experience.currentMode) ? (Experience.currentMode() || '-') : '-';
            const npcId = NpcChat._currentNpc ? NpcChat._currentNpc.id : '-';
            if (stateBox) {
                stateBox.innerHTML =
                    `登录态: <b>${isGuest ? '游客（提示词不生效）' : '已登录'}</b> · ` +
                    `网页状态: <b>${Utils.escapeHtml(webState)}</b> · ` +
                    `剧本类型: <b>${Utils.escapeHtml(cat)}</b> · ` +
                    `NPC: <b>${Utils.escapeHtml(npcId)}</b>`;
            }
            if (isGuest) {
                pre.textContent = '（游客态：提示词模块不生效，NPC 走 NoAiModule，不会发送系统提示词）';
                return;
            }
            // _buildPrompt() 改成无参后（提示词改由后端组装），这行 _getPrompts 白跑一趟
            // 还多一次 /api/npc/prompts 往返，删掉（审计 建议-9）
            const sp = await NpcChat._buildPrompt();
            pre.textContent = sp || '（空）';
        } catch (e) {
            pre.textContent = '生成失败: ' + e.message;
        }
    },

    /** 手动触发 refreshPrompt 并重渲染（验证「重新激活 NPC」是否生效） */
    async _refreshAndRender() {
        if (window.NpcChat && NpcChat.refreshPrompt) await NpcChat.refreshPrompt();
        await this._renderSysPrompt();
        this._renderMainChat();
        this._renderApiLog();
        Utils.showToast('已重新刷新 NPC 提示词', 'success');
    },

    /** 发送：走主界面真实管线（写入历史 + 工具调用 + 分段），同时捕获完整 API 调用 */
    async _send() {
        const input = document.getElementById('demoInput');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;
        input.value = '';

        NpcChat._captureBuffer = [];
        NpcChat._captureAI = true;
        try {
            await NpcChat._sendUserMessage(text);   // 与主界面同一条管线
        } finally {
            NpcChat._captureAI = false;
        }
        (NpcChat._captureBuffer || []).forEach(t => this._sessionLog.push(t));

        this._renderMainChat();
        this._renderSysPrompt();
        this._renderApiLog();
        this._renderFullLog();
    },

    /** 渲染「发往 AI 的上下文」：只展示 API 调用那一刻真实发送的完整请求与 AI 返回的完整回复，
     *  数据来自 NpcChat._apiLog（_callAI 内置记录，主界面/本面板发送均会记录，原文不改、不删、不解码）。 */
    _renderApiLog() {
        const stateBox = document.getElementById('demoCtxState');
        const box = document.getElementById('demoCtxLog');
        if (!box) return;
        const log = (NpcChat._apiLog || []);
        if (stateBox) {
            stateBox.innerHTML = `共 <b>${log.length}</b> 轮真实 API 调用（保留最近 ${NpcChat._API_LOG_MAX || 30} 轮，最新在底部）`;
        }
        if (!log.length) {
            box.innerHTML = '<span class="text-muted">（暂无 API 调用记录，发送消息后显示）</span>';
            return;
        }
        const fmtTime = (t) => {
            const d = (t instanceof Date) ? t : new Date(t);
            return isNaN(d) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false });
        };
        const fmtMsgs = (msgs) => (msgs || []).map(m => `
            <div class="apimsg apimsg-${String(m.role || '').toLowerCase()}">
                <span class="apimsg-role">${Utils.escapeHtml(String(m.role || ''))}</span>
                <pre class="apimsg-body">${Utils.escapeHtml(m.content || '')}</pre>
            </div>`).join('');
        box.innerHTML = log.map((t, i) => `
            <div class="api-turn">
                <div class="api-turn-head">第 ${i + 1} 轮 · ${fmtTime(t.time)}${t.kind ? ` · <span class="api-kind">${Utils.escapeHtml(t.kind)}</span>` : ''} · ${Utils.escapeHtml(t.provider || '')} / ${Utils.escapeHtml(t.model || '')} · <span class="api-url">${Utils.escapeHtml(t.url || '')}</span>${t.error ? ' · <span class="api-err">请求失败</span>' : ''}</div>
                <div class="api-sub">▶ 请求（实际发送的全部消息）：</div>
                <div class="api-msgs">${fmtMsgs(t.request_messages)}</div>
                <div class="api-sub">◀ 响应（AI 返回的全部内容）：</div>
                <pre class="api-resp">${Utils.escapeHtml(t.response || '')}</pre>
            </div>`).join('<hr class="api-sep">');
        box.scrollTop = box.scrollHeight;
    },

    /** 渲染完整 API 调用日志：每轮展示「请求（提示词/系统信息/对话）」与「AI 原始回复（未解码）」 */
    _renderFullLog() {
        const box = document.getElementById('demoFullLog');
        if (!box) return;
        if (!this._sessionLog.length) {
            box.innerHTML = '<span class="text-muted">（发送消息后显示完整 API 调用过程）</span>';
            return;
        }
        const fmtMsgs = (msgs) => (msgs || []).map(m => `
            <div class="apimsg apimsg-${String(m.role || '').toLowerCase()}">
                <span class="apimsg-role">${Utils.escapeHtml(String(m.role || ''))}</span>
                <pre class="apimsg-body">${Utils.escapeHtml(m.content || '')}</pre>
            </div>`).join('');
        box.innerHTML = this._sessionLog.map((t, i) => `
            <div class="api-turn">
                <div class="api-turn-head">第 ${i + 1} 轮${t.kind ? ` · <span class="api-kind">${Utils.escapeHtml(t.kind)}</span>` : ''} · ${Utils.escapeHtml(t.provider || '')} / ${Utils.escapeHtml(t.model || '')} · <span class="api-url">${Utils.escapeHtml(t.url || '')}</span>${t.error ? ' · <span class="api-err">请求失败</span>' : ''}</div>
                <div class="api-sub">▶ 请求（打包给 AI 的提示词 / 系统信息 / 对话）：</div>
                <div class="api-msgs">${fmtMsgs(t.request_messages)}</div>
                <div class="api-sub">◀ 响应（AI 原始回复，未解码）：</div>
                <pre class="api-resp">${Utils.escapeHtml(t.response || '')}</pre>
            </div>`).join('<hr class="api-sep">');
        box.scrollTop = box.scrollHeight;
    },
};
window.AdminDemo = AdminDemo;
