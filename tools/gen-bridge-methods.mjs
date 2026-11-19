#!/usr/bin/env node
/**
 * 桥接方法表生成器（单一真源 → 生成清单）。
 *
 * 【为什么需要】`methodList` 与 `private bridges` 是两份人工维护的清单：漏登记 ⇒ ArkWeb
 * 每次调用报 not found（2026-10-29 真机事故：124,000+ 条报错、约 60% 日志字节）；
 * 多定义 ⇒ 死代码。人工对照会漂移，这里从**定义侧**生成清单，再由门禁比对。
 *
 * 用法：
 *   node tools/gen-bridge-methods.mjs            # 写入 tools/bridge-methods.generated.json
 *   node tools/gen-bridge-methods.mjs --check    # 只校验，不写；过期/不一致 ⇒ rc=1
 *
 * 输出结构（稳定、便于 diff）：
 *   { "entry": { "defined": [...], "registered": [...] }, "phone": {...} }
 * 两个数组都排序；`defined` 来自 bridges 对象，`registered` 来自 methodList。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'tools', 'bridge-methods.generated.json');
const FILES = {
  entry: 'entry/src/main/ets/pages/WebApp.ets',
  phone: 'phone/src/main/ets/pages/WebApp.ets',
};

export function collect(src) {
  const ml = src.match(/methodList:\s*\[([^\]]*)\]/);
  if (ml === null) return null;
  const registered = [...new Set(Array.from(ml[1].matchAll(/'([a-zA-Z]+)'/g), (m) => m[1]))].sort();
  const bridge = src.match(/private bridges: Record<string, Function> = \{([\s\S]*?)\n  \};/);
  if (bridge === null) return null;
  const defined = [...new Set(Array.from(bridge[1].matchAll(/(?:^\s+|,)\s*'([a-zA-Z]+)':\s*\(/gm), (m) => m[1]))].sort();
  return { defined, registered };
}

export function buildManifest() {
  const manifest = {};
  for (const [mod, rel] of Object.entries(FILES)) {
    const collected = collect(readFileSync(join(ROOT, rel), 'utf8'));
    if (collected === null) throw new Error(`${rel} 里找不到 methodList / bridges 对象`);
    manifest[mod] = collected;
  }
  return manifest;
}

function render(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function differences(manifest) {
  const problems = [];
  for (const [mod, { defined, registered }] of Object.entries(manifest)) {
    const definedSet = new Set(defined);
    const registeredSet = new Set(registered);
    for (const name of defined) {
      if (!registeredSet.has(name)) problems.push(`[${mod}] bridges 定义了 '${name}' 但 methodList 未登记（死代码）`);
    }
    for (const name of registered) {
      if (!definedSet.has(name)) problems.push(`[${mod}] methodList 登记了 '${name}' 但 bridges 没有定义`);
    }
  }
  return problems;
}

const check = process.argv.includes('--check');
try {
  const manifest = buildManifest();
  const problems = differences(manifest);
  if (check) {
    if (!existsSync(OUT)) {
      problems.push('生成清单不存在：先运行 node tools/gen-bridge-methods.mjs');
    } else if (readFileSync(OUT, 'utf8') !== render(manifest)) {
      problems.push('生成清单已过期：重新运行 node tools/gen-bridge-methods.mjs');
    }
    if (problems.length > 0) {
      console.error(`❌ 桥接方法表不一致（${problems.length} 处）：`);
      for (const p of problems) console.error(`   · ${p}`);
      process.exit(1);
    }
    console.log('✅ 通过：方法表与 bridges 定义一致，生成清单未过期。');
    process.exit(0);
  }
  writeFileSync(OUT, render(manifest), 'utf8');
  if (problems.length > 0) {
    console.error(`⚠ 已生成清单，但发现 ${problems.length} 处不一致（门禁会判红）：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log(`✅ 已生成 ${OUT}（entry ${manifest.entry.defined.length} 个方法 / phone ${manifest.phone.defined.length} 个方法）。`);
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
