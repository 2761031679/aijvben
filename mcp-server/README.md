# aijuben-mcp — AI剧本网（jvben.cn）的 MCP 插件

把 AI剧本网 的接口包成一组 MCP 工具，让**任意**支持 MCP 的 AI 客户端（Claude Desktop、Cursor、DSH……）
既能当**海龟汤主持人**（开房 → 取主持上下文 → 心跳 → 结算 → 收场），也能替玩家办日常事（找剧本、看人设、查自己的数据）。

## 边界（有意为之，别当成缺陷）

- **只走 HTTP**：不 `import backend`、不打开 SQLite、不读站点任何内部模块。站点改实现，这里不用动。
- **不含任何 LLM 配置**：没有 provider / API Key / 模型名。模型是客户端自己的事，本插件只负责"给站点说话"。
- **不写站点文件**：整个包只在自己的目录里生成文件，唯一的外部写入是宿主目录下的 `~/.aijuben/`。
- **主持证由插件保管**：`host_token` 绝不回显给模型（它会进对话历史），只在本地状态文件里存着。

## 目录结构

```
mcp-server/
├── pyproject.toml              # 包定义：aijuben-mcp / mcp>=1.2 + httpx>=0.27 / 入口 aijuben-mcp
├── contract.schema.json        # 站点 context 契约副本（与 server/docs/contract.schema.json 字节一致）
├── README.md
├── selftest.py                 # 端到端自检（59 项断言，不依赖任何 MCP 客户端）
├── examples/                   # 四种客户端接法
│   ├── claude_desktop_config.json
│   ├── cursor_mcp.json
│   └── dsh_mcp.json
└── aijuben_mcp/
    ├── __init__.py             # __version__
    ├── server.py               # create_server / --doctor / 传输层 / MCP SDK 1.x↔2.x 兼容
    ├── api_client.py           # httpx 异步客户端 + 错误归一化(AijubenError) + 给 AI 的处置提示
    ├── auth.py                 # 凭证解析：AIJUBEN_TOKEN / ~/.aijuben/token / mcp_ 门票 / JWT
    └── tools/
        ├── __init__.py         # 单例客户端、tool_guard、JSON 输出、列表瘦身
        ├── catalog.py          # 6 个只读工具（剧本 / NPC / 标签）
        ├── session.py          # 7 个主持工具 + 本地会话状态
        └── player.py           # 4 个玩家数据工具
```

## 安装

```bash
cd mcp-server
python -m pip install -e .          # 或：python -m pip install --user -e .
# 只装依赖、不装包也行：
python -m pip install --user "mcp>=1.2" "httpx>=0.27"
```

Python ≥ 3.10。**MCP SDK 1.x 与 2.x 都支持**：2.x 把 `FastMCP` 改名成 `MCPServer`，
`server.py` 里先试 `mcp.server.mcpserver.MCPServer`，失败再回落 `mcp.server.fastmcp.FastMCP`，
`--doctor` 会打印实际用的是哪一代。

## 凭证

两种都支持，**`mcp_` 前缀优先**：

| 凭证 | 从哪来 | 适合 |
|---|---|---|
| MCP 门票 `mcp_...` | 站点签到页/接口签发（`POST /api/user/mcp-tokens {name, scopes[]}`） | 长期挂在客户端里，可撤可限额 |
| 用户账号 JWT | `POST /api/auth/login {username,password}` → 响应里的 **`token`** 字段 | 临时联调、自己开自己的房 |

优先级：`--token` 参数 > `~/.aijuben/token` 里的 `mcp_` 门票 > 环境变量 `AIJUBEN_TOKEN` > `~/.aijuben/token`。
站点地址用 `--base-url` 或 `AIJUBEN_BASE_URL`（默认 `https://jvben.cn`）。

两个 HTTP 头分工固定，不要混：

- **用户凭证** → `Authorization: Bearer <token>`
- **主持证** → `X-Host-Token: <host_token>`（后端会把"含点或长度<40"的 Authorization 值当主持证候选丢掉，
  `mcp_` 门票正好是"不含点 + 43 字符"，所以绝不能塞进 Authorization 冒充主持证）

插件自己保管的东西（`AIJUBEN_STATE_DIR` 可改目录，默认 `~/.aijuben/`）：

- `current_session.json` —— 当前这场主持会话（`session_id`、`host_token`、相位、上次 `prompt_hash`）。权限 0600。

