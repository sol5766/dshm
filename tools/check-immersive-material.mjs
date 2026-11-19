#!/usr/bin/env node
/**
 * 门禁：沉浸光感（API 26 uiMaterial）接线 —— 弹窗层与顶栏外壳（docs/280 步①②）。
 *
 * 【为什么需要】材质是"装饰性能力"，接错的表现是**静默降级或闪退**，不是构建失败：
 *   · `ImmersiveStyle` 在未实现设备上是 undefined ⇒ 直接访问抛错、组件更新闪退循环
 *     （真机踩过，docs/196）——所以**兜底双保险**（API<26 判定 + try/catch → undefined）
 *     必须钉住，且所有挂点都必须经共享工具 `ImmersiveMaterialKit` 走（不许就地 new）；
 *   · SDK 原话：systemMaterial 与 backgroundColor/borderWidth/shadow "advised not to use
 *     together"——顶栏挂材质时 backgroundColor 必须让位（Transparent），否则观感互相覆盖；
 *   · 弹窗 options.systemMaterial 是全页面生效的 SDK 实锤路径（AlertDialogParam），
 *     漏挂就是"该有的材质没挂"。
 *
 * 【钉什么】
 *   A. 共享工具单源存在（platform/ui/ImmersiveMaterialKit.ets），含双兜底；
 *   B. 弹窗层：entry+phone 两模块的全部 showAlertDialog 挂 systemMaterial: dialogMaterial()；
 *   C. 顶栏外壳：entry 挂 systemMaterial + 挂材质时 backgroundColor 让位 Transparent；
 *   D. 不许就地 `new uiMaterial.ImmersiveMaterial`（必须走共享工具——兜底纪律单源）。
 *
 * 【对照臂（--self-test）】
 *   删共享工具的 try/catch / 删一个弹窗的 systemMaterial / 顶栏不设 Transparent /
 *   就地 new ImmersiveMaterial —— 各自必须判红。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FILES = {
  kit: 'platform/src/main/ets/ui/ImmersiveMaterialKit.ets',
  entryWeb: 'entry/src/main/ets/pages/WebApp.ets',
  phoneWeb: 'phone/src/main/ets/pages/WebApp.ets',
  platformIndex: 'platform/src/main/ets/Index.ets',
};

function judge(src) {
  const problems = [];
  const kit = src.kit;
  const entry = src.entryWeb;
  const phone = src.phoneWeb;
  const index = src.platformIndex;

  // A. 共享工具单源
  if (!existsSync(join(ROOT, FILES.kit))) {
    problems.push('A: 共享工具 ImmersiveMaterialKit.ets 不存在');
    return problems;
  }
  if (!/function immersiveMaterialOf\(/.test(kit)) {
    problems.push('A: kit 缺 immersiveMaterialOf()（共享构造入口）');
  }
  if (!/deviceInfo\.sdkApiVersion < 26/.test(kit)) {
    problems.push('A: kit 缺 API<26 判定（闪退教训的第一道兜底）');
  }
  if (!/catch \(e\) \{\s*\n\s*return undefined;/.test(kit)) {
    problems.push('A: kit 缺 try/catch → undefined（闪退教训的第二道兜底）');
  }
  if (!/function dialogMaterial\(\)/.test(kit) || !/function shellMaterial\(\)/.test(kit)) {
    problems.push('A: kit 缺 dialogMaterial()/shellMaterial() 场景封装');
  }
  if (!/dialogMaterial|shellMaterial|immersiveMaterialOf|controlMaterial/.test(index)) {
    problems.push('A: platform barrel 未导出材质工具');
  }

  // B. 弹窗层（两模块的全部 showAlertDialog 都挂）
  for (const [mod, text] of [['entry', entry], ['phone', phone]]) {
    const dialogCount = (text.match(/showAlertDialog\(\{/g) || []).length;
    const materialCount = (text.match(/systemMaterial: dialogMaterial\(\)/g) || []).length;
    if (dialogCount === 0) {
      problems.push(`B[${mod}]: 找不到 showAlertDialog（锚点漂移？）`);
    } else if (materialCount < dialogCount) {
      problems.push(`B[${mod}]: ${dialogCount} 处弹窗只有 ${materialCount} 处挂了 systemMaterial: dialogMaterial()`);
    }
    if (!/import \{[^}]*dialogMaterial[^}]*\} from 'platform'/.test(text)) {
      problems.push(`B[${mod}]: 未从 platform 导入 dialogMaterial`);
    }
  }

  // C. 顶栏外壳（entry；phone 无自绘顶栏，不适用）
  if (!/topBarShellMaterial/.test(entry)) {
    problems.push('C: 顶栏缺 topBarShellMaterial 缓存字段（构造一次的先例口径）');
  }
  if (!/\.systemMaterial\(this\.topBarShellMaterial\)/.test(entry)) {
    problems.push('C: TopBar 未挂 systemMaterial');
  }
  if (!/topBarShellMaterial === undefined \? this\.topBarBgNow\(\) : Color\.Transparent/.test(entry)) {
    problems.push('C: 挂材质时 backgroundColor 必须让位 Transparent（SDK 冲突纪律），降级时走 topBarBg');
  }
  if (!/shellMaterial\(\)\s*;?\s*$/.test(entry) && !/= shellMaterial\(\)/.test(entry)) {
    problems.push('C: topBarShellMaterial 未由 shellMaterial() 构造');
  }

  
  /*
   * C4. 深色规则必须锚 body（2026-10-29 docs/284 的真缺陷）
   *   官方把 data-ds-dark-theme 挂在 <body> 上（theme/client.js 实读：body[...] 命中、
   *   html[...] **0 次**）。垫片曾写成 html[data-ds-dark-theme] ⇒ 永不匹配 ⇒ 深色材质
   *   一次都没生效，深色模式下两列成刺眼亮块。这条判据把教训钉死。
   */
  /*
   * 只看**代码形态**（拼接出 CSS 字符串的行），不看注释：
   * 注释里会写"原写法 html[data-ds-dark-theme]"作为历史说明，不能因此判红。
   */
  const codeOnly = (text) => text.split('\n')
    .filter((l) => {
      const s = l.trim();
      return !(s.startsWith('*') || s.startsWith('//') || s.startsWith('/*'));
    }).join('\n');
  for (const [mod, text] of [['entry', entry], ['phone', phone]]) {
    if (/html\[data-ds-dark-theme\]/.test(codeOnly(text))) {
      problems.push(`C4[${mod}]: 深色规则锚在 html 上（官方锚 body）⇒ 永不匹配`);
    }
  }
  if (!/body\[data-ds-dark-theme\]/.test(entry)) {
    problems.push('C4: 深色玻璃规则未锚 body[data-ds-dark-theme]');
  }

  // D. 不许就地 new（兜底必须单源走 kit）
  for (const [mod, text] of [['entry', entry], ['phone', phone]]) {
    const raw = text.replace(/ImmersiveMaterialKit/, '');
    if (/new uiMaterial\.ImmersiveMaterial\(/.test(raw)) {
      problems.push(`D[${mod}]: 出现就地 new uiMaterial.ImmersiveMaterial（必须走共享工具，兜底才不会漂）`);
    }
  }

  return problems;
}



