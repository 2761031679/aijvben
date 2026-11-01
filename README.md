# AI剧本网

> 一个让 AI 当主持人、陪你玩剧本的网站。

## 这是什么

AI剧本网（jvben.cn）是一个在线剧本游戏平台。你把剧本丢进去，选一个 AI 主持人，就能开一场自己的游戏：AI 主持人负责开场、控场、判定你的提问、在你猜中时公布结局。

支持四类剧本：

- **海龟汤** —— 你提问，主持人只答「是 / 不是 / 是也不是 / 无关」，靠推理还原真相
- **DND（龙与地下城）** —— 骰子、职业、回合制的奇幻冒险
- **COC（克苏鲁的呼唤）** —— 理智值、调查员、恐怖氛围
- **剧本扮演** —— 多角色对手戏，AI 演 NPC

除了玩，网站还带一整套创作与社区设施：写剧本、投稿审核、标签分类、评论收藏、成就等级、金币与经验、举报与申诉、站内通知。

## 网站

**https://jvben.cn**

| 想做的事 | 去哪里 |
|---|---|
| 逛剧本库、找一个剧本玩 | 首页剧本卡片墙 |
| 写并投稿剧本 | 「上传剧本」 |
| 改自己的剧本 | 「我的剧本」 |
| 审核剧本、改站内设置 | 管理后台（管理员） |
| 看汤底、翻通关记录 | 剧本详情页 + 个人中心 |

## 技术构成

- 后端：Python + FastAPI + SQLAlchemy + SQLite；接四家模型（DeepSeek / MiniMax / 通义千问 / 火山引擎）
- 前端：原生 JavaScript，零构建，手写 CSS，打开即用
- AI 提示词是纯文本文件，放在 npc_configs/，改完即生效，不用重启
- 部署：nginx + uvicorn，systemd 托管

目录：

    backend/       FastAPI 后端（routers / services / models / core）
    frontend/      网页前端（js 模块 / css / 图片音频）
    npc_configs/   AI 主持人的提示词与人设（纯文本，可直接改）
    mcp-server/    MCP 插件，让别的 AI 来调用本站
    docs/          架构设计、接口契约、分阶段计划
    tools/         自检脚本、契约测试、授权清单生成器

## MCP 插件：让别的 AI 来主持

网站自带的 AI 主持人是在网页里说话的。如果你想让 **Claude Desktop / Cursor / 自己的 Agent** 来当主持人，用 mcp-server/ 这个插件。

它做三件事：读剧本、开一场主持、把主持人提示词整段交给外面那个模型。**插件自己不调模型**——说话的是你的客户端。

### 装

    cd mcp-server
    python -m pip install -e .

要求 Python 3.10+。

### 配置凭据

两种都行，任选其一：

| 方式 | 怎么拿 | 适合 |
|---|---|---|
| MCP 门票（推荐） | 登录网站后调 POST /api/user/mcp-tokens 签发，形如 mcp_xxxx | 长期用，可随时吊销 |
| 登录 JWT | POST /api/auth/login 返回的 token 字段 | 临时调试 |

优先级：命令行 --token > 环境变量 AIJUBEN_TOKEN > 用户目录下的凭据文件。

站点地址用 --base-url 或环境变量 AIJUBEN_BASE_URL 指定，默认 https://jvben.cn。

### 起

stdio 模式（客户端自己拉起来）：

    aijuben-mcp

HTTP 模式（多个客户端共用一个进程）：

    aijuben-mcp --transport streamable-http --host 127.0.0.1 --port 8765 --path /mcp

排查本地残留会话：

    aijuben-mcp --doctor

### 接到客户端

examples/ 里有三份可直接抄的配置：claude_desktop_config.json、cursor_mcp.json、dsh_mcp.json。核心就一段：

    {
      "mcpServers": {
        "aijuben": {
          "command": "python",
          "args": ["-m", "aijuben_mcp.server"],
          "env": {
            "AIJUBEN_TOKEN": "mcp_你的门票",
            "AIJUBEN_BASE_URL": "https://jvben.cn"
          }
        }
      }
    }

- **Claude Desktop** → %APPDATA%\Claude\claude_desktop_config.json（macOS 在 ~/Library/Application Support/Claude/）
- **Cursor** → ~/.cursor/mcp.json，或者项目里的 .cursor/mcp.json
- **其他客户端** → 只要能跑命令、说 stdio 就能挂，把 command 换成解释器路径即可

装好后第一句可以试：**列出最新的海龟汤剧本**、**用惊云娘开一场主持**。

### 能做什么

17 个工具，四组：

- **逛剧本**：list_scripts、search_scripts、get_script、list_tags、list_npcs、get_npc
- **开一场**：start_session、get_context、heartbeat、begin_settling、mark_narrated、end_session、session_status
- **我自己的**：my_profile、my_stats、my_scripts、my_subscriptions

一场主持的标准走法：

    1. list_scripts / search_scripts     挑剧本
    2. get_script(script_id)             读题面；通关过才有 is_full，才看得到汤底
    3. list_npcs → start_session         选主持人、开房
    4. get_context(state="experience")   拿到 system_prompt，整段喂给自己的模型
    5. 玩家每说一句，你按 system_prompt 演主持人
    6. 隔一阵 heartbeat()                续命，顺便看还剩几次提问
    7. 玩家猜中 → begin_settling → 念结局 → mark_narrated → end_session

三种收场：settled（正常通关）、aborted（玩家不玩了，主持证立刻作废）、timeout（闲置 300 秒以上，还能再要一次遗言）。

### 注意

- 站点按 IP 限流：每 10 秒 30 个请求
- 一场主持闲置超过 300 秒会被回收
- 游客开房有每日次数上限
- 插件**正在测试中**，接口与行为仍可能调整

## 许可

GPL-3.0，见 LICENSE。
