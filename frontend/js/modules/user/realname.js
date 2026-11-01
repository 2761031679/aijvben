/** AI剧本网 - 实名认证模块（国家网络身份认证公共服务 · 扫码认证）
 * ------------------------------------------------------------------
 *  流程：打开弹窗 → 调 /auth/realname-verify 生码 → 展示二维码 →
 *        用户用「国家网络身份认证」App 扫码 → 平台回调 → 轮询 /auth/me 确认完成。
 */
const Realname = {
    _pollTimer: null,

    /** 打开实名认证弹窗（个人中心按钮 / 注册后引导调用） */
    open() {
        if (STATE.get('isGuest')) { Utils.showToast('请先注册或登录后再实名认证', 'error'); return; }
        if (!Utils.getUserId()) { Utils.showToast('请先登录', 'error'); return; }
        Utils.openModal('realnameModal');
        this._startVerify();
    },

    /** 关闭弹窗（同时停止轮询） */
    close() {
        Utils.closeModal('realnameModal');
        this._stopPoll();
    },

    /** 调生码接口，展示二维码 */
    async _startVerify() {
        this._stopPoll();
        const box = document.getElementById('realnameBox');
        if (!box) return;
        box.innerHTML = '<div class="loading">正在生成认证二维码...</div>';
        try {
            const res = await API.post('/auth/realname-verify', {});
            if (res.qrCodeImage) {
                box.innerHTML = `
                    <div class="realname-qr">
                        <img src="data:image/png;base64,${res.qrCodeImage}" alt="实名认证二维码">
                        <img class="realname-qr-logo" src="/static/img/digital-identity-logo.png" alt="">
                    </div>
                    <div class="realname-tip">请使用「国家网络身份认证」App 扫描二维码完成认证</div>
                    <div class="realname-tip sub">认证完成后本页面会自动刷新状态</div>
                    <div class="realname-tip diag">流水号：${Utils.escapeHtml(res.bizSeq || '')}</div>`;
                this._startPoll();
            } else {
                box.innerHTML = `<div class="profile-empty">${Utils.escapeHtml(res.error || '生成二维码失败，请稍后重试')}</div>`;
            }
        } catch (e) {
            box.innerHTML = `<div class="profile-empty">生成二维码失败：${Utils.escapeHtml(e.message || '')}</div>`;
        }
    },

    /** 轮询认证状态（最多约 2 分钟） */
    _startPoll() {
        this._stopPoll();
        let count = 0;
        this._pollTimer = setInterval(async () => {
            count++;
            try {
                const me = await API.get('/auth/me');
                if (me && me.realname_verified) {
                    this._stopPoll();
                    this._onVerified(me);
                }
            } catch (e) { /* 轮询失败忽略，继续 */ }
            if (count >= 40) this._stopPoll();  // 2 分钟仍未认证则停止
        }, 3000);
    },

    _stopPoll() {
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    },

    /** 认证成功：更新界面 + 刷新用户信息 */
    _onVerified(me) {
        const box = document.getElementById('realnameBox');
        if (box) {
            box.innerHTML = '<div class="realname-success">✓ 实名认证成功</div>';
        }
        if (me) {
            STATE.set('user', me);
            if (window.Auth && Auth.updateUI) Auth.updateUI();
        }
        Utils.showToast('实名认证成功', 'success');
    },
};

window.Realname = Realname;
