# P1 改点标记

> 只标「改哪里、为什么改、改的时候会踩到什么」。
> 不含实现代码。按你要求：先标记，不动代码。

---

## 0. 先说一个和 P1 无关、但比 P1 紧急的事

**未登录的任何人都能拿到本站「免费海龟汤 AI」的接口密钥。**

### 证据

不登录、不带任何 token，直接请求：

```
GET https://jvben.cn/api/admin/site-settings
→ 200，返回 14 个站点设置键
→ free_ai_config 里同时有 api_key_masked 和 api_key（明文，35 位，sk-991…）
```

### 为什么这是漏洞，而不是设计如此

这个项目自己的代码里写着相反的意图：

- `backend/services/site_service.py:121` —— `def get_free_ai_secret(db)` 的 docstring：
  > 「供后端免费调用内部读取：返回含明文密钥的完整配置（**不对外暴露**）」
- `backend/services/site_service.py:97` —— 专门生成了 `api_key_masked`（`key[:4] + "****" + key[-4:]`），
  就是为了让前端能显示「已保存：sk-9****abcd」而**不需要**真密钥。
- `frontend/js/modules/admin/panel.js:604` —— 前端读的确实是 `api_key_masked`，**全前端没有任何一处读 `api_key`**。

也就是说：掩码机制做对了，只是有一个出口把原始行整个吐了出去。

### 漏在哪（一处）

`backend/services/site_service.py:53-62`

```python
def get_site_settings(db: Session) -> dict:
    """获取站点设置（公开）"""
    rows = db.query(SiteSettings).all()
    result = {}
    for r in rows:
        result[r.key] = r.value      # ← 原样吐出每一行，包括 free_ai_config.api_key
```

调用方 `backend/routers/admin.py:114-115`：

```python
@router.get("/site-settings")
def get_all_settings(db: Session = Depends(get_db)):   # ← 没有任何身份依赖
```

`/api/admin/site-settings` 没有鉴权是**故意的**：前端启动时要读它拿 BGM、轮播图、
可见分类（`frontend/js/app.js:411`、`frontend/js/modules/bgm.js:27`）。
坏的不是「公开」，是「公开了什么」—— 一个公开的聚合接口，不该原样透传每一行。

### 改点

| 位置 | 改什么 |
|---|---|
| `backend/services/site_service.py:53-62` | 返回前，对 `free_ai_config` 剔除 `api_key`（只留 `api_key_masked`） |
| `backend/services/site_service.py:87-98` 附近 | 顺手让 `get_free_ai_config()` 也不再带明文（它被 `/api/admin/free-ai-config` 用，虽然要站长权限，但明文没必要下发到浏览器） |

### 风险

低。前端从不读 `api_key`，剔除后 `/api/admin/site-settings` 的形状只少一个字段。
唯一要确认的是站长后台「免费 AI 配置」表单仍能显示掩码、仍能保存新密钥
（保存走的是 `PUT /api/admin/free-ai-config`，读的是 `api_key_masked`，都不受影响）。

### 需要你定

**要不要现在就单独修这一处并上线**（改动约 3 行，走 SSH 传文件 + 重启服务，白天 1 分钟内）。
或者按你原来的节奏，跟 P1 一起走。

---

## 1. 阻塞 A：后端没有任何「逐路由的身份声明」

### 现状（我数出来的）

146 个端点，按现在写死的身份依赖分：

| 身份级 | 数量 | 写法 |
|---|---|---|
| 用户（必须登录） | 53 | `Depends(get_current_user)` |
| 可选登录 | 13 | `Depends(get_optional_user)` |
| 管理员 | 24 | `Depends(require_admin)` |
| 站长 | 15 | `Depends(require_owner)` |
| 管理员或站主 | 13 | `Depends(require_admin_or_station_master)` |
| 完全无身份依赖 | 28 | — |

那 28 个里，**21 个本来就该公开**（登录/注册/发码/游客令牌/公告/剧本列表与搜索/标签/
统计公开页/成就列表/stt/tts 供应商列表）。剩下 **7 个需要逐个判断该不该公开**：

- `GET /api/admin/site-settings`（就是第 0 节那个）
- `GET /api/admin/npc-configs`（返回 NPC 定义、情绪/动作效果池 —— 注释说「公开，初始化时前端拉取」，大概是对的）
- `GET /api/game/mode-prompt`（返回体验引导 + 模式提示词模板，不含剧本内容，大概是对的）
- `GET /api/npc/prompts`（读 `npc_prompts` 表 —— 见第 3 节，这张表是死的）
- `GET /api/review/flagged-pool`、`GET /api/review/{id}/report-votes`、`GET /api/review/{id}/community-votes`（审核池数据公开？需要你定）

### 为什么这算阻塞

P1 要做的三件事里有两件都得回答「**这个端点归谁**」：

1. **会话结构落库** —— 会话属于哪个账号，由「谁在调这个端点」决定
2. **堵 §10.1 那批越权接口** —— 必须逐个说明每个端点是访客/用户/管理员/站长/主持证

而现在这个信息**只存在于 146 个函数签名的字符串里**，没有任何一处可以集中查看、
没有任何一处可以集中修改。也就是说：

> 今天要堵一个越权，只能改函数签名；明天要加一个「主持证」级别，
> 得把 146 个签名全过一遍，而且改漏了没有任何东西会报错。

这正是你担心的那种「改一处、坏一片、还不知道坏在哪」。

### 三条出路

| 方案 | 做法 | 代价 |
|---|---|---|
| A1 只补一张表 | 新建 `endpoint_manifest`（路由 → 身份级），代码里的签名先不动 | 表会与签名两张皮，迟早对不上，反而制造新的不一致 |
| A2 只改代码 | 把 146 个端点全部换成统一的身份声明依赖 | 一次性大改，风险集中在一天里，且没法灰度 |
| **A3 表 + 生成器（推荐）** | 身份级写在一张表里，由**生成器**校验「代码里的签名」与「表里的声明」一致，不一致就报错 | 需要先写一个几十行的校验脚本；之后每次改动都会被它拦 |

A3 的关键不是那张表，是**那个校验器**：它把「签名」和「声明」绑死，
以后谁改了签名忘了改表，测试就红。这是我建议选它的唯一理由。

---

## 2. 阻塞 B：改完没法验证，也没法确认宿主现在是什么状态

### B-1 部署链是断的（三份脚本，没有一份能在现在的线上跑通）

