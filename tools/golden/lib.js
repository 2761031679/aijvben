/**
 * 黄金样本工具 · 公共层
 * ------------------------------------------------------------------
 * 作用：把「浏览器里跑的 PromptBuilder」装进 Node 的 vm 沙箱，喂同一组输入，
 *      产出可逐字节比对的字符串。P0 的冻结基准就靠这一层。
 *
 * 三条关键约定：
 * 1. 沙箱里 window === globalThis（与浏览器一致）——
 *    prompt_builder.js 里混用了 window.X 和裸 X，例如
 *    `const active = window.Experience && Experience.isActive && Experience.isActive();`
 *    只把 X 挂到 window 上会在求值裸 `Experience` 时抛 ReferenceError。
 * 2. **输入必须是纯数据，不能是函数闭包。**
 *    环境（Experience 是否激活 / 主持数据 / 线索面板 / 站长配置的表情清单 …）
 *    全部表达为 `env` 对象存进样本，这样样本在任何语言、任何机器上都能重放。
 * 3. 提示词优先读从线上拉下来的权威副本 `.src/`——
 *    本地 npc_configs 与线上有漂移，见 README「为什么要用线上副本」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../..');
const SRC_CONFIGS = path.join(__dirname, '.src/npc_configs');
const NPC_CONFIGS = fs.existsSync(SRC_CONFIGS) ? SRC_CONFIGS : path.join(ROOT, 'npc_configs');
const PB_PATH = path.join(ROOT, 'docs/regression/prompt_builder.reference.js');

/** NPC 私有提示词只读这 5 种（backend/services/npc_file_service.py:96 PROMPT_TYPES） */
const NPC_PROMPT_TYPES = ['soul', 'iron_rules', 'tools', 'guide', 'game_mode'];

/** 复刻 get_npc_prompts(npc_id)：缺文件 → content 为空串（空串在 build 里会被过滤掉） */
function getNpcPrompts(npcId) {
  const dir = path.join(NPC_CONFIGS, npcId, 'prompts');
  return NPC_PROMPT_TYPES.map((pt) => {
    const f = path.join(dir, `${pt}.txt`);
    let content = '';
    if (fs.existsSync(f)) content = fs.readFileSync(f, 'utf8').trim();
    return { npc_id: npcId, personality_id: '', prompt_type: pt, content };
  });
}

/** 复刻 get_shared_prompts()：shared/prompts/*.txt 按文件名当 prompt_type */
function getSharedPrompts() {
  const dir = path.join(NPC_CONFIGS, 'shared', 'prompts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort().map((f) => {
    const name = path.basename(f, '.txt');
    let pt = name, cat = '';
    if (name.startsWith('game_mode_')) { pt = 'game_mode'; cat = name.slice('game_mode_'.length); }
    const content = fs.readFileSync(path.join(dir, f), 'utf8').trim();
    return { npc_id: 'shared', personality_id: '', prompt_type: pt, category: cat, content };
  });
}

/** 后端一次下发给前端的完整提示词列表 */
function getPromptsFor(npcId) {
  // npcId 为空时只取共享提示词：若拿 'shared' 当 npcId，会把 shared/prompts 根下的
  // soul/iron_rules/tools/guide/game_mode 再读一遍，凭空造出数组（线上没有叫 shared 的 NPC）
  const own = npcId && npcId !== 'shared' ? getNpcPrompts(npcId) : [];
  return [...own, ...getSharedPrompts()];
}

/** 读一份共享提示词原文 */
function readShared(name) {
  const f = path.join(NPC_CONFIGS, 'shared', 'prompts', name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
}

/* ================= env（纯数据） → 沙箱桩 ================= */

/**
 * env 字段（缺失即「未激活 / 无」）：
 *   experience: { active: bool, host_data: {...}|null }
 *   inventory:  { active: bool, state: { clues:[], items:[] } }
 *   status_uis:  [{ id, name, desc, npcCmds:[] }]
 *   npc_configs: { <npcId>: { enabled_emotions:[], enabled_actions:[] } }
 *   available_defs: { emotions:[{id,name}], actions:[{id,name}] }
 *   emotion_effects: { <emoId>: { name, portrait, anim, prompt } }
 *   ui_targets:  { <targetKey>: <中文名> }
 */
function stubsFromEnv(env) {
  env = env || {};
  const exp = env.experience || {};
  const inv = env.inventory || {};
  const defs = env.available_defs || { emotions: [], actions: [] };
  const fxs = env.emotion_effects || {};
  const cfgs = env.npc_configs || {};
  return {
    UILocator: { TARGETS: env.ui_targets || {} },
    AccountInit: {
      getNpcConfig: (id) => cfgs[id] || {},
      getAvailableDefs: () => defs,
      getEmotionEffect: (_npcId, emoId) => fxs[emoId] || {},
    },
    StatusBar: { describeForNpc: () => env.status_uis || [] },
    GameInventory: {
      isActive: () => !!inv.active,
      getState: () => inv.state || { clues: [], items: [] },
    },
    Experience: {
      isActive: () => !!exp.active,
      getPromptData: () => (exp.active ? (exp.host_data || null) : null),
    },
  };
}

/** 建一个干净的 vm 沙箱：window === globalThis，console 记录但不打印 */
function makeSandbox(env) {
  const logs = [];
  const rec = (kind) => (...args) => logs.push(`${kind}: ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  const sandbox = {
    console: { log: rec('log'), warn: rec('warn'), error: rec('error'), info: rec('log') },
    JSON, Object, Array, String, Number, Boolean, Math, Date,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  Object.assign(sandbox, stubsFromEnv(env));
  vm.createContext(sandbox);
  return { sandbox, logs };
}

/** 载入 prompt_builder.js，返回它的 PromptBuilder 对象 */
function loadPromptBuilder(sandbox) {
  const src = fs.readFileSync(PB_PATH, 'utf8');
  vm.runInContext(src, sandbox, { filename: PB_PATH });
  const PB = sandbox.window.PromptBuilder;
  if (!PB) throw new Error('prompt_builder.js 没有挂上 window.PromptBuilder');
  return PB;
}

/** 用 env 跑一次：返回 { output, logs } */
function runWithEnv(input) {
  const { sandbox, logs } = makeSandbox(input.env);
  const pb = loadPromptBuilder(sandbox);
  const output = pb.build({
    prompts: input.prompts || [],
    webState: input.webState || 'default',
    npcId: input.npcId === undefined ? null : input.npcId,
    playerInfo: input.playerInfo === undefined ? null : input.playerInfo,
  });
  return { output, logs };
}

module.exports = {
  ROOT, NPC_CONFIGS, SRC_CONFIGS, PB_PATH, NPC_PROMPT_TYPES,
  getNpcPrompts, getSharedPrompts, getPromptsFor, readShared,
  stubsFromEnv, makeSandbox, loadPromptBuilder, runWithEnv,
};
