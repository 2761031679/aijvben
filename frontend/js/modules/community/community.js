/** AI剧本网 - 打赏 / 外部交流模块
 *
 *  打赏按钮（左上角）、交流按钮（右上角通知旁）：面板由 CSS :hover 控制
 *  （移入按钮/面板显示，移出自动消失），无需 JS 切换。
 *  剧本详情页底部交流入口：调用 openChatModal() 弹出居中弹窗（不受层级遮挡）。
 *
 *  背景：作者暂无内置论坛/评论所需资质，交流引导至外部平台（QQ群 / 百度贴吧）。
 */
const CommunityModule = {
    QQ_GROUP: '949510550',
    TIEBA_URL: 'https://tieba.baidu.com/f?kw=ai%E5%89%A7%E6%9C%AC%E7%BD%91&fr=personpage',

    /** 详情页底部入口：居中弹窗展示交流信息 */
    openChatModal(e) {
        if (e) e.stopPropagation();
        const old = document.getElementById('communityChatModal');
        if (old) { old.remove(); return; }
        const overlay = document.createElement('div');
        overlay.id = 'communityChatModal';
        overlay.className = 'ui-overlay';
        overlay.innerHTML = `
            <div class="ui-confirm-dialog community-chat-dialog">
                <h3>💬 加入交流</h3>
                <div class="community-chat-body">${this._chatInner()}</div>
                <div class="ui-confirm-actions">
                    <button class="btn btn-primary community-close-btn">关闭</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.community-close-btn').onclick = () => overlay.remove();
        overlay.onclick = (ev) => { if (ev.target === overlay) overlay.remove(); };
    },

    /** 交流信息内层 HTML（右上角面板与弹窗共用，内容统一维护） */
    _chatInner() {
        return `
            <div class="chat-notice">⚠️ 作者没有相关法律凭证和资质，无法在网页内置论坛和评论，请移步外部网站交流。</div>
            <div class="chat-qq">
                <img src="/static/qq_group.jpg" alt="QQ群二维码"
                     onerror="this.style.display='none'">
                <div class="chat-qq-info">
                    <b>AI剧本网 QQ 群</b>
                    <span>群号：${this.QQ_GROUP}</span>
                    <span class="text-muted">扫一扫二维码加入群聊</span>
                </div>
            </div>
            <a class="chat-tieba" href="${this.TIEBA_URL}" target="_blank" rel="noopener noreferrer">
                🔗 前往百度贴吧「ai剧本网」交流 →
            </a>`;
    },

    /** 绑定 hover 延时隐藏：移入按钮/面板显示，移出后延时 1 秒隐藏。
     *  延时期间鼠标移到面板上会取消隐藏，解决「按钮与面板间缝隙触发隐藏」的问题。 */
    _bindHoverPanel(entryId, panelId) {
        const entry = document.getElementById(entryId);
        const panel = document.getElementById(panelId);
        if (!entry || !panel) return;
        let hideTimer = null;
        const show = () => {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            panel.style.display = 'block';
        };
        const scheduleHide = () => {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => { panel.style.display = 'none'; }, 1000);
        };
        entry.addEventListener('mouseenter', show);
        entry.addEventListener('mouseleave', scheduleHide);
        panel.addEventListener('mouseenter', show);
        panel.addEventListener('mouseleave', scheduleHide);
    },
};

window.CommunityModule = CommunityModule;

// 初始化：填充右上角交流面板内容（与弹窗共用同一份内层 HTML）+ 绑定 hover 延时隐藏
document.addEventListener('DOMContentLoaded', () => {
    const panel = document.getElementById('chatPanel');
    if (panel) panel.innerHTML = CommunityModule._chatInner();
    CommunityModule._bindHoverPanel('rewardEntry', 'rewardPanel');
    CommunityModule._bindHoverPanel('chatEntry', 'chatPanel');
});