## 运行

```bash
# 1) stdio（Claude Desktop / Cursor / DSH 都走这个）
aijuben-mcp                       # 等价 python -m aijuben_mcp.server
aijuben-mcp --base-url http://127.0.0.1:8092 --token "$AIJUBEN_TOKEN"

# 2) 本机 HTTP（多客户端共享一个进程）
aijuben-mcp --transport streamable-http --host 127.0.0.1 --port 8765 --path /mcp
#    客户端连 http://127.0.0.1:8765/mcp

# 3) 体检：环境/凭证/站点/本地会话一次看清（不启动 MCP）
aijuben-mcp --doctor
```

`--doctor` 会打印：插件版本、Python、MCP SDK 版本、用的是 1.x 还是 2.x 工厂、站点地址、凭证种类（打码）、
`GET /api/host/status` 是否通、本地是否残留会话。全通退出码 0。

日志一律走 **stderr**（stdio 模式下 stdout 是协议通道，写一个字节都会毁掉连接）。

## 工具清单（17 个）

### 只读：剧本 / NPC / 标签（6）

| 工具 | 什么时候用 | 什么时候别用 |
|---|---|---|
| `list_scripts` | 用户说"有什么剧本/推荐几本/海龟汤有哪些"；先浏览一圈再决定读哪本；按分类·标签·热度筛 | 有明确关键词找内容 → `search_scripts`；已知 id 读正文 → `get_script` |
| `get_script` | 已经知道 `script_id`，要读剧本正文、题面、结局、任务、汤底、主持手册 | 只想看列表 → `list_scripts`；没有 id 只有关键词 → 先 `search_scripts` |
| `search_scripts` | 用户给的是**关键词/主题**（"校园""复仇"），要按相关度或热度排序挑几本 | 要翻页穷举目录 → `list_scripts`；已知 id → `get_script` |
| `list_npcs` | 要挑主持人设（语气/立绘/可用动作），或不知道 `npc_id` 该填什么 | 已经知道 `npc_id` 只想看细节 → `get_npc` |
| `get_npc` | 已知 `npc_id`，要看它的性格、人设、可用情绪/动作 | 还没挑过 → 先 `list_npcs` |
| `list_tags` | 用户想按标签找，但不确定标签叫什么；要补全标签名 | 已知标签且要结果 → `list_scripts(tag=...)` / `search_scripts(tags=...)` |

**汤底不是永远能拿到**：`get_script` 里的 `explanation`（汤底）和 `host_guide`（主持手册）按站点权限下发，
返回里的 `is_full` 告诉你有没有拿到。`is_full=false` 就别硬编汤底，告诉用户需要登录/订阅，或直接开房主持。

### 主持一场海龟汤（7）

| 工具 | 干什么 | 关键约束 |
|---|---|---|
| `start_session` | 开一场：`script_id` + 可选 `npc_id` → 拿 `session_id`、相位 `hosting`、到期时间 | 主持证由插件保管，**不回显**；本地已有未结束的会话时返回 `session_already_open`（一把证只能管一场） |
| `get_context` | **最重要**：取系统提示词 `system_prompt` + `prompt_hash` + `capabilities` + 本场快照 | `state` 三选一：`experience`（正在主持，默认）/`browsing`（没开会只想看人设）/`default`；同一相位重复取 `prompt_hash` 不变，变了就是状态变了 |
| `heartbeat` | 续命并同步相位、`last_words_left` | 空闲 300 秒会被判超时（之后只能 `reason="timeout"` 收场） |
| `begin_settling` | 进入结算相位 | 幂等；已结束的场返回 409 |
| `mark_narrated` | 声明"结局已经念完" | 必须先 `begin_settling`，否则 409 |
| `end_session` | 收场：`reason` = `settled` / `aborted` / `timeout` | 语义见下表，选错了证的去向就不一样 |
| `session_status` | 看这场还活着没、相位、距离超时多久、本地记的是哪一场 | 本地没有会话时退化成"站点通不通"的体检 |

### 玩家数据（4）

| 工具 | 干什么 |
|---|---|
| `my_profile` | 账号资料（用户名、角色、剧本数、评论数、设置） |
| `my_stats` | 站内数据：金币、等级、经验、通关数、被赞数、成就列表 |
| `my_scripts` | 我上传/投稿的剧本 |
| `my_subscriptions` | 我订阅的剧本 |