/*
 * 【2026-10-29 口径反转（docs/286 / 287 / 用户裁决）】
 * 沉浸光感不再由 DSHM 自己注入玻璃 CSS 实现——垫片的 `!important` 抢列背景会把
 * **第三方皮肤盖死**（docs/286），且它是"从外面硬撬"，注定与所有主题打架。
 * 用户裁决：「撤销关于沉浸光感的改动，改用皮肤插件的形式去实现」。
 * ⇒ 本门禁改为守**撤销状态**：垫片里不许再出现玻璃类/标记（出现即回归）。
 * 原生侧的 `menuMaterialOptions`（2026-10-11 既有功能）不受此限。
 */
const FORBIDDEN_IN_SHIM = [
  /GLASS_TOP_CLASS/,
  /GLASS_COL_CLASS/,
  /GLASS_SIDEBAR_CLASS/,
  /dshm-glass-top/,
  /dshm-glasscol/,
  /dshm-glassside/,
  /glass diag/,
];

function judgeRevert(src) {
  const problems = [];
  const codeOnly = (text) => text.split('\n')
    .filter((l) => {
      const s = l.trim();
      return !(s.startsWith('*') || s.startsWith('//') || s.startsWith('/*'));
    }).join('\n');
  for (const [mod, text] of [['entry', src.entryWeb], ['phone', src.phoneWeb]]) {
    const code = codeOnly(text);
    for (const re of FORBIDDEN_IN_SHIM) {
      if (re.test(code)) {
        problems.push(`R[${mod}]: 玻璃实现残留（${re}）——已裁决撤销，改由皮肤插件实现`);
      }
    }
  }
  return problems;
}