| 文件 | 问题 |
|---|---|
| `deploy.sh` | 用相对路径 `venv/bin/python`（线上是 `/opt/turtlesoup/venv`，从别处执行就找不到）；不装依赖；`service turtlesoup` 名字对不上（实际 unit 是 `turtlesoup.service`）；`StandardOutput=append:.../logs/stdout.log` 与线上实际不符（线上日志走 journald，`logs/` 里只有 `backup.log`） |
| `update.sh` | `git pull` —— 线上**根本没有 git 仓库**（实测 `fatal: not a git repository`）；`scp` 没带 `-i` 私钥 |
| `deploy_to_server.bat` | 走 Windows 的 `scp`，同样没带 `-i` |

结论：**现在没有任何一条「从本地改完 → 线上生效」的可靠路径**。每次改动都得手工上传 +
手工重启，而且没法确认「线上跑的到底是哪个版本」。

### B-2 没有任何「宿主反馈」通道

P1 要落库的会话结构里，`host`（主持人 AI）是外部进程。它出了问题，后端收不到任何东西：

- 客户端**没有 service worker**（全前端 0 处命中 `navigator.serviceWorker`）
- SQLite 单文件 + 2 个 uvicorn worker，没有进程内广播（一个 worker 收不到另一个的事件）
- 全仓库没有 WebSocket
- 因此：**网页端能问的每个问题，都是一次十几秒的 HTTP 请求**，宿主那边在干什么后端完全看不见

### B-3 线上代码比本地多，版本不明

`journalctl` 里在报 `is_alive "/health"`，但本地 `backend/main.py` **没有 `/health` 端点**
→ 线上跑着一批本地没有的文件（P0 阶段比对出的 21 个「只在线上有」的文件，
包括整个 `npc_configs/alex/`、`backend/prompts/alex_p1~p3_*`）。

### 三条出路

| 方案 | 做法 | 代价 |
|---|---|---|
| B1 只修部署脚本 | 三份合成一份，用绝对路径 + `-i` 私钥 + 正确 unit 名 | 只解决「上线」，不解决「验证」和「宿主看不见」 |
| B2 修部署 + 加一个 `/health` 与版本号端点 | 顺带让线上能自报版本 | 仍无实时通道 |
| **B3 B2 + 一个只读状态端点（推荐）** | `/api/host/status` 返回「谁持有主持证、哪个剧本、相位、心跳时间」，宿主每 N 秒上报一次 | 要新增一张表和一条上报路径 —— **但这正是 P1「会话结构落库」要做的事，顺手就做了** |

B3 不是额外工作量：P1 本来就要落库会话结构，把「心跳」也算进去，代价接近 0。

---

## 3. 顺带标记的四处（不阻塞 P1，但会骗人）

### 3-1 `npc_prompts` 是一张死表
线上 28 行 = 4 个 NPC × 7 种提示词，正好是旧的「按 NPC 存提示词」模型的遗迹。
`backend/main.py` 的 lifespan 注释写明：

> 「提示词以文件系统为唯一可信源，不再做 DB→文件覆盖式同步」

但现在还有人读它：`GET /api/npc/prompts`（`backend/routers/npc.py`，无鉴权）、
`admin.py:127` 的 `list_npc_prompts`、`npc_config.py:PUT save_npc_prompt`。
**这些接口能成功返回/写入，但改了完全不生效** —— 这是最容易让人白忙一天的坑。

改点：要么删表删接口，要么在读的地方加一句「此表已废弃，请改文件」。
建议后者（先不删，免得前端某处 500）。

### 3-2 主持人口令接口「始终返回完整内容」—— 已核实：不是漏洞，是设计

> **更正**：本条我一开始写成了「匿名访客能拿到未过审剧本全文」，核实代码后**这是错的**，
> 原文撤回，保留更正说明，免得你按错的信息去处理。

`backend/routers/npc.py:145` 那个给 NPC 取剧本的接口，确实用了「可选登录」+「返回完整内容」，
但它**有审核过滤**（`backend/services/npc_service.py:202`）：

```python
if script.review_status != REVIEW_APPROVED and not is_owner_or_admin:
    return None
```

未过审的剧本，除了作者本人和管理员，谁都拿不到 —— 匿名访客更拿不到。

「返回完整内容」也是作者明确写下的设计，`npc_service.py:172` 的注释说得很清楚：
主持人 AI 必须掌握汤底才能推进游戏，**汤底防的是「玩家直接查看」，不是防主持人**。

真正还留着的隐患是另一个（而且你已经表态先不管）：**汤底保密完全靠提示词**
—— 主持人手里有汤底原文，会不会漏，只由提示词约束。这就是之前 Q5 说的那件事。

### 3-3 模糊搜索（已进文档 A10，这里只标位置）
`backend/services/npc_service.py:178-230`。现在是把整张 scripts 表拉进内存做
`in` / `like` 匹配，然后按相似度排序。

### 3-4 alex 整套残留
线上有 `npc_configs/alex/`（整个目录）+ `backend/prompts/alex_p1~p3_soul/tools.txt` +
`alex_memory.txt`；本地没有。线上真正在用的是 deepseek / dagou / xiaomei / xiaoshuai 四个
（外加 review 这个审核用 NPC）。删除前先确认 `NPC_DEFINITIONS` 里没有它。

---

## 4. 顺序与工作量

| 步 | 内容 | 为什么在这个位置 |
|---|---|---|
| 0 | 修密钥泄露（3 行） | 正在漏，且直接烧钱 |
| 1 | 部署脚本收成一份 + 线上自报版本 | 没有它，后面每一步都没法验证 |
| 2 | 端点清单 + 校验器（阻塞 A 的 A3） | P1 的前置 |
| 3 | 会话结构落库 + 主持证 + 心跳（顺手解决阻塞 B 的 B3） | P1 主体 |
| 4 | 用主持证堵 §10.1 那批越权 | P1 收口 |
| 5 | 第 3 节的四处 | 可以穿插，不阻塞 |

第 0、1 步加起来约半天。第 2 步约一天。第 3、4 步是大头。

---

## 5. 需要你拍板的三件事

1. **密钥泄露**：现在单独修上线，还是等 P1 一起？（我倾向现在修 —— 它在掏钱）
2. **身份级的存放方式**：接受方案 A3（表 + 校验器）吗？还是你更想要 A1/A2？
3. **那 7 个「无身份依赖」的端点**，哪些该保留公开？特别是
   `/api/review/flagged-pool`、`report-votes`、`community-votes` 这三个审核池接口。

---

## 6. 已拍板（2026-10-28）

