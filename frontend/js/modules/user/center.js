/** AI剧本网 - 个人中心 / 个人主页（UserCenter，v4.6c 实装）
 * ------------------------------------------------------------------
 *  点击右上角头像打开侧栏面板（#userPanel），展示个人主页：
 *   - 等级 / 成就分 / 经验 / 金币 等统计（token 消耗等隐私数据仅本人可见）
 *   - 上传的剧本、收藏的剧本（用户可选择对他人隐藏）
 *   - 获得/展示的成就
 *   - 关注 / 被关注数（查看他人主页时显示关注按钮）
 *
 *  数据：GET /api/users/{id}/profile（公开）+ GET /api/user/stats（本人完整）。
 */
const UserCenter = {
    _viewUserId: null,   // 当前查看的用户 id（null/自己 = 本人）

    /** 打开个人中心。userId 省略时查看自己 */
    open(userId) {
        if (!Utils.getUserId()) { Utils.showToast('请先登录', 'error'); return; }
        this._viewUserId = userId || Utils.getUserId();
        const panel = document.getElementById('userPanel');
        if (panel) panel.classList.add('open');
        document.body.classList.add('forum-open');   // 复用侧边栏避让：宽屏主场景随面板展开左移
        this._render();
    },

    close() {
        const panel = document.getElementById('userPanel');
        if (panel) panel.classList.remove('open');
        document.body.classList.remove('forum-open');
    },

    async _render() {
        const el = document.getElementById('userPanelContent');
        if (!el) return;
        el.innerHTML = '<div class="loading">加载中...</div>';
        const uid = this._viewUserId;
        try {
            const profile = await API.get(`/users/${uid}/profile`);
            // 本人额外拉完整统计（含 token 消耗等隐私数据）
            let fullStats = null;
            if (profile.is_self) {
                try { fullStats = (await API.get('/user/stats')).stats; } catch (e) { /* 忽略 */ }
            }
            el.innerHTML = this._html(profile, fullStats);
            this._bind(el, profile);
        } catch (e) {
            el.innerHTML = `<div class="profile-empty">加载失败：${Utils.escapeHtml(e.message)}</div>`;
        }
    },

    _html(p, fullStats) {
        const esc = s => Utils.escapeHtml(String(s ?? ''));
        const u = p.user, s = p.stats || {};
        const initial = esc((u.username || '?').charAt(0).toUpperCase());

        // 统计格（本人多展示 token 消耗 / 经验 / 金币）
        const grid = [
            ['等级', 'Lv.' + (s.level || 1)],
            ['成就分', s.achievement_points || 0],
            ['通关剧本', s.scripts_completed || 0],
            ['上传剧本', s.scripts_uploaded || 0],
            ['获得点赞', s.likes_received || 0],
            ['获得收藏', s.subs_received || 0],
        ];
        if (fullStats) {
            grid.push(['经验', fullStats.exp || 0]);
            grid.push(['金币', fullStats.coins || 0]);
            grid.push(['Token消耗', fullStats.tokens_used || 0]);
        }
        const gridHtml = grid.map(([k, v]) =>
            `<div class="profile-stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join('');

        // 关注行 + 关注按钮（他人主页）
        const followBtn = (!p.is_self) ? (p.is_following
            ? '<button class="btn btn-sm" id="pfFollowBtn">已关注</button>'
            : '<button class="btn btn-sm btn-primary" id="pfFollowBtn">+ 关注</button>') : '';

        // 实名认证（仅本人展示）：未认证显示按钮，已认证显示标识
        const realnameBtn = p.is_self
            ? (u.realname_verified
                ? '<span class="profile-realname verified" title="已完成实名认证">✓ 已实名认证</span>'
                : '<button class="btn btn-sm btn-outline profile-realname-btn" id="pfRealnameBtn">实名认证</button>')
            : '';

        // 成就
        const achHtml = (p.achievements && p.achievements.length)
            ? `<div class="profile-ach-list">${p.achievements.map(a =>
                // title 属性位：esc 不转引号，属性值改用 escapeAttr，内容仍用 esc
                `<span class="profile-ach" title="${Utils.escapeAttr(a.description)}">${esc(a.icon)} ${esc(a.name)}<em>+${esc(a.points)}</em></span>`).join('')}</div>`
            : '<div class="profile-empty">暂未获得成就</div>';

        // 上传的剧本
        const worksHtml = (p.works && p.works.length)
            ? p.works.map(w =>
                `<a class="profile-script-item" data-script-id="${Utils.escapeAttr(w.id)}">📜 ${esc(w.title)}<span class="meta">👍${esc(w.likes)}</span></a>`).join('')
            : '<div class="profile-empty">还没有上传过剧本</div>';

        // 收藏的剧本（可隐藏）
        let subsHtml;
        if (p.subscriptions === null) {
            subsHtml = '<div class="profile-empty">该用户已隐藏收藏的剧本</div>';
        } else if (p.subscriptions && p.subscriptions.length) {
            subsHtml = p.subscriptions.map(w =>
                `<a class="profile-script-item" data-script-id="${Utils.escapeAttr(w.id)}">⭐ ${esc(w.title)}</a>`).join('');
        } else {
            subsHtml = '<div class="profile-empty">暂无收藏</div>';
        }
        // 本人：隐藏开关
        const hideToggle = p.is_self ? `
            <label class="profile-toggle-row">
                <input type="checkbox" id="pfHideSubs"> 对他人隐藏我收藏的剧本
            </label>` : '';
        // 本人：注销账号（个人信息删除权）
        const deleteAccountBtn = p.is_self ? `
            <div class="profile-section" style="margin-top:8px;padding-top:12px;border-top:1px solid rgba(255,123,114,0.2);">
                <button class="btn btn-sm btn-danger" id="pfDeleteAccountBtn" style="width:100%;">⚠️ 注销账号</button>
            </div>` : '';

        return `
            <div class="profile-header">
                <div class="profile-avatar">${initial}</div>
                <div>
                    <div class="profile-name">${esc(u.username)}<span class="profile-level">Lv.${esc(s.level || 1)}</span>${realnameBtn}</div>
                    <div class="profile-follow-row">
                        关注 <b>${esc(s.following_count || 0)}</b> ｜ 粉丝 <b>${esc(s.follower_count || 0)}</b>
                        ${followBtn}
                    </div>
                </div>
            </div>
            <div class="profile-stats-grid">${gridHtml}</div>
            <div class="profile-section"><h3>🏅 成就</h3>${achHtml}</div>
            <div class="profile-section"><h3>📜 上传的剧本</h3>${worksHtml}</div>
            <div class="profile-section"><h3>⭐ 收藏的剧本</h3>${hideToggle}${subsHtml}</div>${deleteAccountBtn}`;
    },

    _bind(el, profile) {
        // 剧本跳转详情
        el.querySelectorAll('.profile-script-item').forEach(a => {
            a.addEventListener('click', () => {
                const id = a.dataset.scriptId;
                if (window.ScriptCard && ScriptCard.openDetail) ScriptCard.openDetail(id);
            });
        });
        // 关注 / 取消关注
        const followBtn = el.querySelector('#pfFollowBtn');
        if (followBtn) {
            followBtn.addEventListener('click', async () => {
                try {
                    if (profile.is_following) {
                        await API.delete(`/users/${profile.user.id}/follow`);
                    } else {
                        await API.post(`/users/${profile.user.id}/follow`, {});
                    }
                    this._render();
                } catch (e) { Utils.showToast(e.message, 'error'); }
            });
        }
        // 隐藏收藏开关（本人）
        const hideChk = el.querySelector('#pfHideSubs');
        if (hideChk) {
            // 初始状态从公开 profile 接口推不出（本人总能看到列表），读自己的设置
            API.get('/user/profile').then(r => {
                const st = (r && r.settings) || {};
                hideChk.checked = !!st.hide_subscriptions;
            }).catch(() => {});
            hideChk.addEventListener('change', async () => {
                try {
                    const r = await API.get('/user/profile');
                    const st = (r && r.settings) || {};
                    st.hide_subscriptions = hideChk.checked;
                    await API.put('/user/profile', { settings_json: st });
                    Utils.showToast(hideChk.checked ? '已对他人隐藏你的收藏' : '已公开你的收藏');
                } catch (e) { Utils.showToast(e.message, 'error'); }
            });
        }
        // 实名认证按钮：打开实名认证弹窗（扫码认证）
        const realnameBtn = el.querySelector('#pfRealnameBtn');
        if (realnameBtn) {
            realnameBtn.addEventListener('click', () => {
                this.close();
                if (window.Realname) Realname.open();
            });
        }
        // 注销账号（本人，个人信息删除权）
        const delBtn = el.querySelector('#pfDeleteAccountBtn');
        if (delBtn) {
            delBtn.addEventListener('click', () => this.deleteAccount());
        }
    },

    /** 注销账号：二次确认 + 密码验证，成功后登出（个人信息删除权，GB/T 35273） */
    async deleteAccount() {
        if (STATE.get('isGuest')) return Utils.showToast('请先登录', 'error');
        const pw = prompt('注销账号将清除您的个人身份信息，且不可恢复。\n\n请输入密码确认：');
        if (pw === null) return;   // 用户取消
        if (!pw.trim()) return Utils.showToast('请输入密码', 'error');
        if (!confirm('确定要注销账号吗？此操作不可恢复，注销后无法再登录。')) return;
        try {
            await API.post('/auth/account/delete', { password: pw.trim() });
            Utils.showToast('账号已注销', 'success');
            if (window.Auth && Auth.logout) Auth.logout();
            window.location.hash = '#home';
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },
};

window.UserCenter = UserCenter;
