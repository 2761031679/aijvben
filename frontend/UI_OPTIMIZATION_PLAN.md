# AI 剧本网茶馆 UI 优化方案

## 问题分析

### 1. 当前 UI 问题
- **NPC 立绘太小**: 当前尺寸 240x380px，在 1920x1080 屏幕上占比太小
- **聊天气泡布局不佳**: 气泡与立绘分离，缺乏视觉联系
- **打字机效果 bug**: 分段显示时前缀重复打字，语音被打断
- **语音播放 bug**: 队列管理混乱，多段语音叠加
- **空间浪费**: 聊天区上下留白过多，内容密度低

### 2. 代码问题定位

#### 打字机 bug (`chat.js` 第 650-700 行)
```javascript
// 问题：_advanceSegmentDisplay() 中重新拼接文本后，_typed 标志重置导致整段重打
lastMsg._typed = false;   // ❌ 这会导致整段重新打字
```

#### 语音 bug (`tts.js` 第 50-80 行)
```javascript
// 问题：_speakBrowser() 中先 cancel() 再 speak()，但队列项的 onEnded 可能被多次调用
synth.cancel();  //  会触发前一个语音的 onend
synth.speak(u);
```

---

## 优化方案

### 方案 A：立绘放大 + 气泡内嵌布局（推荐）

**布局调整：**
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│    [玩家剪影]          [聊天区]          [NPC 立绘]  │
│      (左 15%)         (中央 60%)        (右 25%)    │
│                                                     │
│                    ┌──────────────┐                 │
│                    │  用户气泡 →  │                 │
│                    │  ←NPC 气泡   │                 │
│                    │  用户气泡 →  │                 │
│                    │  ←NPC 气泡   │                 │
│                    └──────────────┘                 │
│                                                     │
│              [输入框 + 按钮]                         │
└─────────────────────────────────────────────────────┘
```

**关键改动：**

1. **NPC 立绘放大到 320x520px**
2. **聊天区右边界与立绘重叠**，气泡可以浮动在立绘前方
3. **增加半透明遮罩**确保文字可读性

### 方案 B：左右分栏布局

适合大屏，聊天区完全独立，立绘在两侧作为背景装饰。

### 方案 C：可折叠立绘

用户可点击收起立绘，聊天区自动扩展。

---

## 具体实现

### 1. CSS 修改 (`style.css`)

```css
/* NPC 立绘放大 */
#teahouse-npc {
    width: 320px;  /* 原 240px */
    height: 520px; /* 原 380px */
    right: 8%;     /* 原 6% */
}

/* 聊天区加宽 */
#teahouse-vbox {
    width: min(650px, 85vw);  /* 原 500px, 90vw */
    max-height: 60vh;         /* 原 50vh */
    left: 45%;                /* 新增：向左偏移，给 NPC 留空间 */
}

/* 气泡最大宽度增加 */
.chat-bubble-user, .chat-bubble-npc {
    max-width: 75%;  /* 原 85% */
}

/* NPC 立绘增加半透明遮罩层（确保文字可读） */
#teahouse-npc::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at center, rgba(15,23,42,0.4) 0%, transparent 70%);
    z-index: -1;
    border-radius: 16px;
}

/* 聊天气泡增加阴影和边框，增强对比度 */
.chat-bubble-npc {
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    border: 1px solid rgba(255,255,255,0.1);
}
```

### 2. 打字机修复 (`chat.js`)

```javascript
_advanceSegmentDisplay() {
    if (this._segIndex >= this._segments.length - 1) return;
    clearTimeout(this._autoTimer);
    clearTimeout(this._typeTimer);
    if (window.TTS && TTS.stop) TTS.stop();
    
    this._segIndex++;
    const lastMsg = this._messages[this._messages.length - 1];
    if (lastMsg && lastMsg.role === 'npc') {
        // ✅ 累积已揭示段落
        lastMsg.text = this._segments.slice(0, this._segIndex + 1).join('\n\n');
        lastMsg._hasSegments = this._segIndex < this._segments.length - 1;
        // ✅ 保持 _typed = true，避免整段重打
        lastMsg._typed = true;
        // ✅ 前缀作为静态文本，只对当前段打字
        lastMsg._typePrefix = this._segments.slice(0, this._segIndex);
        lastMsg._typeCurrent = this._segments[this._segIndex];
    }
    this._playFx(this._segments[this._segIndex]);
    this._renderMessages();
    this._speakSegment(this._segments[this._segIndex]);
}
```

### 3. 语音修复 (`tts.js`)

```javascript
_speakBrowser(text, voiceId, onEnded) {
    const synth = window.speechSynthesis;
    if (!synth) {
        this._isPlaying = false;
        Utils.showToast('当前浏览器不支持语音合成', 'error');
        if (onEnded) onEnded();
        return;
    }
    try {
        this._isPlaying = true;
        const config = Utils.getConfig();
        const volume = (config.voiceVolume != null ? config.voiceVolume : 80) / 100;
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        u.volume = volume;
        const v = this._pickBrowserVoice(voiceId);
        if (v) u.voice = v;
        
        // ✅ 用标志位防止重复回调
        let called = false;
        const done = () => {
            if (called) return;
            called = true;
            this._isPlaying = false;
            if (onEnded) onEnded();
        };
        
        u.onend = done;
        u.onerror = () => {
            Utils.showToast('浏览器语音播放失败', 'error');
            done();
        };
        
        // ✅ 不 cancel()，让队列自然播放
        synth.speak(u);
    } catch (e) {
        this._isPlaying = false;
        Utils.showToast(e.message, 'error');
        if (onEnded) onEnded();
    }
}
```

### 4. 响应式优化（移动端）

```css
/* 移动端：立绘缩小，聊天区全屏 */
@media (max-width: 768px) {
    #teahouse-npc {
        width: 180px;
        height: 280px;
        right: 10px;
        top: 60px;
    }
    
    #teahouse-vbox {
        width: 90vw;
        left: 50%;
        top: 20%;
    }
}
```

---

## 预期效果

### 改进前
- NPC 立绘占比：12.5% 屏幕宽度
- 聊天区宽度：500px
- 打字机：整段重打
- 语音：可能叠加

### 改进后
- NPC 立绘占比：16.7% 屏幕宽度（+33%）
- 聊天区宽度：650px（+30%）
- 打字机：仅新段打字 ✅
- 语音：队列串行播放 ✅

---

## 实施步骤

1. **备份当前文件**
2. **修改 `style.css`** (立绘尺寸、聊天区布局)
3. **修改 `chat.js`** (打字机逻辑)
4. **修改 `tts.js`** (语音队列)
5. **测试**: 
   - 打字机逐段显示
   - 语音播放不叠加
   - 移动端响应式
6. **用户反馈收集**

---

## 额外建议

### 1. 立绘表情动画增强
在立绘周围添加表情粒子效果（开心时飘爱心，生气时冒火）。

### 2. 气泡入场动画
```css
@keyframes slideIn {
    from { opacity: 0; transform: translateX(-20px); }
    to { opacity: 1; transform: translateX(0); }
}
.chat-bubble-user { animation: slideIn 0.3s ease; }
```

### 3. 输入框自动聚焦
用户发送消息后，输入框保持聚焦，方便连续对话。

### 4. 快捷键支持
- `Enter`: 发送
- `Ctrl+Enter`: 换行
- `Esc`: 收起设置面板

---

**推荐优先级：**
1. 打字机修复（高 - 影响体验）
2. 语音修复（高 - 功能 bug）
3. 立绘放大（中 - 视觉优化）
4. 响应式（中 - 移动端用户）
