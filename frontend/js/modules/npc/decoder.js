/** AI剧本网 - NPC 回复解码器（NpcDecoder）
 * ------------------------------------------------------------------
 *  职责：把「含功能标记的 AI 原始回复」解码为结构化结果（单一入口，纯函数，无副作用）。
 *  - 解决历史遗留的「解码逻辑分散三处（markers/segments/conditions）」问题：
 *    新增标记只需在本模块注册一处，杜绝类似 [answer:] 漏转的 bug。
 *  - 副作用（动画/表情/引导高亮）以返回值形式提取（extractFx），由渲染层决定是否触发，
 *    避免历史恢复/重渲染时重复触发。
 *  - cond/task 标记仅提取不计数；计数由 ConditionTracker.processReply 显式单次执行。
 *
 *  解码结果字段（decode 返回）：
 *  - raw         : 原始回复（未改动）
 *  - converted   : [answer:] 已转文字的文本（仍含其他功能标记）
 *  - plainText   : 纯文本（去所有标记、折叠空白；用于判空/朗读）
 *  - typingText  : 打字机纯文本（保留换行结构，供逐字显示）
 *  - html        : 展示 HTML（无副作用）
 *  - fx          : { emotions[], actions[], guides[] } 副作用标记
 *  - segments    : { parts[], commands{} } 分段结果
 */
