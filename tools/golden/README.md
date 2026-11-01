# 黄金样本（P0 冻结基准）

**一句话**：把「现在的提示词组装行为」拍成 20 张照片。以后不管用 Python、TS 还是别的语言重写，
只要能一字不差地重现这 20 张照片，就证明重构没走样。

配套文档：`docs/CONTEXT_CONTRACT.md`（契约）、`docs/ARCHITECTURE_PLAN.md`（开发方案）。

---

## 为什么要有这个

提示词组装是整个重构里**最容易静默出错**的地方：

- 它是纯字符串拼接，没有类型检查，错了不报错，只是 AI 变傻；
- 键名是中文（`"A 角色设定"`、`"线索/道具面板（…序号即 remove 指令的 index 参数）"`），差一个字不影响运行；
- 有回退链（`sidebar_guide|guide`）、有单份/多份合并、有空节跳过 —— 分支多，肉眼看不出对不对。

所以先把行为拍下来，再动代码。

## 怎么用

```bash
# 1. 拍基准（改动之前跑一次，产物提交进 git）
node tools/golden/capture.js

# 2. 自查：拿当前的 prompt_builder.js 去比样本，必须 20/20 绿
node tools/golden/compare.js

# 3. 比对自己的实现（别的语言写好后，用一个小适配器包一层）
node tools/golden/compare.js --impl ./path/to/impl.js
```

`--impl` 指向的模块只需导出：

```js
module.exports = { build({ prompts, webState, npcId, playerInfo, env }) => string }
```

返回值必须与 `samples/NN-*.json` 的 `output` 字段**逐字节**相同。
`--json` 输出机器可读结果，给 CI 用；有回归时退出码为 1。

## 样本长什么样

每个样本都是自包含的（不依赖 `npc_configs` 目录）：

```jsonc
{
  "name": "14-experience-hgt-full",
  "note": "体验态 · 海龟汤 · 完整条件表",
  "meta": { "pb_sha256": "…", "prompts_sha256": "…", "output_sha256": "…", "output_bytes": 22978 },
  "input": {
    "webState": "experience",
    "npcId": "dagou",
    "playerInfo": { "proficiency": "new", "username": "新来的茶客", … },
    "prompts": [ { "prompt_type": "soul", "content": "…" }, … ],   // 后端实际下发的完整列表
    "env": {                                                       // 环境也是输入，必须是纯数据
      "experience": { "active": true, "host_data": { … } },
      "inventory":  { "active": true, "state": { "clues": [ … ], "items": [ … ] } },
      "status_uis": [ … ], "npc_configs": { … },
      "available_defs": { … }, "emotion_effects": { … }, "ui_targets": { … }
    }
  },
  "logs": [ "log: [PromptBuilder] 配方 experience: …" ],   // 回退/跳过都会留痕，用来验证分支确实走到了
  "output": "{ … 逐字节基准 … }"
}
```

`logs` 不是装饰：`分节回退：sidebar_guide 为空，使用 guide` 这类日志能证明回退分支真的被命中，
比只看最终字符串更有说服力。

## 20 组用例覆盖了什么

| 组 | 用例 | 验的分支 |
|---|---|---|
| default ×6 | 四个 NPC × 三种玩家档位 | 三档引导策略、G 节随 NPC 变化 |
| | 05 无 npcId | `capability` 为 null → 整节消失 |
| | 06 无 playerInfo | I 玩家信息消失 |
| 边界 ×2 | 07 `alex` | 线上只有 `soul`+`tools`，其余缺 → 缺节跳过 |
| | 08 两份 tools | **规则 3 数组**（线上常态，不是边角） |
| browsing ×5 | 09–13 | `sidebar_guide` 为空 → 回退 `guide`，**但子键名不变** |
| experience ×5 | 14–18 | 四种模式规则、有条件表 / 无条件表 |
| 边界 ×2 | 19 面板未激活 | E 组消失 |
| | 20 体验态无主持数据 | 防御回退 default + 必须打 warn |

## 为什么要用线上副本（`.src/`）

本地 `npc_configs` 和线上**有漂移**，而且漂的正好是这条规则：

| 文件 | 本地 | 线上 |
|---|---|---|
| `dagou/prompts/tools.txt` | 0 字节 | **200 字节** |
| `xiaomei/prompts/tools.txt` | 0 字节 | **200 字节** |
| `xiaoshuai/prompts/tools.txt` | 0 字节 | **200 字节** |
| `jingyuniang/prompts/soul.txt` | 551 字节 | **677 字节** |
| `shared/prompts/iron_rules.txt` | 5311 字节 | **5483 字节** |

线上每个 NPC 都自带 `tools.txt`，**再加上**共享 `tools.txt` → `tools` 永远是 2 份 → **输出数组**。
本地因为私有那份是 0 字节被过滤，只剩单份 → 数组这个分支在样本里根本不会出现，
拍出来的「基准」就是错的。

所以 `capture.js` 优先读 `.src/npc_configs/`（从线上拉的权威副本）。
`.src/` 已被 git 忽略 —— 它只是**重拍样本时**需要，样本本身已自包含。

重拉权威副本：

```bash
ssh <user>@<host> \
  'cd /opt/turtlesoup && find npc_configs -path "*/prompts/*.txt" -o -name config.json -path "npc_configs/*" | sort | tar czf - -T -' \
  > /tmp/npc.tgz
mkdir -p tools/golden/.src && tar xzf /tmp/npc.tgz -C tools/golden/.src/
node tools/golden/capture.js   # 重拍
```

> ⚠️ 只拉提示词和 config，**不要**用本地 `npc_configs` 整体 scp 覆盖线上 ——
> 线上还有本地没有的 12 个文件，会被冲掉。

## 已知边界

- `logs` 里带 `[PromptBuilder]` 前缀的日志是**契约的一部分**（能证明回退发生了），改实现时别丢。
- 样本里的剧本数据是**合成的**，不是线上真实汤底 —— 免得把作者内容烧进仓库。
- 表情/动画清单是夹具，不是站长真实配置；验的是「清单怎么被渲染」，不是「清单内容对不对」。
