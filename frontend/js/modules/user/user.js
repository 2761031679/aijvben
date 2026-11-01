/** AI剧本网 - 用户模块 */
const UserModule = {
    // 获取用户配置
    async getProfile() {
        try {
            return await API.get('/user/profile');
        } catch (e) { Utils.showToast(e.message, 'error'); return null; }
    },

    // 保存用户配置
    async saveProfile(settings) {
        try {
            const res = await API.put('/user/profile', settings);
            Utils.showToast('配置已保存');
            return res;
        } catch (e) { Utils.showToast(e.message, 'error'); return null; }
    },

    // 获取收藏列表
    async getSubscriptions() {
        try {
            return await API.get('/user/subscriptions');
        } catch (e) { return []; }
    },

    // 收藏剧本
    async subscribe(scriptId) {
        try {
            const res = await API.post(`/user/subscriptions/${scriptId}`);
            Utils.showToast('收藏成功');
            STATE.set('subscriptions', [...(STATE.get('subscriptions') || []), scriptId]);
            return res;
        } catch (e) { Utils.showToast(e.message, 'error'); return null; }
    },

    // 取消收藏
    async unsubscribe(scriptId) {
        try {
            await API.delete(`/user/subscriptions/${scriptId}`);
            Utils.showToast('已取消收藏');
            const subs = (STATE.get('subscriptions') || []).filter(s => s !== scriptId);
            STATE.set('subscriptions', subs);
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    // 检查收藏状态
    async checkSubscription(scriptId) {
        try {
            const res = await API.get(`/user/subscriptions/${scriptId}/status`);
            return res?.is_subscribed || false;
        } catch (e) { return false; }
    },

    // 获取游玩进度
    async getPlayData(scriptId) {
        try {
            return await API.get(`/user/play-data/${scriptId}`);
        } catch (e) { return null; }
    },

    // 保存游玩进度
    async savePlayData(scriptId, data) {
        try {
            await API.put(`/user/play-data/${scriptId}`, data);
        } catch (e) { Utils.showToast(e.message, 'error'); }
    },

    // 上传云端同步
    async uploadCloudSync(payload) {
        try {
            const res = await API.post('/user/cloud-sync/upload', { payload });
            Utils.showToast('云端同步成功');
            return res;
        } catch (e) { Utils.showToast(e.message, 'error'); return null; }
    },

    // 下载云端同步
    async downloadCloudSync() {
        try {
            return await API.get('/user/cloud-sync/download');
        } catch (e) { Utils.showToast(e.message, 'error'); return null; }
    }
};

window.UserModule = UserModule;