const NpcDecoder = {
    /** 海龟汤回答标记 → 展示文字。对应关系固定：yes=是 / no=否 / both=是也不是 / irrelevant=不重要 / unable=无法回答 */
    ANSWER_TEXT: {
        yes: '是',
        no: '否',
        both: '是也不是',
        irrelevant: '不重要',
        unable: '无法回答',
    },

    /** 表情关键词 → 表情 id（中英文均可；与 animation.js / ui.js 的映射保持一致） */
    EMOTION_KW: {
        '开心': 'happy', '高兴': 'happy', '快乐': 'happy', '微笑': 'happy', '笑': 'happy',
        '大笑': 'laugh', '哈哈': 'laugh', '偷笑': 'laugh',
        '媚眼': 'wink', '眨眼': 'wink', 'wink': 'wink',
        '思考': 'thinking', '想': 'thinking', '歪头': 'thinking', '皱眉': 'thinking',
        '惊讶': 'surprised', '吃惊': 'surprised', '震惊': 'surprised', '瞳孔地震': 'surprised',
        '难过': 'sad', '伤心': 'sad', '悲伤': 'sad', '哭': 'sad', '担忧': 'sad',
        '悲痛': 'grief', '悲痛欲绝': 'grief',
        '怒': 'angry', '生气': 'angry', '火大': 'angry', '暴怒': 'angry', '愤怒': 'angry',
        '闭眼': 'closeeye', '闭目': 'closeeye',
        '神秘': 'mysterious', '诡异': 'mysterious',
    },

    emotionId(raw) {
        const k = (raw || '').trim().toLowerCase();
        return this.EMOTION_KW[k] || k || 'default';
    },

    /** 把海龟汤回答标记转成对应文字（[answer:yes] → 是）；未知/空标记剥除（不展示）。 */
    convertAnswers(text) {
        return (text || '').replace(/\[answer:([^\]]+)\]/gi, (_, k) => {
            const key = (k || '').trim().toLowerCase();
            return this.ANSWER_TEXT[key] || '';
        });
    },

    /** 彩色特效文字：[color:#RRGGBB]文字[/color] → <span style="color:...">（颜色值白名单清洗防注入） */
    _colorize(s) {
        return (s || '').replace(/\[color:([^\]]*)\]([\s\S]*?)\[\/color\]/g,
            (_, c, content) => `<span style="color:${c.replace(/[^a-zA-Z0-9#]/g, '')}">${content}</span>`);
    },

    /** 提取副作用标记（不触发），供渲染层决定是否触发动画/表情/引导高亮。 */
    extractFx(text) {
        const t = text || '';
        return {
            emotions: (t.match(/\[emotion:([^\]]+)\]/g) || []).map(x => x.slice(9, -1)),
            actions: (t.match(/\[action:([^\]]+)\]/g) || []).map(x => x.slice(8, -1)),
            guides: (t.match(/\[guide:([^\]]+)\]/g) || []).map(x => x.slice(7, -1).trim()),
        };
    },

    /** 生成展示 HTML（纯，无副作用）。与历史 markers.process 的 HTML 生成规则一致。 */
    toHtml(text, msg, npcId) {
        // 先整体转义，杜绝 AI 注入原始 HTML；后续标记生成的 HTML 为受控安全内容
        let t = Utils.escapeHtml(text || '');
        t = t.replace(/\[emotion:([^\]]+)\]/g, '');
        t = t.replace(/\[action:([^\]]+)\]/g, '');
        t = t.replace(/\[guide:([^\]]+)\]/g, '');
        t = t.replace(/[\[<]tool:([^\]>]+)[\]>]/g, (_, toolCall) => {
            const toolName = toolCall.split(':')[0];
            const toolArgs = toolCall.substring(toolName.length + 1);
            // 工具参数进 title 属性：文本此前只经过 escapeHtml（不转引号），
            // 参数里一个 " 就能闭合 title 再接事件处理器，所以属性位一律 escapeAttr。
            return `<span class="tool-indicator" title="${Utils.escapeAttr(toolArgs)}">🔧 ${toolName}</span>`;
        });
        t = t.replace(/\[options:([^\]]+)\]/g, (_, raw) => {
            const opts = raw.split('|').map(o => o.trim()).filter(Boolean);
            const selected = msg && msg._selectedOption;
            return `<div class="npc-options">${opts.map((o) => {
                // 冒号分隔「标题:备注」（备注可选）：[options:标题1:备注1|标题2:备注2]
                const ci = o.indexOf(':');
                const title = ci >= 0 ? o.slice(0, ci).trim() : o.trim();
                const note = ci >= 0 ? o.slice(ci + 1).trim() : '';
                // 纯文本标题（去掉彩色标记）作为选项值，点击后原样发送给 NPC
                const plainTitle = title.replace(/\[color:[^\]]*\]/g, '').replace(/\[\/color\]/g, '');
                const isSel = selected === plainTitle;
                const titleHtml = this._colorize(title);
                const noteSpan = note ? `<span class="option-note">${this._colorize(note)}</span>` : '';
                return `<button class="option-btn${isSel ? ' option-selected' : ''}" data-option="${Utils.escapeAttr(plainTitle)}"${selected ? ' disabled' : ''}>
                    <span class="option-title">${isSel ? '✔ ' : ''}${titleHtml}</span>${noteSpan}
                </button>`;
            }).join('')}</div>`;
        });
        t = t.replace(/\[btn:([^:\]]+):([a-zA-Z_]+)(?::([^\]]*))?\]/g, (_, label, act, arg) => {
            // 原来只手工把 " 换成 &quot;：属性里换个单引号包裹就绕过了，而且这是「属性转义」
            // 不是「补一个引号」，统一交给 escapeAttr（act 已被正则限成字母下划线）。
            return `<button class="npc-action-btn" data-npc-act="${act}" data-npc-arg="${Utils.escapeAttr(arg || '')}">${label}</button>`;
        });
        t = this._colorize(t);   // 彩色特效文字
        t = t.replace(/\s*\[SEGMENT\]\s*/gi, '\n');   // 历史含多段：按行展示
        t = t.replace(/\[pause:\d+\]/g, '');
        t = t.replace(/\[do:[^\]]*\]/g, '');   // 分段延迟指令不展示
        t = t.replace(/\[cond:[^\]]*\]/gi, '');  // 条件/任务计数标记不展示
        t = t.replace(/\[task:[^\]]*\]/gi, '');
        t = t.replace(/\[sys:[^\]]*\]/g, '');  // 系统通道标记不展示
        // 折叠多余空行：AI 常在 [SEGMENT] 周围或段内插入空行，保证每段仅一行、段间无空行
        const t2 = t.replace(/[ \t]+\n/g, '\n');
        return t2.replace(/\n{2,}/g, '\n');
    },

    /** 打字纯文本：与 toHtml 的换行/转义处理一致（块级元素在打字阶段剥除）。 */
    toTypingText(text) {
        let t = Utils.escapeHtml(text || '');
        t = t
            .replace(/\[emotion:[^\]]*\]/g, '')
            .replace(/\[action:[^\]]*\]/g, '')
            .replace(/\[guide:[^\]]*\]/g, '')
            .replace(/[\[<]tool:[^\]>]*[\]>]/g, '')
            .replace(/\[do:[^\]]*\]/g, '')
            .replace(/\[cond:[^\]]*\]/gi, '')
            .replace(/\[task:[^\]]*\]/gi, '')
            .replace(/\[options:[^\]]*\]/g, '')
            .replace(/\[btn:[^\]]*\]/g, '')
            .replace(/\[color:([^\]]*)\](.*?)\[\/color\]/g, '$2')
            .replace(/\s*\[SEGMENT\]\s*/gi, '\n')
            .replace(/\[pause:\d+\]/g, '')
            .replace(/\[sys:[^\]]*\]/g, '');
        return t.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
    },

    /** 纯文本：去所有功能标记、折叠空白（等价 _stripForTTS，用于判空/朗读）。 */
    toPlainText(text) {
        return (text || '').replace(/\[[^\]]*\]/g, '').replace(/\n+/g, ' ').trim();
    },

    /** 分段：按 [do:] / [SEGMENT] / 换行 切分，并提取 [do:] 延迟指令（绑定到「下一段展示前」执行）。 */
    split(reply) {
        const parts = [];
        const commands = {};
        let buf = '';
        const flush = () => {
            const t = buf.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
            if (t) parts.push(t);
            buf = '';
        };
        const re = /\[do:([^\]]+)\]|\[SEGMENT\]|\n+/gi;
        let last = 0, m;
        const src = reply || '';
        while ((m = re.exec(src)) !== null) {
            buf += src.slice(last, m.index);
            last = m.index + m[0].length;
            if (m[1] != null) {          // [do:...]：段边界 + 指令绑定到「下一段展示前」
                flush();
                const cmd = (m[1] || '').trim();
                if (cmd) (commands[parts.length] = commands[parts.length] || []).push(cmd);
            } else {                     // [SEGMENT] 或空行：普通段边界
                flush();
            }
        }
        buf += src.slice(last);
        flush();
        return { parts, commands };
    },

    /** 统一解码入口：先转 answer，再产出各结构（纯函数，可重复调用，幂等）。 */
    decode(raw, opts = {}) {
        const converted = this.convertAnswers(raw);
        return {
            raw: raw || '',
            converted,
            plainText: this.toPlainText(converted),
            typingText: this.toTypingText(converted),
            html: this.toHtml(converted, opts.msg, opts.npcId),
            fx: this.extractFx(converted),
            segments: this.split(converted),
        };
    },
};

window.NpcDecoder = NpcDecoder;
