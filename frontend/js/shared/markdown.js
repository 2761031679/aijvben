/** AI剧本网 - 轻量 Markdown 渲染器（零依赖，XSS 安全）
 *
 *  设计：先对输入整体 HTML 转义，再按白名单语法转换为有限标签，
 *  任何原始 HTML/脚本都不可能注入（天然防 XSS）。
 *
 *  支持语法：
 *    **粗体**  *斜体*  `行内代码`
 *    # / ## / ### 标题（行首）
 *    - 无序列表（连续 "- " 行）
 *    > 引用（行首）
 *    {#rrggb}彩色文字{/}   ← 自定义颜色语法（3 或 6 位十六进制）
 *    换行 → <br>
 *
 *  用途：汤面/汤底/条件文本等作者侧 Markdown 内容的统一渲染
 *  （详情页、工具面板 HUD、上传帮助等）。
 */
const Md = {
    render(text) {
        if (!text) return '';
        let t = Utils.escapeHtml(String(text));

        // 行内代码：先抽离占位（控制字符包裹，避免与正文数字混淆），防止内部字符被其他规则误转换
        const codes = [];
        t = t.replace(/`([^`\n]+)`/g, (m, c) => {
            codes.push(c);
            return `${codes.length - 1}`;
        });

        // 标题（行首 # 后须有空格，避免与颜色语法 {# 混淆）
        t = t.replace(/^### (.+)$/gm, '<h4 class="md-h">$1</h4>');
        t = t.replace(/^## (.+)$/gm, '<h3 class="md-h">$1</h3>');
        t = t.replace(/^# (.+)$/gm, '<h3 class="md-h">$1</h3>');

        // 粗体 / 斜体
        t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

        // 自定义颜色：{#rrggb}文字{/}
        t = t.replace(/\{#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\}([\s\S]*?)\{\/\}/g,
            '<span style="color:#$1">$2</span>');

        // 引用（escapeHtml 已把 > 转为 &gt;）
        t = t.replace(/^&gt; (.+)$/gm, '<blockquote class="md-quote">$1</blockquote>');

        // 无序列表：连续 "- " 行合并为 <ul>
        t = t.replace(/(?:^|\n)((?:- [^\n]+\n?)+)/g, (m, block) => {
            const items = block.trim().split('\n')
                .map(l => `<li>${l.replace(/^- /, '')}</li>`).join('');
            return `\n<ul class="md-ul">${items}</ul>`;
        });

        // 换行
        t = t.replace(/\n/g, '<br>');

        // 还原行内代码（仅匹配占位符，不误伤正文数字）
        t = t.replace(/(\d+)/g, (m, i) => `<code class="md-code">${codes[+i]}</code>`);
        return t;
    },
};

window.Md = Md;
