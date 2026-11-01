/** AI剧本网 - 条件追踪引擎（ConditionTracker）
 * ------------------------------------------------------------------
 *  职责：海龟汤「胜利/失败条件」与「任务条件」两大条件系统的前端核心。
 *
 *  数据：剧本的 endings / tasks 条件表（后端 scripts.endings / scripts.tasks，JSON 字符串）：
 *    {"endings":[{"id","name","type":"win|lose","note",
 *      "conditions":[{"id","name","rule","threshold":1,"hidden":false}]}]}
 *    {"tasks":[{"id","name","note",
 *      "conditions":[{"id","name","rule","threshold":1,"hidden":false}],
 *      "effect":{"type":"reveal_clue|give_item|npc_message","payload":"..."}}]}
 *
 *  工作方式：
 *   - NPC 在回复中发送 [cond:结局ID.条件ID] / [task:任务ID.条件ID] 标记
 *     （一条回复可带多个不同标记，同一条件每条回复最多计 1 次）；系统从
 *     【最终展示给玩家的回复】中提取标记计数（审核驳回的重生成版、工具交换
 *     中间版、历史恢复版均不计数）。
 *   - 计数达到 threshold 该条件满足；隐藏条件在满足的同一时刻解除隐藏。
 *   - 结局：某结局的全部条件满足 → 系统自动结算（NPC 不参与）：
 *       · 胜利结局：Settlement.show() 标记通关、解锁汤底；
 *       · 失败结局：Settlement.showDefeat() 仅展示面板，不标记通关、不解锁汤底。
 *       · 胜利与失败同时满足时，胜利优先。
 *   - 任务：某任务的全部条件满足 → 任务完成，系统自动执行作者定义的效果：
 *       · reveal_clue：揭示一条线索到线索/道具面板（GameInventory.addClue）；
 *       · give_item：给予一件道具到线索/道具面板（GameInventory.addItem）；
 *       · npc_message：把效果内容作为系统消息发给 NPC（NpcBus.push）。
 *     任务完成一次性触发，不重复执行。
 *   - 计数按「账号 × 剧本」持久化到 localStorage（经 Store），刷新页面不丢进度；
 *     已结算过的剧本再次进入时计数清零，开启新一周目。
 *
 *  生命周期：Experience 进入体验时 activate()，退出体验时 deactivate()。
 */
