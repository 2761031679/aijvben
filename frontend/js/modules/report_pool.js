/** AI剧本网 - 公开举报池模块
 *  被举报下架（system_flagged）的剧本对所有用户公开，展示举报信息 + AI 封禁理由 + 三选投票。
 *  复用 ScriptList.card（只含公开字段，天然隐藏汤底/结束条件/指导词）。 */
const ReportPool = {
    async render(container) {
        container.innerHTML = '<div class="loading">加载举报池...</div>';
        let data;
        try { data = await API.get('/review/flagged-pool'); }
        catch (e) { container.innerHTML = `<div class="loading">加载失败：${Utils.escapeHtml(e.message)}</div>`; return; }
        const scripts = data.scripts || [];
        if (!scripts.length) {
            container.innerHTML = '<div class="empty-state">当前没有被举报的剧本</div>';
            return;
        }
        container.innerHTML = `
            <div class="report-pool">
                <h2>🚩 举报池</h2>
                <p class="muted" style="font-size:13px;margin-bottom:12px;">以下剧本被多名用户举报，正在接受社区投票，最终是否封禁由站长决定。</p>
                <div class="script-grid">${scripts.map(s => this.card(s)).join('')}</div>
            </div>`;
    },

    card(s) {
        const reports = (s.reports || []).slice(0, 3);
        const reportHtml = reports.map(r => {
            const ai = (r.ai_suggestion || r.ai_decision)
                ? `<div class="report-ai">🤖 AI 判定：${Utils.escapeHtml(r.ai_suggestion || (r.ai_decision + (r.ai_score ? `（风险${r.ai_score}）` : '')))}</div>`
                : '';
            return `<div class="report-item">📌 ${Utils.escapeHtml(r.reason || '（未填写原因）')}（${Utils.escapeHtml(r.username || '匿名')}）${ai}</div>`;
        }).join('');
        const v = (s.votes && s.votes.stat) || { ban: 0, keep: 0, neutral: 0, total: 0 };
        const extra = `
            <div class="report-pool-extra" onclick="event.stopPropagation()">
                <div class="report-items">${reportHtml}</div>
                <div class="report-vote">
                    <span class="vote-stat">同意封禁 ${v.ban} · 不同意 ${v.keep} · 中立 ${v.neutral}</span>
                    <div class="vote-btns">
                        <button class="btn btn-sm btn-danger" onclick="ReportPool.vote('${s.id}','ban')">同意封禁</button>
                        <button class="btn btn-sm btn-success" onclick="ReportPool.vote('${s.id}','keep')">不同意</button>
                        <button class="btn btn-sm btn-outline" onclick="ReportPool.vote('${s.id}','neutral')">钝角</button>
                    </div>
                </div>
            </div>`;
        return ScriptList.card(s, extra, false);
    },

    async vote(scriptId, vote) {
        if (STATE.get('isGuest')) return Utils.showToast('请先登录', 'error');
        try {
            await API.post(`/review/${scriptId}/report-vote`, { vote });
            Utils.showToast('投票成功', 'success');
            const content = document.getElementById('forumContent');
            if (content) this.render(content);
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },
};

window.ReportPool = ReportPool;
