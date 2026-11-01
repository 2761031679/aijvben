/** AI剧本网 - NPC 工具调用模块（NpcTools）
 * ------------------------------------------------------------------
 *  职责：解析并执行 NPC 回复中的 [tool:NAME:param1=a&param2=b] 工具调用，
 *  读取网站真实数据返回给 NPC（由 NpcSystemChannel 回灌）。
 *  从 chat.js 剥离（核心管线只编排，不实现工具细节）。
 *
 *  调用顺序：用户消息 → AI生成(可能含[tool:]) → 本模块解析执行 →
 *  结果经系统通道再次调用 AI → 得到基于真实数据的自然回答。
 */

/** 工具名别名表：归一化提示词里可能写出的 snake_case / 中文别名 → 代码中的 camelCase 名称，
 *  避免「提示词措辞」与代码耦合。具体工具说明请写在 npc_configs 的 prompts/tools.txt（可编辑文件）中。 */
const NPC_TOOL_ALIASES = {
    search_scripts: 'searchScripts', searchscript: 'searchScripts', 搜索剧本: 'searchScripts',
    user_works: 'userWorks', userworks: 'userWorks', user_scripts: 'userWorks', 用户作品: 'userWorks',
    user_subscriptions: 'userSubscriptions', usersubscriptions: 'userSubscriptions', 用户订阅: 'userSubscriptions', 用户收藏: 'userSubscriptions',
    user_reviews: 'userReviews', userreviews: 'userReviews', 用户待审: 'userReviews',
    review_pending: 'reviewPending', reviewpending: 'reviewPending', 待审队列: 'reviewPending',
    get_script: 'getScript', getscript: 'getScript', script_detail: 'getScript', 剧本详情: 'getScript',
    get_reviews: 'getReviews', getreviews: 'getReviews', script_reviews: 'getReviews', 剧本评价: 'getReviews',
    search_tags: 'searchTags', searchtags: 'searchTags', list_tags: 'searchTags', get_tags: 'searchTags', 标签列表: 'searchTags', 搜索标签: 'searchTags',
    history: 'recallHistory', recall_history: 'recallHistory', recall: 'recallHistory', 历史记录: 'recallHistory', 回想: 'recallHistory', 回忆: 'recallHistory',
    get_trend: 'getTrend', gettrend: 'getTrend', 热梗: 'getTrend', 流行语: 'getTrend', 流行说法: 'getTrend', 网络梗: 'getTrend', meme: 'getTrend',
};

