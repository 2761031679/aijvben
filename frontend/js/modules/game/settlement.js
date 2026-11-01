/** AI剧本网 - 结算面板（Settlement，v4.6c 重构）
 * ------------------------------------------------------------------
 *  结算面板由系统自动调用（ConditionTracker 判定结局达成后触发），NPC 不再负责触发结算。
 *
 *  结算顺序（ConditionTracker._settle 编排）：
 *   ① 本面板（数据优先：胜利先调通关接口落库，再展示面板，玩家看到面板前数据已安全）
 *   ② 状态机 experience → 进入体验前的状态
 *   ③ NpcBus 通知 NPC 用结局备注解说
 *
 *  两种结算：
 *   - 胜利 show()：标记通关 + 写通关记录 + 经验/金币/成就结算（响应 rewards 直接展示）；
 *   - 失败 showDefeat()：仅展示失败面板，不标记通关、不解锁汤底、无奖励。
 */
const Settlement = {
    _shown: false,

    /** 胜利结算：先落库（通关标记 + 统计结算），再展示面板 */
    async show(scriptId, opts = {}) {
        if (!scriptId || this._shown) return;
        this._shown = true;
        let rewards = null, completeOk = false;
        if (Utils.getUserId()) {
            try {
                const res = await API.post(`/game/${scriptId}/complete`, {
                    ending_id: opts.endingId || '',
                    ending_name: opts.endingName || '',
                });
                rewards = res && res.rewards;
                completeOk = true;
            } catch (e) {
                console.warn('[Settlement] 通关标记失败:', e.message);
            }
        }
        console.log('[Settlement] 胜利结算', { scriptId, completeOk, ending: opts.endingName, rewards });
        this._render({ win: true, scriptId, endingName: opts.endingName || '', note: opts.note || '', rewards, completeOk });
    },

    /** 失败结算：只展示面板，不调用通关接口（不标记通关、不解锁汤底、无奖励） */
    async showDefeat(scriptId, endingName, note = '') {
        if (!scriptId || this._shown) return;
        this._shown = true;
        console.log('[Settlement] 失败结算', { scriptId, endingName });
        this._render({ win: false, scriptId, endingName: endingName || '', note, rewards: null, completeOk: false });
    },

    close() {
        const ov = document.getElementById('settlementOverlay');
        if (ov) ov.remove();
        this._shown = false;
    },

    /** 再来一次：关闭面板并重新进入同一剧本体验。
     *  为什么不能直接调 Experience.start：结算面板弹出时这一场**还没结束**（结束要等 NPC 把结局讲完），
     *  start() 开头的 `if (this._isActive && this._scriptId === scriptId)` 会把这句调用原地挡回来，
     *  于是点「再来一次」只关掉了面板、什么都不发生（用户实测就是这个）。
     *  所以优先走 Experience.restart()（收场 → 重新 prepare → 激活 → 触发开场白）；
     *  restart 还不存在时退回 start()，免得整块按钮直接失效。
     *  本方法由 onclick 调用，返回 Promise 无妨。 */
    replay(scriptId) {
        this.close();
        if (window.Experience && Experience.restart) {
            return Experience.restart(scriptId).then(res => {
                // restart 约定返回 {ok,error}：失败要有下音，否则玩家只看到面板关了、又在干等
                if (res && res.ok === false && window.Utils) Utils.showToast(res.error || '重新开始失败', 'error');
                return res;
            });
        }
        if (window.Experience && Experience.start) return Experience.start(scriptId);
    },

    /** 返回剧本库 */
    backToLibrary() {
        this.close();
        if (window.openForumPanel) openForumPanel('board');
    },

    /* ========== 内部 ========== */

    _render({ win, scriptId, endingName, note, rewards, completeOk }) {
        this.close();   // 防御：清掉可能残留的旧面板（_shown 已在入口处拦截，这里仅清 DOM）
        this._shown = true;

        const esc = s => Utils.escapeHtml(s || '');
        const rewardsHtml = (win && rewards) ? this._rewardsHtml(rewards) : '';
        const noteHtml = note ? `<p class="stl-note">${esc(note)}</p>` : '';
        const unlockHtml = (win && completeOk)
            ? '<p class="stl-unlock">🔓 汤底已解锁：前往剧本详情页「查看汤底」</p>' : '';
        const subHtml = win
            ? (completeOk ? '' : '<p class="stl-sub">（通关记录同步失败，将不影响再次通关）</p>')
            : '<p class="stl-sub">未能揭开真相……汤底仍未解锁，再接再厉！</p>';

        const ov = document.createElement('div');
        ov.id = 'settlementOverlay';
        ov.className = `settlement-overlay ${win ? 'stl-win' : 'stl-lose'}`;
        ov.innerHTML = `
            <div class="settlement-card">
                <div class="stl-badge">${win ? '🏆' : '💀'}</div>
                <h2 class="stl-title">${win ? '真相大白' : '游戏失败'}</h2>
                ${endingName ? `<p class="stl-ending">达成结局《${esc(endingName)}》</p>` : ''}
                ${noteHtml}
                ${rewardsHtml}
                ${unlockHtml}
                ${subHtml}
                <div class="stl-actions">
                    <button class="btn btn-primary" id="stlBtnReplay">再来一次</button>
                    <button class="btn" id="stlBtnLibrary">返回剧本库</button>
                    <button class="btn btn-outline" id="stlBtnClose">完成</button>
                </div>
            </div>`;
        document.body.appendChild(ov);
        ov.querySelector('#stlBtnClose').onclick = () => this.close();
        ov.querySelector('#stlBtnReplay').onclick = () => this.replay(scriptId);
        ov.querySelector('#stlBtnLibrary').onclick = () => this.backToLibrary();
        if (window.Events) Events.emit('settlement-shown', { scriptId, win });
    },

    /** 奖励区：经验/金币/等级/新成就 */
    _rewardsHtml(rewards) {
        const esc = s => Utils.escapeHtml(String(s ?? ''));
        const rows = [];
        if (rewards.first_time) {
            if (rewards.exp_gained) rows.push(`<span class="stl-reward-item">✨ 经验 +${esc(rewards.exp_gained)}</span>`);
            if (rewards.coins_gained) rows.push(`<span class="stl-reward-item">🪙 金币 +${esc(rewards.coins_gained)}</span>`);
            if (rewards.level) rows.push(`<span class="stl-reward-item">🎖️ 当前等级 Lv.${esc(rewards.level)}</span>`);
        } else {
            rows.push('<span class="stl-reward-item">本剧本已通关过，不重复发放奖励</span>');
        }
        const achs = (rewards.new_achievements || []).map(a =>
            // title 是属性位：esc（= escapeHtml）不转引号，成就描述里一个 " 就能闭合属性，
            // 属性值一律走 escapeAttr；元素内容仍用 esc。
            `<div class="stl-achievement" title="${Utils.escapeAttr(a.description)}">${esc(a.icon)}「${esc(a.name)}」<em>+${esc(a.points)}分</em></div>`
        ).join('');
        const achHtml = achs ? `<div class="stl-achievements"><div class="stl-ach-title">🎉 解锁成就</div>${achs}</div>` : '';
        return `<div class="stl-rewards">${rows.join('')}</div>${achHtml}`;
    },
};

window.Settlement = Settlement;
