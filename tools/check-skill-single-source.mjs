#!/usr/bin/env node
/*
 * check-skill-single-source.mjs —— P0-4（docs/388）：内置技能文档必须单源
 *
 * 【为什么需要】此前 entry HAP 与 hostruntime HSP 各带一份 `ohos-skills/*.md`，
 * 两份都打进 .app 且内容漂移：Host 的 `resRoot` 指向 **HSP** 的 resfile
 * （main.js `const resRoot = path.resolve(__dirname, '..', '..')`），设备实际读到的是
 * 10-22 的旧版（还残留「本工程不再包含 guest VM」这种已作废的引导），而 entry 那份
 * 10-25 新版只是死重。本门禁把「只留 HSP 一份 + 内容为新口径 + 门禁校验真源」钉死。
 *
 * 【用法】node tools/check-skill-single-source.mjs [--self-test]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const ENTRY_DIR = join(ROOT, 'entry/src/main/resources/resfile/ohos-skills');
const HSP_DIR = join(ROOT, 'hostruntime/src/main/resources/resfile/ohos-skills');
const EXPECTED = [
  'ohos-pc.md',
  'ohos-plugin-install.md',
  'ohos-python.md',
  'ohos-shell.md',
  'ohos-workspace.md',
];
const STALE_LINE = '本工程不再包含 guest VM';

/** 纯判据：入参是可观测事实（self-test 时在内存里变异），返回失败原因数组。 */
function evaluate({ entryExists, hspNames, hspTexts, bridgeSrc, mainSrc }) {
  const fails = [];
  const need = (cond, label) => { if (!cond) fails.push(label); };

  need(entryExists === false, 'D1 entry 侧仍存在 ohos-skills 副本（双份入包 + 误导源）');
  need(hspNames.length === EXPECTED.length && EXPECTED.every((n) => hspNames.includes(n)),
    'D2 HSP 侧技能文档不齐（应为 5 篇）');
  for (const n of EXPECTED) {
    const text = hspTexts[n] || '';
    need(text.length > 0, `D3 ${n} 内容为空`);
    need(!text.includes(STALE_LINE), `D4 ${n} 仍含已作废引导「${STALE_LINE}」`);
  }
  need(!bridgeSrc.includes('entry/src/main/resources/resfile/ohos-skills'),
    'D5 assert-python-bridge 还在校验 entry 副本（不是设备真源）');
  need(bridgeSrc.includes('hostruntime/src/main/resources/resfile/ohos-skills'),
    'D6 assert-python-bridge 未改校验 HSP 真源');
  need(mainSrc.includes("path.join(resRoot, 'ohos-skills')"),
    'D7 Host 的 ensureBundledSkills 未从 resRoot 读技能（真源漂移）');
  need((hspTexts['ohos-python.md'] || '').includes('/dshm-python/'),
    'D8 HSP 侧 ohos-python.md 缺 /dshm-python/ 端点口径');

  return fails;
}

function facts() {
  const hspNames = existsSync(HSP_DIR) ? readdirSync(HSP_DIR).filter((n) => n.endsWith('.md')).sort() : [];
  const hspTexts = {};
  for (const n of hspNames) {
    hspTexts[n] = readFileSync(join(HSP_DIR, n), 'utf8');
  }
  return {
    entryExists: existsSync(ENTRY_DIR),
    hspNames,
    hspTexts,
    bridgeSrc: readFileSync(join(ROOT, 'tools/assert-python-bridge.mjs'), 'utf8'),
    mainSrc: readFileSync(join(ROOT, 'hostcore/app/main.js'), 'utf8'),
  };
}

if (SELF_TEST) {
  const base = facts();
  const clean = evaluate(base);
  if (clean.length > 0) {
    console.error('FAIL：未变异的事实就没过判据：' + clean.join('；'));
    process.exit(1);
  }
  const mutations = [
    ['M1 entry 副本复活', (f) => ({ ...f, entryExists: true })],
    ['M2 HSP 少一篇', (f) => ({ ...f, hspNames: f.hspNames.slice(0, 4) })],
    ['M3 旧引导回流', (f) => ({ ...f, hspTexts: { ...f.hspTexts, 'ohos-shell.md': f.hspTexts['ohos-shell.md'] + '\n' + STALE_LINE } })],
    ['M4 某篇变空', (f) => ({ ...f, hspTexts: { ...f.hspTexts, 'ohos-pc.md': '' } })],
    ['M5 门禁回读 entry 副本', (f) => ({ ...f, bridgeSrc: f.bridgeSrc.replace('hostruntime/src/main/resources/resfile/ohos-skills', 'entry/src/main/resources/resfile/ohos-skills') })],
    ['M6 Host 不再从 resRoot 读', (f) => ({ ...f, mainSrc: f.mainSrc.replace("path.join(resRoot, 'ohos-skills')", "'/tmp/ohos-skills'") })],
    ['M7 端点口径丢失', (f) => ({ ...f, hspTexts: { ...f.hspTexts, 'ohos-python.md': (f.hspTexts['ohos-python.md'] || '').split('/dshm-python/').join('/hdsh-python/') } })],
  ];
  let passed = 0;
  for (const [label, mutate] of mutations) {
    const fails = evaluate(mutate(base));
    if (fails.length === 0) {
      console.error(`FAIL：${label} 没有判红`);
      process.exit(1);
    }
    passed += 1;
  }
  console.log(`OK：check-skill-single-source --self-test ${passed}/${mutations.length} 个变异体全部判红`);
  process.exit(0);
}

const fails = evaluate(facts());
if (fails.length > 0) {
  console.error('FAIL：' + fails.join('；'));
  process.exit(1);
}
console.log('OK：内置技能文档单源（HSP 5 篇新版，entry 无副本，门禁校验真源）');
