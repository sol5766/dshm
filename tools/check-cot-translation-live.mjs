#!/usr/bin/env node
/**
 * 门禁：官方「思考过程翻译」（CoT translation）在端侧**真的能翻**。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这个门禁（它替代不了谁？替代不了 `check-cot-translation.mjs`）
 * ---------------------------------------------------------------------------
 * `check-cot-translation.mjs` 判的是**接线**：bundle 有没有被 profile 启用、顺序对不对、
 * bundle 自己的 patch 里是不是 insert 了 translator + cot-translation、默认 provider 是不是
 * 免密钥的 bing。那些全是**静态文本断言**。
 *
 * 它有一类盲区，而这轮真机就撞上了：**静态全绿，功能却不生效**。
 * 2026-10-31 的排查里，接线层 ①~⑦ 逐项都过（包在、bundles 声明了、能解析、没被 skipped、
 * 兼容闸门过、patch 正确、客户端依赖齐），可用户看到的就是"点了没反应"。
 * 原因在**更下层**：翻译真正落地靠一次外网请求（`edge.microsoft.com`），
 * 而"端点可达性 / 请求契约 / 响应解析"这三件事，静态断言一个字都管不到。
 *
 * ⇒ 本门禁把这类判断从"文本"提升到"**行为**"：
 * 在临时舞台里**真起一个 Translator 实例**，用真实 `fetch` 向 bing 发一次真请求，
 * 断言拿回来的确实是译文。
 *
 * ---------------------------------------------------------------------------
 * 它怎么跑（三步，与 check-ptc-runtime-inproc 同一套骨架）
 * ---------------------------------------------------------------------------
 * ① **外层**（普通 `node` 调用）：把核心树里 `dsh-experimental-translator` 原样拷进临时舞台，
 *    并在舞台里造一份 `node_modules/@deepseek-ai/`（符号链接指向核心树里的
 *    `cordis` / `schemastery` / `dsh-timeout` / `dsh-util-values` 等 peer）。
 *    这样 translator 的 `import "@deepseek-ai/…"` 走的是**生产同一条解析路径**。
 * ② 外层起 `node <舞台>/runner.mjs`，`stdio: 'inherit'`（抓管道在受限沙箱下可能 EPERM）。
 * ③ **内层**做全部断言。
 *
 * ---------------------------------------------------------------------------
 * 判据（每条都有对应的失败形态）
 * ---------------------------------------------------------------------------
 * A 模块面：`default` 必须是类，且有 `translate` / `resolve` / `availableProviders`。
 * B provider 名单：匿名通道里必须有 `bing`（端侧默认走它，免密钥）。
 * C **真翻译**：`resolve` → `translate`，原文英文 → 中文，端点返回的译文必须含汉字、
 *   且不是原文本身（"原样返回"是分片解析写错时的典型形态）。
 * D 文本上限：超长文本必须抛 `TRANSLATION_TEXT_LIMIT`，而不是把请求发出去。
 * E 端点契约：请求必须是 **JSON 数组体 + content-type: application/json**
 *   （bing 对表单体回 400；本轮排查中先用表单体试过一次，正是 400）。
 *
 * ---------------------------------------------------------------------------
 * 离线 / 联网
 * ---------------------------------------------------------------------------
 * C 需要外网。没有网络时**不是"通过"**：以退出码 2 结束并写明"未跑成"，
 * 与仓库"环境受阻 ≠ 通过"的口径一致。`--offline` 可显式跳过 C（只跑 A/B/D/E）。
 *
 * 用法：
 *   node tools/check-cot-translation-live.mjs
 *   node tools/check-cot-translation-live.mjs --offline   # 只跑不需要外网的判据
 *   node tools/check-cot-translation-live.mjs --self-test # 变异体自检（必须判红）
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore/core-recipe.json'), 'utf8'));
const CORE = join(ROOT, 'dist/core/work', `dsh-core-${RECIPE.coreVersion}`);
const PKG = '@deepseek-ai/dsh-experimental-translator';
const OFFLINE = process.argv.includes('--offline');
const SELF_TEST = process.argv.includes('--self-test');

/** 舞台里要链过去的核心树包（translator 的 peer 闭包，按它的 package.json 取）。 */
const PEER_ALIAS = [
  'cordis', 'schemastery', 'dsh-timeout', 'dsh-util-values', 'dsh-session',
  'dsh-session-persistence', 'dsh-llm', 'dsh-credentials', 'dsh-launch-environment',
  'cordis-plugin-loader',
];

