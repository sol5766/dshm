/**
 * Node 原生引导的启动契约。
 *
 * 2026-10-20 模拟器实测（x86_64 缺 libnode）：
 *   - runtimeVersion() 仍返回编译期 "26.7.0"；
 *   - startHost() 返回 started=true；
 *   - Node 线程随后才发现 node::Start 缺失并退出。
 *
 * 这会把"运行时不可用"伪装成"Host 已启动"，UI 只能等端口超时。
 * 本门禁要求两个原生入口都先检查 node::Start，再回答可用/已启动。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const FILE = 'hostruntime/src/main/cpp/dshhost.cc';
const src = readFileSync(join(ROOT, FILE), 'utf8');
const ENTRY_FILE = 'entry/src/main/ets/entryability/EntryAbility.ets';
const WEB_FILE = 'entry/src/main/ets/pages/WebApp.ets';
const entry = readFileSync(join(ROOT, ENTRY_FILE), 'utf8');
const web = readFileSync(join(ROOT, WEB_FILE), 'utf8');

export function collectProblems(source) {
  const scopeStart = source.indexOf('namespace {');
  if (scopeStart < 0) return ['缺少匿名 namespace，无法定位原生入口'];
  const rvStart = source.indexOf('napi_value RuntimeVersion', scopeStart);
  const shStart = source.indexOf('napi_value StartHost', rvStart);
  const isStart = source.indexOf('napi_value IsHostRunning', shStart);
  if (rvStart < 0 || shStart <= rvStart || isStart <= shStart) {
    return ['RuntimeVersion / StartHost / IsHostRunning 函数边界缺失'];
  }
  const rv = source.slice(rvStart, shStart);
  const sh = source.slice(shStart, isStart);
  const problems = [];

  const rvGuard = rv.indexOf('if (g_nodeStart == nullptr)');
  const rvCreate = rv.indexOf('napi_create_string_utf8');
  if (!(rvGuard >= 0 && rvGuard < rvCreate)) {
    problems.push('runtimeVersion 必须先在 node::Start 缺失时返回空串，不得回编译期版本号');
  }

  const shGuard = sh.indexOf('if (g_nodeStart == nullptr)');
  const shStarted = sh.indexOf('g_started.store(true)');
  if (!(shGuard >= 0 && shStarted > shGuard)) {
    problems.push('startHost 必须在置 started=true 并启动线程前检查 node::Start');
  }
  if (!sh.includes('libnode 未加载或 node::Start 不可用')) {
    problems.push('startHost 缺失符号时必须返回可读原因');
  }
  return problems;
}

const base = collectProblems(src);
function appProblems(entrySource, webSource) {
  const problems = [];
  const keyDecl = "const KEY_HOST_BOOT_ERROR: string = 'dshHostBootError';";
  if (!entrySource.includes(keyDecl) || !webSource.includes(keyDecl)) {
    problems.push('EntryAbility / WebApp 必须共用 dshHostBootError 键');
  }
  if (!/if \(s\.ok && s\.handle !== null\)[\s\S]{0,700}?AppStorage\.setOrCreate<string>\(KEY_HOST_BOOT_ERROR,\s*message\)/.test(entrySource)
    || !/\.catch\(\(e: Object\) => \{[\s\S]{0,500}?e instanceof Error[\s\S]{0,300}?AppStorage\.setOrCreate<string>\(KEY_HOST_BOOT_ERROR,\s*message\)/.test(entrySource)) {
    problems.push('Host 启动失败与异常必须发布到 KEY_HOST_BOOT_ERROR');
  }
  if (!/@StorageProp\(KEY_HOST_BOOT_ERROR\) @Watch\('onHostBootErrorChanged'\)/.test(webSource)) {
    problems.push('WebApp 必须监听 Host 启动错误');
  }
  if (!/private onHostBootErrorChanged\(\): void \{[\s\S]{0,700}?this\.phase = WebPhase\.ERROR;/.test(webSource)) {
    problems.push('Host 启动错误必须直接进入 ERROR，而不是永久启动页');
  }
  return problems;
}
const appBase = appProblems(entry, web);
console.log('# Node 原生启动契约');
if (base.length === 0 && appBase.length === 0) {
  console.log('✅ runtimeVersion / startHost 先检查 node::Start；Host 失败会进入 ERROR。');
} else {
  [...base, ...appBase].forEach((p) => console.log(`  ✗ ${p}`));
}

if (process.argv.includes('--self-test')) {
  const arms = [
    {
      name: 'runtimeVersion 回退成编译期版本号',
      source: src.replace(
        /if \(g_nodeStart == nullptr\) \{\s*napi_value empty = nullptr;\s*napi_create_string_utf8\(env, "", 0, &empty\);\s*return empty;\s*\}/,
        '')
    },
    {
      name: 'startHost 不再先检查 node::Start',
      source: src.replace(
        /if \(g_nodeStart == nullptr\) \{\s*SetBool\(env, out, "started", false\);[\s\S]*?return out;\s*\}/,
        '')
    },
    {
      name: 'WebApp 不监听 Host 启动错误',
      source: src,
      entrySource: entry,
      webSource: web.replace("@StorageProp(KEY_HOST_BOOT_ERROR) @Watch('onHostBootErrorChanged')", '')
    }
  ];
  let failed = 0;
  for (const arm of arms) {
    if (arm.source === src && arm.webSource === undefined) {
      failed += 1;
      console.log(`  ✗ 对照臂失效（锚点未命中）：${arm.name}`);
      continue;
    }
    if (arm.webSource !== undefined && arm.webSource === web) {
      failed += 1;
      console.log(`  ✗ 对照臂失效（锚点未命中）：${arm.name}`);
      continue;
    }
    const problems = [
      ...collectProblems(arm.source),
      ...appProblems(arm.entrySource ?? entry, arm.webSource ?? web)
    ];
    if (problems.length === 0) {
      failed += 1;
      console.log(`  ✗ 对照臂没判红：${arm.name}`);
    } else {
      console.log(`  ✓ 对照臂判红：${arm.name}（${problems.length} 条）`);
    }
  }
  console.log(`# 对照臂 ${arms.length - failed}/${arms.length} 通过`);
  process.exit(failed === 0 && base.length === 0 && appBase.length === 0 ? 0 : 1);
}

process.exit(base.length === 0 && appBase.length === 0 ? 0 : 1);
