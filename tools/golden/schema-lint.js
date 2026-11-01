/**
 * 契约 schema 校验（零依赖）
 * ------------------------------------------------------------------
 * 用法：
 *   node tools/golden/schema-lint.js               # 正常校验
 *   node tools/golden/schema-lint.js --selftest    # 额外跑 8 条「故意做错」的反例，确认校验器真的会拒
 *
 * 做四件事：
 *   1. 检查 docs/contract.schema.json 里每个 $ref 都能解析（防断链）
 *   2. 拿 20 组黄金样本的 output 校验 $defs/PromptBundle（契约说的形状，实现真做到了吗）
 *   3. 拿 schema 自带 examples 校验 $defs/SessionData
 *   4. --selftest：喂反例，确认「全绿」不是因为校验器啥也没查
 *
 * 只实现本契约用到的 JSON Schema 子集；遇到不认识的 keyword **直接报错**，
 * 而不是默默跳过 —— 免得哪天 schema 里写了个没人执行的关键字还以为它在管用。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.resolve(__dirname, '../../docs/contract.schema.json');
const SAMPLES = path.join(__dirname, 'samples');
const ROOT_MARK = '$';

const EXEC_KEYWORDS = new Set([
  '$ref', 'type', 'enum', 'const', 'properties', 'additionalProperties', 'required',
  'propertyNames', 'items', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
  'oneOf', 'anyOf', 'allOf', 'not', 'minimum',
]);
const ANNOTATIONS = new Set([
  '$schema', '$id', '$comment', '$defs', 'title', 'description', 'examples', 'default', 'format',
]);

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error('只支持 #/ 开头的本地 $ref：' + ref);
  let node = root;
  for (const seg of ref.slice(2).split('/')) {
    node = node && node[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error('$ref 断链: ' + ref);
  }
  return node;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function checkTypes(want, v) {
  const list = Array.isArray(want) ? want : [want];
  const got = typeOf(v);
  return list.some((t) => t === got || (t === 'number' && got === 'integer'));
}

/** 校验 schema 自身：$ref 可达 + 无未实现关键字 */
function auditSchema(node, root, at, problems) {
  if (Array.isArray(node)) { node.forEach((n, i) => auditSchema(n, root, at + '[' + i + ']', problems)); return; }
  if (!node || typeof node !== 'object') return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (EXEC_KEYWORDS.has(k)) {
      if (k === '$ref') { try { resolveRef(root, v); } catch (e) { problems.push(at + ': ' + e.message); } }
      else if (k === 'required') { /* 字符串数组，不是 schema */ }
      else auditSchema(v, root, at + '.' + k, problems);
    } else if (!ANNOTATIONS.has(k)) {
      problems.push(at + ': 未实现的关键字 "' + k + '"（要么加进 EXEC_KEYWORDS，要么别用）');
    }
  }
}

function validate(schema, v, root, at, errs) {
  if (schema === true || !schema || typeof schema !== 'object') return;
  if (schema.$ref) { validate(resolveRef(root, schema.$ref), v, root, at, errs); return; }

  if (schema.type !== undefined && !checkTypes(schema.type, v)) {
    errs.push(at + ': 期望类型 ' + JSON.stringify(schema.type) + '，实际 ' + typeOf(v));
    return;
  }
  if (schema.const !== undefined && JSON.stringify(v) !== JSON.stringify(schema.const)) {
    errs.push(at + ': 期望常量 ' + JSON.stringify(schema.const) + '，实际 ' + JSON.stringify(v));
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) {
    errs.push(at + ': 值 ' + JSON.stringify(v) + ' 不在枚举 ' + JSON.stringify(schema.enum) + ' 里');
  }
  if (schema.minimum !== undefined && typeof v === 'number' && v < schema.minimum) {
    errs.push(at + ': ' + v + ' < minimum ' + schema.minimum);
  }
  if (schema.not) {
    const sub = []; validate(schema.not, v, root, at, sub);
    if (!sub.length) errs.push(at + ': 命中了 not 子句（本不该匹配）');
  }

  if (typeOf(v) === 'array') {
    if (schema.minItems !== undefined && v.length < schema.minItems) errs.push(at + ': 数组长度 ' + v.length + ' < minItems ' + schema.minItems);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errs.push(at + ': 数组长度 ' + v.length + ' > maxItems ' + schema.maxItems);
    if (schema.items) v.forEach((it, i) => validate(schema.items, it, root, at + '[' + i + ']', errs));
  }

  if (typeOf(v) === 'object') {
    const keys = Object.keys(v);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errs.push(at + ': 只有 ' + keys.length + ' 个键 < minProperties ' + schema.minProperties);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errs.push(at + ': ' + keys.length + ' 个键 > maxProperties ' + schema.maxProperties);
    (schema.required || []).forEach((r) => { if (!(r in v)) errs.push(at + ': 缺少必填字段 "' + r + '"'); });
    if (schema.propertyNames) keys.forEach((k) => validate(schema.propertyNames, k, root, at + '<键名>', errs));
    const props = schema.properties || {};
    for (const k of keys) {
      if (props[k]) validate(props[k], v[k], root, at + '.' + k, errs);
      else if (schema.additionalProperties === false) errs.push(at + ': 不允许的字段 "' + k + '"');
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v[k], root, at + '.' + k, errs);
    }
  }

  ['allOf', 'anyOf', 'oneOf'].forEach((kw) => {
    if (!schema[kw]) return;
    const subs = schema[kw].map((s) => { const e = []; validate(s, v, root, at, e); return e; });
    const okCount = subs.filter((e) => e.length === 0).length;
    if (kw === 'allOf' && okCount !== subs.length) errs.push(at + ': allOf 有 ' + (subs.length - okCount) + ' 条不满足');
    if (kw === 'anyOf' && okCount === 0) errs.push(at + ': anyOf 全都不满足');
    if (kw === 'oneOf' && okCount !== 1) errs.push(at + ': oneOf 期望恰好 1 条满足，实际 ' + okCount + ' 条');
  });
}

