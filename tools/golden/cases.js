/**
 * 黄金样本工具 · 20 组用例
 * ------------------------------------------------------------------
 * 只描述「输入」（prompts 列表 + 三态 + 玩家档案 + 环境 env），输出由 prompt_builder.js 现算后冻结。
 * 覆盖：三态 × 有/无 playerInfo × 有/无 npcId × 回退链命中 × 同类型多文件(数组)
 *      × 四种模式规则 × 有/无条件表 × 有/无线索面板 × experience 态防御回退。
 */
'use strict';
const { getPromptsFor, readShared } = require('./lib');

/* ============ 静态夹具：站长配置的开放表情/动画 ============ */
const AVAILABLE_DEFS = {
  emotions: [
    { id: 'normal', name: '平静' }, { id: 'happy', name: '开心' }, { id: 'angry', name: '生气' },
    { id: 'sad', name: '难过' }, { id: 'shy', name: '害羞' }, { id: 'surprised', name: '惊讶' },
  ],
  actions: [{ id: 'idle', name: '待机' }, { id: 'wag', name: '摇尾' }, { id: 'jump', name: '跳一下' }],
};

const EMOTION_EFFECTS = {
  normal: { name: '默认表情', portrait: 'normal.png' },
  happy: { name: '咧嘴笑', portrait: 'happy.png', anim: 'jump', prompt: '嘴角上扬，眼睛弯成月牙' },
  angry: { name: '皱眉', portrait: 'angry.png', prompt: '眉头紧锁，嘴角向下' },
  sad: { name: '垂眼', portrait: 'sad.png', prompt: '眼皮下垂，视线偏下' },
  shy: { name: '脸红', portrait: 'shy.png', prompt: '脸颊泛红，视线躲闪' },
  surprised: { name: '瞪眼', portrait: 'surprised.png', anim: 'jump', prompt: '眼睛睁大，身体后仰' },
};

/** 每个 NPC 开放的表情/动画不同 → 验证 G 节随 npcId 变化 */
const NPC_CONFIGS_FX = {
  dagou: { enabled_emotions: ['normal', 'happy', 'angry', 'sad'], enabled_actions: ['idle', 'wag'] },
  xiaomei: { enabled_emotions: ['normal', 'happy', 'shy'], enabled_actions: ['idle'] },
  xiaoshuai: { enabled_emotions: ['normal', 'happy', 'surprised', 'angry'], enabled_actions: ['idle', 'jump'] },
  jingyuniang: { enabled_emotions: ['normal', 'happy', 'sad', 'shy'], enabled_actions: [] },
};

// 顺序 = 浏览器注册序（index.html 先 mode、再 hp、最后 conditions），
// 因为 StatusBar.describeForNpc() 取的是对象插入序。
const STATUS_UIS = [
  { id: 'mode', name: '模式状态', desc: '显示当前正在游玩的剧本类型。玩家点击此卡可退出当前剧本体验（由玩家操作，非 NPC 命令）。', npcCmds: [] },
  { id: 'hp', name: '血量条', desc: '玩家血量条。默认不显示，NPC 通过 hp_* 命令调用时自动显示并操作。', npcCmds: [
    'hp_reset —— 初始化/重置血量至默认值（生命值 100/100，上限 100）',
    'hp_set:value=数字 —— 设置当前生命值',
    'hp_add:amount=数字(可负) —— 增减生命值',
    'hp_max:value=数字 —— 设置生命值上限',
    'hp_clear —— 生命值清零',
    'hp_fill —— 生命值补满',
    'hp_name:value=名字 —— 设置血量条名称',
  ] },
  { id: 'conditions', name: '失败/成功条件', desc: '实时显示当前海龟汤剧本的胜利/失败条件进度（条件名 + 次数/阈值）。隐藏条件达成后自动浮现。此卡只读，NPC 通过 [cond:] 标记推进条件，不直接修改。', npcCmds: [] },
];

const UI_TARGETS = { start_experience: '开始体验', script_library: '剧本库', desk_npc: '桌面 NPC' };

/** 基础环境（全站公共部分），各用例按需覆盖 */
function baseEnv(over) {
  return Object.assign({
    experience: { active: false, host_data: null },
    inventory: { active: false, state: { clues: [], items: [] } },
    status_uis: STATUS_UIS,
    npc_configs: NPC_CONFIGS_FX,
    available_defs: AVAILABLE_DEFS,
    emotion_effects: EMOTION_EFFECTS,
    ui_targets: UI_TARGETS,
  }, over || {});
}

/* ============ 玩家档案夹具 ============ */
const P_NEW = { proficiency: 'new', username: '新来的茶客', level: 1, scripts_completed: 0, scripts_uploaded: 0, achievement_points: 0 };
const P_REG = { proficiency: 'regular', username: '小何', level: 3, scripts_completed: 1, scripts_uploaded: 0, achievement_points: 120 };
const P_VET = { proficiency: 'veteran', username: '老饕', level: 12, scripts_completed: 37, scripts_uploaded: 4, achievement_points: 4820 };