| 事项 | 决定 |
|---|---|
| 密钥泄露 | **等 P1 一起修**。理由：站还没发布，暂时没人会特意来偷。 |
| 身份级的存放方式 | 采用方案 A3：一张表 + 一个校验器，签名与声明不一致就报错。 |
| alex 残留 | 确认无引用，删除。 |
| 7 个「无身份依赖」端点 | **全部归入游客权限**（任何人都能查阅），改完之后要逐个说明是哪 7 个。 |

### 已执行（本次）

1. **本地 npc_configs 拉回，与线上对齐**（44 个文件，逐字节一致）。
   起因：本地那三份 `config.json` 是残缺版（`methods` 全空、缺 `dazed` 等），
   线上那份才是站长在后台配好的真配置。**再次确认：npc_configs 的真相在服务器，
   本地覆盖会冲掉所有 NPC 的表情/动作配置。**
2. **alex 删除**：线上 `npc_configs/alex/`、`backend/prompts/`（7 个 alex 文件）已删，
   备份在 `/opt/turtlesoup/_deleted_backup/`；本地代码里删掉无引用的 `NPC_ID_COMPAT`
   和 `seed/npc_prompts.py` 里 6 条 alex 人格提示词。
3. **部署脚本收成一份** `server/deploy.sh`，替代原来三份跑不通的脚本。
4. **新增 `/api/version`**，线上能自报「当前是几点几分推的、推了哪些文件」。
   这解决了「线上没有 git，改完不知道跑的是哪一版」。
5. **免费 AI 密钥不再随公开设置下发**。`site_service.SECRET_FIELDS` 在聚合返回前剔除
   `free_ai_config.api_key`；`api_key_masked` 照旧保留给后台显示。线上实测两个入口都干净了。
   **注意：已经泄出去的那把 key 仍然是暴露过的**，建议站长到 DeepSeek 后台重置一次。
6. **新增身份清单 + 校验器**（方案 A3 落地）：`docs/authz-manifest.json`（155 条，含 level、
   代码依赖、是否需要主持证、为什么这么定）+ `tools/authz/{extract,make_manifest,check}.py`。
   校验器带 7 条反例自测（新增端点未声明 / public 被偷偷加登录要求 / admin 被降级 /
   幽灵条目 / level 非法 / 主持证校验被删 / 原样清单应通过），全部会红。
   **已挂进 `deploy.sh`：校验不过不许推。**
7. **顺手补掉一个会 500 的坑**：`init_db()` 原来是手写清单补列，模型加字段在老库上完全不生效
   （本地开发库实测缺 10 列，任一接口一查就 `no such column: scripts.synopsis` → 500）。
   改成按模型声明自动补齐，现在本地库漂移为 0。**线上旧库哪天要加字段，这是前提。**
8. **会话骨架落地**（P1 第 3 步）：新表 `host_sessions` + `/api/host/*` 五个端点
   （开房 / 快照 / 心跳 / 结束 / 状态）+ 主持证（不透明串，库里只存 sha256，4 小时封顶、
   可撤销）+ 安静超时 300 秒 + 遗言证（超时不撤销，降级成只许用一次）+ 并发锁落库。
   **这一层刻意不碰提示词、不解析标记、不调 AI**——混在一起改，出问题说不清是谁坏的。
   验证：HTTP 12 项行为逐个点过（含 401/403/409/410 的分界），引擎回归 17 项
   （`tools/host/test_session_engine.py`，覆盖超时降级、遗言轮只一次、4 小时封顶、
   settled 必须先 narrated、并发锁）。**尚未接入现有前端**，前端仍走老链路。
9. **§10.1 越权收口**（P1 第 4 步）：把「谁能看见汤底」从「接口默认为真」改成「按身份当场算」。
   - `GET /api/npc/scripts/{id}`：公开字段（标题/封面/分类/难度/标签/简介/谜面/游玩数/评分）
     人人可读；**汤底全套只给四种人**——该作者、管理员/站长、**持有这一场的有效主持证**、
     或者登录了且在该剧本还有一场没结束的会话。其余一律剥成公开字段 + `full_locked: true`。
     按标题模糊搜照旧能搜到（这是要保的联想度），但同样只回公开字段。
   - `GET /api/scripts/{id}`：未过审的稿子非作者 404（原来只判 `is_deleted`）。
   - `POST/GET /api/game/{id}/start|ask`：未过审 423（作者与管理员/站长可以试玩自己的稿子）。
   - `POST /api/game/{id}/hint`：**原来是把汤底原句直接吐出来**（游客还完全不计数）。
     改成只回通用盘问方向（5 档），游客同样计数，落 `guest_counters`（按 IP 哈希，不能反查人）。
   - 回归：`tools/host/test_leak_gates.py`（16 项）+ HTTP 8 项实跑，已挂进 `deploy.sh`。
   - **代价：线上前端现在拿不到汤底了**——NPC 主持必然哑火，直到 P2 把前端接上主持证。
     这是这次改动唯一一处「先破后立」，P1 全部做完、P2 接完才能再上线。
10. **废弃提示词表的三个接口**（P1 收尾）：`npc_prompts` 表只剩历史数据（线上 28 行 = 4 NPC × 7 种），
   提示词的可信源是 `npc_configs/` 下的文件。以前 `POST /api/admin/npc-prompts` 会返回
   「提示词已保存」，但 NPC 一个字都不会变——这是最容易让人白忙一天的坑。
   - `GET /api/admin/npc-prompts`：保留（兼容脚本核对历史），返回加 `deprecated: true`
     + `effective_source: "files"` + 一句指向文件接口的说明。
   - `POST` / `DELETE`：固定 **410**，把调用方指到
     `PUT /api/admin/npc-configs/{npc_id}/prompts/{prompt_type}`。
   - 前端**从未**调用过这三个接口（`grep npc-prompts frontend/js/` 为空），所以改成 410 没有回归面。
   - 顺带纠正自己一处**错报**：早先我以为 `backend/routers/npc.py` 有个 `/api/npc/guide`
     用 `include_full=True` 把未过审全文下发。**该端点根本不存在**（全后端 `grep '/guide'` 无路由命中），
     是当时看岔了。已核实：`_attach_ai`（`include_full=True`）只被 `user_reviews`（本人/管理员）
     和 `review_pending`（管理员/站长）调用，`script_service` 里三处 `include_full=True`
     分别属于「创建自己的稿」「更新自己的稿」「我的作品列表」，都只回自己的东西。**这条不用改。**

## P1 到此为完整的 5 步

密钥 → 部署脚本/版本自报 → 身份清单+校验器 → 会话引擎 → 越权收口 → 废弃接口收尾。