function expectReject(root, list) {
  let bad = 0;
  for (const [label, defName, doc] of list) {
    const errs = [];
    validate(root.$defs[defName], doc, root, ROOT_MARK, errs);
    if (errs.length) console.log('✓ 反例已被拒：' + label);
    else { console.log('✗ 反例本该被拒却通过了！' + label); bad++; }
  }
  return bad;
}

const NEGATIVES = [
  ['顶层多一个键', 'PromptBundle', { '工作流程（最高优先级，务必逐级严格遵循）': 'x', '多余键': 1 }],
  ['槽位名多写一个字', 'PromptBundle', { '资料库（按需查阅）': { 'A 角色设定X': '内容' } }],
  ['多分节组不许是字符串', 'PromptBundle', { '资料库（按需查阅）': { 'C 网页面板引导': '一段话' } }],
  ['回退命中后子键名写错', 'PromptBundle', { '资料库（按需查阅）': { 'C 侧边栏引导': { '侧边栏引导': 'x' } } }],
  ['单份内容不许是数组', 'PromptBundle', { '资料库（按需查阅）': { 'D 工具手册': ['只有一份'] } }],
  ['相位 preparing 已删除', 'SessionData', { schema: 2, phase: 'preparing', owner_user_id: 'u' }],
  ['缺 owner_user_id', 'SessionData', { schema: 2, phase: 'hosting' }],
  ['ending_type 只能是 win/lose', 'SessionData', { schema: 2, phase: 'ended', owner_user_id: 'u', ending_type: 'draw' }],
];

function main() {
  const root = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  let bad = 0;

  const problems = [];
  auditSchema(root, root, ROOT_MARK, problems);
  if (problems.length) { bad += problems.length; problems.forEach((p) => console.log('✗ schema ' + p)); }
  else console.log('✓ schema 自审通过（$ref 全部可达，无未实现关键字）');

  const files = fs.readdirSync(SAMPLES).filter((f) => /^\d\d-.*\.json$/.test(f)).sort();
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(SAMPLES, f), 'utf8'));
    let parsed;
    try { parsed = JSON.parse(s.output); } catch (e) { console.log('✗ ' + s.name + ' 输出不是合法 JSON'); bad++; continue; }
    const errs = [];
    validate(root.$defs.PromptBundle, parsed, root, ROOT_MARK, errs);
    if (errs.length) { bad += errs.length; console.log('✗ ' + s.name); errs.slice(0, 5).forEach((e) => console.log('    ' + e)); }
    else console.log('✓ ' + s.name + ' 符合 PromptBundle');
  }

  (root.$defs.SessionData.examples || []).forEach((ex, i) => {
    const errs = [];
    validate(root.$defs.SessionData, ex, root, ROOT_MARK, errs);
    if (errs.length) { bad += errs.length; console.log('✗ SessionData 示例[' + i + '] (phase=' + ex.phase + ')'); errs.forEach((e) => console.log('    ' + e)); }
    else console.log('✓ SessionData 示例[' + i + '] (phase=' + ex.phase + ') 符合');
  });

  if (process.argv.includes('--selftest')) {
    console.log('\n--- 反例自测（以下每条都必须被拒） ---');
    bad += expectReject(root, NEGATIVES);
  }

  console.log(bad ? '\n❌ ' + bad + ' 处不通过' : '\n✅ 全部通过');
  process.exit(bad ? 1 : 0);
}
main();
