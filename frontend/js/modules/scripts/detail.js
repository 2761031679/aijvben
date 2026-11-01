/** AI剧本网 - 剧本详情 */
const ScriptDetail = {
    async render(container, id, data) {
        if (!data) {
            try { data = await ScriptAPI.detail(id); } catch (e) {
                container.innerHTML = `<div class="loading">加载失败：${Utils.escapeHtml(e.message)}</div>`;
                return;
            }
        }

        const cats = CONFIG.CATEGORY_NAMES;
        let html = `
        <div class="script-detail">
            <h2>${Utils.escapeHtml(data.title)}</h2>
            <div class="script-meta">
                <span>📂 ${cats[data.category] || data.category}</span>
                <span>✍ ${Utils.escapeHtml(data.author || '匿名')}</span>
                <span>⭐ ${data.avg_rating || '0'} (${data.rating_count || 0}评)</span>
                <span>${'★'.repeat(data.difficulty || 0)}</span>
            </div>
            <div class="script-tags" id="scriptTags">
                ${(data.tags || []).map(t => `
                    <span class="tag-chip tag-like" data-tag="${Utils.escapeHtml(t.tag)}">
                        ${Utils.escapeHtml(t.tag)}
                        <span class="tag-like-count" onclick="ScriptDetail.toggleTagLike('${id}','${Utils.escapeHtml(t.tag)}', this)">👍 ${t.likes || 0}</span>
                    </span>`).join('')}
            </div>
            ${data.synopsis ? `
            <div class="script-synopsis">
                <h3>剧本简介</h3>
                <p>${Md.render(data.synopsis)}</p>
            </div>` : ''}
            <div class="script-story">
                <h3>谜面/故事</h3>
                <div class="story-content">${Md.render(data.story || '')}</div>
            </div>`;

        // 汤底/答案：默认隐藏，点击「查看汤底」按权限显示；无权限时弹浮动提示说明原因
        const hasExp = !!data.explanation;
        let lockReason = '';
        if (!hasExp) {
            const u = (window.STATE && STATE.get) ? STATE.get('user') : null;
            const isGuest = (window.STATE && STATE.get) ? !!STATE.get('isGuest') : false;
            if (!u || isGuest) lockReason = '请先登录并体验该剧本，通关后即可查看汤底';
            else if (!data.is_subscribed) lockReason = '收藏并通关该剧本后，即可查看汤底';
            else lockReason = '通关该剧本后，即可查看汤底';
        }
        html += `
            <div class="script-explanation">
                <h3>汤底/答案 <button class="btn btn-sm btn-outline" onclick="ScriptDetail.revealExplanation()">👁 查看汤底</button></h3>
                <div class="explanation-content" id="explanationContent" data-locked="${hasExp ? '0' : '1'}" data-reason="${Utils.escapeHtml(lockReason)}" style="display:none">${hasExp ? Md.render(data.explanation) : ''}</div>
            </div>`;

        // 结束条件：默认隐藏，与「汤底」同级权限（通关或管理员/站长可见）。
        // 用 data.is_full 判定权限（后端授权才下发），避免「已授权但字段为空」被误判为锁定。
        const canViewEnding = data.is_full === true;
        const hasEnding = canViewEnding && !!data.ending_condition;
        let endingLockReason = '';
        if (!canViewEnding) {
            const u = (window.STATE && STATE.get) ? STATE.get('user') : null;
            const isGuest = (window.STATE && STATE.get) ? !!STATE.get('isGuest') : false;
            if (!u || isGuest) endingLockReason = '请先登录并体验该剧本，通关后即可查看结束条件';
            else if (!data.is_subscribed) endingLockReason = '收藏并通关该剧本后，即可查看结束条件';
            else endingLockReason = '通关该剧本后，即可查看结束条件';
        } else if (!data.ending_condition) {
            endingLockReason = '作者未设置结束条件';
        }
        html += `
            <div class="script-ending">
                <h3>结束条件 <button class="btn btn-sm btn-outline" onclick="ScriptDetail.revealEndingCondition()">👁 查看结束条件</button></h3>
                <div class="ending-content" id="endingContent" data-locked="${hasEnding ? '0' : '1'}" data-reason="${Utils.escapeHtml(endingLockReason)}" style="display:none">${hasEnding ? Md.render(data.ending_condition) : ''}</div>
            </div>`;

        // 胜利/失败条件（新条件系统）：与结束条件同级权限（通关/作者/管理员可见），
        // 按作者定义顺序排列展示；未授权时下发为空则不渲染本区（与旧结束条件同款隐藏）。
        let endings = [];
        if (canViewEnding && data.endings) {
            try {
                const p = JSON.parse(data.endings);
                if (p && Array.isArray(p.endings)) endings = p.endings;
            } catch (e) { /* 非法 JSON 不渲染 */ }
        }
        if (endings.length) {
            html += `
            <div class="script-endings">
                <h3>胜利/失败条件 <button class="btn btn-sm btn-outline" onclick="ScriptDetail.revealEndings()">👁 查看条件</button></h3>
                <div class="endings-content" id="endingsContent" style="display:none">
                    ${endings.map(e => `
                    <div class="ending-view ending-${e.type === 'lose' ? 'lose' : 'win'}">
                        <div class="ending-view-head">
                            <span>${e.type === 'lose' ? '💀' : '🏆'}</span>
                            <b>${Md.render(e.name || '')}</b>
                            ${e.note ? `<span class="ending-view-note">${Md.render(e.note)}</span>` : ''}
                        </div>
                        <ul class="ending-view-conds">
                            ${(e.conditions || []).map(c => `
                            <li>
                                <span class="cond-view-name">${Md.render(c.name || '')}</span>
                                <span class="cond-view-rule">${Md.render(c.rule || '')}</span>
                                ${(c.threshold || 1) > 1 ? `<span class="cond-view-threshold">×${c.threshold}</span>` : ''}
                                ${c.hidden ? '<span class="cond-view-hidden" title="隐藏条件：游玩时达成前不可见">🙈</span>' : ''}
                            </li>`).join('')}
                        </ul>
                    </div>`).join('')}
                </div>
            </div>`;
        }

        // 任务条件：与胜利/失败条件同级权限（通关/作者/管理员可见），未授权不下发则不渲染本区
        let tasks = [];
        if (canViewEnding && data.tasks) {
            try {
                const p = JSON.parse(data.tasks);
                if (p && Array.isArray(p.tasks)) tasks = p.tasks;
            } catch (e) { /* 非法 JSON 不渲染 */ }
        }
        if (tasks.length) {
            const effectNames = { reveal_clue: '🔎 揭示线索', give_item: '🎁 给予道具', npc_message: '📨 给NPC发消息' };
            html += `
            <div class="script-endings">
                <h3>任务条件 <button class="btn btn-sm btn-outline" onclick="ScriptDetail.revealTasks()">👁 查看任务</button></h3>
                <div class="endings-content" id="tasksContent" style="display:none">
                    ${tasks.map(t => `
                    <div class="ending-view ending-task">
                        <div class="ending-view-head">
                            <span>📋</span>
                            <b>${Md.render(t.name || '')}</b>
                            ${t.note ? `<span class="ending-view-note">${Md.render(t.note)}</span>` : ''}
                        </div>
                        <ul class="ending-view-conds">
                            ${(t.conditions || []).map(c => `
                            <li>
                                <span class="cond-view-name">${Md.render(c.name || '')}</span>
                                <span class="cond-view-rule">${Md.render(c.rule || '')}</span>
                                ${(c.threshold || 1) > 1 ? `<span class="cond-view-threshold">×${c.threshold}</span>` : ''}
                                ${c.hidden ? '<span class="cond-view-hidden" title="隐藏条件：游玩时达成前不可见">🙈</span>' : ''}
                            </li>`).join('')}
                        </ul>
                        <div class="task-view-effect">完成效果：${effectNames[(t.effect || {}).type] || '🔎 揭示线索'} —— ${Md.render((t.effect || {}).payload || '')}</div>
                    </div>`).join('')}
                </div>
            </div>`;
        }

        if (Utils.isAdmin() && data.ai_review) {
            const ai = data.ai_review;
            const reasons = (ai.reasons || []).map(r => Utils.escapeHtml(r)).join('、');
            const flags = (ai.flags || []).map(f => Utils.escapeHtml(f)).join('、');
            html += `
            <div class="ai-review-box">
                <h3>🤖 AI 初审结果</h3>
                <p>结论：<b>${Utils.escapeHtml(ai.decision)}</b> ｜ 风险分：${ai.score}</p>
                ${reasons ? `<p>命中理由：${reasons}</p>` : ''}
                ${flags ? `<p>风险标签：${flags}</p>` : ''}
                ${ai.suggestion ? `<p>修改建议：${Utils.escapeHtml(ai.suggestion)}</p>` : ''}
            </div>`;
        }

        html += `
            <div class="script-actions">
                <button class="btn btn-success" onclick="Experience.start('${id}')">🎮 开始体验</button>
                <button class="btn btn-outline" onclick="ScriptDetail.speakStory()" aria-label="朗读汤面">🔊 朗读</button>
                <button class="btn btn-primary" id="scriptLikeBtn" onclick="ScriptDetail.doLike('${id}','like')">👍 ${data.likes || 0}</button>
                <button class="btn btn-outline" id="scriptDislikeBtn" onclick="ScriptDetail.doLike('${id}','dislike')">👎 ${data.dislikes || 0}</button>
                <button class="btn btn-outline" onclick="ScriptDetail.download('${id}')">⬇ 下载</button>
                <button class="btn btn-outline" onclick="ScriptDetail.report('${id}')">🚩 举报</button>
                <button class="btn btn-outline" onclick="ScriptDetail.subscribe('${id}')">⭐ ${data.is_subscribed ? '已收藏' : '收藏'}</button>
                ${data.can_manage ? `<button class="btn btn-danger" onclick="ScriptDetail.remove('${id}')">🗑 删除</button>` : ''}
            </div>
            <div class="detail-chat-entry">
                <span>💬 本站未设论坛与评论（作者暂无相关资质），欢迎移步外部交流：</span>
                <button class="btn btn-sm btn-outline" onclick="CommunityModule.openChatModal(event)">QQ群 ${CommunityModule.QQ_GROUP}</button>
                <a href="${CommunityModule.TIEBA_URL}" target="_blank" rel="noopener noreferrer">百度贴吧 →</a>
            </div>
        </div>`;

        container.innerHTML = html;
        // 缓存当前详情（remove 取标题、speakStory 取汤面用，避免把文本内联进 onclick 造成引号注入）
        this._current = { id, title: data.title || '', story: data.story || '' };
    },

    /** 朗读汤面（无障碍：盲人进入体验前先听谜面） */
    speakStory() {
        const story = (this._current && this._current.story) || '';
        if (!story.trim()) { Utils.showToast('暂无内容可朗读', 'warn'); return; }
        // 去掉 markdown 标记与条件标记，避免朗读出符号
        const plain = story.replace(/\[cond:[^\]]+\]/g, '').replace(/[#*`>{}]/g, '').trim();
        TTS.stop();
        TTS.speak(plain || story);
        Utils.showToast('开始朗读汤面', 'info');
    },

    /** 删除剧本（原作者/站长，按钮仅 can_manage 时渲染）：走全局 deleteScript（确认+删除+刷新） */
    remove(id) {
        const title = (this._current && this._current.id === id) ? this._current.title : '';
        if (window.deleteScript) window.deleteScript(id, title);
    },

    async doLike(id, type) {
        // 先查询当前点赞状态
        let curStatus = null;
        try {
            const statusRes = await API.get(`/scripts/${id}/like-status`);
            curStatus = statusRes.type;
        } catch (e) { /* ignore */ }

        // 判断操作逻辑
        if (curStatus === type) {
            Utils.showToast(type === 'like' ? '您已经赞美过该剧本啦' : '您已经踩过该剧本啦', 'info');
            return;
        }

        try {
            const res = await ScriptAPI.toggleLike(id, type);
            const msg = curStatus
                ? '已重新为您更改评价'
                : (type === 'like' ? '赞美成功' : '已踩');
            Utils.showToast(msg, 'success');

            // 视觉反馈：临时更新按钮数字。
            // 必须按 id 取，不能按 class 取：这两个 class 在 .script-actions 里都不是唯一第一个，
            // .btn-primary 的首个元素是「🎮 开始体验」，.btn-outline 的首个元素是「🔊 朗读」，
            // 早先用 querySelector 按 class 定位，点赞后会把「🔊 朗读」这句文案改写成「👎 N」
            // （用户实测：点了赞，朗读按钮变成「👎 0」）。
            const likeBtn = document.getElementById('scriptLikeBtn');
            const dislikeBtn = document.getElementById('scriptDislikeBtn');
            if (res) {
                const newLikes = res.likes !== undefined ? res.likes : (parseInt(likeBtn?.textContent?.match(/\d+/)?.[0] || '0') + (type === 'like' ? 1 : 0));
                const newDislikes = res.dislikes !== undefined ? res.dislikes : (parseInt(dislikeBtn?.textContent?.match(/\d+/)?.[0] || '0') + (type === 'dislike' ? 1 : 0));
                if (likeBtn) likeBtn.innerHTML = `👍 ${newLikes}`;
                if (dislikeBtn) dislikeBtn.innerHTML = `👎 ${newDislikes}`;
            }
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    async download(id) {
        try {
            const data = await ScriptAPI.download(id);
            Utils.showToast('下载成功');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `${data.title || 'script'}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    async subscribe(id) {
        try {
            if (STATE.get('isGuest')) return Utils.showToast('请先登录', 'error');
            await API.post(`/user/subscriptions/${id}`);
            Utils.showToast('收藏成功');
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    async report(id) {
        if (STATE.get('isGuest')) return Utils.showToast('请先登录', 'error');
        // 举报需用「用户自己的 AI」判定剧本是否违规；未配置 API Key 则提示并引导设置
        if (!AiClient.currentKey()) {
            Utils.showToast('请先在设置中配置 AI API Key 才能举报', 'error');
            if (window.NpcChat && NpcChat.openSettings) NpcChat.openSettings();
            return;
        }
        const reason = await UIModule.prompt('请填写举报原因（将提交给站长审核）', {
            title: '举报作品', placeholder: '举报原因...', okText: '提交举报',
        });
        if (reason === null) return;   // 用户取消
        if (!reason.trim()) return Utils.showToast('举报原因不能为空', 'error');

        Utils.showToast('正在用你的 AI 审核该剧本…', 'info');
        let aiResult = null;
        try { aiResult = await this._aiReviewScript(id, reason.trim()); }
        catch (e) { aiResult = null; }   // AI 判定失败不阻断举报

        try {
            const res = await API.post(`/review/${id}/report`, { reason: reason.trim(), ai_result: aiResult });
            Utils.showToast(res.flagged ? '举报成功，该作品已进入举报池' : '举报已受理，感谢反馈', 'success');
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    /** 用举报人自己的 AI 判定剧本是否违规（返回 JSON 或降级对象） */
    async _aiReviewScript(id, reason) {
        const d = await ScriptAPI.detail(id);
        const system = '你是内容安全审核员。判断这个剧本是否存在违规内容（色情、暴力、仇恨、自残、违法、政治敏感等）。只输出 JSON，格式：{"decision":"recommend_approve|recommend_reject|need_human","score":0到100的风险分,"reasons":["命中理由"],"flags":["风险类别"],"suggestion":"给站长的建议"}';
        const tags = Array.isArray(d.tags) ? d.tags.map(t => (typeof t === 'string' ? t : (t.tag || ''))).filter(Boolean).join(',') : '';
        const user = `举报理由：${reason}\n\n分类：${d.category || ''}\n标题：${d.title || ''}\n简介：${d.synopsis || ''}\n标签：${tags}\n正文（汤面/谜题）：${(d.story || '').slice(0, 1500)}\n\n请严格只返回 JSON。`;
        const ep = AiClient.endpoint();
        try {
            const { content } = await AiClient.complete([
                { role: ep.rm.system, content: system },
                { role: ep.rm.user, content: user },
            ], { temperature: 0.2 });
            try { return JSON.parse(content); }
            catch (e) {
                return { decision: 'need_human', score: 0, reasons: [], flags: [], suggestion: (content || '').slice(0, 200) };
            }
        } catch (e) {
            AiClient.reportError({ provider: ep.provider, model: ep.model, message: (e && e.message) || '', kind: '举报AI审核' });
            throw e;
        }
    },

    _tagLiked: {},

    async toggleTagLike(id, tag, el) {
        const liked = this._tagLiked[tag] || false;
        const span = el.closest('.tag-like-count') || el;
        try {
            const res = await ScriptAPI.toggleTagLike(id, tag, !liked);
            this._tagLiked[tag] = res.liked;
            span.textContent = `👍 ${res.likes || 0}`;
            span.classList.toggle('liked', res.liked);
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    /** 查看汤底：默认隐藏，点击切换显示；无权限时弹浮动提示说明原因（复用现有 toast 模块） */
    revealExplanation() {
        const content = document.getElementById('explanationContent');
        if (!content) return;
        if (content.dataset.locked === '1') {
            Utils.showToast(content.dataset.reason || '暂无法查看汤底', 'info');
            return;
        }
        content.style.display = (content.style.display === 'none') ? '' : 'none';
    },

    /** 查看结束条件：默认隐藏，点击切换显示；无权限时弹浮动提示说明原因 */
    revealEndingCondition() {
        const content = document.getElementById('endingContent');
        if (!content) return;
        if (content.dataset.locked === '1') {
            Utils.showToast(content.dataset.reason || '暂无法查看结束条件', 'info');
            return;
        }
        content.style.display = (content.style.display === 'none') ? '' : 'none';
    },

    /** 查看胜利/失败条件：默认隐藏，点击切换显示（本区仅在已授权时渲染，无需锁判定） */
    revealEndings() {
        const content = document.getElementById('endingsContent');
        if (!content) return;
        content.style.display = (content.style.display === 'none') ? '' : 'none';
    },

    /** 查看任务条件：默认隐藏，点击切换显示（本区仅在已授权时渲染，无需锁判定） */
    revealTasks() {
        const content = document.getElementById('tasksContent');
        if (!content) return;
        content.style.display = (content.style.display === 'none') ? '' : 'none';
    }
};

window.ScriptDetail = ScriptDetail;

/** 打开剧本详情弹窗（侧边栏/列表卡片点击的统一入口）。
 *  此前卡片走 Router.navigate('script') 但该路由从未注册，导致点击无反应；
 *  现改为直接渲染 detailModal 弹窗。 */
window.showScriptDetail = (id) => {
    if (!id) return;
    const content = document.getElementById('detailContent');
    if (!content) return;
    content.innerHTML = '<div class="loading">加载中...</div>';
    ScriptDetail.render(content, id);
    if (window.Utils) Utils.openModal('detailModal');
};
