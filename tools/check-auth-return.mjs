#!/usr/bin/env node
/**
 * 账号登录完成页回跳门禁。
 *
 * DeepSeek 官方 `/dsh/authorized?login_source=desktop` 页面会把浏览器跳转到
 * `dsh://open`，按钮也调用同一个 URI。每个实际交付的客户端壳必须同时满足：
 *   1. EntryAbility 的 skills 声明 viewData + browsable + scheme=dsh/host=open；
 *   2. EntryAbility.onNewWant 消费该 URI 并显式 restore/show 主窗；
 *   3. 冷启动 onCreate 暂存首次 Want，并在窗口 ready 后消费。
 *
 * 只检查一处会留下“manifest 能接、代码不消费”或“代码有分支、系统找不到入口”
 * 的半条链，因此门禁把两侧一起钉住。根目录始终由脚本路径推导，不依赖调用方 cwd。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = [
  { name: '桌面/平板/PC', manifest: 'entry/src/main/module.json5',
    ability: 'entry/src/main/ets/entryability/EntryAbility.ets' },
  { name: '手机', manifest: 'phone/src/main/module.json5',
    ability: 'phone/src/main/ets/entryability/EntryAbility.ets' },
];

function parseJson5(text) {
  return JSON.parse(text
    .replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1'));
}

function sourceOf(target) {
  const manifestPath = join(ROOT, target.manifest);
  const abilityPath = join(ROOT, target.ability);
  return {
    manifestText: existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '',
    abilityText: existsSync(abilityPath) ? readFileSync(abilityPath, 'utf8') : '',
  };
}

function methodBody(source, signature) {
  const signatureAt = source.indexOf(signature);
  const openAt = signatureAt < 0 ? -1 : source.indexOf('{', signatureAt + signature.length);
  if (openAt < 0) return '';
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let i = openAt; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote !== '') {
      if (escaped) escaped = false;
      else if (char === '\\\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (char === '\'' || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(openAt + 1, i);
  }
  return '';
}

export function collectProblems(targets = TARGETS, reader = sourceOf) {
  const problems = [];
  for (const target of targets) {
    const source = reader(target);
    if (source.manifestText.length === 0) {
      problems.push(`${target.name}：缺少 ${target.manifest}`);
      continue;
    }
    if (source.abilityText.length === 0) {
      problems.push(`${target.name}：缺少 ${target.ability}`);
      continue;
    }

    try {
      const module = parseJson5(source.manifestText)?.module;
      const ability = module?.abilities?.find((item) => item?.name === 'EntryAbility');
      const authSkill = ability?.skills?.find((skill) => {
        const actions = Array.isArray(skill?.actions) ? skill.actions : [];
        const entities = Array.isArray(skill?.entities) ? skill.entities : [];
        const uris = Array.isArray(skill?.uris) ? skill.uris : [];
        return actions.includes('ohos.want.action.viewData')
          && entities.includes('entity.system.browsable')
          && uris.some((uri) => uri?.scheme === 'dsh' && uri?.host === 'open');
      });
      if (authSkill === undefined) {
        problems.push(`${target.name}：EntryAbility 未声明 dsh://open 的 viewData/browsable skill`);
      }
    } catch (e) {
      problems.push(`${target.name}：module.json5 解析失败（${String(e)}）`);
    }

    const ability = source.abilityText;
    if (!ability.includes("const AUTH_RETURN_URI: string = 'dsh://open';")) {
      problems.push(`${target.name}：EntryAbility 没有 dsh://open 常量`);
    }
    if (!ability.includes('this.handleAuthReturnWant(want);')) {
      problems.push(`${target.name}：onNewWant 没有调用 handleAuthReturnWant`);
    }
    const onCreateBody = methodBody(ability,
      'onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void');
    const handlerBody = methodBody(ability, 'private handleAuthReturnWant(want: Want): void');
    const stashesFromOnCreate = onCreateBody.includes('this.handleAuthReturnWant(want);')
      && handlerBody.includes('this.pendingAuthReturnWant = want;');
    const stashesDirectly = onCreateBody.includes('this.pendingAuthReturnWant = want;')
      && onCreateBody.includes('want.uri.trim().toLowerCase() === AUTH_RETURN_URI');
    if (!ability.includes('private pendingAuthReturnWant: Want | undefined = undefined;')
      || (!stashesFromOnCreate && !stashesDirectly)) {
      problems.push(`${target.name}：onCreate 没有暂存首次 dsh://open Want`);
    }
    const readyBody = methodBody(ability,
      'private afterWindowStageReady(windowStage: window.WindowStage): void');
    const readyOrder = [
      readyBody.indexOf('this.mainWindow = win;'),
      readyBody.indexOf('const pendingAuthReturnWant: Want | undefined = this.pendingAuthReturnWant;'),
      readyBody.indexOf('this.pendingAuthReturnWant = undefined;'),
      readyBody.indexOf('this.handleAuthReturnWant(pendingAuthReturnWant);'),
      readyBody.indexOf('if (this.launchParams.kind !== WindowKind.MAIN) {'),
    ];
    const mainOnlyDrain = /if \(this\.launchParams\.kind === WindowKind\.MAIN\) \{[\s\S]*?const pendingAuthReturnWant: Want \| undefined = this\.pendingAuthReturnWant;[\s\S]*?this\.pendingAuthReturnWant = undefined;[\s\S]*?this\.handleAuthReturnWant\(pendingAuthReturnWant\);[\s\S]*?\n    \}/.test(readyBody);
    if (readyOrder.some((index) => index < 0)
      || !readyOrder.every((index, position) => position === 0 || readyOrder[position - 1] < index)
      || !mainOnlyDrain) {
      problems.push(`${target.name}：pending 回跳必须在窗口赋值后、MAIN early return 前由主窗清空并消费`);
    }
    const queuesWhenWindowMissing = /if \(this\.mainWindow === undefined\) \{[\s\S]*?this\.pendingAuthReturnWant = want;[\s\S]*?return;/.test(handlerBody)
      || /const win: window\.Window \| undefined = this\.mainWindow;[\s\S]*?if \(win === undefined\) \{[\s\S]*?this\.pendingAuthReturnWant = want;[\s\S]*?return;/.test(handlerBody);
    const handlerMainOnly = handlerBody.includes('this.launchParams.kind !== WindowKind.MAIN');
    if (!queuesWhenWindowMissing || !handlerMainOnly) {
      problems.push(`${target.name}：handler 未限制主窗或未在主窗 ready 前暂存回跳 Want`);
    }
    const restoresWindowDirectly = handlerBody.includes('restore()')
      && (handlerBody.includes('show()') || handlerBody.includes('showWindow()'));
    const delegatesToWindowRestore = handlerBody.includes('this.ensureWindowShown()');
    if (!restoresWindowDirectly && !delegatesToWindowRestore) {
      problems.push(`${target.name}：授权回跳没有恢复并显示主窗`);
    }
  }
  return problems;
}

if (process.argv.includes('--self-test')) {
  const sources = new Map(TARGETS.map((target) => [target.name, sourceOf(target)]));
  const arms = [
    {
      name: '手机 manifest 删除 dsh://open',
      mutate: (target, source) => target.name !== '手机' ? source : {
        ...source,
        manifestText: source.manifestText.replace('"scheme": "dsh"', '"scheme": "https"'),
      },
    },
    {
      name: '手机 onNewWant 漏掉回跳处理',
      mutate: (target, source) => target.name !== '手机' ? source : {
        ...source,
        abilityText: source.abilityText.replace('this.handleAuthReturnWant(want);', ''),
      },
    },
    {
      name: '手机冷启动未暂存或消费回跳 Want',
      mutate: (target, source) => target.name !== '手机' ? source : {
        ...source,
        abilityText: source.abilityText
          .replace('this.pendingAuthReturnWant = want;', '')
          .replace('this.handleAuthReturnWant(pendingAuthReturnWant);', ''),
      },
    },
    {
      name: '桌面/平板/PC 冷启动未暂存或消费回跳 Want',
      mutate: (target, source) => target.name !== '桌面/平板/PC' ? source : {
        ...source,
        abilityText: source.abilityText
          .replace('this.pendingAuthReturnWant = want;', '')
          .replace('this.handleAuthReturnWant(pendingAuthReturnWant);', ''),
      },
    },
    {
      name: '手机非主窗误消费授权回跳',
      mutate: (target, source) => target.name !== '手机' ? source : {
        ...source,
        abilityText: source.abilityText.replace(
          'uri !== AUTH_RETURN_URI || this.launchParams.kind !== WindowKind.MAIN',
          'uri !== AUTH_RETURN_URI',
        ),
      },
    },
    {
      name: '手机 onNewWant 窗口未就绪时丢弃回跳 Want',
      mutate: (target, source) => target.name !== '手机' ? source : {
        ...source,
        abilityText: source.abilityText.replace(
          /if \(win === undefined\) \{\n      this\.pendingAuthReturnWant = want;\n      return;\n    \}/,
          'if (win === undefined) {\n      return;\n    }',
        ),
      },
    },
    {
      name: '三端非主窗不能 drain 冷启动回跳',
      mutate: (target, source) => ({
        ...source,
        abilityText: source.abilityText.replace(
          /if \(this\.launchParams\.kind === WindowKind\.MAIN\) \{\n      const pendingAuthReturnWant: Want \| undefined = this\.pendingAuthReturnWant;\n      this\.pendingAuthReturnWant = undefined;\n      if \(pendingAuthReturnWant !== undefined\) \{\n        this\.handleAuthReturnWant\(pendingAuthReturnWant\);\n      \}\n    \}/,
          'const pendingAuthReturnWant: Want | undefined = this.pendingAuthReturnWant;\n    this.pendingAuthReturnWant = undefined;\n    if (pendingAuthReturnWant !== undefined) {\n      this.handleAuthReturnWant(pendingAuthReturnWant);\n    }',
        ),
      }),
    },
    {
      name: '桌面/平板/PC manifest 删除 dsh://open',
      mutate: (target, source) => target.name !== '桌面/平板/PC' ? source : {
        ...source,
        manifestText: source.manifestText.replace('"scheme": "dsh"', '"scheme": "https"'),
      },
    },
    {
      name: '桌面/平板/PC 回跳不再恢复主窗',
      mutate: (target, source) => target.name !== '桌面/平板/PC' ? source : {
        ...source,
        abilityText: source.abilityText.replace('this.ensureWindowShown();', 'this.applyLaunchParams(want);'),
      },
    },
  ];
  let failures = 0;
  for (const arm of arms) {
    const problems = collectProblems(TARGETS, (target) => arm.mutate(target, sources.get(target.name)));
    if (problems.length === 0) {
      failures += 1;
      console.log(`  ✗ 对照臂没判红：${arm.name}`);
    } else {
      console.log(`  ✓ 对照臂判红：${arm.name}（${problems.length} 条）`);
    }
  }
  console.log(`# 对照臂 ${arms.length - failures}/${arms.length} 通过`);
  process.exit(failures === 0 ? 0 : 1);
}

console.log('# 账号授权完成回跳门禁');
const problems = collectProblems();
if (problems.length === 0) {
  console.log('✅ entry（平板/PC）、phone 两个客户端壳均声明 dsh://open，并在复用实例时恢复主窗。');
  process.exit(0);
}
for (const problem of problems) console.log(`  ✗ ${problem}`);
process.exit(1);