这 4 个没有凭证会稳定返回 `401 no_actor`，别用游客身份重试。

## 主持一轮的推荐序列

```
1. list_scripts / search_scripts            挑剧本
2. get_script(script_id)                    读题面；is_full=true 才看得到汤底
3. list_npcs → start_session(script_id, npc_id)
4. get_context(state="experience")          ← 拿到 system_prompt，整段喂给模型自己（本插件不调模型）
5. 玩家每说一句：按 system_prompt 演主持人
6. 每隔一阵 heartbeat()                     续命 + 看 last_words_left
7. 玩家猜中了：begin_settling() → 念结局 → mark_narrated() → end_session(reason="settled")
   玩家不玩了：end_session(reason="aborted")
   长时间没动静：end_session(reason="timeout")（要求空闲 ≥300 秒）
```

**收场三种 reason 的后果（已按后端代码核对，不是猜的）**

| reason | 相位要求 | 主持证 | 之后还能取上下文吗 |
|---|---|---|---|
| `settled` | 必须已是 `settling` 且 `narrated=true`，否则 409 | 不作废，但相位变 `ended` | **不能**：`state="experience"` 一律 403 `capability_denied` |
| `aborted` | 任意 | 立刻 `revoked_at` | 不能，`GET /api/host/status` 直接 410 `host_token_expired` |
| `timeout` | 空闲 ≥300 秒，否则 409 `session_not_idle` | 不立刻作废 | **能，且只有一次**：遗言轮，用掉后再取 403/410 |

## 错误与提示

所有工具都返回 JSON 文本（不会因为后端报错就抛一个空异常让客户端只显示 "tool failed"）：

```json
{ "ok": false,
  "error": { "status": 403, "code": "capability_denied",
             "message": "这一场已经结束，主持上下文不再下发",
             "hint": "先 start_session 重开一场；只想聊人设用 state=\"browsing\"。" } }
```

`hint` 是**手写给模型看的处置建议**，会随 `code` 变化。常见码：

| status | code | 意思 / 怎么办 |
|---|---|---|
| 0 | `network_error` | 连不上站点：看 `--base-url`、看网络；不要反复重试 |
| 0 | `no_local_session` | 本地没有会话：先 `start_session`；只想看人设用 `get_context(state="browsing")` |
| 0 | `session_already_open` | 本地已有未结束的场：先 `session_status`，再 `end_session` |
| 400 | `contract_mismatch` | 传的 `contract` 版本与站点不符：本插件是 `aijuben.context/1.3`，一般别传 |
| 401 | `no_actor` | 没凭证或凭证失效：配 `AIJUBEN_TOKEN`，门票过期就重签 |
| 403 | `capability_denied` | 这场已结束 / 证不属于这场：别刷，按 hint 重开 |
| 404 | `script_not_found` / `session_not_found` | id 错了，或剧本未过审（未过审只有作者和管理员看得见） |
| 409 | `session_phase_conflict` / `session_not_idle` | 相位跳步 / 还没到超时：按 hint 走完前一步 |
| 410 | `host_token_expired` | 主持证作废（aborted、或遗言轮已用）：必须重新 `start_session` |
| 423 | `script_not_approved` | 剧本没过审，不能拿来开房 |
| 429 | `rate_limited` / `quota_exhausted` | 站点限流（每 IP 30 请求/10 秒）或当天开房次数用完：等，别循环重试 |

## 自检（selftest）

```bash
cd mcp-server
# 需要站点在跑（本地或线上都行）
AIJUBEN_TEST_USER=你的账号 AIJUBEN_TEST_PASS=你的密码 \
  python selftest.py --base-url http://127.0.0.1:8092

# 也可以直接给一张凭证（不碰账号密码）
AIJUBEN_TOKEN=mcp_xxx python selftest.py --base-url http://127.0.0.1:8092

# 门票通道另外验一遍（后端 /api/user/mcp-tokens 没上线时自动跳过，不算失败）
AIJUBEN_TEST_USER=... AIJUBEN_TEST_PASS=... \
  python selftest.py --base-url http://127.0.0.1:8092 --with-ticket
```

7 段：凭证 → 工具装配（数量/描述字数/参数 schema/默认值）→ 只读 → 主持主链（开房到收场）→
负面路径（跳步 409、坏 contract 400、无凭证 401、aborted 后 410）→ 门票通道 → 收尾（把开过的场全部 aborted 掉）。