const ConditionTracker = {
    _active: false,
    _scriptId: null,
    _endings: [],     // 解析后的结局定义数组
    _tasks: [],       // 解析后的任务定义数组
    _counts: {},      // "结局ID.条件ID" -> 已触发次数
    _taskCounts: {},  // "任务ID.条件ID" -> 已触发次数
    _tasksDone: {},   // 任务ID -> true（已完成，效果只执行一次）
    _settled: null,   // 已结算的结局 id（本场防重复结算）

    /** 进入体验：装载条件表 + 恢复持久化计数（已结算的记录清零重开） */
    activate(scriptId, endingsDef, tasksDef) {
        this._scriptId = scriptId;
        this._endings = Array.isArray(endingsDef) ? endingsDef : [];
        this._tasks = Array.isArray(tasksDef) ? tasksDef : [];
        this._counts = {};
        this._taskCounts = {};
        this._tasksDone = {};
        this._settled = null;
        const saved = this._scriptId ? Store.get('cond_' + this._scriptId, null) : null;
        if (saved && !saved.settled) {
            // 只恢复仍存在于条件表中的键（作者可能改过条件表）
            if (saved.counts) {
                for (const k of Object.keys(saved.counts)) {
                    if (this._find(k)) this._counts[k] = saved.counts[k];
                }
            }
            if (saved.taskCounts) {
                for (const k of Object.keys(saved.taskCounts)) {
                    if (this._findTask(k)) this._taskCounts[k] = saved.taskCounts[k];
                }
            }
            if (saved.tasksDone) {
                for (const k of Object.keys(saved.tasksDone)) {
                    if (this._tasks.some(t => t.id === k)) this._tasksDone[k] = true;
                }
            }
        }
        this._active = true;
        if (window.SystemTexts) SystemTexts.ensure();   // 预热系统文案（条件提示用）
        this._emitUpdate();
        console.log('[ConditionTracker] 激活', {
            scriptId, endings: this._endings.length, tasks: this._tasks.length,
            restored: Object.keys(this._counts).length + Object.keys(this._taskCounts).length,
        });
    },

    /** 退出体验 */
    deactivate() {
        this._active = false;
        this._scriptId = null;
        this._endings = [];
        this._tasks = [];
        this._counts = {};
        this._taskCounts = {};
        this._tasksDone = {};
        this._settled = null;
    },

    isActive() { return this._active; },

    /** 当前已揭示条件视图（供条件面板/HUD 使用；隐藏且未满足的条件不出现） */
    getRevealed() {
        return this._endings.map(e => ({
            id: e.id, name: e.name, type: e.type, note: e.note || '',
            conditions: (e.conditions || [])
                .filter(c => !c.hidden || this._isMet(e, c))
                .map(c => ({
                    id: c.id, name: c.name,
                    count: this._counts[`${e.id}.${c.id}`] || 0,
                    threshold: c.threshold || 1,
                    met: this._isMet(e, c),
                })),
        }));
    },

    /** 处理 NPC 最终展示回复：提取 [cond:] / [task:] 标记并计数，返回清理后的文本。
     *  由 NpcChat 在「审核通过之后、展示之前」调用，保证只有最终展示版计数。 */
    processReply(text) {
        if (!this._active || !text) return text;
        const condMarks = [];
        const taskMarks = [];
        // 容错正则：兼容全角冒号/句点、标记内多余空格（AI 输出不稳定时的常见变体）
        const cleaned = text
            .replace(/\[\s*cond\s*[:：]\s*([^\].．\s:：\]]+?)\s*[.．]\s*([^\]\s]+?)\s*\]/gi, (m, eid, cid) => {
                condMarks.push(`${eid}.${cid}`);
                return '';
            })
            .replace(/\[\s*task\s*[:：]\s*([^\].．\s:：\]]+?)\s*[.．]\s*([^\]\s]+?)\s*\]/gi, (m, tid, cid) => {
                taskMarks.push(`${tid}.${cid}`);
                return '';
            })
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        // 测试信息：文本里疑似有条件标记却一个都没解析出来（格式错误被静默吞掉的排查入口）
        if (!condMarks.length && !taskMarks.length && /\[\s*(cond|task)\s*[:：]/i.test(text)) {
            console.warn('[ConditionTracker] 疑似条件/任务标记但解析失败（检查标记格式）:',
                text.match(/\[[^\]]*(cond|task)[^\]]*\]/gi));
        }
        // 同一条件每条回复最多计 1 次。
        // 条件标记的含义是「玩家这一问踩中了某个要素」，所以它必须挂在一次**肯定回答**上。
        // AI 有时会自作主张单独吐一个 [cond:...]（比如顺口把「尸体是丧尸咬的」写成备注），
        // 以前照单全收，结果玩家什么都没问到就被判通关。
        //
        // 口径（与审计对齐，之前这里是「整条回复里出现过一次 yes 就全放行」——那是错的）：
        //   · 整条回复只有一个 [answer:]  → 它管辖所有标记（最常见：标记统一写末尾）
        //   · 有多个 [answer:]              → 每个标记归属它前面最近的那个，那条是 yes/both 才算数
        // 这样「问 A 答 yes、问 B 答 no、B 的条件也 +1」不再可能；而 AI 把标记换行写在
        // 回答下面（"…？[answer:yes]\n[cond:e1.c1]"）也照常成立。
        // 注：此处早于 NpcMarkers.convertAnswers，所以标记还在原文里，能直接判。
        const allowedCond = this._gateByAnswer(text, condMarks, 'cond');
        if (allowedCond.length) this._applyMarks(allowedCond);
        const allowedTask = this._gateByAnswer(text, taskMarks, 'task');
        if (allowedTask.length) this._applyTaskMarks(allowedTask);
        return cleaned;
    },

    /** 把 [cond:]/[task:] 标记按「前面最近的那个 [answer:]」分组，只放行肯定回答下的那些。
     *  kind 是 'cond' 或 'task'；返回放行的去重键数组。 */
    _gateByAnswer(text, marks, kind) {
        const uniq = [...new Set(marks)];
        if (!uniq.length) return [];
        const ANSWER = /\[\s*answer\s*[:：]\s*([^\]\s]+)\s*\]/gi;
        const MARK = new RegExp('\\[\\s*' + kind + '\\s*[:：]\\s*([^\\].．\\s:：\\]]+?)\\s*[.．]\\s*([^\\]\\s]+?)\\s*\\]', 'gi');
        // 所有回答标记的位置与取值
        const answers = [];
        let m;
        ANSWER.lastIndex = 0;
        while ((m = ANSWER.exec(text)) !== null) {
            answers.push({ at: m.index, value: (m[1] || '').toLowerCase() });
        }
        if (!answers.length) {
            console.warn('[ConditionTracker] ' + kind + ' 标记没有对应的回答，已忽略:', uniq);
            return [];
        }
        const pass = [];
        const deny = [];
        MARK.lastIndex = 0;
        while ((m = MARK.exec(text)) !== null) {
            const key = `${m[1]}.${m[2]}`;
            // 取它前面最近的一个回答；前面没有就退回后面最近的那个（AI 偶发把回答写在后头）
            let owner = null;
            for (const a of answers) { if (a.at <= m.index) owner = a; else break; }
            if (!owner) {
                for (const a of answers) { if (a.at > m.index) { owner = a; break; } }
            }
            // 只有一个回答标记时，它管辖这一整条回复里的全部标记 ——
            // 这是实际输出最常见的形态（AI 习惯把标记统一写在末尾），
            // 按位置归属会把它自己写出来的正确标记全判掉。
            // 出现多个回答标记（玩家一条消息问了好几件事）时，才按「前面最近的那个」归属：
            // 那种情况 AI 必须把标记写在对应回答后面，否则无法判断归属，宁可漏计不可错计。
            const single = answers.length === 1 ? answers[0].value : null;
            const value = single !== null ? single : (owner ? owner.value : '');
            const ok = value === 'yes' || value === 'both';
            if (ok) pass.push(key); else deny.push(key);
        }
        if (deny.length) {
            console.warn('[ConditionTracker] ' + kind + ' 标记没有对应的肯定回答，已忽略:', deny);
        }
        // 只放行同时被判为肯定、且在去重集合里的那些
        return uniq.filter(k => pass.includes(k));
    },

    /** 仅剥离 [cond:]/[task:] 功能标记，不计数（供审核驳回后的重写版使用——
     *  原回复已在展示前计数，重写版只是纠正内容，不应重复计数）。 */
    stripMarks(text) {
        return (text || '')
            .replace(/\[\s*cond\s*[:：]\s*[^\]]+\]/gi, '')
            .replace(/\[\s*task\s*[:：]\s*[^\]]+\]/gi, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    },

    /* ========== 结局条件 ========== */

    _find(key) {
        const dot = key.indexOf('.');
        if (dot < 0) return null;
        const eid = key.slice(0, dot), cid = key.slice(dot + 1);
        const ending = this._endings.find(e => e.id === eid);
        if (!ending) return null;
        const cond = (ending.conditions || []).find(c => c.id === cid);
        return cond ? { ending, cond } : null;
    },

    _isMet(ending, cond) {
        return (this._counts[`${ending.id}.${cond.id}`] || 0) >= (cond.threshold || 1);
    },

    _applyMarks(keys) {
        if (this._settled) return;   // 已结算：后续标记全部忽略
        const invalid = [];
        const newlyMet = [];
        for (const key of keys) {
            const found = this._find(key);
            if (!found) { invalid.push(key); continue; }
            const { ending, cond } = found;
            const threshold = cond.threshold || 1;
            const prev = this._counts[key] || 0;
            if (prev >= threshold) continue;          // 已满足的条件不再重复计
            const cur = Math.min(prev + 1, threshold);
            this._counts[key] = cur;
            if (cur >= threshold) newlyMet.push({ ending, cond });
        }

        // 非法标记：经系统通道告知 NPC 纠正（非立即触发，避免循环；文案见 system_texts.txt）
        if (invalid.length && window.NpcBus) {
            NpcBus.push(SystemTexts.t('conditions.invalid_cond',
                { marks: invalid.map(k => `[cond:${k}]`).join('、') }));
        }
        // 新达成条件：揭示给玩家 + 告知 NPC
        for (const { ending, cond } of newlyMet) {
            NpcChat.addMessage('system', `[info:🔎 条件已达成：${cond.name}]`);
            // 系统气泡可能随回复重渲染被忽略，补一个短 toast 保证达成反馈可见。
            if (window.Utils) Utils.showToast(`🔎 条件已达成：${cond.name}`, 'info');
            if (window.NpcBus) {
                NpcBus.push(SystemTexts.t('conditions.cond_met',
                    { cond: cond.name, ending: ending.name, threshold: cond.threshold || 1 }));
            }
        }
        this._persist();
        this._emitUpdate();
        this._checkEndings();
    },

    /** 结局判定：全部条件满足即结算；胜利优先于失败 */
    _checkEndings() {
        if (this._settled) return;
        const isMet = (e) => (e.conditions || []).length > 0 &&
            e.conditions.every(c => this._isMet(e, c));
        const win = this._endings.find(e => e.type === 'win' && isMet(e));
        const ending = win || this._endings.find(e => e.type === 'lose' && isMet(e));
        if (!ending) return;
        this._settled = ending.id;
        this._persist();
        this._emitUpdate();
        this._settle(ending);
    },

    /** 系统自动结算。结算顺序（v4.6 定稿）：
     *  ① 结算面板（数据优先：胜利先标记通关再展示，玩家看到面板前数据已落库）
     *  ② 状态变更：experience → 进入体验前的状态（HUD 收起、提示词重组）
     *  ③ NpcBus 通知 NPC 用结局备注解说（immediate，一轮主动发言） */
    async _settle(ending) {
        const isWin = ending.type === 'win';
        const scriptId = this._scriptId;   // 先取：Experience.end() 会清空本模块状态
        // 记下这是「第几场」。结算流程中间要等 NPC 把结局讲完（最长 60 秒），
        // 这段时间玩家完全可能点了「再来一次」开新的一场；那次等待一结束，
        // 这里如果照着往下走，就会把**新的一场**当成旧的一场收掉（新场刚开就被拆）。
        // 所以每个 await 之后对一次序号，不是自己那一场就立刻停手。
        const seq0 = (window.Experience && Experience.sessionSeq) ? Experience.sessionSeq() : 0;
        const stillMine = () => !window.Experience || !Experience.sessionSeq
            || Experience.sessionSeq() === seq0;
        console.log('[ConditionTracker] 结算', { ending: ending.id, type: ending.type });

        // ⓪ 先声明「进入结算相位」。服务端自此只等一件事：把结局讲完。
        //    没有这一步，后面「讲完 → 收场」那条路在服务端根本走不通（审计 S1）。
        if (window.Experience && Experience.beginSettling) {
            try { await Experience.beginSettling(); } catch (e) { /* 已记日志 */ }
        }

        // ① 结算面板（失败不标记通关、不解锁汤底）
        if (window.Settlement) {
            if (isWin) await Settlement.show(scriptId, { endingId: ending.id, endingName: ending.name, note: ending.note || '' });
            else await Settlement.showDefeat(scriptId, ending.name, ending.note || '');
        }
        if (window.Events) Events.emit('script-settled', { scriptId, ending });
        // 玩家在面板弹出期间就点了「再来一次」：这一场的收尾到此为止，别碰新的一场。
        if (!stillMine()) {
            console.log('[ConditionTracker] 结算期间已开新的一场，本次收尾中止');
            return;
        }
        // ② 系统消息告知 AI 并触发 NPC 解说（必须在【体验态内】进行：NPC 仍持有剧本内容与结局备注，
        //    才能正确解说；若在退出体验态后才解说，提示词已重组为 default，NPC 失去剧本上下文，
        //    表现为"结算后无回应，需重问一遍"——即本次修复的时序 bug）
        let narrated = false;
        if (window.NpcBus && window.NpcChat) {
            // 关键：结算几乎总是由「这一轮里出现的条件标记」触发的 —— 也就是说此刻
            // NPC 正在出字。以前这里判断 `_isLoading` 就直接跳过了解说，紧接着撤掉剧本
            // 上下文，于是它正在讲的那段真相被从中间掐断（「电话响了——」戛然而止）。
            // 现在改成「等它这一轮讲完，再让它讲结局」。
            await this._waitChatIdle(60000);
            if (!stillMine()) {
                console.log('[ConditionTracker] 等解说期间已开新的一场，跳过解说与收场');
                return;
            }
            NpcBus.push(SystemTexts.t('conditions.settle', {
                result: isWin ? '胜利' : '失败',
                ending: ending.name,
                note: ending.note ? `结局备注：${ending.note}。` : '',
            }));
            try {
                await NpcChat.systemTurn();
                narrated = true;
            } catch (e) {
                console.warn('[ConditionTracker] 结算解说失败', e);
            }
        }
        // 第三道守卫（必须有）：解说可能要讲几十秒，而结算面板此刻已经在屏上、
        // 上面就摆着「再来一次」。玩家点它是正常操作不是作弊 —— 一旦他点了，
        // 下面两个动作会打到**新开的那一场**身上：
        //   ① markNarrated 读的是「调用时」的 _hostSession（已经是新场的证），
        //      给新场盖 narrated=true ⇒ 服务端「先解说后收场」那道闸对新局永久失效；
        //   ② Experience.end('settled') 会把刚开的新场按 settled 收掉 ⇒ 新局秒退。
        if (!stillMine()) {
            console.log('[ConditionTracker] 解说期间已开新的一场，不再收旧场（新场保持原样）');
            return;
        }
        // 解说讲完了才允许以 settled 收场；没讲成（报错/超时）就按中止收，
        // 让服务端如实知道这一场没走完正常流程。
        if (narrated && window.Experience && Experience.markNarrated) {
            try { await Experience.markNarrated(); } catch (e) { /* 已记日志 */ }
        }
        // ③ 状态变更：退出体验态（含 ConditionTracker/Inventory 停用、提示词重组）
        if (window.Experience && Experience.end) Experience.end(narrated ? 'settled' : 'settlement');
    },

    /** 等 NPC 当前这一轮出字结束。结算常常在出字途中被触发，必须等它讲完再让它讲结局。 */
    async _waitChatIdle(maxMs) {
        if (!window.NpcChat) return;
        const limit = maxMs || 60000;
        const t0 = Date.now();
        while (NpcChat._isLoading && Date.now() - t0 < limit) {
            await new Promise(r => setTimeout(r, 200));
        }
        if (NpcChat._isLoading) {
            console.warn('[ConditionTracker] 等 NPC 出字超时（%dms），仍继续结算', limit);
        }
    },

    /* ========== 任务条件 ========== */

    _findTask(key) {
        const dot = key.indexOf('.');
        if (dot < 0) return null;
        const tid = key.slice(0, dot), cid = key.slice(dot + 1);
        const task = this._tasks.find(t => t.id === tid);
        if (!task) return null;
        const cond = (task.conditions || []).find(c => c.id === cid);
        return cond ? { task, cond } : null;
    },

    _isTaskCondMet(task, cond) {
        return (this._taskCounts[`${task.id}.${cond.id}`] || 0) >= (cond.threshold || 1);
    },

    _applyTaskMarks(keys) {
        if (this._settled) return;   // 已结算：后续标记全部忽略
        const invalid = [];
        const newlyMet = [];
        for (const key of keys) {
            const found = this._findTask(key);
            if (!found) { invalid.push(key); continue; }
            const { task, cond } = found;
            if (this._tasksDone[task.id]) continue;   // 任务已完成：不再计数
            const threshold = cond.threshold || 1;
            const prev = this._taskCounts[key] || 0;
            if (prev >= threshold) continue;
            const cur = Math.min(prev + 1, threshold);
            this._taskCounts[key] = cur;
            if (cur >= threshold) newlyMet.push({ task, cond });
        }

        if (invalid.length && window.NpcBus) {
            NpcBus.push(SystemTexts.t('conditions.invalid_task',
                { marks: invalid.map(k => `[task:${k}]`).join('、') }));
        }
        for (const { task, cond } of newlyMet) {
            NpcChat.addMessage('system', `[info:📋 任务进度：${task.name} —— ${cond.name} 已达成]`);
            if (window.NpcBus) {
                NpcBus.push(SystemTexts.t('conditions.task_progress', { task: task.name, cond: cond.name }));
            }
        }
        this._persist();
        this._emitUpdate();
        this._checkTasks();
    },

    /** 任务判定：全部条件满足 → 任务完成，执行作者定义的效果（一次性） */
    _checkTasks() {
        for (const task of this._tasks) {
            if (this._tasksDone[task.id]) continue;
            const conds = task.conditions || [];
            if (!conds.length || !conds.every(c => this._isTaskCondMet(task, c))) continue;
            this._tasksDone[task.id] = true;
            this._persist();
            this._completeTask(task);
        }
        this._emitUpdate();
    },

    /** 任务完成：执行效果（揭示线索 / 给予道具 / 给 NPC 发消息）+ 通知玩家与 NPC */
    _completeTask(task) {
        const effect = task.effect || {};
        const payload = (effect.payload || '').trim();
        console.log('[ConditionTracker] 任务完成', { task: task.id, effect: effect.type });
        let effectDesc = '';
        if (effect.type === 'reveal_clue') {
            if (window.GameInventory) GameInventory.addClue(payload, `任务《${task.name}》`);
            effectDesc = `🔎 获得线索：${payload}`;
        } else if (effect.type === 'give_item') {
            if (window.GameInventory) GameInventory.addItem(payload, `任务《${task.name}》`);
            effectDesc = `🎁 获得道具：${payload}`;
        } else if (effect.type === 'npc_message') {
            if (window.NpcBus && payload) NpcBus.push(SystemTexts.t('conditions.task_npc_message', { task: task.name, payload }));
            effectDesc = '📨 主持人收到了新的信息';
        }
        NpcChat.addMessage('system', `[info:✅ 任务完成：${task.name}${effectDesc ? ' ｜ ' + effectDesc : ''}]`);
        if (window.NpcBus) {
            NpcBus.push(SystemTexts.t('conditions.task_done', {
                task: task.name,
                note: task.note ? `任务备注：${task.note}。` : '',
            }));
        }
        if (window.Events) Events.emit('task-completed', { scriptId: this._scriptId, task });
    },

    /* ========== 持久化 ========== */

    _persist() {
        if (!this._scriptId) return;
        Store.set('cond_' + this._scriptId, {
            counts: this._counts,
            taskCounts: this._taskCounts,
            tasksDone: this._tasksDone,
            settled: this._settled,
        });
        // 同步到云端（debounce 合并，登录用户生效）
        if (window.GameDataSync) GameDataSync.scheduleUpload();
    },

    _emitUpdate() {
        if (window.Events) Events.emit('conditions-updated', { scriptId: this._scriptId });
    },
};

window.ConditionTracker = ConditionTracker;
