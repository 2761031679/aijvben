/** AI剧本网 - API 请求封装 */
const API = {
    BASE: '/api',

    async _request(method, path, body, extra) {
        const headers = { 'Content-Type': 'application/json' };
        const token = STATE.get('token');
        if (token) headers['Authorization'] = `Bearer ${token}`;
        // 主持证走独立请求头。同一个请求里可能同时需要两个凭证：
        //   Authorization  = 我是谁（长期钥匙）
        //   X-Host-Token   = 我此刻正在主持哪一场（本场主持证）
        // 合同 §7.4 允许第三方主持人只带主持证、不带登录身份，那时 Authorization 仍旧空着。
        const hostToken = extra && extra.hostToken;
        if (hostToken) headers['X-Host-Token'] = hostToken;

        // no-store：禁用浏览器对 API 的启发式缓存，避免「保存后刷新仍显示旧数据」（如提示词管理面板）
        const opts = { method, headers, cache: 'no-store' };
        if (body && method !== 'GET') opts.body = JSON.stringify(body);

        const res = await fetch(this.BASE + path, opts);
        // 401 不一定等于「登录失效」：像「这一场没有主持证」这种，是设计允许发生的
        // （开房失败/额度用尽/证过期），当成掉登录态就等于「什么都没做错，账号被登出」。
        // 所以判据不写路径名（那样下一个端点必然重犯，审计 建议-1），
        // 由调用方声明「这个请求的 401 不代表登录过期」：extra.noAuthLogout = true。
        const authOptional = !!(extra && extra.noAuthLogout);
        if (res.status === 401 && !hostToken && !authOptional) {
            // 区分「登录失败」和「Token 过期」
            if (path === '/auth/login') {
                // 登录接口本身返回的 401 是密码错误，不清理状态
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || '用户名或密码错误');
            }
            // 先把服务端给的原因读出来再用：服务端常常已经写明「哪张票不对」
            // （例如「登录已过期」「这个账号不能走免费通道」），一律盖成「请先登录」
            // 会让报错书里全是同一句话，查问题时等于没有信息。
            const errBody = await res.json().catch(() => ({}));
            const serverSaid = typeof errBody.detail === 'string' ? errBody.detail : '';
            STATE.set('token', null);
            STATE.set('user', null);
            STATE.set('isGuest', false);
            if (window.updateAuthUI) window.updateAuthUI();
            throw new Error(serverSaid || '请先登录');
        }
        if (res.status === 410) {
            throw new Error('这一场已经结束了');
        }
        if (res.status === 429) {
            // 读取后端 detail（如免费额度耗尽的具体原因），而非一律显示"请求过于频繁"
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || '请求过于频繁');
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const error = new Error(err.detail || `请求失败 (${res.status})`);
            error.status = res.status;
            throw error;
        }
        return res.json();
    },

    get(path, extra) { return this._request('GET', path, undefined, extra); },
    post(path, data, extra) { return this._request('POST', path, data, extra); },
    put(path, data, extra) { return this._request('PUT', path, data, extra); },
    delete(path, extra) { return this._request('DELETE', path, undefined, extra); },

    async upload(path, formData) {
        const token = STATE.get('token');
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(this.BASE + path, { method: 'POST', headers, body: formData });
        if (!res.ok) throw new Error('上传失败');
        return res.json();
    }
};

window.API = API;