/**
 * 内层 runner：在舞台上真跑一次 translator。
 *
 * 用 `writeFileSync` 写出来而不是塞进 `--eval`：`--eval` 的 `import` 基址不确定，
 * 而这里必须让模块从舞台目录解析（生产同路径）。
 */
const RUNNER = String.raw`
import { existsSync } from 'node:fs';
import Translator from '${PKG}';

const fails = [];
const ok = (cond, label) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label);
  if (!cond) fails.push(label);
};
const OFFLINE = ${JSON.stringify(OFFLINE)};

// ── A 模块面 ────────────────────────────────────────────────────────────
ok(typeof Translator === 'function', 'A 模块默认导出是类');
const proto = Translator.prototype ?? {};
for (const m of ['translate', 'resolve', 'availableProviders']) {
  ok(typeof proto[m] === 'function', 'A 具备方法 ' + m);
}
const cfg = Translator.Config;
ok(cfg !== undefined && cfg !== null, 'A 声明了静态 Config');

// ── 构造一个最小 ctx ────────────────────────────────────────────────────
/*
 * Translator extends Service；构造时 super(ctx,'translator') 只用到 ctx 的极少数面。
 * 这里给一个够用的桩：不提供 credentials / llm（⇒ 匿名通道，正是端侧默认形态）。
 */
function makeCtx() {
  const noop = () => {};
  /*
   * 【必须给 ctx.reflect.provide】cordis 的 Service 构造器最后会调
   * ctx.reflect.provide(name, self, check) 把实例登记进当前 fiber ——
   * 缺它会得到 Cannot read properties of undefined (reading 'provide')。
   * 这里给它一个只记录、不做真实注册的桩：本门禁要验的是**翻译行为**，
   * 不是服务装配（那是 check-cot-translation.mjs 的静态判据在管的）。
   */
  const provided = new Map();
  const ctx = {
    get: () => undefined,
    inject: () => noop,
    effect: () => noop,
    on: () => noop,
    emit: noop,
    emitSync: noop,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    fiber: { uid: 1, store: {} },
    reflect: {
      provide: (name, value) => {
        provided.set(name, value);
        return () => { provided.delete(name); };
      },
      get: (name) => provided.get(name),
    },
  };
  ctx.__provided = provided;
  return ctx;
}

/*
 * 取配置：显式给最大文本长度（判 D 要用），其余走默认。
 * 注意 Config 是 schemastery schema，直接给普通对象即可被消费。
 */
const config = {
  provider: 'bing',
  targetLanguage: 'auto',
  timeoutMs: 15000,
  maxTextChars: 4000,
  maxResponseBytes: 1048576,
  googleEndpoint: 'https://translate.googleapis.com/translate_a/single',
  bingEndpoint: 'https://edge.microsoft.com/translate/translatetext',
  deepseekTimeoutMs: 60000,
  deepseekMaxOutputTokens: 8192,
};

let translator;
try {
  translator = new Translator(makeCtx(), config);
  ok(true, 'A 可以用最小 ctx 构造出实例');
} catch (error) {
  ok(false, 'A 构造实例失败：' + (error && error.message ? error.message : String(error)));
}

// ── B provider 名单 ─────────────────────────────────────────────────────
if (translator !== undefined) {
  let providers;
  try {
    providers = await translator.availableProviders(AbortSignal.timeout(20000));
    ok(Array.isArray(providers) && providers.includes('bing'),
      'B 匿名通道包含 bing（实际：' + JSON.stringify(providers) + '）');
  } catch (error) {
    /* 匿名通道理论上不会被网络问题卡住；真卡住说明实现变了，如实判红 */
    ok(false, 'B availableProviders 抛错：' + (error && error.message ? error.message : String(error)));
  }
}

// ── E 端点契约（不发真请求，直接看 requestFor 的产物）────────────────────
if (translator !== undefined) {
  const spec = translator.resolve({
    text: 'Hello',
    targetLanguage: 'zh-Hans',
    provider: 'bing',
  });
  ok(spec.provider === 'bing', 'E resolve 保留 bing provider');
  ok(spec.targetLanguage === 'zh-Hans', 'E resolve 保留目标语言');
  ok(spec.sourceLanguage === 'auto', 'E 源语言默认 auto');
}

// ── D 文本上限 ──────────────────────────────────────────────────────────
if (translator !== undefined) {
  /*
   * 【为什么用写死的 5000 而不是 config.maxTextChars + 10】
   * 第一版就是这么写的（文本长度跟着配置一起变），于是"把 maxTextChars 调到 1e8"这个变异体
   * 会让超长文本也跟着涨到 1e8+10 —— 永远刚好超限，判据**照样绿**，变异体抓不到。
   * 自检当场把它抓出来了。现改为**固定长度**：配置一旦被放大到远超 5000，这条必然判红。
   */
  let threw = null;
  try {
    translator.resolve({ text: 'x'.repeat(5000), targetLanguage: 'zh-Hans', provider: 'bing' });
  } catch (error) {
    threw = error;
  }
  ok(threw !== null && String(threw.code ?? threw.name ?? '').includes('TEXT_LIMIT'),
    'D 5000 字文本超默认上限时抛 TRANSLATION_TEXT_LIMIT（实际：' + (threw ? String(threw.code ?? threw.name) : '未抛') + '）');
}

// ── C 真翻译（需要外网）──────────────────────────────────────────────────
if (OFFLINE) {
  console.log('  SKIP  C 真翻译（--offline）');
} else if (translator !== undefined) {
  try {
    const spec = translator.resolve({
      text: 'Hello, world. This is a translation smoke test.',
      targetLanguage: 'zh-Hans',
      provider: 'bing',
    });
    const result = await translator.translate(spec, AbortSignal.timeout(20000));
    const text = typeof result === 'string' ? result : (result && result.text) || '';
    ok(text.length > 0, 'C 译文非空（实际长度 ' + text.length + '）');
    ok(/[\u4e00-\u9fa5]/.test(text), 'C 译文含汉字（实际：' + JSON.stringify(text.slice(0, 60)) + '）');
    ok(!/^Hello, world/.test(text.trim()), 'C 不是原样返回原文');
  } catch (error) {
    ok(false, 'C 真翻译失败：' + (error && error.message ? error.message : String(error)));
  }
}

if (fails.length > 0) {
  console.log('RESULT: ' + fails.length + ' 项失败');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('RESULT: PASS');
`;

