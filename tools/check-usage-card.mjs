#!/usr/bin/env node
/**
 * 门禁：桌面服务卡片「会话进度 + 余额/token 用量」（2026-10-17，docs/178）。
 *
 * 【用户口径】"有余额就显示余额；**余额取不到时才显示** token 用量（今天 / 近5小时 /
 * 近一周 / 近一个月）"，另加"当前在沟通的会话进度"。
 *
 * 【判什么】
 *   ① Host（`hostcore/app/main.js` registerCardState）：
 *      · 全局订阅 session/event；turn/start|step/*|turn/end 维护会话进度；
 *      · assistant/message 的 usage（inputTokens/outputTokens）落账并聚合 today/last5h/last7d/last30d；
 *      · `ctx.deepseekAccount.getBalance({version,locale,timezoneOffsetSeconds})` 取余额；
 *      · 写 `$DSH_HOME/card-state.json`（balance.available 决定卡片走余额还是用量）。
 *   ② FormExtensionAbility（`UsageFormAbility.ets`）：onAddForm 登记 formId + 读 card-state；
 *      onUpdateForm 推送；onRemoveForm 注销。
 *   ③ 卡片 UI（`UsageCard.ets`）：`useBalance` 条件分支 + 点击 router 回主窗。
 *   ④ 主应用推送器（`CardStateWatcher.ets`）：轮询状态文件 → formProvider.updateForm（只对已登记 formId）。
 *   ⑤ form_config.json：名称/源码路径/2*2+2*4/动态/周期刷新。
 *
 * 【对照臂】12 个变异体（摘余额查询 / 摘用量聚合 / 改 form src / 摘推送 / 把"余额可用"判据写反 /
 * 重开系统定时刷新 / 轮询恢复 2s / 去掉条形图 / 背景改回纯黑 / 摘掉 data-row-key 直达 /
 * 更新失败也记成功 / 四档 token 恢复 number 绑定）都必须判红。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOST_FILE = 'hostcore/app/main.js';
const FORM_ABILITY = 'entry/src/main/ets/form/UsageFormAbility.ets';
const CARD_UI = 'entry/src/main/ets/form/pages/UsageCard.ets';
const CARD_STATE = 'entry/src/main/ets/form/CardState.ets';
const WATCHER = 'entry/src/main/ets/system/CardStateWatcher.ets';
const FORM_CONFIG = 'entry/src/main/resources/base/profile/form_config.json';
const MODULE_JSON = 'entry/src/main/module.json5';
const WEBAPP = 'entry/src/main/ets/pages/WebApp.ets';

function inspect(files) {
  const notes = [];
  let pass = 0;
  let fail = 0;
  const ok = (cond, msg) => {
    if (cond) { pass++; notes.push('  PASS  ' + msg); } else { fail++; notes.push('  FAIL  ' + msg); }
  };
  const host = files.host;
  const ability = files.ability;
  const ui = files.ui;
  const state = files.state;
  const watcher = files.watcher;
  const cfg = files.config;
  const moduleJson = files.moduleJson;
  const webapp = files.webapp;

  // ① Host
  ok(host.includes('function registerCardState(ctx)'), 'Host：registerCardState 存在');
  ok(host.includes("ctx.on('session/event'"), 'Host：订阅 session/event');
  ok(host.includes("event.type === 'turn/start'") && host.includes("event.type === 'turn/end'"),
    'Host：维护 turn 开始/结束（当前会话进度）');
  ok(host.includes("event.type === 'assistant/message'") && host.includes('usage.inputTokens')
    && host.includes('usage.outputTokens'), 'Host：从 assistant/message 取 inputTokens/outputTokens');
  ok(host.includes('today: 0, last5h: 0, last7d: 0, last30d: 0'), 'Host：四档用量窗口（今天/5h/7d/30d）');
  ok(host.includes('ctx.deepseekAccount') && host.includes('await account.getBalance(client);'),
    'Host：用 deepseekAccount.getBalance 取余额（判据打在调用行，不是头注）');
  ok(host.includes('balance = { available: true') && host.includes('balance = { available: false'),
    'Host：余额可用/不可用两态都写入状态（卡片据此回退到 token 用量）');
  ok(host.includes('card-state.json'), 'Host：写 card-state.json');

  // ② FormExtensionAbility
  ok(ability.includes('formInfo.FormParam.IDENTITY_KEY'), 'FormAbility：onAddForm 取 formId');
  ok(ability.includes('saveFormIds'), 'FormAbility：登记 formId（主应用据此推送）');
  ok(ability.includes('readCardState(filesDir)'), 'FormAbility：首帧读 card-state.json');
  ok(ability.includes('onUpdateForm') && ability.includes('formProvider.updateForm'),
    'FormAbility：周期刷新时 updateForm');

  // ③ 卡片 UI
  ok(state.includes('const useBalance: boolean = state.balance.available && state.balance.display.length > 0;'),
    'CardState：余额优先的绑定逻辑（判据打在代码行）');
  ok(state.includes("'usageToday': String(state.usage.today)") &&
    state.includes("'usage30d': String(state.usage.last30d)"),
    'CardState：四档用量以字符串跨进程传递（FormBindingData 会序列化为 string）');
  ok(ui.includes("@LocalStorageProp('usageToday') usageToday: string = '0'") &&
    ui.includes('private usageNumber(value: string): number'),
    '卡片 UI：四档 token 按字符串接收并显式转 number（防真机全 0）');
  ok(ui.includes('if (this.useBalance)') && ui.includes('this.usageBar('),
    '卡片 UI：余额行按需显示 + 四档用量条形图始终显示');
  ok(ui.includes("backgroundColor('#FFFFFF')") && ui.includes('linearGradient'),
    '卡片 UI：白底 + 浅色渐变（不再是纯黑背景）');
  ok(ui.includes('private barWidth(value: number): string') && ui.includes("backgroundColor('#2FB98A')"),
    '卡片 UI：条形图（归一化宽度 + 青绿填充）');
  ok(ui.includes("if (!Number.isFinite(value) || value <= 0)") && ui.includes("return '0%';"),
    '卡片 UI：0 / 非法用量必须画 0%，不能伪装成"有数据"的 4%');
  ok(ui.includes('Math.min(100, Math.max(4, Math.round(value / this.usageMax() * 100)))'),
    '卡片 UI：正数条形宽度夹在 4%..100%');
  ok(ui.includes("action: 'router'") && ui.includes("abilityName: 'EntryAbility'"),
    '卡片 UI：点击回 DSHM 主窗');
  ok(webapp.includes("var key = 'session:' + wantId;") &&
    webapp.includes("String(rows[i].getAttribute('data-row-key') || '')") &&
    webapp.includes('actual === key || actual.indexOf(wantId) >= 0'),
    '卡片直达：用上游稳定锚点 data-row-key="session:<id>" 选会话');
  ok(webapp.includes("sb.state() !== 'expanded'") && webapp.includes("return 'opening-drawer';"),
    '卡片直达：手持档抽屉收起时先展开并轮询会话行');
  ok(webapp.includes('function closeDrawer()') && webapp.includes('closeDrawer();'),
    '卡片直达：点中会话后收起手机抽屉');

  // ④ 推送器
  ok(watcher.includes('loadFormIds') && watcher.includes('formProvider.updateForm(id, binding)'),
    'Watcher：只对已登记 formId 推送 updateForm（判据打在调用行，不是头注）');
  ok(watcher.includes('ids.length === 0'), 'Watcher：没有卡片时零读取');
  ok(watcher.includes('}, 5000);'), 'Watcher：推送轮询降为 5s（原来 2s）');
  ok(watcher.includes('new Map<string, string>()') && watcher.includes('deliveredRaw.set(id, raw)'),
    'Watcher：按 formId 记录已成功版本，不用一个全局 lastRaw 冒充成功');
  ok(watcher.includes('.catch((error: BusinessError): void =>') &&
    watcher.includes('卡片更新失败 formId=') &&
    (watcher.match(/deliveredRaw\.set\(id, raw\)/g) || []).length === 1,
    'Watcher：updateForm 失败不记成功 ⇒ 下一拍会重试并留日志');

  // ⑤ form_config + module.json5
  let parsed = null;
  try { parsed = JSON.parse(cfg); } catch { parsed = null; }
  ok(parsed !== null && Array.isArray(parsed.forms) && parsed.forms.length === 1, 'form_config：只有一个 forms 项');
  const form = parsed && parsed.forms && parsed.forms[0] ? parsed.forms[0] : {};
  ok(form.uiSyntax === 'arkts' && form.isDynamic === true, 'form_config：ArkTS 动态卡片');
  ok(form.updateEnabled === false && form.updateDuration === undefined,
    'form_config：关闭系统定时刷新（DSHM 不运行时不更新，只有主应用推送才更新）');
  ok(Array.isArray(form.supportDimensions) && form.supportDimensions.includes('2*2')
    && form.supportDimensions.includes('2*4'), 'form_config：支持 2*2 / 2*4');
  ok(typeof form.src === 'string' && existsSync(join('entry/src/main', form.src)),
    'form_config：src 指向真实卡片文件（相对 module 源根 entry/src/main）');
  ok(moduleJson.includes('"name": "UsageFormAbility"') && moduleJson.includes('"type": "form"')
    && moduleJson.includes('ohos.extension.form'), 'module.json5：注册 FormExtensionAbility');

  return { pass, fail, notes };
}

const files = {
  host: readFileSync(HOST_FILE, 'utf8'),
  ability: readFileSync(FORM_ABILITY, 'utf8'),
  ui: readFileSync(CARD_UI, 'utf8'),
  state: readFileSync(CARD_STATE, 'utf8'),
  watcher: readFileSync(WATCHER, 'utf8'),
  config: readFileSync(FORM_CONFIG, 'utf8'),
  moduleJson: readFileSync(MODULE_JSON, 'utf8'),
  webapp: readFileSync(WEBAPP, 'utf8'),
};

console.log('== 主体：桌面服务卡片（会话进度 + 余额/ token 用量）==');
const main = inspect(files);
for (const line of main.notes) console.log(line);
console.log(`  小计：${main.pass} passed / ${main.fail} failed`);

let failed = main.fail > 0;

const arms = [
  {
    name: 'A：摘掉余额查询（只剩用量，违背"有余额显示余额"）',
    files: { ...files, host: files.host.replace('await account.getBalance(client);', 'void 0;') },
  },
  {
    name: 'B：摘掉用量聚合的四档窗口（余额不可用时无数据可显示）',
    files: { ...files, host: files.host.replace('today: 0, last5h: 0, last7d: 0, last30d: 0', 'today: 0') },
  },
  {
    name: 'C：form_config 的 src 指向不存在的文件',
    files: { ...files, config: files.config.replace('./ets/form/pages/UsageCard.ets', './ets/form/pages/Missing.ets') },
  },
  {
    name: 'D：摘掉主应用推送器（卡片永远只有首帧）',
    files: { ...files, watcher: files.watcher.replace('formProvider.updateForm(id, binding)', 'void 0') },
  },
  {
    name: 'E：把"余额可用"判据写反（卡片永远显示用量/余额颠倒）',
    files: {
      ...files,
      state: files.state.replace(
        'const useBalance: boolean = state.balance.available && state.balance.display.length > 0;',
        'const useBalance: boolean = !state.balance.available;',
      ),
    },
  },
  {
    name: 'F：重新打开系统定时刷新（DSHM 不运行也会更新，违背用户口径）',
    files: {
      ...files,
      config: files.config.replace('"updateEnabled": false,', '"updateEnabled": true,\n      "updateDuration": 1,'),
    },
  },
  {
    name: 'G：推送轮询恢复 2s（更新频没有降低）',
    files: { ...files, watcher: files.watcher.replace('}, 5000);', '}, 2000);') },
  },
  {
    name: 'H：去掉条形图宽度函数（四档退回纯文字/不可视化）',
    files: { ...files, ui: files.ui.replace('private barWidth(value: number): string', 'private noBarWidth(value: number): string') },
  },
  {
    name: 'I：背景改回纯黑（用户明确不要纯黑）',
    files: { ...files, ui: files.ui.replace("backgroundColor('#FFFFFF')", "backgroundColor('#000000')") },
  },
  {
    name: 'J：卡片直达不再使用 data-row-key（退回 session-not-found）',
    files: { ...files, webapp: files.webapp.replace("var key = 'session:' + wantId;", "var key = '';") },
  },
  {
    name: 'K：updateForm 失败也提前记成成功（卡片永久停在旧数据）',
    files: {
      ...files,
      watcher: files.watcher.replace(
        'formProvider.updateForm(id, binding).then((): void => {',
        "deliveredRaw.set(id, raw);\n        formProvider.updateForm(id, binding).then((): void => {"),
    },
  },
  {
    name: 'L：四档 token 恢复 number 绑定（真机会序列化成 string ⇒ 全 0）',
    files: {
      ...files,
      state: files.state.replace("'usageToday': String(state.usage.today)", "'usageToday': state.usage.today"),
    },
  },
];

for (const arm of arms) {
  const mutated = inspect(arm.files);
  const red = mutated.fail > 0;
  console.log(`\n== 对照臂 ${arm.name} ==`);
  console.log(`  变异体：${mutated.pass} passed / ${mutated.fail} failed（期望 failed > 0）`);
  if (!red) {
    console.log('  FAIL  变异体竟然全绿 => 判据是恒真摆设，必须修');
    failed = true;
  } else {
    console.log('  PASS  变异体如期变红 => 判据有牙');
  }
}

console.log('\nRESULT: ' + (failed ? 'FAIL' : 'PASS')
  + ` —— 主体 ${main.pass}/${main.fail}，对照臂 ${arms.length} 组`);
process.exit(failed ? 1 : 0);
