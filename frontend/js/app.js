/** AI剧本网 - 应用入口 */
(function () {
    'use strict';

    // 初始化全局兼容函数
    window.showAuthModal = (mode) => Auth.showModal(mode);
    window.toggleAuthMode = () => Auth.toggleMode();
    window.submitAuth = (e) => Auth.submit(e);
    window.sendRegCode = () => Auth.sendCode();
    window.guestLogin = () => Auth.guestLogin();
    window.logout = () => Auth.logout();
    window.updateAuthUI = () => Auth.updateUI();
    window.togglePassword = (inputId, btn) => {
        const input = document.getElementById(inputId);
        if (input) input.type = input.type === 'password' ? 'text' : 'password';
    };
    window.closeModal = (id) => Utils.closeModal(id);

    // 论坛面板
    // 记忆关闭前停留的页面；刷新页面（IIFE 重新执行）或 resetForumState 后回到首页
    let _forumLastPage = { page: 'home', param: null };

    window.resetForumState = () => {
        _forumLastPage = { page: 'home', param: null };
    };

    /** 删除剧本（原作者/站长可用，后端 can_edit_script 二次校验）：
     *  确认弹窗 → 软删除（移入回收站）→ 关闭详情弹窗 → 刷新当前停留页。
     *  title 可选；缺省时从「我的作品」缓存中查找（卡片入口不内联传标题，避免引号注入）。 */
    window.deleteScript = async (id, title) => {
        if (!id) return;
        if (!title) {
            const w = (window._allMyWorks || []).find(s => s.id === id);
            title = w ? w.title : '';
        }
        const ok = await UIModule.confirm(
            `确定删除剧本《${title || '未命名'}》吗？剧本将移入回收站。`,
            { title: '删除剧本', okText: '删除', cancelText: '取消' }
        );
        if (!ok) return;
        try {
            await ScriptAPI.delete(id);
            Utils.showToast('剧本已移入回收站', 'success');
            Utils.closeModal('detailModal');
            // 刷新当前停留页，移除已删卡片（board/my-works/subscriptions 等均适用）
            const content = document.getElementById('forumContent');
            if (content) window.loadPage(_forumLastPage.page, _forumLastPage.param, content);
        } catch (e) { Utils.showToast(e.message, 'error'); }
    };

    window.openForumPanel = (page, param) => {
        const panel = document.getElementById('forumPanel');
        if (panel) panel.classList.add('open');
        document.body.classList.add('forum-open');   // 宽屏：主场景避让样式（见 style.css）
        // 状态机：默认态打开侧边栏 → 浏览态（体验态不被侧边栏打断）
        if (window.GameState && GameState.is(GameState.DEFAULT)) {
            GameState.set(GameState.BROWSING, { page: page || _forumLastPage.page }, 'sidebar_open');
        }
        // 未指定页面时，回到上次停留的页面（而非强制首页）
        if (page) {
            window.navigateForum(page, param);
        } else {
            window.navigateForum(_forumLastPage.page, _forumLastPage.param);
        }
    };
    window.closeForumPanel = () => {
        // 关闭侧边栏：若停留在「立绘表情调用」面板，恢复网页 NPC 默认立绘并清除预览动画
        if (window.AdminPanel && AdminPanel._exitNpcCallPreview && AdminPanel._currentTab === 'npc-call') {
            AdminPanel._exitNpcCallPreview();
        }
        const panel = document.getElementById('forumPanel');
        if (panel) panel.classList.remove('open');
        document.body.classList.remove('forum-open');
        // 状态机：关闭侧边栏 → 浏览态回到默认（不影响剧本体验状态）
        if (window.GameState && GameState.is(GameState.BROWSING)) {
            GameState.set(GameState.DEFAULT, {}, 'sidebar_close');
        }
    };
    // 宽屏下侧边栏展开时的「点击空白关闭」判定：
    // 遮罩已透明且点击穿透（聊天/立绘可正常操作），此处按命中元素区分——
    // 点到功能区（侧栏本体/聊天区/立绘/输入栏/任意可交互元素）→ 不关闭，正常交互；
    // 点到真正的页面空白 → 关闭侧边栏。窄屏仍由黑色遮罩自身的 onclick 负责。
    const _FORUM_FUNCTIONAL = '.forum-content, button, a, input, textarea, select, label, ' +
        '.modal, .npc-dropdown, .option-btn, .fold-toggle, .chat-bubble-user, .chat-bubble-npc, ' +
        '#teahouse-npc, #teahouse-desk, .tea-user-info, .tea-user-btn, #teahouse-forum-arrow, ' +
        '[role="button"], [onclick]';
    document.addEventListener('click', (e) => {
        const panel = document.getElementById('forumPanel');
        if (!panel || !panel.classList.contains('open')) return;
        if (!window.matchMedia('(min-width: 1025px)').matches) return;   // 窄屏由遮罩处理
        if (e.target.closest(_FORUM_FUNCTIONAL)) return;
        closeForumPanel();
    });
    // 侧边栏「剧本区」分组：展开/收起海龟汤、DND、COC、剧本扮演四个板块
    // 点击展开后，鼠标移出按钮/下拉区域即自动收起（一次性监听）
    window.toggleScriptZone = () => {
        const g = document.getElementById('scriptZoneGroup');
        if (!g) return;
        g.classList.toggle('open');
        if (g.classList.contains('open')) {
            g.addEventListener('mouseleave', () => g.classList.remove('open'), { once: true });
        }
    };
    // 点击「剧本区」：直接跳转到「全部板块」（展示四大板块所有剧本），同时展开子板块下拉。
    // 与子板块按钮（海龟汤/DND/COC/剧本扮演）共用 navigateForum('board', category)，
    // 空分类即「全部」，由后端 scripts 接口返回全部板块内容。
    window.openAllBoards = () => {
        window.navigateForum('board', '');
        const g = document.getElementById('scriptZoneGroup');
        if (g) {
            g.classList.add('open');
            g.addEventListener('mouseleave', () => g.classList.remove('open'), { once: true });
        }
    };
    window.navigateForum = (page, param) => {
        // 离开管理面板（尤其「立绘表情调用」）时，恢复网页 NPC 默认立绘并清除预览动画
        if (page !== 'admin' && window.AdminPanel && AdminPanel._exitNpcCallPreview && AdminPanel._currentTab === 'npc-call') {
            AdminPanel._exitNpcCallPreview();
        }
        const content = document.getElementById('forumContent');
        if (!content) return;
        // 注意：网页状态（default/browsing/experience）由侧边栏开关与体验流程驱动（状态机），
        // 不再按页面切换——侧边栏打开即浏览态，与浏览哪个页面无关。
        _forumLastPage = { page, param: param || null };  // 记录当前停留页面
        STATE.set('currentPage', page);
        window.updateBreadcrumb(page, param);
        window.loadPage(page, param, content);
    };

    window.updateBreadcrumb = (page, param) => {
        const bc = document.getElementById('forumBreadcrumb');
        if (!bc) return;
        const names = {
            home: '首页', 'board': '板块', 'subscriptions': '收藏', 'my-works': '我的作品',
            upload: '上传剧本', review: '审核', 'report-pool': '举报池', chat: '社区', admin: '管理',
        };
        bc.innerHTML = `<a href="#" onclick="navigateForum('home');return false;">🏠 首页</a> / ${names[page] || page}`;
        if (param && page === 'board') bc.innerHTML += ` / ${CONFIG.CATEGORY_NAMES[param] || param}`;
        bc.style.display = page !== 'home' ? 'block' : 'none';
    };

    window.loadPage = (page, param, container) => {
        switch (page) {
            case 'home': {
                container.innerHTML = `
                    <div class="home-container">
                        <h2>🏠 欢迎来到 AI剧本网</h2>
                        <p>发现、分享、创作你的剧本世界</p>
                        <div id="homeBanner"></div>
                        <div id="homeSearchBar"></div>
                        <div id="homeContentView">
                            <div class="category-grid">
                                ${Object.entries(CONFIG.CATEGORY_NAMES).map(([k, v]) => `
                                    <div class="category-card" onclick="navigateForum('board','${k}')">
                                        <span class="cat-icon">${CONFIG.CATEGORY_ICONS[k]}</span>
                                        <h3>${v}</h3>
                                    </div>`).join('')}
                            </div>
                        </div>
                    </div>`;
                // 首页轮播海报：海报池为空时不展示（Banner.mount 内部判空）
                if (window.Banner) Banner.mount(document.getElementById('homeBanner'), STATE.get('homeBanners'));
                const homeBar = SearchBar.mount(document.getElementById('homeSearchBar'), {
                    placeholder: '全站搜索剧本标题 / 简介 / 标签...',
                    showCategory: true,
                    categoryDefault: '',
                    tagSource: 'hot',
                    showRange: true,
                    sort: 'popular',
                    onSearch: (f) => {
                        const el = document.getElementById('homeContentView');
                        if (!el) return;
                        el.innerHTML = '<div class="loading">搜索中...</div>';
                        ScriptList._searchBar = homeBar;
                        ScriptList.searchAndRender(el, f);
                    },
                });
                break;
            }
            case 'board':
                ScriptList.render(container, param);
                break;
            case 'subscriptions':
                window.loadUserSubs(container);
                break;
            case 'my-works':
                window.loadMyWorks(container);
                break;
            case 'upload':
                ScriptUpload.render(container, param);   // param 为剧本 id 时进入编辑模式
                break;
            case 'review':
                window.loadReviewPage(container, param);
                break;
            case 'admin':
                AdminPanel.render(container);
                break;
            case 'report-pool':
                window.ReportPool.render(container);
                break;
            case 'chat':
                container.innerHTML = '<div class="loading">社区功能开发中...</div>';
                break;
            default:
                container.innerHTML = '<div class="loading">页面未找到</div>';
        }
    };

    /** 游客访问需登录页面时的提示（我的作品/收藏等） */
    window._guestLoginPrompt = () => `
        <div class="empty-state" style="padding:44px 16px;">
            <div style="font-size:44px;margin-bottom:14px;">🔒</div>
            <p style="margin-bottom:18px;font-size:14px;">请先注册或登录后查看</p>
            <div style="display:flex;gap:10px;justify-content:center;">
                <button class="btn btn-primary" onclick="showAuthModal('login')">登录</button>
                <button class="btn btn-outline" onclick="showAuthModal('register')">注册</button>
            </div>
        </div>`;

    window.loadUserSubs = async (container) => {
        if (STATE.get('isGuest') || !Utils.getUserId()) {
            container.innerHTML = window._guestLoginPrompt();
            return;
        }
        try {
            const subs = await API.get('/user/subscriptions');
            window._allSubs = subs || [];
            container.innerHTML = `
                <h2>我的收藏</h2>
                <div id="subsSearchBar"></div>
                <div id="subsList" class="scripts-grid"></div>`;
            window._renderSubsList(window._allSubs);
            SearchBar.mount(document.getElementById('subsSearchBar'), {
                key: 'subs', placeholder: '搜索我的收藏（标题/简介/标签）...',
                showRange: true, tagSource: 'all',
                onSearch: (f) => window._renderSubsList(SearchBar.clientFilter(window._allSubs || [], f)),
            });
        } catch (e) { container.innerHTML = '<div class="loading">加载失败</div>'; }
    };

    window._renderSubsList = (subs) => {
        const el = document.getElementById('subsList');
        if (!el) return;
        if (!subs || subs.length === 0) { el.innerHTML = '<div class="empty-state">暂无收藏</div>'; return; }
        el.innerHTML = subs.map(s => `
            <div class="script-card" onclick="showScriptDetail('${s.script_id}')">
                <h3>${Utils.escapeHtml(s.title)}</h3>
                <p>${Utils.escapeHtml((s.synopsis || '').substring(0, 60))}...</p>
                <div class="script-card-meta">
                    <span>📂 ${CONFIG.CATEGORY_NAMES[s.category] || s.category}</span>
                    <span>⭐ ${s.avg_rating || '0'}</span>
                </div>
            </div>`).join('');
    };

    window.loadMyWorks = async (container) => {
        if (STATE.get('isGuest') || !Utils.getUserId()) {
            container.innerHTML = window._guestLoginPrompt();
            return;
        }
        try {
            const scripts = await ScriptAPI.myScripts();
            window._allMyWorks = scripts || [];
            container.innerHTML = `
                <div class="page-header-row">
                    <h2>我的作品</h2>
                    <button class="btn btn-primary" onclick="navigateForum('upload')">+ 上传剧本</button>
                </div>
                <div id="worksSearchBar"></div>
                <div id="worksList" class="scripts-grid"></div>`;
            window._renderMyWorksList(window._allMyWorks);
            SearchBar.mount(document.getElementById('worksSearchBar'), {
                key: 'works', placeholder: '搜索我的作品（标题/简介/标签）...',
                showRange: true, tagSource: 'all',
                onSearch: (f) => window._renderMyWorksList(SearchBar.clientFilter(window._allMyWorks || [], f)),
            });
        } catch (e) { container.innerHTML = '<div class="loading">加载失败</div>'; }
    };

    window._renderMyWorksList = (scripts) => {
        const el = document.getElementById('worksList');
        if (!el) return;
        const STATUS_MAP = { draft: '草稿', pending_api: 'AI初审中', pending_admin: '管理员审核中', approved: '已通过', rejected: '已驳回' };
        if (!scripts || scripts.length === 0) { el.innerHTML = '<div class="empty-state">还没有发布作品</div>'; return; }
        el.innerHTML = scripts.map(s => `
            <div class="script-card" onclick="showScriptDetail('${s.id}')">
                <h3>${Utils.escapeHtml(s.title)}</h3>
                <p>${Utils.escapeHtml((s.synopsis || '').substring(0, 60))}...</p>
                <div class="script-card-meta">
                    <span>📂 ${CONFIG.CATEGORY_NAMES[s.category] || s.category}</span>
                    <span>👍 ${s.likes || 0}</span>
                    <span>状态：${STATUS_MAP[s.review_status] || s.review_status || '草稿'}</span>
                    ${s.review_status === 'rejected' && s.review_reason ? `<span class="review-reason" title="${Utils.escapeHtml(s.review_reason)}">打回原因：${Utils.escapeHtml(s.review_reason.substring(0, 30))}${s.review_reason.length > 30 ? '...' : ''}</span>` : ''}
                    <button class="btn btn-sm btn-outline card-edit-btn" title="编辑剧本"
                        onclick="event.stopPropagation();navigateForum('upload','${s.id}')">✏️</button>
                    <button class="btn btn-sm btn-outline card-del-btn" title="删除剧本"
                        onclick="event.stopPropagation();deleteScript('${s.id}')">🗑️</button>
                </div>
            </div>`).join('');
    };

    window.loadReviewPage = async (container, type) => {
        const tab = (type === 'community' || type === 'reviewed') ? type : 'system';
        // 审核中心整体为站长/管理员专属（含社区审核池，涉及举报人隐私）
        if (!Utils.isAdmin()) {
            container.innerHTML = '<h2>审核中心</h2><div class="empty-state">仅站长/管理员可访问审核中心</div>';
            return;
        }
        container.innerHTML = `
            <h2>审核中心</h2>
            <div class="review-tabs">
                <button class="board-tab ${tab === 'system' ? 'active' : ''}" onclick="loadReviewPage(document.getElementById('forumContent'),'system')">站长审核</button>
                <button class="board-tab ${tab === 'reviewed' ? 'active' : ''}" onclick="loadReviewPage(document.getElementById('forumContent'),'reviewed')">已审核</button>
                <button class="board-tab ${tab === 'community' ? 'active' : ''}" onclick="loadReviewPage(document.getElementById('forumContent'),'community')">社区审核池</button>
            </div>
            <div id="reviewSearchBar"></div>
            <div id="reviewContent"></div>`;
        SearchBar.mount(document.getElementById('reviewSearchBar'), {
            key: 'review', placeholder: '搜索剧本...',
            showRange: true, tagSource: 'all',
            onSearch: (f) => window._loadReviewList(tab, f),
        });
        window._loadReviewList(tab, {});
    };

    window._loadReviewList = async (tab, f) => {
        const content = document.getElementById('reviewContent');
        if (!content) return;
        if (!Utils.isAdmin()) {
            content.innerHTML = '<div class="empty-state">仅站长/管理员可访问审核队列</div>';
            return;
        }
        content.innerHTML = '<div class="loading">加载中...</div>';
        try {
            const urls = {
                system: '/review/queue/system',
                community: '/review/queue/community',
                reviewed: '/review/queue/reviewed',
            };
            const data = await API.get(urls[tab]);
            const items = SearchBar.clientFilter(data.scripts || [], f || {});
            window._renderReviewList(tab, items, content);
        } catch (e) {
            content.innerHTML = `<div class="loading">加载失败：${Utils.escapeHtml(e.message)}</div>`;
        }
    };

    window._renderReviewList = (type, items, content) => {
        if (!items || !items.length) { content.innerHTML = '<div class="empty-state">没有符合条件的剧本</div>'; return; }
        content.innerHTML = items.map(s => {
            const tags = (s.tags || []).slice(0, 5).map(t => Utils.escapeHtml(typeof t === 'string' ? t : (t.tag || ''))).join('，');
            const ai = s.ai_review
                ? `<div class="ai-review-box"><b>AI初审</b>：${Utils.escapeHtml(s.ai_review.decision)}（风险${s.ai_review.score}） ${s.ai_review.suggestion ? Utils.escapeHtml(s.ai_review.suggestion) : ''}</div>`
                : '';
            const statusLabel = { approved: '✅ 已通过', rejected: '❌ 已驳回' };
            const result = type === 'reviewed'
                ? `<div class="review-result ${s.review_status}">${statusLabel[s.review_status] || s.review_status}${s.review_status === 'rejected' && s.review_reason ? `：${Utils.escapeHtml(s.review_reason)}` : ''}</div>`
                : '';
            const report = (type === 'community' && s.report)
                ? `<div class="ai-review-box"><b>🚩 举报</b>：${Utils.escapeHtml(s.report.reason || '（未填写原因）')}（举报人：${Utils.escapeHtml(s.report.username || '匿名')}）</div>`
                : '';
            const actions = type === 'system'
                ? `<button class="btn btn-success btn-sm" onclick="ReviewModule.adminReview('${s.id}','approve')">通过</button>
                   <button class="btn btn-danger btn-sm" onclick="ReviewModule.adminReview('${s.id}','reject')">驳回</button>`
                : (type === 'reviewed' ? ''
                   : `<button class="btn btn-danger btn-sm" onclick="ReviewModule.reportReview('${s.id}','uphold')">采纳举报·下架</button>
                      <button class="btn btn-success btn-sm" onclick="ReviewModule.reportReview('${s.id}','dismiss')">驳回举报·恢复</button>`);
            return `
            <div class="review-item" data-id="${s.id}">
                <div class="review-item-head" onclick="showScriptDetail('${s.id}')">
                    <b>${Utils.escapeHtml(s.title)}</b>
                    <span class="review-status ${s.review_status}">${s.review_status}</span>
                </div>
                <div class="review-item-body">${Utils.escapeHtml((s.synopsis || '').substring(0, 80))}</div>
                <div class="tag-list">${tags}</div>
                ${ai}
                ${result}
                ${report}
                <div class="review-item-actions">${actions}</div>
            </div>`;
        }).join('');
    };

    window.parseHashAndNavigate = () => {
        const hash = window.location.hash.replace('#', '') || '';
        const [page, param] = hash.split('/');
        if (page && ['board', 'subscriptions', 'my-works', 'upload', 'review', 'report-pool', 'admin', 'chat'].includes(page)) {
            openForumPanel(page, param);
        }
    };

    // ==================== 权限相关 UI 控制 ====================
    window.updatePermissionUI = () => {
        const navAdmin = document.getElementById('navAdmin');
        if (navAdmin) navAdmin.style.display = Utils.isAdmin() ? '' : 'none';
    };

    // ==================== 统一初始化流程 ====================
    document.addEventListener('DOMContentLoaded', async () => {
        // 阶段1：恢复认证状态
        STATE.init();

        // 阶段2：基础 UI 初始化
        Auth.updateUI();
        window.updatePermissionUI();
        NpcChat.init();
        NpcOptions.init();

        // 阶段3：加载站点全局配置
        try {
            const siteData = await API.get('/site-settings');
            STATE.set('visibleCategories', siteData.visible_categories || []);
            STATE.set('homeBanners', siteData.home_banners || null);   // 首页轮播海报配置
        } catch (e) { /* 忽略 */ }

        // 阶段4：账号初始化（加载用户配置、NPC配置、激活NPC）
        await AccountInit.init('startup');

        // 阶段4.2：文字设置（字号/字体/加粗等，依赖用户配置）
        if (window.TextSettings) TextSettings.apply();

        // 阶段4.3：游戏数据云同步恢复（条件进度/线索道具等，云端覆盖本地对应键）
        if (window.GameDataSync) GameDataSync.load();

        // 阶段4.5：BGM 背景音乐（依赖用户配置与站点配置，故在账号初始化后启动）
        if (window.BgmPlayer) BgmPlayer.init();

        // 阶段5：URL 路由绑定
        window.addEventListener('hashchange', () => {
            window.parseHashAndNavigate();
        });

        // 阶段6：论坛面板初始加载
        const content = document.getElementById('forumContent');
        if (content) {
            window.loadPage('home', null, content);
        }

        // 阶段7：通知红点（登录后才有）
        if (!STATE.get('isGuest')) {
            try { await NotificationCenter.updateBadge(); } catch (e) { /* 忽略 */ }
        }
        // 每 60 秒刷新红点
        setInterval(() => {
            if (!STATE.get('isGuest')) NotificationCenter.updateBadge();
        }, 60000);
    });
})();
