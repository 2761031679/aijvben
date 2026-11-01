/* 统一搜索栏组件
 *
 * 功能：
 *  - 关键词搜索（标题 / 简介 / 标签正文）
 *  - 标签筛选：在搜索框中用 “+标签” 表示想要、“-标签” 表示不想要，空格分隔
 *  - 分类筛选（可选，首页默认“全部分类”即全站）
 *  - 排序（可选）
 *  - 点赞 / 点踩区间筛选（紧凑双滑块）
 *
 * 后端只需读取搜索框内容（keyword）即可完成标签筛选（见 search_service.parse_query）。
 */
(function () {
  // 评论区已关闭（网站审核要求）：移除 comments_24h「24h活跃」排序项
  const DEFAULT_SORTS = [
    { key: 'newest', label: '最新' },
    { key: 'popular', label: '最热门' },
    { key: 'rating', label: '评分最高' },
    { key: 'hot_likes', label: '高点赞' },
  ];

  function esc(s) { return Utils.escapeHtml(s == null ? '' : String(s)); }
  function escAttr(s) { return String(s == null ? '' : s).replace(/'/g, "\\'").replace(/"/g, '&quot;'); }
  function likeCount(it) { const l = it.likes; return typeof l === 'object' && l ? (l.count || 0) : (l || 0); }
  function dislikeCount(it) { const d = it.dislikes; return typeof d === 'object' && d ? (d.count || 0) : (d || 0); }

  /* 解析搜索栏内容：+标签 想要 / -标签 不想要 / 其余为自由关键词 */
  function parseQuery(q) {
    const include = [], exclude = [], free = [];
    (q || '').trim().split(/\s+/).filter(Boolean).forEach(tok => {
      if (tok.startsWith('+')) { const t = tok.slice(1).trim(); if (t) include.push(t); }
      else if (tok.startsWith('-')) { const t = tok.slice(1).trim(); if (t) exclude.push(t); }
      else free.push(tok);
    });
    return { include, exclude, free: free.join(' ') };
  }

  function serializeQuery(p) {
    const parts = [];
    if (p.free) parts.push(p.free);
    p.include.forEach(t => parts.push('+' + t));
    p.exclude.forEach(t => parts.push('-' + t));
    return parts.join(' ');
  }

  /* 切换某标签的 +/- 状态：无 → + → - → 无 */
  function toggleTagInQuery(q, tag) {
    const p = parseQuery(q);
    const i = p.include.indexOf(tag);
    const e = p.exclude.indexOf(tag);
    if (i >= 0) { p.include.splice(i, 1); p.exclude.push(tag); }
    else if (e >= 0) { p.exclude.splice(e, 1); }
    else { p.include.push(tag); }
    return serializeQuery(p);
  }

  function catOptionsHTML() {
    let html = '<option value="">全部分类</option>';
    const names = (typeof CONFIG !== 'undefined' && CONFIG.CATEGORY_NAMES) || {};
    Object.keys(names).forEach(k => {
      html += `<option value="${escAttr(k)}">${esc(names[k])}</option>`;
    });
    return html;
  }

  function sortOptionsHTML(sorts, cur) {
    sorts = (sorts && sorts.length) ? sorts : DEFAULT_SORTS;
    return sorts.map(s => `<option value="${escAttr(s.key)}" ${s.key === cur ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
  }

  function drHTML(key, label) {
    return `
      <div class="sb-range-item">
        <label>${label}</label>
        <div class="dual-range dr-${key}">
          <div class="dr-track"></div>
          <div class="dr-fill"></div>
          <input type="range" class="dr-min" min="0" max="100" value="0">
          <input type="range" class="dr-max" min="0" max="100" value="100">
        </div>
        <span class="dr-label"></span>
      </div>`;
  }

  function buildHTML(opts) {
    const cat = opts.showCategory
      ? `<div class="sb-field"><label>分类</label><select class="sb-cat">${catOptionsHTML()}</select></div>`
      : '';
    const sort = `<div class="sb-field"><label>排序</label><select class="sb-sort">${sortOptionsHTML(opts.sorts, opts.sort)}</select></div>`;
    const range = opts.showRange
      ? `<div class="sb-range">${drHTML('likes', '👍 点赞')}${drHTML('dislikes', '👎 点踩')}</div>`
      : '';
    return `
      <div class="sb-row">
        <input class="sb-input" placeholder="${escAttr(opts.placeholder)}" autocomplete="off">
        <button class="sb-btn" type="button" title="搜索">🔍</button>
        <button class="sb-gear" type="button" title="筛选 / 排序">⚙</button>
      </div>
      <div class="sb-tags"></div>
      <div class="sb-pop" hidden>${cat}${sort}${range}</div>`;
  }

  const SearchBar = {
    /* 挂载到容器，返回控制器 { setFilter, getFilter, addTag, setKeyword } */
    mount(container, opts = {}) {
      opts = Object.assign({
        placeholder: '搜索标题、简介或标签...',
        showCategory: false,
        categoryDefault: '',
        tagSource: 'none',   // 'all' | 'hot' | 'none'
        showRange: false,
        sort: 'popular',
        sorts: null,
        onSearch: null,
      }, opts);

      const el = typeof container === 'string' ? document.getElementById(container) : container;
      el.innerHTML = buildHTML(opts);
      el.classList.add('search-bar-mount');

      const input = el.querySelector('.sb-input');
      const tagsBox = el.querySelector('.sb-tags');
      const pop = el.querySelector('.sb-pop');
      const gear = el.querySelector('.sb-gear');

      const state = {
        keyword: '',
        category: opts.categoryDefault || '',
        sort: opts.sort || 'popular',
        minLikes: 0, maxLikes: null,
        minDislikes: 0, maxDislikes: null,
      };
      let tagsList = [];

      function emit() {
        state.keyword = input.value;
        if (opts.onSearch) opts.onSearch(Object.assign({}, state));
      }

      if (opts.showCategory) {
        const sel = el.querySelector('.sb-cat');
        sel.value = state.category;
        sel.addEventListener('change', () => { state.category = sel.value; emit(); });
      }
      const sortSel = el.querySelector('.sb-sort');
      if (sortSel) {
        sortSel.value = state.sort;
        sortSel.addEventListener('change', () => { state.sort = sortSel.value; emit(); });
      }
      el.querySelector('.sb-btn').addEventListener('click', emit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') emit(); });
      input.addEventListener('input', () => { state.keyword = input.value; renderTags(); });

      gear.addEventListener('click', () => { pop.hidden = !pop.hidden; });

      function renderTags() {
        const p = parseQuery(state.keyword);
        const st = {};
        p.include.forEach(t => st[t] = 'inc');
        p.exclude.forEach(t => st[t] = 'exc');
        tagsBox.innerHTML = tagsList.map(t => {
          const s = st[t.tag] || '';
          const mark = s === 'inc' ? '+' : (s === 'exc' ? '−' : '');
          return `<span class="sb-chip ${s}" data-tag="${escAttr(t.tag)}">${mark}${esc(t.tag)}</span>`;
        }).join('');
        Array.from(tagsBox.querySelectorAll('.sb-chip')).forEach(chip => {
          chip.addEventListener('click', () => {
            const tag = chip.getAttribute('data-tag');
            state.keyword = toggleTagInQuery(state.keyword, tag);
            input.value = state.keyword;
            renderTags();
            emit();
          });
        });
      }

      if (opts.tagSource && opts.tagSource !== 'none') {
        const fetcher = opts.tagSource === 'hot' ? ScriptAPI.hotTags() : ScriptAPI.allTags();
        Promise.resolve(fetcher).then(data => {
          tagsList = (data && data.tags) || [];
          renderTags();
        }).catch(() => { tagsList = []; });
      }

      if (opts.showRange) {
        // 先用默认区间挂载，再异步拉取动态区间（随站点实时数据浮动）并应用
        setupDual(el.querySelector('.dr-likes'), 'Likes');
        setupDual(el.querySelector('.dr-dislikes'), 'Dislikes');
        Promise.resolve(ScriptAPI.rangeStats()).then(stats => {
          if (!stats) return;
          setupDual(el.querySelector('.dr-likes'), 'Likes', stats.likes);
          setupDual(el.querySelector('.dr-dislikes'), 'Dislikes', stats.dislikes);
        }).catch(() => { /* 保持默认区间 */ });
      }

      /* 双滑块：bounds = {min, max}（不传则默认 0~100）。
       * 滑到最小值视为"不限下限"，滑到最大值视为"不限上限"。
       * 通过替换节点重新绑定，避免多次调用导致监听器叠加。 */
      function setupDual(node, suffix, bounds) {
        if (!node) return;
        const fresh = node.cloneNode(true);
        node.parentNode.replaceChild(fresh, node);
        node = fresh;

        const minI = node.querySelector('.dr-min');
        const maxI = node.querySelector('.dr-max');
        const fill = node.querySelector('.dr-fill');
        const label = node.parentElement.querySelector('.dr-label');

        const MIN = (bounds && Number.isFinite(bounds.min)) ? bounds.min : 0;
        const MAX = Math.max((bounds && Number.isFinite(bounds.max)) ? bounds.max : 100, MIN + 1);
        const span = MAX - MIN;
        [minI, maxI].forEach(i => { i.min = MIN; i.max = MAX; });
        minI.value = MIN; maxI.value = MAX;

        function update() {
          let lo = parseInt(minI.value, 10);
          let hi = parseInt(maxI.value, 10);
          if (lo > hi) { const t = lo; lo = hi; hi = t; }
          minI.value = lo; maxI.value = hi;
          const pct = a => ((a - MIN) / span) * 100;
          fill.style.left = pct(lo) + '%';
          fill.style.right = (100 - pct(hi)) + '%';
          state['min' + suffix] = lo <= MIN ? 0 : lo;
          state['max' + suffix] = hi >= MAX ? null : hi;
          if (label) label.textContent = (lo <= MIN ? '不限' : lo) + ' ~ ' + (hi >= MAX ? '不限' : hi);
        }
        minI.addEventListener('input', update);
        maxI.addEventListener('input', update);
        minI.addEventListener('change', emit);
        maxI.addEventListener('change', emit);
        update();
      }

      return {
        setFilter(f) {
          if (!f) return;
          state.keyword = f.keyword || '';
          input.value = state.keyword;
          if (f.category != null) state.category = f.category;
          if (f.sort) state.sort = f.sort;
          if (f.minLikes != null) state.minLikes = f.minLikes;
          if (f.maxLikes !== undefined) state.maxLikes = f.maxLikes;
          if (f.minDislikes != null) state.minDislikes = f.minDislikes;
          if (f.maxDislikes !== undefined) state.maxDislikes = f.maxDislikes;
          const sel = el.querySelector('.sb-cat'); if (sel && opts.showCategory) sel.value = state.category;
          const ss = el.querySelector('.sb-sort'); if (ss) ss.value = state.sort;
          renderTags();
        },
        getFilter() { return Object.assign({}, state); },
        addTag(tag) {
          state.keyword = toggleTagInQuery(state.keyword, tag);
          input.value = state.keyword;
          renderTags();
          emit();
        },
        setKeyword(k) { input.value = k; state.keyword = k; renderTags(); emit(); },
      };
    },

    /* 客户端兜底筛选（接口不可用或本地列表时使用） */
    clientFilter(items, f) {
      f = f || {};
      const q = parseQuery(f.keyword || '');
      return (items || []).filter(it => {
        if (f.category && it.category && it.category !== f.category) return false;
        const likes = likeCount(it), dislikes = dislikeCount(it);
        if (f.minLikes && likes < f.minLikes) return false;
        if (f.maxLikes != null && likes > f.maxLikes) return false;
        if (f.minDislikes && dislikes < f.minDislikes) return false;
        if (f.maxDislikes != null && dislikes > f.maxDislikes) return false;
        const itemTags = (it.tags || []).map(t => (typeof t === 'string' ? t : (t.tag || '')).toLowerCase());
        if (q.include.length && !q.include.every(t => itemTags.includes(t.toLowerCase()))) return false;
        if (q.exclude.length && q.exclude.some(t => itemTags.includes(t.toLowerCase()))) return false;
        if (q.free) {
          const hay = [it.title || '', it.synopsis || '', it.story || '',
            (it.tags || []).map(t => typeof t === 'string' ? t : (t.tag || '')).join(' ')].join(' ').toLowerCase();
          if (!hay.includes(q.free.toLowerCase())) return false;
        }
        return true;
      });
    },
  };

  window.SearchBar = SearchBar;
})();