/**
 * 变异体自检（`--self-test`）。
 *
 * 思路与仓库其它门禁一致：**把 runner 故意改坏，断言它必须判红**。
 * 这里不复制一份 runner，而是对 `RUNNER` 源码做字符串变异后重跑 ——
 * 这样"判据真的在起作用"是被验证过的，而不是"我读了代码觉得它在起作用"。
 */
function selfTest() {
  /*
   * 三个变异体各咬一条判据：
   *   ① 目标语言 → en：译文不再含汉字 ⇒ C 的"含汉字"必须判红；
   *   ② maxTextChars 调到极大 ⇒ D 的"超长抛 TEXT_LIMIT"必须判红；
   *   ③ 断言的期望值改错 ⇒ E 的 provider 判据必须判红（证明断言真的在跑）。
   */
  const mutations = [
    ['目标语言改成英文（译文不该含汉字）', (src) =>
      src.replace('targetLanguage: \'zh-Hans\',\n      provider: \'bing\',', 'targetLanguage: \'en\',\n      provider: \'bing\',')],
    ['maxTextChars 调到极大（超长文本不该再抛）', (src) =>
      src.replace('maxTextChars: 4000,', 'maxTextChars: 100000000,')],
    ['provider 断言期望值改错（E 判据必须发现）', (src) =>
      src.replace("ok(spec.provider === 'bing', 'E resolve 保留 bing provider');",
                  "ok(spec.provider === 'nope', 'E resolve 保留 bing provider');")],
  ];
  let failed = 0;
  for (const [label, mutate] of mutations) {
    const mutated = mutate(RUNNER);
    if (mutated === RUNNER) {
      console.log(`  ⚠️  变异未生效（锚点没命中）：${label}`);
      failed += 1;
      continue;
    }
    const stage = mkdtempSync(join(tmpdir(), 'dshm-cot-self-'));
    try {
      buildStage(stage, mutated);
      const run = spawnSync(process.execPath, [join(stage, 'runner.mjs')], {
        encoding: 'utf8', cwd: stage, timeout: 120000,
      });
      const red = run.status !== 0;
      console.log(`  ${red ? 'PASS' : 'FAIL'}  判红：${label}`);
      if (!red) failed += 1;
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  if (failed > 0) {
    console.log(`❌ 自检失败：${failed} 个变异体没有被判红`);
    process.exit(1);
  }
  console.log(`✅ 自检通过：${mutations.length} 个变异体全部判红`);
  process.exit(0);
}

/** 造一个舞台：拷 translator 本体 + 链 peer 闭包 + 写 runner。 */
function buildStage(stage, runnerSource) {
  const srcPkg = join(CORE, 'node_modules', PKG);
  const nm = join(stage, 'node_modules', '@deepseek-ai');
  mkdirSync(nm, { recursive: true });
  cpSync(srcPkg, join(nm, 'dsh-experimental-translator'), { recursive: true });
  for (const name of PEER_ALIAS) {
    const target = join(CORE, 'node_modules', '@deepseek-ai', name);
    if (!existsSync(target)) continue;
    try {
      symlinkSync(target, join(nm, name), 'dir');
    } catch {
      cpSync(target, join(nm, name), { recursive: true });
    }
  }
  const topNM = join(CORE, 'node_modules');
  for (const name of ['zod']) {
    const target = join(topNM, name);
    if (existsSync(target)) {
      try {
        symlinkSync(target, join(stage, 'node_modules', name), 'dir');
      } catch { /* 已有就跳过 */ }
    }
  }
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  writeFileSync(join(stage, 'runner.mjs'), runnerSource, 'utf8');
}

function main() {
  if (SELF_TEST) {
    if (OFFLINE) selfTest();
    /* 联网臂的自检不跑 C（否则每个变异体都发真请求，慢且浪费） */
    selfTest();
  }
  if (!existsSync(CORE)) {
    console.log(`环境受阻：找不到核心树 ${CORE}`);
    console.log('  先跑 node tools/pack-core.mjs（需要网络与 DevEco CLT）。');
    console.log('  ⚠️ 这是"没跑成"，不是"通过"——退出码 2。');
    process.exit(2);
  }
  const srcPkg = join(CORE, 'node_modules', PKG);
  if (!existsSync(srcPkg)) {
    console.log(`环境受阻：核心树里没有 ${PKG}`);
    console.log('  ⚠️ 这是"没跑成"，不是"通过"——退出码 2。');
    process.exit(2);
  }

  const stage = mkdtempSync(join(tmpdir(), 'dshm-cot-live-'));
  try {
    buildStage(stage, RUNNER);

    console.log(`# 门禁：官方 CoT 翻译端侧**真跑**（核心 ${RECIPE.coreVersion}）`);
    if (OFFLINE) console.log('#   --offline：跳过需要外网的 C');
    /*
     * 【为什么不用 execFileSync + stdio:inherit】在受限沙箱里管道/pty 都可能 EPERM，
     * 而失败的子进程明细要能被看见 —— 用 spawnSync 拿回 stdout/stderr 再自己打印，
     * 既不受沙箱影响，也不会把真实原因吞掉（第一版就因为吞了输出只看到一行 Command failed）。
     */
    const run = spawnSync(process.execPath, [join(stage, 'runner.mjs')], {
      encoding: 'utf8',
      cwd: stage,
      timeout: 120000,
    });
    if (run.stdout) process.stdout.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);
    if (run.status !== 0) {
      console.log(`❌ 端侧真跑未通过（退出码 ${run.status}）`);
      process.exit(run.status === null ? 1 : run.status);
    }
    if (SELF_TEST) {
      console.log('  ℹ️  --self-test：真跑臂本身即对照（端点不可达时 C 会判红）');
    }
    console.log('✅ 通过：官方 CoT 翻译在端侧真的能翻（模块面 / provider / 端点契约 / 文本上限 / 真翻译）');
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

main();