**上线时机**：必须等 P2 把前端接上主持证。现在推上去，网页端的 NPC 主持会哑火。

---

# 审计角色复审后的修复（P1 收尾第二轮）

独立审计角色对「P1 第 3–4 步 + 收尾」做了对抗式复核，交了 6 条必改、7 条建议，
并主动撤回了 11 条自己核实后不成立的。它对闸口本身的结论是「逐条验过，是好的」，
但指出闸口**外面**还有三条独立通道。已全部处理，逐条对应如下。

| 审计编号 | 它指出的问题 | 处理 |
|---|---|---|
| **M3** | 「订阅 → 自己声明通关 → 揭晓答案」四步拿汤底。`/complete` 纯声明式，`can_view_full_script` 读的又是客户端可写的 `play_data` | **已修**。判据改读 `Completion` 表（只有服务端 `on_script_completed` 会写），而那个入口现在要求「本人此刻正在这一场里」。自报通关不再算数 |
| **M2** | 未过审门禁只挂在 `start/ask/hint` 三个端点，`/complete` 与 `/reveal` 漏了 | **已修**。两处都补上 `_require_playable` |
| **M4** | `GET /api/scripts?review_status=draft` 能列出所有人的草稿 | **已修**。非审核角色传非 approved 一律回落成 approved |
| **M5** | `/ask` 恒答「无关」：`[w for w in question_lower if len(w) > 1]` 对字符串逐字符迭代，条件恒 False | **已修**。改 2-gram 字面重叠；同时给 ask 加 30 次上限（修好之后它就是有区分度的免费 oracle） |
| **M6** | `reason="timeout"` 由客户端自报，`timeout` 又让 token 落到遗言证，而遗言证能过 `has_script_access` → 撤销后权限续到 4 小时 | **已修**。服务端核对真的闲置够 300 秒才允许转遗言证；遗言证不再等于汤底权限 |
| **M1** | 前端从不创建 HostSession（`grep /api/host frontend/js/` 零命中），闸口装好了但唯一客户端没接 | **不在 P1 修**。这正是「先破后立」的那一半，属于 P2 第 0 项，与 S1 一起做 |
| S4 | 游客计数并发首次请求会撞唯一键 → 500 | **已修**，撞了就退回去重数一次 |
| S7 | 游客计数依赖 uvicorn 的隐式 `proxy_headers` 默认值 | **已修**，`main.py` 显式挂 `ProxyHeadersMiddleware(trusted_hosts=["127.0.0.1"])` |
| S6 | `seed/npc_prompts.py` 还往废弃表写数据 | **已修**，改为空操作（不再生成读得出、改不动的幽灵提示词） |
| S2 | 未过审口径不一：详情页放行 station_master，`can_view_full_script` 不放行 | **已修**，两处统一放行 |
| S5 | `session_data.get("completed")` 未判 None → 500 | **已随 M3 消失**（不再读那份数据） |
| S1 | `PHASE_SETTLING` 没有任何代码写入 ⇒ `end_session(settled)` 恒 409；`TURN_LOCK_SECONDS(120) < SESSION_IDLE_SECONDS(300)` | **P2 前置**。接前端之前必须先补 settling 迁移，否则结算永远走不通 |
| S3 | `GET /api/npc/prompts`、`GET /api/game/mode-prompt` 无鉴权，回提示词模板全文 | **暂留**。不含真汤底，且前端组装提示词确实要用。等 P2 把组装搬到后端后自然消失 |

## 回归测试从 16 项扩到 26 项

新增三组，全部针对上面这些「改回一行就悄悄失效」的地方：

- 第 6 组：客户端自报通关不给汤底 / 服务端见证的通关给汤底 / 没通关过的不给
- 第 7 组：问句匹配能认出汤底里有的东西 / 不认识的仍答无关
- 第 8 组：刚开的场不能按超时结束 / 遗言证不再等于汤底权限

**结论：P1 到此结束。下一步是 P2，而 P2 的第一件事不是写新功能，是把 M1 + S1 补上
（前端接主持证 + 结算相位迁移），否则这一整套闸门在网页上等于不存在。**

---

# P2 第 0 步：把闸门接上网（M1 + S1）

审计最后那句判词是「闸门本身是好的，但前端从不创建主持会话」——
也就是说 P1 那一整套闸门在网页上等于不存在。这一步做的就是把两头接上。

## S1：结算相位打通（服务端）

以前 `PHASE_SETTLING` 没有任何代码会写入，于是 `end{reason:settled}` 的两条前置条件
（相位已是 `settling`、`narrated=true`）永远不可能同时成立 —— **「正常结算」这条路由根本走不通**，
客户端只能一直用 `aborted` 收场。补上两个显式端点：

| 端点 | 谁调 | 语义 |
|---|---|---|
| `POST /api/host/session/{id}/settling` | 条件系统判定结局成立那一刻 | 幂等进入结算相位 |
| `POST /api/host/session/{id}/narrated` | 结局解说**真的讲完之后** | 声明可以收场了 |

顺带定死一条量级关系：锁 120 秒 **必须** 明显短于闲置超时 300 秒。反过来就是「人早走了、锁还占着」。
长解说要中途续锁，不能靠加大这个数（已加 `renew_turn_lock`）。

## M1：前端接上主持证

- `Experience._prepare()` 第一步先开这一场的主持会话（拿证），再用证去取剧本完整内容。
  以前是「先取内容、没有证」，所以只拿得到公开字段，汤底与条件表全空，**条件结算系统一直在静默空转**。
- 新增心跳：每 60 秒报活一次。超时判定看的是「安静了多久」，不是「一次请求多久」。
- 离开体验时按触发原因收场：正常结算走 `settled`，其余走 `aborted`。
- 登录身份与主持证分两个头：`Authorization` = 我是谁，`X-Host-Token` = 我正在主持这一场。
  一个头装不下两个凭证；纯第三方主持人只带后者。

## 顺手修掉的老 BUG：真相被切成半句

`_settle()` 原来这么写：

```js
if (!NpcChat._isLoading) { await NpcChat.systemTurn(); }   // 正在出字就跳过解说
Experience.end('settlement');                              // 紧接着就撤上下文
```

而结算**几乎总是**由「这一轮里出现的条件标记」触发的 —— 也就是说触发的那一刻，
NPC 正在出字。于是解说被整段跳过、上下文随即被撤掉，它正在讲的那段真相被从中间掐断
（实测就是「……便当盒掉在地上。就在这时，电话响了——」戛然而止）。

