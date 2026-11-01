/* 板块剧本列表 + 统一卡片渲染 + 搜索栏集成
 *
 * 入口：Router.go('board', { key }) → loadPage('board') → ScriptList.render(container, { key })
 *  - 板块内不显示分类筛选（用户已进入某板块，即代表只看该板块）
 *  - 标签 / 关键词 / 点赞区间由统一 SearchBar 负责
 */
(function () {
  function getBoardName(key) {
    const map = {
      '': '全部', 'hai-gui-tang': '海龟汤', 'dnd': 'DND', 'coc': 'COC', 'ju-ben-ban-yan': '剧本扮演',
    };
    return map[key] || '全部';
  }
  function esc(s) { return Utils.escapeHtml(s == null ? '' : String(s)); }
  function escAttr(s) { return String(s == null ? '' : s).replace(/'/g, "\\'").replace(/"/g, '&quot;'); }
  function likeCount(it) { const l = it.likes; return typeof l === 'object' && l ? (l.count || 0) : (l || 0); }
  function dislikeCount(it) { const d = it.dislikes; return typeof d === 'object' && d ? (d.count || 0) : (d || 0); }

  const ScriptList = {
    _state: null,
    _searchBar: null,

    /* 板块入口 */
    async render(container, param) {
      // 兼容两种调用：字符串分类（app.js 的 navigateForum('board','xxx')）或对象 { key }
      const key = (typeof param === 'string') ? param : ((param && param.key) || STATE.board || '');
      STATE.board = key;
      const boardName = getBoardName(key);
      container.innerHTML = `
        <div class="board-header">
          <div class="board-title">${esc(boardName)}</div>
          <div class="board-sub">使用搜索栏按标签 / 关键词 / 点赞区间筛选本板块内容</div>
        </div>
        <div id="boardSearchBar"></div>
        <div id="scriptList" class="script-list"></div>`;

      this._searchBar = SearchBar.mount(document.getElementById('boardSearchBar'), {
        placeholder: '本板块搜索，如 +恐怖悬疑 -变格',
        showCategory: false,
        tagSource: 'all',
        showRange: true,
        sort: 'newest',
        onSearch: (f) => {
          this.router.list({
            keyword: f.keyword,
            category: STATE.board,
            sort: f.sort,
            minLikes: f.minLikes, maxLikes: f.maxLikes,
            minDislikes: f.minDislikes, maxDislikes: f.maxDislikes,
          });
        },
      });

      await this.renderInto(document.getElementById('scriptList'), { category: STATE.board, sort: 'newest' });
    },

    /* 拉取并渲染列表（分页：加载更多） */
    async renderInto(container, filters) {
      this._state = { container, filters: filters || {}, page: 1, done: false, all: [] };
      await this._loadMore(true);
    },

    async _loadMore(reset) {
      const st = this._state;
      if (!st || st.done) return;
      try {
        const data = await ScriptAPI.list(Object.assign({}, st.filters, { page: st.page, page_size: 12 }));
        const list = data.scripts || [];
        st.all = reset ? list : (st.all || []).concat(list);
        st.page += 1;
        if (list.length < 12) st.done = true;
        this._render(st.container, st.all, !st.done);
      } catch (e) {
        st.container.innerHTML = '<div class="empty-state">加载失败，请稍后再试</div>';
      }
    },

    _render(container, scripts, hasMore) {
      if (!scripts.length) {
        container.innerHTML = '<div class="empty-state">没有符合条件的剧本</div>';
        return;
      }
      let html = '<div class="script-grid">';
      scripts.forEach(s => html += this._card(s));
      html += '</div>';
      if (hasMore) {
        html += '<div class="list-more"><button class="btn btn-sm" onclick="ScriptList.loadMore()">加载更多</button></div>';
      }
      container.innerHTML = html;
    },

    /** 生成单张剧本卡片（公开可复用，举报池等场景附加 extraHtml 即可）。
     *  卡片只含公开字段（标题/分类/难度/标签/点赞），天然不含汤底/结束条件/指导词。 */
    card(s, extraHtml = '', showExp = true) {
      const catName = (typeof CONFIG !== 'undefined' && CONFIG.CATEGORY_NAMES[s.category]) || s.category || '未分类';
      const likes = likeCount(s), dislikes = dislikeCount(s);
      const tagsHtml = (s.tags || []).slice(0, 5).map(t => {
        const tag = typeof t === 'string' ? t : (t.tag || '');
        return `<span class="tag-chip" onclick="ScriptList.onTagClick('${escAttr(tag)}')">${esc(tag)}</span>`;
      }).join('');
      const rating = s.avg_rating != null ? s.avg_rating : (s.rating_avg || 0);
      return `
        <div class="script-card" onclick="showScriptDetail('${escAttr(s.id)}')">
          <div class="script-card-header">
            <span class="script-category">📂 ${esc(catName)}</span>
            <span class="script-difficulty">⭐ ${rating}</span>
          </div>
          <div class="script-card-title">${esc(s.title || '无标题')}</div>
          <div class="script-card-tags">${tagsHtml}</div>
          <div class="script-card-footer">
            <span>👍 ${likes}</span>
            <span>👎 ${dislikes}</span>
            ${showExp ? `<span class="script-card-exp">${window.Experience ? Experience.renderStartButton(s.id) : ''}</span>` : ''}
          </div>
          ${extraHtml}
        </div>`;
    },

    _card(s) {
      return this.card(s);
    },

    loadMore() { this._loadMore(false); },

    /* 卡片标签点击 → 在搜索栏中加入该标签 */
    onTagClick(tag) {
      if (this._searchBar) this._searchBar.addTag(tag);
    },

    /* 首页全站搜索结果渲染 */
    async searchAndRender(container, f) {
      await this.renderInto(container, {
        keyword: f.keyword, category: f.category, sort: f.sort,
        minLikes: f.minLikes, maxLikes: f.maxLikes,
        minDislikes: f.minDislikes, maxDislikes: f.maxDislikes,
      });
    },

    router: {
      list(params) {
        const filters = Object.assign({ page: 1, sort: 'popular' }, params);
        if (!filters.category) delete filters.category;
        ScriptList.renderInto(document.getElementById('scriptList'), filters);
      },
    },
  };

  window.ScriptList = ScriptList;
})();
