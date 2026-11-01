/** AI剧本网 - 审核模块 */
const ReviewModule = {
    async submitForReview(scriptData) {
        try {
            const res = await API.post('/review/upload', scriptData);
            Utils.showToast('剧本已提交审核');
            return res;
        } catch (e) { Utils.showToast(e.message, 'error'); return null; }
    },

    // 管理员审核队列
    async loadSystemQueue() {
        try {
            return await API.get('/review/queue/system');
        } catch (e) { Utils.showToast(e.message, 'error'); return { scripts: [] }; }
    },

    // 管理员审核操作：驳回时先弹窗填写（可选）不通过原因；通过直接提交
    async adminReview(scriptId, action, reason) {
        try {
            if (action === 'reject' && reason === undefined) {
                reason = await UIModule.prompt('填写不通过原因（可选，将展示给作者）', {
                    title: '驳回作品', placeholder: '不通过原因...', okText: '确认驳回',
                });
                if (reason === null) return null; // 用户取消驳回
            }
            const res = await API.post(`/review/${scriptId}/admin-review`, { action, reason: reason || '' });
            Utils.showToast(action === 'approve' ? '审核通过' : '已驳回');
            return res;
        } catch (e) { Utils.showToast(e.message, 'error'); return null; }
    },

    // 社区审核池判决：采纳举报（下架）/ 驳回举报（恢复）
    async reportReview(scriptId, action, reason) {
        try {
            if (action === 'uphold' && reason === undefined) {
                reason = await UIModule.prompt('填写下架原因（可选，将展示给作者）', {
                    title: '采纳举报下架', placeholder: '下架原因...', okText: '确认下架',
                });
                if (reason === null) return null; // 用户取消
            }
            const res = await API.post(`/review/${scriptId}/report-review`, { action, reason: reason || '' });
            Utils.showToast(action === 'uphold' ? '已采纳举报并下架' : '已驳回举报并恢复');
            return res;
        } catch (e) { Utils.showToast(e.message, 'error'); return null; }
    },

    // 社区审核池（被举报待判决作品）
    async loadCommunityQueue() {
        try {
            return await API.get('/review/queue/community');
        } catch (e) { Utils.showToast(e.message, 'error'); return { scripts: [] }; }
    },

    // 已审核列表（审核通过 + 已驳回）
    async loadReviewedQueue() {
        try {
            return await API.get('/review/queue/reviewed');
        } catch (e) { Utils.showToast(e.message, 'error'); return { scripts: [] }; }
    },

    // 社区投票
    async communityVote(scriptId, vote) {
        try {
            const res = await API.post(`/review/${scriptId}/community-vote`, { vote });
            Utils.showToast('投票成功');
            return res;
        } catch (e) { Utils.showToast(e.message, 'error'); return null; }
    },

    // 获取社区投票统计
    async getCommunityVotes(scriptId) {
        try {
            return await API.get(`/review/${scriptId}/community-votes`);
        } catch (e) { return { approve: 0, reject: 0, abstain: 0 }; }
    }
};

window.ReviewModule = ReviewModule;