现在改成：先等它这一轮讲完（`_waitChatIdle`）→ 再让它讲结局 → 讲完了才标记 `narrated` → 才收场。
解说失败就按中止收场，让服务端如实知道这一场没走完正常流程。

## 验收

新增 `tools/host/test_http_flow.py`（真实 HTTP，不要再只测服务函数）：
匿名只有公开字段 → 开房拿证 → **持证拿到汤底** → 进结算相位 → 没解说就收场被拒 409
→ 标记讲完 → 收场成功 → 收场后再拿不到汤底。全部通过。

四道闸门 + 这道新闸共五道全绿：`authz/check.py`（157 端点）、`golden/schema-lint.js`、
`host/test_session_engine.py`（17 项）、`host/test_leak_gates.py`（26 项）、`host/test_http_flow.py`（15 项）。

---

# P2 第 1 步：把提示词组装搬到后端

## 为什么这一步是 P2 的核心

在 P2 之前，「喂给 AI 的 system prompt」是在浏览器里拼出来的。这句话有两个后果：

1. **汤底在浏览器内存里。** 谁能打开 F12，谁就能读到「汤底/真相」那一节。
   P1 那套闸门解决的是「接口会不会把汤底吐给不该拿的人」，解决不了「拿到的人把它存在哪」。
2. **组装逻辑有两份。** 前端一份、将来的插件一份，各写各的就一定漂移；
   而漂移的后果是「AI 变傻」，界面上一点都看不出来。

所以组装搬进服务端，前端只拿一段已经拼好的字符串，原样塞进 `role:"system"`。

## 新增

| 文件 | 干什么 |
|---|---|
| `backend/services/prompt_assembly_service.py` | 组装本身。纯函数，不碰数据库、不读文件 |
| `backend/services/prompt_env_service.py` | 把服务端掌握的东西装成组装要的 `env` |
| `backend/routers/host.py` → `POST /api/host/context` | 对外那个端点（契约 §9.2） |
| `tools/golden/compare_py.py` | 拿后端实现回放 20 组冻结样本，要求逐字节全等 |
| `tools/host/test_context_api.py` | 真实 HTTP 回归（12 组断言） |

## 一致性怎么保证：不是「看着像」，是一个字节都不许差

`tools/golden/samples/` 里有 P0 冻结的 20 组样本，每组存着「输入 + 前端算出来的输出」。
`compare_py.py` 把同一份输入喂给后端实现，要求 `system_prompt` 与样本**逐字节相同**。

第一次跑就 20/20 —— 因为这份 Python 是从那段 JS 一段段抄下来的，不是重写的：
键名照抄、空串当「无内容」照抄、回退链 `a|b` 的判定照抄、`JSON.stringify(root, null, 2)`
换成 `json.dumps(..., ensure_ascii=False, indent=2)`（缩进 2 空格、不转义中文、无尾随换行）。

这条也进了部署闸门：对不上就不许推。

## 汤底的钥匙：正持着这一场

`POST /api/host/context` 的规则：

| `state` | 凭证要求 |
|---|---|
| `default` / `browsing` | 不需要。资料库里没有剧本内容 |
| `experience` | **必须有本场主持证**，没有就是 401 `no_actor` |

再叠三条：

- 证是真的、但 `session_id` 不是它绑的那一场 → **403** `capability_denied`；
- 会话已经正常结算收场（`end_reason=settled`）→ 再要上下文 **403**，汤底没有第二次上台的理由；
- 只有**安静超时**结束的会话，遗言证还能再取一次上下文 —— 那一次是用来把最后一句讲完的。

每次下发主持内容都会写一条 `access_logs`（`action=主持上下文下发`），对应契约 §10「实现要点」第 4 条。

## 还没做的（诚实记下来）

1. **前端还没切过来。** `frontend/js/modules/npc/prompt_builder.js` 仍是活的组装实现，
   `NpcChat._buildPrompt` 还走它。切换要等 `NpcChat` 改成「取 bundle → 塞进 messages」这一步。
   在此之前，线上行为不变（也仍然是旧的、汤底在浏览器里的行为）。
2. **线索/道具面板状态还没服务端化。** `env.inventory` 现在从会话 payload 里读，
   而 payload 里的 `inventory` 还没有任何代码去写 —— 也就是说体验态下 E 组恒为「暂无线索」。
   面板的 `[sys:add_clue]` 等指令目前仍由前端解析。
3. **`status_uis` / `ui_targets` 是常量镜像。** 它们在后端有一份、前端有一份（`status_ui_*.js`、
   `ui_locator.js`）。过渡期两份并存，等前端彻底不组装了再把前端那份降级为「只渲染」。

## 验收

- `python tools/golden/compare_py.py` → **20/20 逐字节一致**
- `python tools/host/test_context_api.py http://127.0.0.1:8020` → **全部通过**（服务端 Traceback 0）
- 六道闸门全绿：`authz/check.py`（**158 端点**）、`golden/schema-lint.js`、
  `host/test_session_engine.py`（17 项）、`host/test_leak_gates.py`（26 项）、
  `golden/compare.js`（20/20）、`golden/compare_py.py`（20/20）

---

# P2 第 1 步 · 审计复审（12 条）与修正

审计角色对这一步打穿了 6 条必改、6 条建议，另有 8 条它自己核实后撤回。
它的总评值得抄在这里：**「核心装配器是真的，但验收基线是假的」**。
下面是逐条落地情况。

## 必改（6 条，全部已修）

| 编号 | 它指出的问题 | 修法 |
|---|---|---|
| M1 | 已结算收场的会话，再喊一句 `reason=timeout` 就把 `end_reason` 覆写回 `timeout`，「settled 之后不再下发汤底」一句话被推翻 | `end_session` 第一行加终态短路：`if session.phase == PHASE_ENDED: return session` |
| M2 | 遗言证「只许用一次」在代码里**一次也没被执行过**——`consume_last_words` 全项目零调用方 | `/context` 的遗言分支先查 `last_words_used`，否定才放行；放行即 `consume_last_words`（用完立刻撤销，第二次 410） |
| M3 | 空闲清扫把 `phase` 推成 ended 却不写 `end_reason`，于是「AI 把最后一句讲完」在最常见的路径（客户端没主动收场）上**压根不生效**，还静默失败 | `sweep_if_idle` 补写 `end_reason="timeout"` |
| M4 | `Authorization` 一律被当成主持证原文。可登录用户的浏览器**每个请求都带 JWT**，于是「不需要凭证」的 default/browsing 对登录用户必然 401 —— 最常用的路径只剩游客能走 | `raw_from_headers` 认形状：主持证是不透明随机串（43 字符、不含点），JWT 含点或长度不足一律**忽略**，按匿名处理 |
| M5 | `status_uis` 三方不一致：常量是 `[hp, mode]` 两条、样本也是两条、真实浏览器是 `mode→hp→conditions` 三条。「逐字节等价」这句声明在**接线层**不成立 | 常量与样本夹具都改成浏览器注册序三条；**重抓 20 组样本**；前后端两条 compare 重新 20/20 |
| M6 | **钥匙可以免费自取**：任何人对任何已过审剧本调一次 `POST /api/host/session/start`（游客、不限次）就能拿到证，随后 `/context` 交出汤底。它实测 3/3 命中 | 同主体同剧本重复开房先把旧会话收掉（不再繁殖）；开房次数限额（登录 200 / 游客 20，`guest_counter` 落库）。**这是抬高成本，不是根治**，见下方「待拍板」 |