/* ============ 剧本夹具（合成数据，不是线上真实汤底） ============ */
const HGT_FULL = {
  id: 'test-hgt-0001', title: '测试汤·完整条件表', categoryName: '海龟汤',
  story: '一个男人走进餐馆点了一碗海龟汤，喝了一口就哭了。为什么？',
  explanation: '他小时候遇海难，母亲告诉他那是海龟汤；他此刻才尝出那其实是母亲的肉。',
  ending_condition: '',
  endings: [
    { id: 'e1', name: '真相大白', type: 'win', note: '', threshold: 1, conditions: [
      { id: 'c1', rule: '说出海难经历', hidden: false },
      { id: 'c2', rule: '识破汤是母亲的肉', hidden: true },
    ] },
    { id: 'e2', name: '错失真相', type: 'lose', note: '问满 30 次仍未触及核心', threshold: 1, conditions: [
      { id: 'c9', rule: '超过回合上限', hidden: true },
    ] },
  ],
  tasks: [
    { id: 't1', name: '取回航海日志', note: '玩家找到线索后解锁', conditions: [
      { id: 'tc1', rule: '玩家提出查看旧物', hidden: false },
    ] },
  ],
  host_guide: '开局先问玩家是否玩过海龟汤；回答只给判定，不给方向。',
};

const HGT_BARE = {
  id: 'test-hgt-0002', title: '测试汤·无条件表（旧剧本）', categoryName: '海龟汤',
  story: '电梯里只有他一个人。他按了 12 楼，走到一半却开始尖叫。为什么？',
  explanation: '他是侏儒，够不到 12 楼的按钮，只能按到 7 楼再走楼梯；今天他发现按钮变矮了。',
  ending_condition: '玩家完整复述侏儒与身高的关系',
  endings: [], tasks: [], host_guide: '',
};

const DND_SCRIPT = {
  id: 'test-dnd-0001', title: '测试团·地城', categoryName: 'DND 跑团',
  story: '你们被雇佣清理一座废弃矿坑。', explanation: '矿坑深处是一只会说人话的食人魔。',
  ending_condition: '击败食人魔或与其达成交易', endings: [], tasks: [], host_guide: '',
};
const COC_SCRIPT = {
  id: 'test-coc-0001', title: '测试团·调查员', categoryName: 'COC 跑团',
  story: '一封来自老友的信，字迹潦草。', explanation: '老友已经被某种东西替换了。',
  ending_condition: 'SAN 归零或查明真相', endings: [], tasks: [], host_guide: '',
};
const ACTING_SCRIPT = {
  id: 'test-act-0001', title: '测试本·对戏', categoryName: '剧本扮演',
  story: '雨夜的茶馆，你推门进来。', explanation: '没有真相，这是一场即兴对戏。',
  ending_condition: '玩家主动收尾', endings: [], tasks: [], host_guide: '',
};

/** 复刻 Experience._buildHostData 的占位符填充 */
function fill(tpl, s) {
  return (tpl || '')
    .replace(/\{story\}/g, s.story || '')
    .replace(/\{explanation\}/g, s.explanation || '')
    .replace(/\{ending_condition\}/g, s.ending_condition || '')
    .replace(/\{title\}/g, s.title || '')
    .replace(/\{script_id\}/g, s.id || '');
}

/** 造体验态环境：host_data 与 Experience._buildHostData 同构 */
function expEnv(script, modeFile, over) {
  const host_data = { guide: '', modePrompt: fill(readShared(modeFile), script), script };
  return baseEnv(Object.assign({
    experience: { active: true, host_data },
    inventory: {
      active: true,
      state: {
        clues: [
          { text: '一张褪色的船票', source: '询问男人随身物品' },
          { text: '半张泛黄的照片', source: '' },
        ],
        items: [{ text: '母亲留下的汤勺', source: '完成 t1' }],
      },
    },
  }, over || {}));
}

