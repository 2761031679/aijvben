/** AI剧本网 - 剧本 API 服务 */
const ScriptAPI = {
    list(filters = {}) {
        const params = new URLSearchParams();
        if (filters.page) params.set('page', filters.page);
        if (filters.category) params.set('category', filters.category);
        if (filters.tag) params.set('tag', filters.tag);
        if (filters.sort) params.set('sort', filters.sort);
        if (filters.keyword) params.set('keyword', filters.keyword);
        if (filters.tags) params.set('tags', Array.isArray(filters.tags) ? filters.tags.join(',') : filters.tags);
        if (filters.minLikes) params.set('min_likes', filters.minLikes);
        if (filters.maxLikes != null) params.set('max_likes', filters.maxLikes);
        if (filters.minDislikes) params.set('min_dislikes', filters.minDislikes);
        if (filters.maxDislikes != null) params.set('max_dislikes', filters.maxDislikes);
        return API.get(`/scripts?${params}`);
    },

    // 获取最近一段时间内最热门的标签
    hotTags(days = 30) {
        return API.get(`/scripts/tags/hot?days=${days}`);
    },

    // 获取点赞/点踩数值区间（动态，供滑块设置上下限）
    rangeStats() {
        return API.get('/scripts/range-stats');
    },

    search(keyword) {
        return API.get(`/scripts/search?keyword=${encodeURIComponent(keyword)}`);
    },

    detail(id) {
        return API.get(`/scripts/${id}`);
    },

    download(id) {
        return API.get(`/scripts/${id}/download`);
    },

    create(data) {
        return API.post('/scripts/upload', data);
    },

    update(id, data) {
        return API.put(`/scripts/${id}`, data);
    },

    delete(id) {
        return API.delete(`/scripts/${id}`);
    },

    rate(id, rating) {
        return API.post(`/scripts/${id}/rate`, { rating });
    },

    toggleLike(id, likeType) {
        return API.post(`/scripts/${id}/like`, { like_type: likeType });
    },

    // 评论区已关闭（网站审核要求）：comment / getComments 接口已下线

    myScripts() {
        return API.get('/scripts/mine/list');
    },

    /* ========== 标签点赞 ========== */
    allTags() {
        return API.get('/scripts/tags/all');
    },

    toggleTagLike(id, tag, like) {
        return API.post(`/scripts/${id}/tags/${encodeURIComponent(tag)}/like`, { like });
    },

    /* ========== NPC 工具调用（供 NPC 读取网站信息） ========== */
    npcSearch(opts = {}) {
        const params = new URLSearchParams();
        if (opts.keyword) params.set('keyword', opts.keyword);
        if (opts.category) params.set('category', opts.category);
        if (opts.tags) params.set('tags', (opts.tags || []).join(','));
        if (opts.sort) params.set('sort', opts.sort);
        if (opts.minLikes) params.set('min_likes', opts.minLikes);
        if (opts.minDislikes) params.set('min_dislikes', opts.minDislikes);
        if (opts.limit) params.set('limit', opts.limit);
        return API.get(`/npc/scripts/search?${params}`);
    },

    npcUserWorks(userId) {
        return API.get(`/npc/user/${userId}/works`);
    },

    npcUserSubscriptions(userId) {
        return API.get(`/npc/user/${userId}/subscriptions`);
    },

    npcUserReviews(userId) {
        return API.get(`/npc/user/${userId}/reviews`);
    },

    npcReviewPending() {
        return API.get('/npc/review/pending');
    },

    npcScriptDetail(id, hostToken) {
        // id 可能是内部 ID，也可能是 NPC 直接传入的剧本标题（含中文），需编码。
        // 汤底与条件表要凭「本场主持证」才下发（合同 §10.1）：只登录过不算，
        // 必须正主持着这一场。没有证时这个接口只回公开字段（标题/谜面/标签）。
        return API.get(`/npc/scripts/${encodeURIComponent(id)}`, { hostToken });
    },

    npcScriptReviews(id) {
        return API.get(`/npc/scripts/${encodeURIComponent(id)}/reviews`);
    },

    // NPC 查询热梗/问好资源库（按需 RAG 式，改善回复鲜活度）
    npcGetTrend(keyword = '', category = '') {
        const params = new URLSearchParams();
        if (keyword) params.set('keyword', keyword);
        if (category) params.set('category', category);
        return API.get(`/npc/trend?${params}`);
    },

    // NPC 获取标签列表：无关键词按热度前 20；有关键词搜索筛选前 10
    npcTags(keyword = '') {
        return API.get(`/npc/tags${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`);
    },

    /* ========== 通知 ========== */
    notifications(page = 1, unreadOnly = false) {
        return API.get(`/notifications?page=${page}&unread_only=${unreadOnly}`);
    },

    notificationUnreadCount() {
        return API.get('/notifications/unread-count');
    },

    markNotificationRead(id = '') {
        return API.post('/notifications/read', { notification_id: id });
    },
};

window.ScriptAPI = ScriptAPI;