## 建议（6 条，修了 5 条）

| 编号 | 问题 | 处置 |
|---|---|---|
| S1 | 审计留痕只有 path/user/ip，没有 `script_id`/`session_id` ⇒ 事后答不出「谁看了哪一本汤底」 | `access_logs` 加两列（由 `_sync_columns()` 自动补到现有库），审计写入时带上 |
| S2 | 审计写失败 `except` 全静默，坏了没人知道 | 加 `logging.warning`，带 `session.id` 与异常 |
| S3 | default/browsing 只要带了证就拿到半个 actor：整块 `session`（含 `script_id`）、`script:host`/`session:settle` 两项能力、以及**该场玩家**的档案 | 非主持态一律收敛：`session` 只给 `id`/`phase`，能力只给 `script:read`，玩家档案改取「当前登录者或游客」 |
| S4 | `/context` 里的 script 查询不看 `is_deleted`/`review_status` ⇒ 会话建好之后剧本被下架或退回审核，仍继续下发它的汤底 | 加判定：不存在 / 已删 / 非已过审 → 404 `script_not_found` |
| S6 | `test_context_api.py` 第 6 项写成 `st in (403, 410)`，这种「二选一」会藏 bug；整份测试**没有任何遗言证用例** | 断言收严为 `403` + `capability_denied`；新增第 6b 组（已收场的场不能被一句话喊回 timeout）；另起 `tools/host/test_host_hardening.py` 补 M1~M5 的服务层回归 |
| S5 | 三处「畸形数据下才分叉」的边缘不等价（字典缺 `name` 时 Python 出 `None`、JS 出 `undefined`；`NaN`/`Infinity`；U+2028/2029 转义） | **不改代码**，但记在这里：`compare_py.py` 的「逐字节一致」只对**正常数据**成立 |

## 它撤回的 8 条（值得记）

它核实后自己撤掉了 8 条，包括：default 态会不会间接漏汤底（不漏，逐字段探针全 False）、
审计有没有绕过分支（没有）、`has_script_access` 收 token 是否还放行遗言证（已收紧，挡住了）、
「证对场不对」能不能靠猜 `session_id` 绕（绕不了）、env 的表情逻辑会不会与前端分叉（一致）、
`UI_TARGETS` 键与顺序（一致）、`STATUS_UIS` 三条文案（逐字相同，错的只是顺序与条数）、
第 6 项断言是不是「必然通过」式假绿（不是，它确实在拦）。

它还自己踩过并纠正一个假阴性：用 `explanation[:20]` 做子串判断时，
`json.dumps` 把换行转义成 `\n` 导致恒 False —— 换成不含换行的切片才测对。

## 待用户拍板（M6 的根治，需要动产品规则）

1. **登录后才能开体验会话**（游客只能看剧本、不能开房）——最彻底，但会挡住免登录试玩。
2. **开体验会话就扣一次免费额度**——但插件不负责取 AI/API（D2 决策），
   无法判断这一场会不会用到站长的密钥，扣在这里会误伤自带 key 的玩家。
3. **只保留现在的限流**——承认「汤底对已过审剧本的公开内容的人来说不是秘密」，
   靠限额抬高批量抓取的成本。

## 验收

七道闸门全绿：`authz/check.py`（**158 端点**）、`golden/schema-lint.js`、
`host/test_session_engine.py`（17 项）、`host/test_leak_gates.py`（26 项）、
`golden/compare.js`（20/20）、`golden/compare_py.py`（20/20）、`host/test_host_hardening.py`（18 项）。

真 HTTP 实测：同主体重复开房 → 旧场 ended、新场 hosting ✓；遗言轮第一次 200 拿到汤底、
第二次 410 `host_token_expired` ✓；伪造 JWT 形状的 Authorization 走 default 态 → 200 正常 ✓；
游客开房超限 → 429 `rate_limited` ✓。

---

## P2 第 2 步：汤底彻底离开浏览器

**起因（用户口径）**：「汤面、汤底其实都是公开的……只需保证用户在正常游玩、没碰前端源代码的情况下接触不到汤底即可。」
验收标准因此从「接口防得住」降为「正常玩的人在浏览器里看不到汤底」——重心从堵接口变成**让浏览器根本拿不到**。

### 做了什么

1. **序列化拆三档**：`backend/models/script.py` 的 `to_dict(include_full, include_synopsis, include_conditions)` 把「条件表」从「汤底」里拆出来（`ending_condition`/`endings`/`tasks` 归条件表，`explanation`/`host_guide` 归汤底）。
2. **判权拆三档**：`backend/services/npc_service.py` 的 `get_script` 改成
   - 作者/管理员/站长 → `include_full=True`（全套）；
   - 正在主持这一场的人 → `include_conditions=True`（**有条件表、没有汤底**）；
   - 其他人 → 只有公开字段 + `full_locked`。
3. **前端不再自己拼提示词**：`frontend/js/modules/npc/chat.js` 的 `_buildPrompt` 改为 `async`，POST `/api/host/context` 取 `system_prompt`；`_buildRequestMessages` 随之 async；两个调用点（主路径与免费路径）加 `await`；示例页 `frontend/js/modules/admin/demo.js` 同步改 await。
4. **主持会话对 NpcChat 可见**：`frontend/js/modules/game/game.js` 新增 `Experience.hostSession()`，返回 `{scriptId, id, token, expiresAt}`。只有这一场开着且有证时返回，不把过期证递出去。

### 验收（都实跑过）