const NpcTools = {
    ALIASES: NPC_TOOL_ALIASES,

    /** 解析回复中的第一个 [tool:NAME:params] 标记；无则返回 null。
     *  容错：部分模型会把工具调用误写成尖括号 <tool:NAME:params>，这里同时兼容两种写法。 */
    parse(raw) {
        const m = (raw || '').match(/[\[<]tool:([a-zA-Z_]+)(?::([^\]>]*))?[\]>]/);
        if (!m) return null;
        const name = NPC_TOOL_ALIASES[m[1].toLowerCase()] || m[1];
        const paramStr = m[2] || '';
        const params = {};
        paramStr.split('&').forEach(p => {
            const idx = p.indexOf('=');
            if (idx < 0) return;
            const k = p.slice(0, idx).trim();
            const v = decodeURIComponent(p.slice(idx + 1));
            if (k) params[k] = v;
        });
        return { name, params };
    },

    /** 执行工具调用，返回结果文本（失败返回错误描述文本，不抛异常） */
    async run(tool) {
        try {
            const uid = tool.params.user_id || Utils.getUserId() || '';
            switch (tool.name) {
                case 'searchScripts': {
                    const res = await ScriptAPI.npcSearch({
                        keyword: tool.params.keyword || '', category: tool.params.category || '',
                        tags: tool.params.tags ? tool.params.tags.split(',') : [],
                        sort: tool.params.sort || 'popular',
                        minLikes: parseInt(tool.params.minLikes) || 0,
                        minDislikes: parseInt(tool.params.minDislikes) || 0,
                        limit: parseInt(tool.params.limit) || 5,
                    });
                    return this._fmtScripts(res.scripts || []);
                }
                case 'getScript': {
                    const d = await ScriptAPI.npcScriptDetail(tool.params.script_id);
                    return '【剧本详情】\n' + (d && d.script ? this._fmtScriptDetail(d.script) : '未找到该剧本或无权访问。');
                }
                case 'getReviews': {
                    // 评论区已关闭（网站审核要求），工具保留入口但固定返回下线提示
                    return '评论区已关闭（网站已下线评论功能，无法再查看玩家评价）。';
                }
                case 'userWorks': {
                    const res = await ScriptAPI.npcUserWorks(uid);
                    return this._fmtScripts(res.works || []);
                }
                case 'userSubscriptions': {
                    const res = await ScriptAPI.npcUserSubscriptions(uid);
                    return JSON.stringify((res.subscriptions || []).map(s => ({ title: s.title, category: s.category })), null, 0);
                }
                case 'userReviews': {
                    const res = await ScriptAPI.npcUserReviews(uid);
                    return this._fmtScripts(res.reviews || []);
                }
                case 'reviewPending': {
                    const res = await ScriptAPI.npcReviewPending();
                    return this._fmtScripts(res.scripts || []);
                }
                case 'searchTags': {
                    const res = await ScriptAPI.npcTags(tool.params.keyword || '');
                    return this._fmtTags(res.tags || []);
                }
                case 'recallHistory': {
                    // 查看历史记录：返回完整历史（不受上下文隔断影响），供 NPC 回想早前的对话
                    const list = (window.NpcHistory && NpcHistory._loadAll) ? NpcHistory._loadAll() : [];
                    return this._fmtHistory(list);
                }
                case 'getTrend': {
                    // 查询热梗/问好资源库（按需 RAG 式，避免打包进提示词）
                    const res = await ScriptAPI.npcGetTrend(tool.params.keyword || '', tool.params.category || '');
                    return this._fmtTrend(res.items || []);
                }
                default:
                    return '未知工具: ' + tool.name;
            }
        } catch (e) {
            return '工具调用失败: ' + e.message;
        }
    },

    /* ========== 结果格式化 ========== */

    /** 剧本列表统一格式：仅保留 ID/名称/类型/简介/标签 五条信息 */
    _fmtScripts(list) {
        return JSON.stringify((list || []).map(s => ({
            id: s.id, title: s.title, category: s.category,
            synopsis: s.synopsis || '',
            tags: (Array.isArray(s.tags) ? s.tags : []).map(t => t.tag || t).slice(0, 5),
        })), null, 0);
    },

    _fmtTags(list) {
        if (!list || !list.length) return '站点暂无标签。';
        return '【标签列表】\n' + list.map(t => `${t.tag}（${t.count || 0}个剧本，${t.likes || 0}赞）`).join('、');
    },

    /** 历史对话记录格式化：剥离功能标记，按玩家/主持人标注，只取最近 50 条防超长 */
    _fmtHistory(list) {
        if (!list || !list.length) return '（暂无历史对话记录）';
        const recent = list.slice(-50);
        return '【历史对话记录（最近 ' + recent.length + ' 条）】\n' +
            recent.map(r => {
                const who = r.role === 'user' ? '玩家' : '主持人';
                const text = (r.text || '').replace(/\[[^\]]*\]/g, '').trim();
                return `${who}：${text}`;
            }).join('\n');
    },

    /** 热梗/问好资源格式化：分类标注，供 NPC 参考改写语气/说法 */
    _fmtTrend(list) {
        if (!list || !list.length) return '资源库暂无匹配的热梗/问好说法。';
        const catName = { greeting: '问好', meme: '热梗', trend: '流行说法' };
        return '【热梗/问好资源】\n' + list.map(t =>
            `[${catName[t.category] || '流行说法'}] ${t.keyword}：${t.content}`
        ).join('\n');
    },

    _fmtScriptDetail(d) {
        if (!d) return '未找到该剧本。';
        // 未实现详情功能的类型：仅返回基本信息 + 制作中提示
        if (d.not_implemented) {
            const base = [
                `标题：${d.title || ''}`,
                d.category ? `分类：${d.category}` : '',
                d.synopsis ? `简介：${d.synopsis}` : '',
                d.detail_notice || '该类型剧本详情功能正在制作中。',
            ].filter(Boolean);
            return base.join('\n');
        }
        const lines = [
            `标题：${d.title || ''}`,
            d.author ? `作者：${d.author}` : '',
            d.category ? `分类：${d.category}` : '',
            d.difficulty ? `难度：${d.difficulty}/5` : '',
            (typeof d.avg_rating === 'number') ? `评分：${d.avg_rating}（${d.rating_count || 0}人）` : '',
            `点赞：${d.likes || 0} / 点踩：${d.dislikes || 0}`,
            (Array.isArray(d.tags) && d.tags.length) ? `标签：${d.tags.map(t => t.tag || t).join('、')}` : '',
            d.synopsis ? `简介：${d.synopsis}` : '',
            d.story ? `汤面：${d.story}` : '',
            d.explanation ? `汤底：${d.explanation}` : '汤底：需收藏并通关后方可查看',
            d.ending_condition ? `结束条件：${d.ending_condition}` : '结束条件：需收藏并通关后方可查看',
        ].filter(Boolean);
        return lines.join('\n');
    },

    _fmtReviews(r) {
        const list = (r && r.comments) || [];
        if (!list.length) return '该剧本暂无评价。';
        return '该剧本评价：\n' + list.slice(0, 10).map(c => `- ${c.username}：${c.content}`).join('\n');
    },
};

window.NpcTools = NpcTools;
