/** AI剧本网 - 海龟汤工具面板 HUD（TurtleSoupHud）
 * ------------------------------------------------------------------
 *  剧本体验期间填充到底部工具面板（ToolPanel）的海龟汤专属内容：
 *   - 汤面模块：展示当前剧本的汤面（Markdown 渲染 + 颜色语法）；
 *   - 线索/道具模块（原胜利/失败条件面板改造）：展示玩家当前已获得的
 *     线索与道具（来源：任务条件完成效果 / 主持人 NPC 指令修改），
 *     数据由 GameInventory 管理。
 *
 *  布局：宽屏（宽>高，orientation: landscape）两个模块并排；
 *        竖屏（portrait）两个模块纵向排列；内容过多时模块内滚动。
 *
 *  刷新：线索/道具变化（inventory-updated）时 ToolPanel 调 refresh() 只更新该模块
 *       （保留汤面滚动位置）。
 */
const TurtleSoupHud = {
    /** 渲染整个 HUD（ToolPanel 调用） */
    render(container) {
        const script = (window.Experience && Experience.currentScript && Experience.currentScript()) || {};
        container.innerHTML = `
        <div class="hud-root">
            <div class="hud-module hud-story">
                <div class="hud-module-title">🍜 汤面</div>
                <div class="hud-module-body">${Md.render(script.story || '（无汤面）')}</div>
            </div>
            <div class="hud-module hud-inv">
                <div class="hud-module-title">🎒 线索 / 道具</div>
                <div class="hud-module-body" id="hudInvBody">${this._invHtml()}</div>
            </div>
        </div>`;
    },

    /** 只刷新线索/道具模块（面板内容变化时） */
    refresh() {
        const body = document.getElementById('hudInvBody');
        if (body) body.innerHTML = this._invHtml();
    },

    /** 复位到默认态 —— 由 Experience.end() 调用（收场/结算/切剧本都会经过它）。
     *  为什么需要它：ToolPanel 是靠 experience-ended 事件重渲染的，而 game.js 里这个事件
     *  是在 `_isActive = false` **之前**发出的，重渲染那一刻 Experience.isActive() 还是 true，
     *  于是它把上一局的汤面/线索又画了一遍，收场后 HUD 就赖在面板上，非得刷新页面才消失。
     *  这里不猜时机、也不看 isActive：直接把面板内容落回「不在体验中」的默认文案。
     *  幂等：面板没建过、内容不是本 HUD、重复调用，都直接安全返回。 */
    resetForExperienceEnd() {
        // 面板 DOM 与默认文案的归属者是 ToolPanel（它建的节点，文案也只该它写一份），
        // 所以把「落回默认态」交回去做，避免两处抄同一段 HTML 日后漂移。
        if (window.ToolPanel && ToolPanel.resetForExperienceEnd) {
            ToolPanel.resetForExperienceEnd();
            return;
        }
        // ToolPanel 不可用时的兜底：把可能残留的 HUD 节点摘掉
        const body = document.getElementById('toolPanelBody');
        if (body && body.querySelector('.hud-root')) body.innerHTML = '';
    },

    /* ========== 内部 ========== */

    /** 线索/道具区 HTML：两小节分开展示，带来源标注与空态文案 */
    _invHtml() {
        const st = (window.GameInventory && GameInventory.isActive && GameInventory.isActive())
            ? GameInventory.getState() : { clues: [], items: [] };
        const sec = (icon, title, list, emptyText) => `
            <div class="hud-inv-sec">
                <div class="hud-inv-sec-title">${icon} ${title}</div>
                ${list.length ? `<ul class="hud-cond-list">${list.map(c => `
                    <li class="met">
                        <span class="hud-cond-name">${Md.render(c.text)}</span>
                        ${c.source ? `<span class="hud-cond-progress">${Utils.escapeHtml(c.source)}</span>` : ''}
                    </li>`).join('')}</ul>`
                : `<p class="hud-empty">${emptyText}</p>`}
            </div>`;
        return sec('🔎', '线索', st.clues, '暂无线索，继续向主持人提问吧……')
             + sec('🎁', '道具', st.items, '暂无道具');
    },
};

// 注册到底部工具面板的 HUD 注册中心（海龟汤类型）
if (window.ToolPanel) ToolPanel.registerHud('hai-gui-tang', TurtleSoupHud);

window.TurtleSoupHud = TurtleSoupHud;
