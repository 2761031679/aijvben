/**
 * 黄金样本工具 · 抓取基准
 * ------------------------------------------------------------------
 * 用法：node tools/golden/capture.js
 * 产物：tools/golden/samples/NN-<case>.json + manifest.json
 *
 * 这一步要在**改动之前**跑，产出的就是「现在的行为」。
 * 样本完全自包含：prompts 列表 + 环境 env 全部内联，不依赖 npc_configs 目录。
 * 于是任何语言的实现都能只凭样本重放，用 compare.js 证明「没走样」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PB_PATH, NPC_CONFIGS, getPromptsFor, runWithEnv } = require('./lib');
const { CASES } = require('./cases');

const OUT = path.join(__dirname, 'samples');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPrompts() {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.txt')) h.update(path.relative(NPC_CONFIGS, p)).update('\0').update(fs.readFileSync(p));
    }
  };
  walk(NPC_CONFIGS);
  return h.digest('hex');
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const pbSha = sha256(fs.readFileSync(PB_PATH));
  const cfgSha = hashPrompts();
  const manifest = [];

  for (const c of CASES) {
    const input = {
      webState: c.webState,
      npcId: c.npcId === undefined ? null : c.npcId,
      playerInfo: c.playerInfo === undefined ? null : c.playerInfo,
      prompts_mode: c.prompts ? 'custom' : 'auto',
      prompts: c.prompts || getPromptsFor(c.npcId),
      env: c.env,
    };
    const { output, logs } = runWithEnv(input);
    const sample = {
      name: c.name,
      note: c.note,
      meta: {
        pb_sha256: pbSha,
        prompts_sha256: cfgSha,
        output_sha256: sha256(output),
        output_bytes: Buffer.byteLength(output, 'utf8'),
      },
      input,
      logs,
      output,
    };
    fs.writeFileSync(path.join(OUT, `${c.name}.json`), JSON.stringify(sample, null, 2) + '\n', 'utf8');
    manifest.push({ name: c.name, note: c.note, bytes: sample.meta.output_bytes, logs: logs.length });
    console.log(`✓ ${c.name}  ${sample.meta.output_bytes} B  ${logs.length} 条日志`);
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
    generated_by: 'tools/golden/capture.js',
    prompt_source: NPC_CONFIGS,
    pb_sha256: pbSha,
    prompts_sha256: cfgSha,
    count: manifest.length,
    cases: manifest,
  }, null, 2) + '\n', 'utf8');
  console.log(`\n共 ${manifest.length} 组样本 → ${path.relative(process.cwd(), OUT)}`);
}
main();