- 匿名取详情：`explanation`/`endings`/`host_guide` 全无，`full_locked=true`；
- 持主持证取详情：`endings`/`tasks` 有，`explanation`/`host_guide` **没有**，且不再标 `full_locked`；
- 服务端组装出的 `system_prompt` 里**能**找到汤底原文（说明汤底确实参与了推理），而浏览器侧拿到的详情 JSON 里**找不到**汤底原文；
- `default`/`browsing` 无证可取；`experience` 无证 401 `no_actor`。
- 七道闸门全绿；`test_leak_gates.py` 新增第 2b 组（主持人拿条件表、拿不到汤底）、`test_http_flow.py` 第 3 组改成新口径并加「服务端提示词非空」。

### 还没做的

- `frontend/js/modules/npc/prompt_builder.js` 已退出运行时，但文件还在、`index.html` 还加载着（只服务黄金样本比对）。要么删，要么标明「仅供回归」。
- `frontend/js/modules/game/game.js` 还在拉 `GET /api/game/mode-prompt`（只为拿 `mode` 字段给事件用）。提示词模板本身不是汤底，但这条链路迟早该收掉。
- `Experience._buildHostData()` 仍在跑，现在只喂 `ConditionTracker` 与 HUD（`endings`/`tasks`），`guide`/`modePrompt` 已是死数据。

---

## P2 第 3 步：第三轮审计（条件门 / 结算守卫 / 假绿）

审计角色这轮盯的是「16 条 bug 修完之后，防线内部还有没有缝」。结论：**有，而且缝在最重要的那条路上**。

### M1（已修）结算解说期间开新场，旧流程会把新局拆掉
`frontend/js/modules/game/conditions.js` 的 `_settle` 原本只有两道 `stillMine()`（结算面板之后、`_waitChatIdle` 之后），**`await NpcChat.systemTurn()` 之后没有第三道**。而结局解说可能讲几十秒，这段时间结算面板已经在屏上、上面就摆着「再来一次」——玩家点它是正常操作，不是作弊。一旦点了，后面两个动作会打到**新开的那一场**：

1. `Experience.markNarrated()` 读的是调用时的 `_hostSession`（已经是新场的证），给新场盖 `narrated=true` ⇒ 服务端「先解说后收场」那道闸对新局永久失效；
2. `Experience.end('settled')` 把刚开的新场按 settled 收掉 ⇒ 新局秒退。

修：`systemTurn()` 之后、`markNarrated()` 之前补第三道守卫。

> 审计附带的另一条建议（把 `seq0` 的取法提到函数第一行）**它自己看错了**：`seq0` 本来就在 `beginSettling()` 之前取。交叉验证后不采纳。

### M2（已修）条件标记的肯定回答门，粒度错了
原实现是「整条回复里出现过一次 `[answer:yes|both]` 就全部放行」，而代码注释与对外口径都写「同一次肯定回答」。于是一条回复里问两件事——A 答是、B 答否——B 的条件照样 +1。

修法与定稿口径（`_gateByAnswer`）：

- 整条回复**只有一个** `[answer:]` → 它管辖全部 `[cond:]` / `[task:]` 标记（这是实际输出最常见的形态：AI 习惯把标记统一写在末尾，按位置归属会把它自己写出来的正确标记全判掉）；
- 出现**多个** `[answer:]` → 每个标记归属它前面最近的那个回答，那条是 `yes`/`both` 才算数；找不到前面的就退回后面最近的。

`[cond:]` 与 `[task:]` 走同一道门（原来 `[task:]` 完全没有门）。

**`[answer:both]`（是也不是）算肯定回答** —— 这是产品口径，统一写在这里，代码、注释、文档三处从此一致。

### M3（已修）一条恒真断言
`tools/host/test_context_api.py` 里 `json.loads(sp) == root_of(d)` —— 而 `root_of` 就是从 `sp` 解析的，永远为真。A1 把 `root` 从响应里删掉时，这条断言静默退化成同义反复。改成拿写死的结构名单当锚：顶层只有两键、资料库分节是配方的有序子序列、必有分节齐全。

### S5（已修）三条「不跑也绿」
`tools/host/test_http_flow.py` 第 3 组缺 `check("200", st, 200)`，请求失败时 `d` 变成 `{"detail":…}`，下面几条「xx 不在里」的断言全部自动成立；另有两处 `if xxx:` 静默跳过。三处全部改成「取不到就记失败」。另外发现本地开发库三本剧本**都没有条件表**，于是这条检查实际上从来没验过——现在测试会自己临时装一份条件表、跑完还原。

### S1（已修）登出不清主持证
`frontend/js/modules/auth/auth.js` 的 `logout()` 不结束体验、不清 `Experience._hostSession`。同一浏览器换账号再进同一本剧本，会命中「同剧本 + 证还有效」的复用短路，把上一个人的证交出去 ⇒ 新账号看到上一个人的玩家档案，结算也记在别人头上。修：登出前 `Experience.end('aborted')`。

### S4（已修）记账失败会把成功调用打成 500
`backend/services/site_service.py` 的 `record_free_quota` 自己那段 `db.commit()` 没有 try，DB 忙时会让一次**已经成功**的 AI 调用返回 500，且这次不计额。修：包 try/except + rollback + warning，与 `_bump_trial_call` 对齐。

### 审计自己撤回了 6 条
「证过期重试刷穿开房额度」（`bump` 在 `used >= limit` 时先返回不 +1）、「降级后仍能读汤底」「免费额度双算」「搜索过滤能绕过」「汤底断言仍被 except 跳过」「条件标记完全无门可通关」——实测均不成立。

### 这两份 HTTP 测试不在闸门里
`test_http_flow.py` 与 `test_context_api.py` 需要真实服务在跑，部署时没有服务可打，所以不进 `deploy.sh`。但它们是「汤底不外泄 + 主持通道贯通」最接近现场的回归网，改动 `backend/routers/{host,npc,game}.py` 或 `backend/services/{host_session,prompt_assembly,prompt_env}_service.py` 时必须手动跑一次。

---

# P3 / P4 第一批（2026-11-01）

## 做了什么

