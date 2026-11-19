#!/usr/bin/env node
/**
 * 门禁：云同步的**产品口径**不许被改回去。
 *
 * ① **不默认登录**：登录必须先弹确认框，用户点"登录"后才可拉起华为账号登录/授权页。
 *    entry / phone 两个壳的 `WebApp.ets` 都必须有 `confirmCloudLogin()`，
 *    且其内部是 `showAlertDialog` + 「取消 / 登录」两个按钮；确认文案须说明系统登录页与返回应用，
 *    Account Kit 请求必须使用 `forceLogin=true` 并校验 state，用户取消不得按登录失败提示。
 *
 * ② **恢复不覆盖本机**：`ImportRunner` 遇到目标已存在时必须
 *    "同内容幂等跳过 / 不同内容拒绝覆盖"，即"合并、按会话去重、保留本机"。
 *
 * ③ **账号显示必须脱敏**：`SyncEngine` 只暴露 `maskedUnionId`，不得把原始 unionId 给 UI。
 *
 * ④ **账号显示不是内部代号（docs/378）**：UI 一律读 `accountLabel`（昵称 / 匿名
 *    手机号 / 匿名邮箱），绝不把 `****abcd`（脱敏 UnionID）拼进 subtitle / hint；
 *    读不到资料时说人话「已登录」；状态桥必须把 `accountLabel` 序列化出去。
 *
 * ⑤ **权限面铁律**：读取账号展示名只能用 `profile` scope（官方《获取头像昵称》
 *    指南明文「此场景无需申请账号权限」）。`phone` / `email` /
 *    `quickLoginAnonymousPhone` 等需 AGC 单独审批的 scope 一律不接、不预留分支；
 *    也不申请 `permissions`（不取 authorizationCode / idToken）。
 *
 * ⑥ **确认框文案必须如实**：不能保留「不会获取头像、昵称等资料」的旧承诺，
 *    因为现在确实会请求一次 profile 授权。
 *
 * ⑦ **正式包报错不得出现 beta 身份（2026-11-06 用户口径）**：CLOUD_DISABLED 的
 *    可操作提示只会出现在 AGC 正式/邀请测试包里，出现另一套包名会让用户误判装错包。
 *    提示必须给出正确契约：容器 DSHM / 数据类型 sync_units / 12 列逐字一致。
 *
 * 用法：
 *   node tools/check-cloud-sync-policy.mjs
 *   node tools/check-cloud-sync-policy.mjs --self-test
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHELLS = [
  'entry/src/main/ets/pages/WebApp.ets',
  'phone/src/main/ets/pages/WebApp.ets',
  /* 2026-11-12：pc 独立壳已于 2026-11-08 并入 entry（tablet+2in1），不再存在 pc/ 目录；
     留在这里会让本门禁 ENOENT 崩溃、整条云同步口径失去判据。 */
];
const IMPORT = 'platform/src/main/ets/sync/ImportRunner.ets';
const ENGINE = 'platform/src/main/ets/sync/SyncEngine.ets';
const STATE = 'platform/src/main/ets/sync/SyncState.ets';
const ACCOUNT = 'platform/src/main/ets/system/HuaweiCloud.ets';
const PANEL = 'platform/src/main/ets/view/CloudSyncSettings.ets';
const STORE = 'platform/src/main/ets/sync/SyncStore.ets';
const PLUGIN_SRC = 'hostcore/plugins/dshm-cloud-sync/src/client.src.js';
const PLUGIN_LIB = 'hostcore/plugins/dshm-cloud-sync/lib/client.js';
const UI_FILES = [PANEL, PLUGIN_SRC, PLUGIN_LIB];
const ALL = [...SHELLS, IMPORT, ENGINE, STATE, ACCOUNT, STORE, ...UI_FILES];

