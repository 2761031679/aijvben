/** AI剧本网 - 认证模块 */
const Auth = {
    _mode: 'login',

    init() {
        this.updateUI();
    },

    showModal(mode) {
        this._mode = mode;
        const title = document.getElementById('authTitle');
        const regFields = document.getElementById('registerFields');
        const regFields2 = document.getElementById('registerFields2');
        const submitBtn = document.getElementById('authSubmitBtn');
        const switchText = document.getElementById('authSwitch');
        const emailInput = document.getElementById('authEmail');
        const usernameInput = document.getElementById('authUsername');

        if (mode === 'register') {
            if (title) title.textContent = '注册';
            if (regFields) regFields.style.display = 'block';
            if (regFields2) regFields2.style.display = 'block';
            if (submitBtn) submitBtn.textContent = '注册';
            if (switchText) switchText.innerHTML = '已有账号？<a href="#" onclick="Auth.toggleMode()">立即登录</a>';
            if (usernameInput) { usernameInput.placeholder = '用户名'; usernameInput.required = true; }
            if (emailInput) { emailInput.required = true; }
        } else {
            if (title) title.textContent = '登录';
            if (regFields) regFields.style.display = 'none';
            if (regFields2) regFields2.style.display = 'none';
            if (submitBtn) submitBtn.textContent = '登录';
            if (switchText) switchText.innerHTML = '还没有账号？<a href="#" onclick="Auth.toggleMode()">立即注册</a>';
            if (usernameInput) { usernameInput.placeholder = '邮箱或用户名'; usernameInput.required = true; }
            if (emailInput) { emailInput.required = false; emailInput.value = ''; }
        }
        Utils.openModal('authModal');
    },

    toggleMode() {
        this.showModal(this._mode === 'login' ? 'register' : 'login');
    },

    async submit(e) {
        e.preventDefault();
        try {
            if (this._mode === 'register') {
                // 注册须勾选同意《用户协议》和《隐私政策》（个人信息保护合规）
                const agreeEl = document.getElementById('authAgree');
                if (!agreeEl || !agreeEl.checked) {
                    Utils.showToast('请先阅读并同意《用户协议》和《隐私政策》', 'error');
                    return;
                }
                const emailEl = document.getElementById('authEmail');
                const data = {
                    username: document.getElementById('authUsername').value.trim(),
                    email: emailEl ? emailEl.value.trim() : document.getElementById('authUsername').value.trim(),
                    password: document.getElementById('authPassword').value,
                    confirm_password: document.getElementById('authConfirmPassword')?.value || '',
                    code: document.getElementById('authCode')?.value || '',
                };
                const res = await API.post('/auth/register', data);
                this._onLoginSuccess(res);
                Utils.showToast('注册成功', 'success');
                // 注册成功后自动弹窗引导实名认证（用户可暂时跳过）
                if (res.user && !res.user.realname_verified) {
                    setTimeout(() => { if (window.Realname) Realname.open(); }, 400);
                }
            } else {
                const data = {
                    username: document.getElementById('authUsername').value.trim(),
                    password: document.getElementById('authPassword').value,
                };
                const res = await API.post('/auth/login', data);
                this._onLoginSuccess(res);
            }
            Utils.closeModal('authModal');
        } catch (e) {
            Utils.showToast(e.message, 'error');
        }
    },

    async guestLogin() {
        try {
            const res = await API.post('/auth/guest-token');
            STATE.set('token', res.token);
            STATE.set('isGuest', true);
            STATE.set('user', null);
            this.updateUI();
            Utils.showToast('以游客身份登录');
            // 触发账号初始化
            AccountInit.init('guest');
        } catch (e) {
            Utils.showToast(e.message, 'error');
        }
    },

    async logout() {
        // 先收掉正在进行的体验：主持证挂在 Experience 内存里、绑的是「上一个账号」这一场，
        // 不清掉的话，同一浏览器换账号再进同一本剧本，会命中「同剧本 + 证还有效」的复用
        // 短路，把上一个人的证交出去 —— 新账号会看到上一个人的玩家档案，结算也记在别人头上。
        try {
            if (window.Experience && Experience.isActive && Experience.isActive()) {
                Experience.end('aborted');
            }
        } catch (e) { /* 收尾失败不挡登出 */ }
        STATE.set('token', null);
        STATE.set('user', null);
        STATE.set('isGuest', false);
        // 配置改为纯分账号存储：登出只需清空内存态配置，账号自身的配置仍安全保存在
        // 各自的 Store 命名空间（ts_<uid>_config）中，重登后由 _loadLocalConfig 载回。
        // 不再擦写全局 turtlesoup_config（此前的擦写会导致 key 永久丢失）。
        STATE.set('config', null);
        window.resetForumState && window.resetForumState();  // 重登后侧边栏回到首页
        this.updateUI();
        window.location.hash = '#home';
        // 触发账号初始化（内部会重置会话并载入游客配置/历史）
        AccountInit.init('logout');
    },

    _countdownTimer: null,

    async sendCode() {
        const emailEl = document.getElementById('authEmail');
        const email = emailEl?.value?.trim();
        if (!email) return Utils.showToast('请输入邮箱', 'error');
        if (!email.includes('@') || !email.includes('.')) return Utils.showToast('邮箱格式不正确', 'error');

        const btn = document.getElementById('sendCodeBtn');
        if (btn && btn.dataset.counting === 'true') return;

        try {
            await API.post('/auth/send-code', { email: email, purpose: 'register' });
            Utils.showToast('验证码已发送');
            // 开始倒计时
            if (btn) {
                btn.dataset.counting = 'true';
                btn.disabled = true;
                let sec = 60;
                btn.textContent = sec + 's';
                this._countdownTimer = setInterval(() => {
                    sec--;
                    if (sec <= 0) {
                        clearInterval(this._countdownTimer);
                        btn.textContent = '发送验证码';
                        btn.disabled = false;
                        btn.dataset.counting = 'false';
                    } else {
                        btn.textContent = sec + 's';
                    }
                }, 1000);
            }
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    _onLoginSuccess(res) {
        STATE.set('token', res.token);
        STATE.set('user', res.user);
        STATE.set('isGuest', false);
        this.updateUI();
        // 触发账号初始化
        AccountInit.init('login');
    },

    updateUI() {
        const token = STATE.get('token');
        const user = STATE.get('user');
        const isGuest = STATE.get('isGuest');
        const guestBtns = document.getElementById('teahouse-guest-btns');
        const userInfo = document.getElementById('teahouse-user-info');
        const userName = document.getElementById('teaUserName');

        if (token && !isGuest) {
            if (guestBtns) guestBtns.style.display = 'none';
            if (userInfo) userInfo.style.display = 'flex';
            if (userName && user) userName.textContent = user.username;
        } else if (token && isGuest) {
            if (guestBtns) guestBtns.style.display = 'none';
            if (userInfo) userInfo.style.display = 'flex';
            if (userName) userName.textContent = '游客';
        } else {
            if (guestBtns) guestBtns.style.display = 'flex';
            if (userInfo) userInfo.style.display = 'none';
        }
        Events.emit('auth-changed', { token, user, isGuest });
        if (window.updatePermissionUI) window.updatePermissionUI();
    }
};

window.Auth = Auth;

/** 打开隐私政策 / 用户协议弹窗（注册表单勾选链接调用） */
function showPolicyModal(type) {
    const id = type === 'privacy' ? 'policyPrivacyModal' : 'policyTermsModal';
    if (window.Utils && Utils.openModal) Utils.openModal(id);
}
window.showPolicyModal = showPolicyModal;