| 模块 | 产物 | 验证 |
|---|---|---|
| **M30a** 主持客户端 | `frontend/js/core/host_client.js`（235 行）：`/api/host/*` 全部收敛，统一 15s/30s 超时、错误码→人话映射、`X-Host-Token` 头 | `node --check`；真机全链路 |
| **M30b** 降级与指纹 | 服务端 `prompt_hash` 存进 `NpcChat`，每轮比对：一致→用服务端的；不一致→用服务端的+告警+弹一次提示；不可达→**体验态显式失败**（插系统消息、把输入还给玩家），default/browsing 才走本地兜底；`window.__hostDegraded` 留痕 | 真机（服务端不可达时不再静默哑火） |
| **ui-meta 单一真源** | `backend/services/prompt_env_service.ui_meta()` + `GET /api/host/ui-meta`（公开）+ `frontend/js/core/ui_meta.js`（启动拉一次、失败回落本地常量） | `test_host_hardening` 断言顺序 mode→hp→conditions、hp 7 条命令 |
| **M27** 凭证服务 | `backend/models/mcp_token.py` + `backend/services/token_service.py`（327 行）；`security.py` 按 `mcp_` 前缀分流；`/api/user/mcp-tokens` 三个端点；能力 8 种；上限 10 把；60 次/分钟；审计写 `access_logs` | 21 条自测：生成→用→吊销→401；未知 scope 忽略+告警；空集 401；超 10 把 409；限流 429；审计行带 `X-Mcp-Tool` |
| **M31** MCP 插件 | `server/mcp-server/`（aijuben-mcp 0.1.0）：`aijuben_mcp/` 包 + 17 个工具（catalog 6 / session 7 / player 4）+ `README.md`(244 行) + `selftest.py` + `examples/`；只走 HTTP，不 import backend、不读 SQLite、不含任何 LLM provider 或 API Key；stdio 与 streamable-http 双模 | **selftest 64/64 通过**（对本地后端，含门票通道）；真 MCP 客户端双模握手成功 |

## 三个坑（都已修，值得记）

1. **`mcp_` 门票会被误判成主持证**。`raw_from_headers` 的判据是「不含点且 ≥40 位」，而门票正好长这样 —— 「只带门票、不带 `X-Host-Token`」的请求会拿到一张查不到的证，连不需要凭证的 `default` 态都 401。修在 `host_session_service.raw_from_headers`（唯一该认识凭证种类的地方）显式排掉 `mcp_` 前缀，而不是在各调用点打补丁。
2. **`access_logs` 没有 `detail` 列**。要记「这次 MCP 调用用的是哪个工具」就得加列；靠 `_sync_columns()` 自动补，不必手写迁移。
3. **`status_uis` 有两套键名**。提示机组装按内部 camelCase `npcCmds` 读，且有 20 组逐字节黄金样本锁着 —— 一个字符都不能动；对外的 `ui-meta` 用契约的 `npc_cmds`。`ui_meta()` 在出口处改名并每次造新对象，两边各用各的。

## 明确没做（留给下一轮，别误以为有了）

- **M30c 条件判定上移**：现在**前端仍是条件表的判定者**，服务端只提供条件表原文。搬错的最坏结果是结局永不触发且静默 —— 需要「新旧两条路径判定结果必须一致」的对照测试，不宜与凭证/插件混做。
- **M30e 工具执行上移**：`[tool:*]` 仍在浏览器里执行。
- **inventory 服务端化**：线索/道具面板仍由前端拼进 `env`。
- **门票的写类能力**：`write:script` / `social:vote` / `social:report` / `social:follow` 只解析、不执行；`capability_denied` 的判定留给将来用到这些能力的端点。v1 的门票实际上是**只读 + 会话**。
- **未部署**：本轮产物都在工作区，MCP 插件是用户本地跑的东西（`pip install ./mcp-server`），不进 `deploy.sh` 的推送范围。


---

## P4 审计复审（P3/P4 第一批）与修正

`auditor-contract` 对「P3 前端切换 + P4 凭证与插件」这一批的结论：工程完成度不低
（凭证分流对、`ui_meta()` 单一真源名副其实、M30b「把话还给玩家」做到了、插件默认不泄凭证），
但 **`scopes` 这一层是空的** —— 唯一一条「会出事」。

| 编号 | 问题 | 修法 |
|---|---|---|
| M1 | 门票 = 账号全部权限：`capabilities_for_user()` 直接 `return set(SCOPES)`，`_mcp_scopes` 全项目零读取。审计用一张 `["player:read"]` 的票读到了未过审稿的汤底、`/api/admin/npc-prompts` 全文、并成功开房拿主持证 | `security._deny_by_token()` 写死「门票 ≠ 管理员」，挂到三个守卫尾部；`host.py._check_ticket_scope()` 管开房（`session:host`）与结算相位（`session:settle`） |
| M2 | 门票能给自己续签，吊销形同作废（吊销前先签 10 张，`scopes` 还能超出原票） | 三个 `/api/user/mcp-tokens` 端点改用 `Depends(require_login_not_token)` |
| M3 | `window.__hostDegraded` 只写不读，降级对运营侧全静默 | 新增 `POST /api/log/client-event`（公开、白名单、永远 204），`noteDegraded` 里 fire-and-forget 上报，落 `access_logs`（`action=M30b降级`），每局最多报 5 次 |
| S1 | 插件把整个响应 dict 塞进给模型看的 `message` 并指示「原样报给用户」——那个 dict 里就装着明文主持证 | 改成两个布尔 + 「不要把接口返回原文贴出来」 |
| S2 | 门票调用在审计里查不出用了哪个工具（`X-MCP-Tool` 从没被设置） | `api_client.request(tool=)` + `current_tool` contextvar，由 `tool_guard` 统一设/复位，17 个工具不用各自记得传参 |
| S3 | `current_session.json` 崩溃/断电不清，明文主持证留到过期（4 小时） | `atexit` + `SIGINT/SIGTERM/SIGHUP` 钩子清一次 |
| S4 | 8 个能力名里 `write:script` 之类目前是纯装饰，前端勾选框会误导 | 签发响应加 `note` 如实说明 |

审计自己撤回 6 条（门票换主持权 / 排 `mcp_` 误伤合法证 / M30b 吞玩家一句话 / `ui_meta()` 非单一真源 /
插件回显凭证 / `prompt_hash` 误报），逐条复核成立。

**验证**：`_ops/verify_scope_fix.py` 18 项全过（站长 JWT 造门票 → 门票读管理面 403 → 门票开房 403 →
门票自签 403 → 本人仍可签发 201 → 降级上报 204 且落库 → 站长 JWT 与匿名均不受影响）；
MCP `selftest.py --with-ticket` **64/64 全过**（含门票通道开房/收房）；`access_logs` 实测出现
`token=mt_xxx tool=start_session`。八道闸门全绿（authz **168** 条）。

**这一轮之后仍然没做**（明确记账）：M30c 条件判定仍在浏览器、M30e 工具执行仍在浏览器、
`write:script` / `social:*` 只解析不执行、`$PATH` 级的 MCP 上架（npm 包 + awesome-dsh-plugin PR）。