function judgeShell(rel, src) {
  const out = [];
  const tag = rel.split('/')[0];
  const at = src.indexOf('private confirmCloudLogin(');
  if (at < 0) {
    out.push(`[${tag}] 缺 confirmCloudLogin()：登录必须在用户点击后弹确认框`);
    return out;
  }
  const body = src.slice(at, at + 1800);
  if (!/showAlertDialog\s*\(/.test(body)) out.push(`[${tag}] confirmCloudLogin 没有弹确认框`);
  if (!/'取消'/.test(body)) out.push(`[${tag}] 确认框缺「取消」按钮（用户必须能反悔）`);
  if (!/'登录'/.test(body)) out.push(`[${tag}] 确认框缺「登录」按钮`);
  /* ⑥ 文案如实：旧承诺与 docs/378 的实际行为矛盾 */
  if (/不会获取头像/.test(body)) {
    out.push(`[${tag}] 确认框仍承诺「不会获取头像、昵称等资料」，与实际 profile 授权矛盾`);
  }
  /* ① 用户确认后必须如实告知交互式登录及返回应用 */
  if (!/系统会打开华为账号登录\/授权页面/.test(body) || !/返回本应用/.test(body)) {
    out.push(`[${tag}] 确认框没有说明系统登录/授权页及完成后返回应用`);
  }
  if (!/result\.kind === SilentSignInKind\.CANCELED/.test(src)) {
    out.push(`[${tag}] 用户取消华为账号登录后未静默结束`);
  }
  /* ④ 登录后必须尽力读展示名，且回填中枢 */
  if (!/fetchAccountDisplayName\s*\(/.test(src)) {
    out.push(`[${tag}] 登录成功后未读取账号展示名`);
  }
  if (!/SyncEngine\.adoptAccountLabel\s*\(/.test(src)) {
    out.push(`[${tag}] 未把账号展示名回填 SyncEngine`);
  }
  return out;
}

function judgeImport(src) {
  const out = [];
  if (!/UnitOutcome\.FAILED,\s*'本机已有内容不同/.test(src)) {
    out.push('[ImportRunner] 丢了"内容不同拒绝覆盖本机"的拒绝分支');
  }
  if (!/SKIPPED/.test(src)) out.push('[ImportRunner] 丢了"同内容幂等跳过"');
  if (!/unions?|sessionId/.test(src)) out.push('[ImportRunner] 找不到按会话去重的键');
  return out;
}

function judgeEngine(src) {
  const out = [];
  /* ③ 原始 unionId 仍必须只以脱敏形态存在 */
  if (!/maskedUnionId/.test(src)) out.push('[SyncEngine] 没有 maskedUnionId 字段');
  if (!/maskUnionId\s*\(/.test(src)) out.push('[SyncEngine] 未对 unionId 做脱敏');
  /* ④ accountLabel 链路 */
  if (!/accountLabel:\s*string/.test(src)) out.push('[SyncEngine] 状态里没有 accountLabel 字段');
  if (!/static adoptAccountLabel\s*\(/.test(src)) out.push('[SyncEngine] 缺 adoptAccountLabel()');
  if (!/accountLabel\.length > 0 \? SyncEngine\.accountLabel : '已登录'/.test(src)) {
    out.push('[SyncEngine] 丢了「读不到资料就显示已登录、不退回 ****abcd」的兜底');
  }
  return out;
}

function judgeState(src) {
  const out = [];
  if (!/,"accountLabel":/.test(src)) {
    out.push('[SyncState] 状态桥没有把 accountLabel 序列化给网页插件');
  }
  return out;
}

function judgePanelLogin(src) {
  const out = [];
  const at = src.indexOf('private confirmSignIn(): void {');
  const body = at < 0 ? '' : src.slice(at, at + 1400);
  if (at < 0 || !/showAlertDialog\s*\(/.test(body) || !/value: '取消'/.test(body)
    || !/value: '登录'/.test(body) || !/系统会打开华为账号登录\/授权页面/.test(body)
    || !/返回本应用/.test(body)) {
    out.push('[CloudSyncSettings] 原生登录入口缺少交互式告知与可取消确认框');
  }
  if (!/onLogin:\s*\(\): void => \{\s*this\.confirmSignIn\(\);/.test(src)) {
    out.push('[CloudSyncSettings] 原生登录按钮绕过确认框');
  }
  if (!/result\.kind !== SilentSignInKind\.CANCELED/.test(src)) {
    out.push('[CloudSyncSettings] 原生面板没有静默处理用户取消');
  }
  const appearAt = src.indexOf('aboutToAppear(): void {');
  const appearEnd = appearAt < 0 ? -1 : src.indexOf('\n  }', appearAt);
  const appearBody = appearAt < 0 || appearEnd < 0 ? '' : src.slice(appearAt, appearEnd);
  if (appearBody.includes('this.signIn();') || !appearBody.includes('this.confirmSignIn();')) {
    out.push('[CloudSyncSettings] autoLogin 信号绕过交互确认框');
  }
  return out;
}

function judgeUi(rel, src) {
  const out = [];
  const tag = rel.split('/').pop();
  /* ④ 三处 UI 都不许再拼 maskedUnionId */
  if (/subtitle:.*maskedUnionId|hint:.*maskedUnionId|华为账号 \$\{this\.engineState\.maskedUnionId\}/.test(src)) {
    out.push(`[${tag}] 账号显示又退回 ****abcd（脱敏 UnionID）`);
  }
  if (!/accountLabel/.test(src)) {
    out.push(`[${tag}] 没有消费 accountLabel`);
  }
  return out;
}

function judgeAccount(src) {
  const out = [];
  /* ⑤ 只看 scopes 赋值行，不误伤注释里对这些词的说明 */
  const m = /request\.scopes\s*=\s*\[([^\]]*)\]/.exec(src);
  if (m === null) {
    out.push('[HuaweiCloud] 找不到 request.scopes 赋值（展示名读取链路被改掉了？）');
  } else {
    const list = m[1];
    if (!/'profile'/.test(list)) out.push('[HuaweiCloud] scopes 没有 profile（拿不到昵称/匿名手机号）');
    if (/'(phone|email|quickLoginAnonymousPhone|riskLevel|realNameAgeRange)'/.test(list)) {
      out.push('[HuaweiCloud] 申请了需要 AGC 审批的 scope：违反「没有的权限就不要接入」');
    }
  }
  if (/request\.permissions\s*=/.test(src)) {
    out.push('[HuaweiCloud] 设置了 permissions：会拿到 authorizationCode / idToken，违反凭据纪律');
  }
  /* 二次脱敏必须存在，且不出口明文 */
  if (!/export function maskAccountLabel\s*\(/.test(src)) {
    out.push('[HuaweiCloud] 缺 maskAccountLabel()：不能把上游返回值直接上 UI');
  }
  if (!/request\.forceLogin\s*=\s*true/.test(src)) {
    out.push('[HuaweiCloud] 用户确认后的登录未设置 forceLogin=true');
  }
  if (!/if\s*\(\s*(?:returned|returnedState)\s*!==\s*String\(request\.state\)\s*\)/.test(src)) {
    out.push('[HuaweiCloud] 没有校验登录响应 state');
  }
  if (!/code === 1001502012/.test(src) || !/SilentSignInKind\.CANCELED/.test(src)) {
    out.push('[HuaweiCloud] 没有将 Account Kit 用户取消码映射为 CANCELED');
  }
  return out;
}

/** ⑦ 正式包的 CLOUD_DISABLED 提示：不带 beta 身份，且给出正确的云侧契约。 */
function judgeStore(src) {
  const out = [];
  const at = src.indexOf('const hint: string = lastCode === 3');
  if (at < 0) { out.push('[SyncStore] 找不到 CLOUD_DISABLED 可操作提示'); return out; }
  const body = src.slice(at, at + 1200);
  if (/dshmbeta|beta\s*包|Beta\s*包/.test(body)) {
    out.push('[SyncStore] 正式包报错里出现 beta 包名/身份（用户会误判装错包）');
  }
  if (!/本地表名称/.test(body)) {
    out.push('[SyncStore] 提示没有区分「本地表名称」与「数据类型名称」——数据类产品名有字符校验，会误导用户去改本地表名');
  }
  if (!/sync_units/.test(body)) out.push('[SyncStore] 提示里没有「本地表名称 = sync_units」');
  if (!/workspace_id/.test(body)) out.push('[SyncStore] 提示里没有 workspace_id 字段差异');
  if (!/实施变更到生产环境|重新部署/.test(body)) {
    out.push('[SyncStore] 提示里没有「实施变更到生产环境」（正式 release 包连生产环境，不实施不生效）');
  }
  return out;
}

function judgeFile(rel, src) {
  if (SHELLS.includes(rel)) return judgeShell(rel, src);
  if (rel === PANEL) return [...judgePanelLogin(src), ...judgeUi(rel, src)];
  if (rel === IMPORT) return judgeImport(src);
  if (rel === ENGINE) return judgeEngine(src);
  if (rel === STATE) return judgeState(src);
  if (rel === ACCOUNT) return judgeAccount(src);
  if (rel === STORE) return judgeStore(src);
  if (UI_FILES.includes(rel)) return judgeUi(rel, src);
  return [];
}

const texts = {};
const problems = [];
for (const rel of ALL) {
  texts[rel] = readFileSync(join(ROOT, rel), 'utf8');
  for (const p of judgeFile(rel, texts[rel])) problems.push(p);
}

if (!process.argv.includes('--self-test')) {
  if (problems.length > 0) {
    console.error(`❌ 云同步产品口径被破坏（${problems.length} 处）：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：登录须经确认框（可取消）、恢复不覆盖本机、账号显示非内部代号、只用 profile scope、确认框文案如实。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let ok = problems.length === 0;
console.log(`  基线：${problems.length} 处问题（应为 0）`);
for (const p of problems) console.log(`     · ${p}`);

const arms = [
  ['entry 去掉确认框（改成启动即登录）', SHELLS[0],
    (s) => s.replace('private confirmCloudLogin(', 'private confirmCloudLoginRemoved(')],
  ['entry 去掉「取消」按钮（用户无法反悔）', SHELLS[0],
    (s) => {
      const at = s.indexOf('private confirmCloudLogin(');
      return s.slice(0, at) + s.slice(at).replace("value: '取消'", "value: '关闭'");
    }],
  ['ImportRunner 把"拒绝覆盖"改成"覆盖"', IMPORT,
    (s) => s.replace("derive(base, UnitOutcome.FAILED, '本机已有内容不同的会话文件（不覆盖）'",
      "derive(base, UnitOutcome.OK, '覆盖本机文件'")],
  ['确认框恢复「不获取资料」的旧承诺（说谎）', SHELLS[0],
    (s) => s.replace('应用还会请求 profile 授权以显示昵称或脱敏手机号/邮箱；',
      '本应用不会获取头像、昵称等资料；')],
  ['原生面板把账号显示退回 ****abcd', PANEL,
    (s) => s.replace('`华为账号 ${this.engineState.accountLabel}`',
      '`华为账号 ${this.engineState.maskedUnionId}`')],
  ['原生面板 autoLogin 绕过确认框', PANEL,
    (s) => {
      const at = s.indexOf('aboutToAppear(): void {');
      return s.slice(0, at) + s.slice(at).replace('this.confirmSignIn();', 'this.signIn();');
    }],
  ['网页插件把账号显示退回 ****abcd', PLUGIN_SRC,
    (s) => s.replace("'华为账号 ' + (state.accountLabel || '已登录')",
      "'华为账号 ' + state.maskedUnionId")],
  ['HuaweiCloud 越权申请 phone scope', ACCOUNT,
    (s) => s.replace("request.scopes = ['profile'];", "request.scopes = ['profile', 'phone'];")],
  ['华为登录退回静默模式', ACCOUNT,
    (s) => s.replace('request.forceLogin = true;', 'request.forceLogin = false;')],
  ['华为登录删除响应 state 校验', ACCOUNT,
    (s) => s.replace('if (returnedState !== String(request.state)) {', 'if (returnedState === String(request.state)) {')],
  ['entry 确认框隐去登录页返回路径', SHELLS[0],
    (s) => s.replace('完成后返回本应用。', '完成后继续。')],
  ['HuaweiCloud 顺手取 authorizationCode', ACCOUNT,
    (s) => s.replace("request.scopes = ['profile'];", "request.scopes = ['profile'];\n    request.permissions = ['serviceauthcode'];")],
  ['SyncEngine 去掉「已登录」兜底（回到内部代号）', ENGINE,
    (s) => s.replace("SyncEngine.accountLabel.length > 0 ? SyncEngine.accountLabel : '已登录'",
      'maskUnionId(SyncEngine.unionId)')],
  ['SyncState 停止序列化 accountLabel', STATE,
    (s) => s.replace('+ `,"accountLabel":${JSON.stringify(st.accountLabel)}`', '+ ``')],
  ['SyncStore 把 beta 包名写回正式包报错', STORE,
    (s) => s.replace('②AGC 已为 com.dshm.dshclient 开启云空间服务并启用端云同步；',
      '②使用 AGC 正式包 com.dshm.dshclient —— beta 包 com.dshm.dshmbeta 未在 AGC 注册，必然禁用；')],
  ['SyncStore 把提示退回「数据类型名称 = sync_units」旧错误口径', STORE,
    (s) => s.replace('「本地表名称」必须填 sync_units；', '数据类型名称必须为 sync_units；')],
];
for (const [label, rel, mutate] of arms) {
  const mutated = mutate(texts[rel]);
  const reds = mutated === texts[rel] ? [] : judgeFile(rel, mutated);
  const red = reds.length > 0;
  if (!red) ok = false;
  console.log(`  ${red ? '✅' : '❌'} ${label} ⇒ ${mutated === texts[rel] ? '变异未生效' : `判红（${reds.length} 处）`}`);
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败（门禁没牙）。');
process.exit(ok ? 0 : 3);