两条实践提醒：

- 自检**自己会改环境**：`AIJUBEN_STATE_DIR` 默认指向临时目录，不污染你 `~/.aijuben/` 的真实会话。
- 站点按 IP 限流（30 请求/10 秒）。自检会带一个随机的 `X-Real-IP`（TEST-NET-3 段）把自己和别的联调隔开，
  否则同一台机器上同时跑自检、别人联调、真人浏览器会互相挤成 429，满屏假失败。
- 中途失败也会尽力收尾，但如果你看到 `session_already_open`，说明上一次没收干净：
  `AIJUBEN_TOKEN=... aijuben-mcp --doctor` 看本地残留，或直接删 `~/.aijuben/current_session.json`。

## 客户端接法

三个 `examples/` 文件可直接抄：`claude_desktop_config.json`、`cursor_mcp.json`、`dsh_mcp.json`。

- **Claude Desktop** → `%APPDATA%\Claude\claude_desktop_config.json`（macOS：`~/Library/Application Support/Claude/`），
  在 `mcpServers` 里加一段，重启客户端。
- **Cursor** → `~/.cursor/mcp.json`（项目里放 `.cursor/mcp.json` 也行）。
- **DSH / 自研**：任何能执行命令 + 说 stdio 的 MCP 客户端都能挂，把 `command` 换成解释器路径、`args` 换成
  `["-m", "aijuben_mcp.server"]`，`env` 里给 `AIJUBEN_TOKEN`、`AIJUBEN_BASE_URL`。

装好之后第一句可以试：`列出最新的海龟汤剧本`、`用惊云娘开一场主持`。

## 与后端代码/契约的出入（以代码为准）

跑通过程里发现的差异，按代码改的，记在这里免得下一个人再踩：

1. **登录返回的字段是 `token`，不是 `access_token`**（`POST /api/auth/login` → `{"token": ..., "user": {...}}`）。
2. **"我的剧本"是 `GET /api/scripts/mine/list`**，不是 `/api/scripts/mine`（后者不存在）；返回裸数组。
3. **契约 §9.2 表里列了 `POST /api/host/session/turn`，但后端没有这个端点**（`backend/routers/host.py` 里没有任何 turn 路由）。
   所以本插件不提供"提交一轮"工具——一轮就是模型自己按 `system_prompt` 生成，不需要站点介入。
4. **MCP SDK 2.x 把 `FastMCP` 改名成 `MCPServer`**（`mcp.server.fastmcp` 直接 ImportError）。插件做了一代兼容，
   `pyproject.toml` 因此写 `mcp>=1.2` 而不是钉死 2.x。
5. **NPC 列表没有专门的门面接口**，用的是 `GET /api/admin/npc-configs`（公开、无鉴权），
   它把 `npcs`（只有 id/立绘/名字）与 `configs`（性格、情绪、动作）两段分开返回，`list_npcs` 负责合成。
6. **汤底/主持手册按权限下发**，`get_script` 的 `is_full` 是唯一判据。
7. **主持证与用户凭证必须分头走**（见上文 `X-Host-Token` 一节）——混用会被后端静默丢弃，表现为莫名其妙的 401。
8. **收场语义不对称**：`aborted` 立刻作废证；`settled` 证挂着但上下文一律 403；`timeout` 只有一次遗言上下文。
   这条只有读 `backend/services/host_session_service.py` 才看得出来，契约文档里没写这么细。
9. **错误体两套形状并存**：host 端点 `{"detail":{"code","message"}}`，老端点 `{"detail":"中文人话"}`。
   `api_client._error_from_response` 两种都归一化成 `AijubenError`。
10. **限流是每 IP 30 请求/10 秒**（`RateLimitMiddleware`），不是按用户；一台机器上跑多个客户端会共用一个桶。

## 没做什么（有意留白）

- 没有"部署/运维"工具：本插件不碰仓库、不跑脚本、不改站点数据。
- 没有写操作（发评论、点赞、投稿、改资料）：本期只覆盖"找内容 + 主持一场 + 看自己的数据"。
- 没有内置模型调用：`get_context` 只把 `system_prompt` 交出去，谁生成谁负责。
- 没有多会话并发：一把主持证管一场，本地状态就一份（`current_session.json`）。
