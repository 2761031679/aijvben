/**
 * NPC 对话历史记录模块 (NpcHistory)
 * ------------------------------------------------------------------
 * 后端未存储聊天记录，对话历史以「分账号 + 分 NPC」形式保存在用户本地。
 * 依赖 Store（分账号命名空间），键格式实际为：ts_<uid>_chat_<npcId>。
 *
 * 视觉交互（配合 NpcChat._bindHistoryScroll）：
 *   - 登录 / 切换 NPC 时恢复最近一页（restoreRecent）；
 *   - 用户向上滚动到顶部时，自动加载更早的一页（olderPage）并保持视口位置。
 */
const NpcHistory = {
    PAGE: 20,           // 每页加载条数
    MAX_STORED: 1000,   // 单个 NPC 最多本地保存条数（超出丢弃最旧）
    _cursor: 0,         // 已加载进会话的历史条数（用于分页）

    /** 当前 NPC 对应的存储键名（Store 已按账号隔离） */
    _key() {
        const npc = (window.NpcChat && NpcChat.getCurrentNpc && NpcChat.getCurrentNpc());
        return 'chat_' + ((npc && npc.id) || 'default');
    },

    _loadAll() {
        return (window.Store ? Store.get(this._key(), []) : []) || [];
    },

    _saveAll(list) {
        if (window.Store) Store.set(this._key(), list.slice(-this.MAX_STORED));
    },

    /** 追加一条对话记录（仅持久化 user / npc 的真实对话，忽略系统提示） */
    append(msg) {
        if (!msg || (msg.role !== 'user' && msg.role !== 'npc')) return;
        if (msg._restored) return;   // 恢复出来的记录不重复写回
        const list = this._loadAll();
        list.push({
            role: msg.role,
            text: msg.text,
            time: (msg.time && msg.time.toISOString) ? msg.time.toISOString() : new Date().toISOString(),
        });
        this._saveAll(list);
        // 追加新消息后，游标随之推进（这条也算"已展示")
        this._cursor += 1;
    },

    /** 恢复最近一页历史，重置游标；返回消息数组（供 NpcChat 拼接） */
    restoreRecent() {
        const all = this._loadAll();
        const start = Math.max(0, all.length - this.PAGE);
        this._cursor = all.length - start;
        return all.slice(start).map(r => this._deserialize(r));
    },

    /** 是否还有更早的历史未加载 */
    hasMore() {
        return this._loadAll().length > this._cursor;
    },

    /** 取更早的一页（返回数组，供插入到会话最前面），并推进游标 */
    olderPage() {
        const all = this._loadAll();
        const end = all.length - this._cursor;
        if (end <= 0) return [];
        const start = Math.max(0, end - this.PAGE);
        this._cursor += (end - start);
        return all.slice(start, end).map(r => this._deserialize(r));
    },

    /** 切换 NPC / 账号时重置分页游标 */
    resetCursor() {
        this._cursor = 0;
    },

    /** 清空当前 NPC 的本地历史 */
    clear() {
        if (window.Store) Store.remove(this._key());
        this._cursor = 0;
    },

    /** 返回最后一条对话消息的时间（Date），无历史返回 null。用于开场判断「上次对话时间」。 */
    lastTime() {
        const all = this._loadAll();
        if (!all.length) return null;
        const last = all[all.length - 1];
        return last && last.time ? new Date(last.time) : null;
    },

    /** 撤回最后一条 NPC 消息（审核驳回撤回时同步删除历史，避免刷新后"口胡"消息复现） */
    removeLastNpc() {
        const list = this._loadAll();
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].role === 'npc') {
                list.splice(i, 1);
                break;
            }
        }
        this._saveAll(list);
        if (this._cursor > 0) this._cursor -= 1;
    },

    _deserialize(r) {
        return {
            role: r.role,
            text: r.text,
            time: new Date(r.time),
            _id: (window.NpcChat ? ++NpcChat._msgId : 0),
            _restored: true,
        };
    },
};

window.NpcHistory = NpcHistory;