const CASES = [
  /* ---- default ×6 ---- */
  { name: '01-default-dagou-new', note: '默认态 · 大狗 · 新玩家', npcId: 'dagou', webState: 'default', playerInfo: P_NEW, env: baseEnv() },
  { name: '02-default-xiaomei-veteran', note: '默认态 · 小梅 · 老玩家', npcId: 'xiaomei', webState: 'default', playerInfo: P_VET, env: baseEnv() },
  { name: '03-default-xiaoshuai-regular', note: '默认态 · 小帅 · 普通玩家', npcId: 'xiaoshuai', webState: 'default', playerInfo: P_REG, env: baseEnv() },
  { name: '04-default-jingyuniang-new', note: '默认态 · 鲸鱼娘 · 新玩家（未开放任何动画）', npcId: 'jingyuniang', webState: 'default', playerInfo: P_NEW, env: baseEnv() },
  { name: '05-default-npc-null', note: '默认态 · 无 npcId → capability 为 null，G 节整体消失；且无私有提示词', npcId: null, webState: 'default', playerInfo: P_REG, env: baseEnv() },
  { name: '06-default-no-player', note: '默认态 · 无 playerInfo → I 玩家信息 消失', npcId: 'dagou', webState: 'default', playerInfo: null, env: baseEnv() },

  /* ---- default 边界 ×2 ---- */
  { name: '07-default-npc-missing', note: '默认态 · alex（线上只有 soul+tools，无 iron_rules/guide/game_mode）', npcId: 'alex', webState: 'default', playerInfo: P_NEW,
    env: baseEnv({ npc_configs: Object.assign({}, NPC_CONFIGS_FX, { alex: { enabled_emotions: ['normal', 'happy'], enabled_actions: [] } }) }) },
  { name: '08-default-array-tools', note: '规则3 · 同类型 tools 两份 → 必须是数组 [私有, 共享]（线上常态）', npcId: 'dagou', webState: 'default', playerInfo: P_REG,
    prompts: [
      ...getPromptsFor('dagou').filter((p) => p.prompt_type !== 'tools'),
      { npc_id: 'dagou', personality_id: '', prompt_type: 'tools', content: '{"私有工具": "只有大狗能用的工具"}' },
      { npc_id: 'shared', personality_id: '', prompt_type: 'tools', content: '{"共享工具": "所有 NPC 都能用"}' },
    ],
    env: baseEnv() },

  /* ---- browsing ×5 ---- */
  { name: '09-browsing-dagou-new', note: '浏览态 · sidebar_guide 为空 → 回退 guide（子键名仍是「侧边栏状态引导」）', npcId: 'dagou', webState: 'browsing', playerInfo: P_NEW, env: baseEnv() },
  { name: '10-browsing-xiaomei-veteran', note: '浏览态 · 小梅 · 老玩家', npcId: 'xiaomei', webState: 'browsing', playerInfo: P_VET, env: baseEnv() },
  { name: '11-browsing-xiaoshuai-regular', note: '浏览态 · 小帅 · 普通玩家', npcId: 'xiaoshuai', webState: 'browsing', playerInfo: P_REG, env: baseEnv() },
  { name: '12-browsing-jingyuniang-new', note: '浏览态 · 鲸鱼娘 · 新玩家', npcId: 'jingyuniang', webState: 'browsing', playerInfo: P_NEW, env: baseEnv() },
  { name: '13-browsing-no-player', note: '浏览态 · 无 playerInfo', npcId: 'dagou', webState: 'browsing', playerInfo: null, env: baseEnv() },

  /* ---- experience ×5 ---- */
  { name: '14-experience-hgt-full', note: '体验态 · 海龟汤 · 完整条件表（endings+tasks+host_guide+线索道具）', npcId: 'dagou', webState: 'experience', playerInfo: P_NEW, env: expEnv(HGT_FULL, 'game_mode_turtle_soup.txt') },
  { name: '15-experience-hgt-bare', note: '体验态 · 海龟汤 · 无条件表（旧剧本，条件结算系统空转）', npcId: 'dagou', webState: 'experience', playerInfo: P_REG, env: expEnv(HGT_BARE, 'game_mode_turtle_soup.txt') },
  { name: '16-experience-dnd', note: '体验态 · DND 跑团', npcId: 'xiaoshuai', webState: 'experience', playerInfo: P_VET, env: expEnv(DND_SCRIPT, 'game_mode_dnd.txt') },
  { name: '17-experience-coc', note: '体验态 · COC 跑团', npcId: 'jingyuniang', webState: 'experience', playerInfo: P_REG, env: expEnv(COC_SCRIPT, 'game_mode_coc.txt') },
  { name: '18-experience-acting', note: '体验态 · 剧本扮演', npcId: 'xiaomei', webState: 'experience', playerInfo: P_NEW, env: expEnv(ACTING_SCRIPT, 'game_mode_script_acting.txt') },

  /* ---- experience 边界 ×2 ---- */
  { name: '19-experience-no-inventory', note: '体验态 · 线索面板未激活 → E 组整体消失', npcId: 'dagou', webState: 'experience', playerInfo: P_REG,
    env: expEnv(HGT_FULL, 'game_mode_turtle_soup.txt', { inventory: { active: false, state: { clues: [], items: [] } } }) },
  { name: '20-experience-inactive-fallback', note: '体验态防御 · Experience 未激活 → 回退 default 配方（且必须打 warn）', npcId: 'dagou', webState: 'experience', playerInfo: P_REG,
    env: baseEnv({ experience: { active: false, host_data: null } }) },
];

module.exports = { CASES, AVAILABLE_DEFS, EMOTION_EFFECTS, NPC_CONFIGS_FX, STATUS_UIS, UI_TARGETS, baseEnv, expEnv, fill };