const src = {};
for (const [k, rel] of Object.entries(FILES)) {
  src[k] = existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '';
}

const selfTest = process.argv.includes('--self-test');
if (!selfTest) {
  const problems = judgeRevert(src);
  if (problems.length > 0) {
    console.error(`❌ 沉浸光感接线有 ${problems.length} 处缺陷：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：沉浸光感的玻璃实现已撤销（垫片零残留），改由皮肤插件承担；'
    + '原生菜单材质（2026-10-11 既有功能）保留。');
  process.exit(0);
}

/* ── 对照臂 ─────────────────────────────────────────────────── */
const arms = [
  {
    name: '删掉 kit 的 try/catch 兜底（闪退回归）',
    mutate: (s) => ({ ...s, kit: s.kit.replace(/} catch \(e\) \{\s*\n\s*return undefined;\s*\n\s*\}/, '\n  // removed') }),
  },
  {
    name: '删掉一个弹窗的 systemMaterial（该有的材质没挂）',
    mutate: (s) => ({ ...s, entryWeb: s.entryWeb.replace('systemMaterial: dialogMaterial(),\n      primaryButton', 'primaryButton') }),
  },
  {
    name: '顶栏挂材质时不让位 backgroundColor（SDK 冲突纪律回归）',
    mutate: (s) => ({ ...s, entryWeb: s.entryWeb.replace(
      'this.topBarShellMaterial === undefined ? this.topBarBgNow() : Color.Transparent',
      'this.topBarBgNow()') }),
  },
  {
    name: 'C4：深色规则锚回 html（永不匹配，深色材质失效）',
    mutate: (s) => ({ ...s, entryWeb: s.entryWeb.replace(
      'html.dshm-glass-top body[data-ds-dark-theme] .',
      'html[data-ds-dark-theme].dshm-glass-top .') }),
  },
  {
    name: '就地 new ImmersiveMaterial（绕开共享工具的兜底）',
    mutate: (s) => ({ ...s, entryWeb: s.entryWeb + '\n// new uiMaterial.ImmersiveMaterial({})\n' }),
  },
];

let ok = true;
console.log('--self-test：变异体必须判红 --');
const baseline = judge(src);
console.log(`  基线：${baseline.length} 处问题（应为 0）`);
if (baseline.length !== 0) { ok = false; }
for (const arm of arms) {
  const mutated = arm.mutate(src);
  const judged = judge(mutated);
  const red = judged.length > 0;
  console.log(`  ${red ? '✅' : '❌'} ${arm.name} ⇒ ${red ? `判红（${judged.length} 处）` : '未判红（门禁没牙）'}`);
  if (!red) { ok = false; }
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败。');
process.exit(ok ? 0 : 3);