/**
 * 黄金样本工具 · 比对
 * ------------------------------------------------------------------
 * 用法：
 *   node tools/golden/compare.js                      # 用当前 prompt_builder.js 自查（应全绿）
 *   node tools/golden/compare.js --impl ./my.js       # 比对别的实现
 *   node tools/golden/compare.js --json               # 机器可读输出，给 CI 用
 *
 * --impl 指向的模块必须导出：
 *   module.exports = { build({ prompts, webState, npcId, playerInfo }) => string }
 * 返回值必须与 samples/*.json 的 output 字段**逐字节**相同。
 *
 * 这是 P0 的核心闸门：任何语言的实现只要过了这一关，
 * 就证明「组装出来的提示词和改之前一模一样」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { runWithEnv } = require('./lib');

const SAMPLES = path.join(__dirname, 'samples');

function loadDefaultImpl() {
  // 基准实现就是改动前的 prompt_builder.js 本身，所以自查必须全绿。
  return { build: (input) => runWithEnv(input).output };
}

/** 找第一处不同，返回人类可读的上下文 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  if (a.length !== b.length) return n;
  return -1;
}

function preview(s, at, pad = 40) {
  const s0 = Math.max(0, at - pad), s1 = Math.min(s.length, at + pad);
  return (s0 > 0 ? '…' : '') + s.slice(s0, s1).replace(/\n/g, '⏎') + (s1 < s.length ? '…' : '');
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const iIdx = argv.indexOf('--impl');
  const impl = iIdx >= 0 ? require(path.resolve(argv[iIdx + 1])) : loadDefaultImpl();
  if (typeof impl.build !== 'function') throw new Error('--impl 模块必须导出 build(input) 函数');

  const files = fs.readdirSync(SAMPLES).filter((f) => /^\d\d-.*\.json$/.test(f)).sort();
  if (!files.length) throw new Error('samples/ 里没有样本，先跑 capture.js');

  const results = [];
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(SAMPLES, f), 'utf8'));
    let got;
    try {
      got = impl.build(s.input);
    } catch (e) {
      results.push({ name: s.name, pass: false, reason: '抛异常: ' + e.message });
      continue;
    }
    if (got === s.output) {
      results.push({ name: s.name, pass: true, bytes: s.meta.output_bytes });
    } else {
      const at = firstDiff(got, s.output);
      results.push({
        name: s.name, pass: false,
        reason: `第 ${at} 字节起不同（期望 ${s.meta.output_bytes} B，实得 ${Buffer.byteLength(got, 'utf8')} B）`,
        expect_preview: preview(s.output, at),
        actual_preview: preview(got, at),
      });
    }
  }

  const bad = results.filter((r) => !r.pass);
  if (asJson) {
    console.log(JSON.stringify({ total: results.length, passed: results.length - bad.length, failed: bad.length, results }, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.pass ? '✓' : '✗'} ${r.name}${r.pass ? `  ${r.bytes} B` : ''}`);
      if (!r.pass) {
        console.log(`    ${r.reason}`);
        if (r.expect_preview) {
          console.log(`    期望: ${r.expect_preview}`);
          console.log(`    实得: ${r.actual_preview}`);
        }
      }
    }
    console.log(`\n${results.length - bad.length}/${results.length} 通过${bad.length ? '  ❌ 有回归' : '  ✅ 全部一致'}`);
  }
  process.exit(bad.length ? 1 : 0);
}
main();
