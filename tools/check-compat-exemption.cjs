'use strict';

/**
 * P1-3 门禁：兼容性豁免通道（`dsh plugin allow-version`）端侧可达 + 上游真正接受。
 *
 * 【为什么必须有这个门禁】P1-3 的原始症状是"授予了豁免、插件仍被跳过"。
 * 这条通道的失败模式极其安静：
 *   · 写错 profile 目录 ⇒ 上游读的是另一个目录，文件写完就没人看；
 *   · 文件名/键名/schema 与上游不一致 ⇒ 上游 `readProfileVersionExemptions` 静默跳过坏记录；
 *   · 版本写成 range（`^1.66.2`）⇒ 上游只认**精确版本**，同样静默跳过；
 *   · 假的 accepting 逻辑（不传 acceptRisk）⇒ 一旦上游加固就直接失效。
 * 以上四种在 UI 上都表现为"点了开关、提示成功、什么都没变"。所以本门禁的判据不能是
 * "文件写了没"，必须是**上游的挂载决策真的变了**：用上游自己的
 * `evaluatePluginCompatibility` 对比豁免前后的 `exempted` 字段（臂 B）。
 *
 * 【两臂设计】
 *   臂 A（无前置条件，PC 上恒可跑）：注入假 appBoot，断言薄封装把
 *     profileDir / packageVersion / runtimeVersion / enabled / acceptRisk
 *     原样透传，且"运行时空值 ⇒ 回退当前版本"这条不回退成空串。
 *   臂 B（需 `dist/core/work/dsh-core-<ver>`）：用**真实上游 app-boot**，
 *     断言挂载决策翻转 + 文件 schema + 上游拒收路径（range / 非精确版本 / 未确认风险 /
 *     批准未运行的版本 / 文件损坏时拒绝改写）。
 *   dist/ 被 gitignore，臂 B 的前置条件在未构建的 checkout 上不成立 ⇒ exit 2
 *   （与 check-parity.mjs「找不到矩阵」同约定：2 = 前置条件不成立，不是"通过"）。
 *
 * 【为什么不写"读回自己的文件"就算过】那是自证。臂 B 的读回全部用
 * `appBoot.readProfileVersionExemptions` / `evaluatePluginCompatibility`，
 * 即被验证方的对手——只有它们认账，才叫端侧豁免生效。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'hostcore', 'app', 'dshm-compat.js');
const RECIPE_PATH = path.join(ROOT, 'hostcore', 'core-recipe.json');

const compat = require(MODULE_PATH);

let passed = 0;
let failed = 0;
const skipNotes = [];

function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log('[PASS] ' + label);
  } else {
    failed += 1;
    console.log('[FAIL] ' + label + (detail === undefined ? '' : ' -- ' + detail));
  }
}

function mkProfileDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-compat-'));
}

function readRaw(file) {
  return fs.readFileSync(file, 'utf8');
}

/**
 * 读文件，失败返回 null。**只能用在 `check()` 的实参/条件里**。
 *
 * 【为什么必须有它（2026-09-28 由故障注入暴露）】`check(label, cond, detail)` 的实参在
 * 调用前就要先求值。若 detail 写成 `readRaw(compatFile)`，那么"豁免文件不存在"这一
 * **正是本门禁要抓的失败模式**会让断言还没跑就抛 ENOENT，整个门禁以
 * `[FATAL] … ENOENT` + 栈帧收场：报告说的是"文件读不到"，而真实结论应该是
 * "豁免没生效"。注入验证时两种注入（跳过写入 / 写错目录）都撞上了这一点，
 * 所以修在门禁里——否则它只会在真的回归时误导排查方向。
 */
function readSoft(file) {
  try {
    return readRaw(file);
  } catch (e) {
    return null;
  }
}

/** 供 detail 使用的安全展示（不存在 ⇒ `<不存在>`，换行转义成字面量）。 */
function show(file) {
  const t = readSoft(file);
  return t === null ? '<不存在>' : t.replace(/\n/g, '\\n');
}

/** 解析 JSON，失败（含文件不存在）返回 null。同样只用于断言实参。 */
function readJsonSoft(file) {
  const t = readSoft(file);
  if (t === null) {
    return null;
  }
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}

/** 取 stat，失败返回 null（文件被写没时 B6 不该变成 FATAL）。 */
function statSoft(file) {
  try {
    return fs.statSync(file);
  } catch (e) {
    return null;
  }
}

// ─────────────────────────── 臂 A：透传语义（假 appBoot） ───────────────────────────
function armA() {
  const calls = [];
  const fake = {
    getDshRuntimeVersion() {
      return '9.9.9-fake';
    },
    readProfileCompatibility() {
      return { exemptions: { 'x@1.0.0': ['9.9.9-fake'] }, warnings: [], rewritable: true };
    },
    setProfileVersionExemption(profileDir, packageVersion, runtimeVersion, enabled, acceptRisk) {
      calls.push({ profileDir, packageVersion, runtimeVersion, enabled, acceptRisk });
    },
  };
  const profileDir = mkProfileDir();
  return (async () => {
    // A1 四条实参原样到达（这是薄封装唯一真正要保证的事）
    await compat.applyRequest(
      { action: 'set', packageVersion: 'dshmarket@1.66.2', enabled: true, acceptRisk: true },
      { appBoot: fake, profileDir },
    );
    const c = calls[0] || {};
    check('A1 profileDir passed through',
      c.profileDir === profileDir, JSON.stringify(c.profileDir));
    check('A2 packageVersion passed through',
      c.packageVersion === 'dshmarket@1.66.2', JSON.stringify(c.packageVersion));
    check('A3 enabled passed through',
      c.enabled === true, JSON.stringify(c.enabled));
    check('A4 acceptRisk passed through', c.acceptRisk === true, JSON.stringify(c.acceptRisk));

    // A5 空运行时 ⇒ 由封装填当前版本。若透传空串，上游会抛
    //    "Cannot approve DSH : this application runs DSH 9.9.9-fake."（版本为空的假批准）。
    check('A5 empty runtimeVersion falls back to current (not empty string)',
      c.runtimeVersion === '9.9.9-fake', JSON.stringify(c.runtimeVersion));

    // A6 显式运行时不被覆盖（用户可以用 --dsh-version 指定，虽然上游会校验相等）
    await compat.applyRequest(
      { action: 'set', packageVersion: 'a@1.0.0', runtimeVersion: ' 1.2.3 ', enabled: true, acceptRisk: true },
      { appBoot: fake, profileDir },
    );
    const c2 = calls[1] || {};
    check('A6 explicit runtimeVersion wins (trimmed)',
      c2.runtimeVersion === '1.2.3', JSON.stringify(c2.runtimeVersion));

    // A7 revoke 传 enabled=false（而不是"不传参默认撤销"这种隐式语义）
    await compat.applyRequest(
      { action: 'set', packageVersion: 'a@1.0.0', enabled: false },
      { appBoot: fake, profileDir },
    );
    const c3 = calls[2] || {};
    check('A7 revoke passes enabled=false', c3.enabled === false, JSON.stringify(c3.enabled));

    // A8 acceptRisk 缺省即 false：**不能**因为"调用方没传"就替用户确认风险
    await compat.applyRequest(
      { action: 'set', packageVersion: 'a@1.0.0', enabled: true },
      { appBoot: fake, profileDir },
    );
    const c4 = calls[3] || {};
    check('A8 acceptRisk defaults to false (never auto-accept risk)',
      c4.acceptRisk === false, JSON.stringify(c4.acceptRisk));

    // A9 list 不触发写入，且如实回报 rewritable（否则 UI 无法提示"文件需先修复"）
    const before = calls.length;
    const rl = await compat.applyRequest({ action: 'list' }, { appBoot: fake, profileDir });
    check('A9 list does not write', calls.length === before);
    check('A10 list returns exemptions + rewritable',
      rl.ok === true && rl.rewritable === true && rl.exemptions['x@1.0.0'][0] === '9.9.9-fake',
      JSON.stringify(rl.exemptions || null));
    check('A11 list does not force runtimeVersion fallback call',
      typeof rl.runtimeVersion === 'undefined', JSON.stringify(rl.runtimeVersion));

    // A12-A17 契约：绝不抛错（队列轮询靠返回值写 .fail；抛错会让请求方等到超时）
    const bad = [
      ['null body', null],
      ['array body', []],
      ['string body', 'x'],
      ['missing packageVersion', { action: 'set' }],
      ['packageVersion without @', { action: 'set', packageVersion: 'dshmarket' }],
      ['packageVersion with trailing @', { action: 'set', packageVersion: 'dshmarket@' }],
      ['leading-@ (no name)', { action: 'set', packageVersion: '@1.0.0' }],
    ];
    for (const [label, body] of bad) {
      let r = null;
      let threw = '';
      try {
        r = await compat.applyRequest(body, { appBoot: fake, profileDir });
      } catch (e) {
        threw = String(e && e.message ? e.message : e);
      }
      check('A12 never throws / rejects cleanly: ' + label,
        threw.length === 0 && r !== null && r.ok === false && typeof r.error === 'string' && r.error.length > 0,
        threw.length > 0 ? 'threw: ' + threw : JSON.stringify(r));
    }

    // A18 缺 profileDir ⇒ 明确报错。静默用宿主 profile 会让"给 web profile 授权"变成
    //     一次无痕的空写（用户以为成功、实际写到了 ondevice）。
    let rNoDir = null;
    try {
      rNoDir = await compat.applyRequest({ action: 'set', packageVersion: 'a@1.0.0' }, { appBoot: fake });
    } catch (e) {
      rNoDir = { ok: false, error: 'threw: ' + e.message };
    }
    check('A18 missing profileDir fails loudly',
      rNoDir.ok === false && String(rNoDir.error).indexOf('profileDir') >= 0,
      JSON.stringify(rNoDir));

    // A19 上游抛错被收进 {ok:false,error}（arm B 会真的走到这条：上游的策略性拒绝）
    const boom = {
      getDshRuntimeVersion() { return '1.0.0'; },
      readProfileCompatibility() { return { exemptions: {}, warnings: [], rewritable: true }; },
      setProfileVersionExemption() { throw new Error('upstream said no'); },
    };
    const rBoom = await compat.applyRequest(
      { action: 'set', packageVersion: 'a@1.0.0', acceptRisk: true },
      { appBoot: boom, profileDir },
    );
    check('A19 upstream throw becomes {ok:false,error}',
      rBoom.ok === false && rBoom.error === 'upstream said no', JSON.stringify(rBoom));

    // A20-A25 解析器边界：作用域包取**最后一个** @（与上游 lastIndexOf 同口径）
    const p1 = compat.splitPackageVersion('@scope/name@1.2.3');
    check('A20 scoped name splits on last @',
      p1 !== null && p1.name === '@scope/name' && p1.version === '1.2.3', JSON.stringify(p1));
    const p2 = compat.splitPackageVersion('@scope/name@1.2.3+build.7');
    check('A21 build metadata kept intact',
      p2 !== null && p2.version === '1.2.3+build.7', JSON.stringify(p2));
    check('A22 no @ => null', compat.splitPackageVersion('dshmarket') === null);
    check('A23 trailing @ => null', compat.splitPackageVersion('dshmarket@') === null);
    check('A24 leading @ => null', compat.splitPackageVersion('@1.0.0') === null);
    check('A25 non-string => null', compat.splitPackageVersion(1234) === null && compat.splitPackageVersion(null) === null);

    // A26 文件名常量与上游一致（臂 B 还会与上游导出常量对拍）
    check('A26 filename is compatibility.json',
      compat.COMPAT_FILENAME === 'compatibility.json', compat.COMPAT_FILENAME);

    // A27 摘要为空表时是 ''（调用方据此不打印空行）
    check('A27 describeCompat empty => empty string', compat.describeCompat({ exemptions: {} }) === '');
  })();
}

// ─────────────────────────── 臂 B：真实上游（真接受 / 真拒绝） ───────────────────────────
async function armB() {
  const recipe = JSON.parse(readRaw(RECIPE_PATH));
  const coreDir = path.join(ROOT, 'dist', 'core', 'work', 'dsh-core-' + recipe.coreVersion);
  const appBootPath = path.join(coreDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!fs.existsSync(appBootPath)) {
    console.log('[SKIP] 臂 B 需要真实上游 app-boot，未找到：' + appBootPath);
    console.log('       （先构建核心树：见 docs/40-上游升级手册.md；本门禁不因此判红）');
    return 'SKIP-CORE';
  }

  const appBoot = await compat.loadAppBoot(coreDir);
  const runtime = appBoot.getDshRuntimeVersion();
  const profileDir = mkProfileDir();
  const compatFile = path.join(profileDir, 'compatibility.json');

  // B1 文件名与上游常量同值：上游改名字而我们继续写旧名 ⇒ 上游永远读不到
  check('B1 filename matches upstream constant',
    compat.COMPAT_FILENAME === appBoot.PROFILE_COMPATIBILITY_FILENAME,
    compat.COMPAT_FILENAME + ' vs ' + appBoot.PROFILE_COMPATIBILITY_FILENAME);

  // 一个真实的"卡在 0.1.x peer 上"的插件清单（dshmarket 的真实现象）
  const manifest = {
    name: 'dshmarket',
    version: '1.66.2',
    peerDependencies: { '@deepseek-ai/dsh': '^0.1.7' },
  };
  const before = appBoot.evaluatePluginCompatibility(manifest, {});
  // 上游 `peers` 是**以 peer 名为键的对象**（`{"@deepseek-ai/dsh":"^0.1.7"}`），不是数组。
  // 断言写成 `.peers.length > 0` 会永远为假（undefined > 0）——那正是"判据错了但看起来
  // 像在测东西"的典型：基线红着，后面 B8 的翻转就成了无意义对比（未被阻断的东西
  // 当然也"被豁免"）。
  check('B2基线：未经豁免 ⇒ exempted=false 且 peers 非空',
    before !== undefined && before.exempted === false
      && before.peers !== null && typeof before.peers === 'object'
      && Object.keys(before.peers).length > 0,
    JSON.stringify(before || null));

  // B3 授予（走端侧的整条路径：applyRequest，与队列/假壳/UI 用的是同一个入口）
  const granted = await compat.applyRequest(
    { action: 'set', packageVersion: 'dshmarket@1.66.2', enabled: true, acceptRisk: true },
    { coreDir, profileDir },
  );
  check('B3 grant ok', granted.ok === true, JSON.stringify(granted.error || ''));

  // B4 文件 schema 逐字节（上游 writeFileAtomic 的产物：2 空格缩进 + 末尾换行）
  const want = {};
  want['dshmarket@1.66.2'] = [runtime];
  let rawJson = null;
  try {
    rawJson = JSON.parse(readRaw(compatFile));
  } catch (e) {
    rawJson = null;
  }
  check('B4 compatibility.json content is exact',
    JSON.stringify(rawJson) === JSON.stringify(want),
    'disk=' + show(compatFile) + ' want=' + JSON.stringify(want));
  const rawText = readSoft(compatFile);
  check('B5 file ends with newline',
    rawText !== null && rawText.endsWith('}\n'),
    rawText === null ? '<不存在>' : JSON.stringify(rawText.slice(-4)));
  if (process.platform !== 'win32') {
    const st = statSoft(compatFile);
    check('B6 file mode 0600', st !== null && (st.mode & 0o777) === 0o600,
      st === null ? '<不存在>' : '0o' + (st.mode & 0o777).toString(8));
  } else {
    skipNotes.push('B6 file mode（Windows 上无 POSIX 权限位）');
  }

  // B7 上游自己的读取器认账（不是我们读回自己写的文件）
  const readBack = appBoot.readProfileVersionExemptions(profileDir);
  check('B7 upstream reader sees the exemption',
    JSON.stringify(readBack) === JSON.stringify(want), JSON.stringify(readBack));

  // B8★ 核心判据：上游的**挂载决策**翻转
  const after = appBoot.evaluatePluginCompatibility(manifest, readBack);
  check('B8 exemption flips the mount decision (exempted true)',
    after !== undefined && after.exempted === true, JSON.stringify(after || null));
  // B9 只翻转**精确**那一对：别的版本仍是 false（豁免不能顺带放宽整包）
  const other = appBoot.evaluatePluginCompatibility(
    { name: 'dshmarket', version: '1.66.3', peerDependencies: { '@deepseek-ai/dsh': '^0.1.7' } },
    readBack,
  );
  check('B9 another version of same package stays blocked',
    other !== undefined && other.exempted === false, JSON.stringify(other || null));
  // B10 同包同版本但换运行时 ⇒ 仍是 false（豁免是"精确版本对"）
  const otherRt = appBoot.evaluatePluginCompatibility(manifest, { 'dshmarket@1.66.2': ['0.1.7-rc.2'] });
  check('B11 exemption is per runtime version',
    otherRt !== undefined && otherRt.exempted === false, JSON.stringify(otherRt || null));

  // B12 未确认风险 ⇒ 上游拒绝（薄封装绝不能替用户按掉这个闸）
  const noRisk = await compat.applyRequest(
    { action: 'set', packageVersion: 'dshmarket@1.66.2', enabled: true, acceptRisk: false },
    { coreDir, profileDir },
  );
  check('B12 acceptRisk=false is refused by upstream',
    noRisk.ok === false && /accept-risk/i.test(String(noRisk.error)), JSON.stringify(noRisk.error || ''));

  // B13 批准一个**没在跑**的运行时 ⇒ 上游拒绝
  const wrongRt = await compat.applyRequest(
    { action: 'set', packageVersion: 'dshmarket@1.66.2', runtimeVersion: '0.1.7-rc.2', enabled: true, acceptRisk: true },
    { coreDir, profileDir },
  );
  check('B13 approving a non-running DSH version is refused',
    wrongRt.ok === false && /Cannot approve DSH/.test(String(wrongRt.error)), JSON.stringify(wrongRt.error || ''));

  // B14 range 不是精确版本 ⇒ 上游拒绝（这条最容易被"顺手支持 ^"的改动破坏）
  const range = await compat.applyRequest(
    { action: 'set', packageVersion: 'dshmarket@^1.66.2', enabled: true, acceptRisk: true },
    { coreDir, profileDir },
  );
  check('B14 range version is refused (exact only)',
    range.ok === false && /exact/i.test(String(range.error)), JSON.stringify(range.error || ''));

  // B15 非法包名 ⇒ 上游拒绝
  const badName = await compat.applyRequest(
    { action: 'set', packageVersion: 'not a package@1.0.0', enabled: true, acceptRisk: true },
    { coreDir, profileDir },
  );
  check('B15 invalid package name is refused',
    badName.ok === false, JSON.stringify(badName.error || ''));

  // B16 文件被写坏 ⇒ 拒绝改写（改写会丢掉用户内容）。这是**数据保全**判据。
  fs.writeFileSync(compatFile, '{ this is not json');
  const corruptSet = await compat.applyRequest(
    { action: 'set', packageVersion: 'other@1.0.0', enabled: true, acceptRisk: true },
    { coreDir, profileDir },
  );
  check('B17 corrupt file => refuse to rewrite (data safety)',
    corruptSet.ok === false && /must be repaired/i.test(String(corruptSet.error)),
    JSON.stringify(corruptSet.error || ''));
  check('B18 corrupt file left untouched',
    readSoft(compatFile) === '{ this is not json', show(compatFile));
  // B19 但"读"要如实回报 rewritable=false（UI 据此提示，而不是假装正常）
  const corruptList = await compat.applyRequest({ action: 'list' }, { coreDir, profileDir });
  check('B20 list on corrupt file reports rewritable=false',
    corruptList.ok === true && corruptList.rewritable === false && corruptList.warnings.length > 0,
    JSON.stringify({ rewritable: corruptList.rewritable, warnings: corruptList.warnings }));

  // B21-B22 撤销：grant → revoke 回到"无豁免、决策重新变回 blocked"
  fs.rmSync(compatFile, { force: true });
  await compat.applyRequest(
    { action: 'set', packageVersion: 'dshmarket@1.66.2', enabled: true, acceptRisk: true },
    { coreDir, profileDir },
  );
  const revoked = await compat.applyRequest(
    { action: 'set', packageVersion: 'dshmarket@1.66.2', enabled: false },
    { coreDir, profileDir },
  );
  check('B21 revoke ok', revoked.ok === true, JSON.stringify(revoked.error || ''));
  check('B22 revoke deletes the key entirely (empty object, not null value)',
    JSON.stringify(readJsonSoft(compatFile)) === '{}', show(compatFile));
  const afterRevoke = appBoot.evaluatePluginCompatibility(manifest, appBoot.readProfileVersionExemptions(profileDir));
  check('B23 after revoke the mount decision is blocked again',
    afterRevoke !== undefined && afterRevoke.exempted === false, JSON.stringify(afterRevoke || null));

  // B24 两条豁免并存时互不覆盖（多插件场景：授权第二个不能抹掉第一个）
  await compat.applyRequest(
    { action: 'set', packageVersion: 'dsh-better-sidebar@0.22.1', enabled: true, acceptRisk: true },
    { coreDir, profileDir },
  );
  await compat.applyRequest(
    { action: 'set', packageVersion: 'dshmarket@1.66.2', enabled: true, acceptRisk: true },
    { coreDir, profileDir },
  );
  const both = readJsonSoft(compatFile);
  check('B24 two exemptions coexist',
    both !== null
      && Object.keys(both).sort().join(',') === 'dsh-better-sidebar@0.22.1,dshmarket@1.66.2',
    JSON.stringify(both) + ' disk=' + show(compatFile));

  return 'OK';
}

(async () => {
  console.log('check-compat-exemption：兼容性豁免通道（P1-3）');
  console.log('module: ' + path.relative(ROOT, MODULE_PATH));
  await armA();
  const armBResult = await armB();
  for (const s of skipNotes) {
    console.log('[SKIP] ' + s);
  }
  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    process.exit(1);
  }
  if (armBResult === 'SKIP-CORE') {
    // 前置条件不成立（未构建核心树）：不是"通过"，也不是"失败"。
    console.log('NOTE: 臂 B 未执行 ⇒ 上游接受性尚未验证；构建核心树后重跑。');
    process.exit(2);
  }
  console.log('OK：臂 A + 臂 B 全过（上游挂载决策确实被豁免翻转）');
  process.exit(0);
})().catch((e) => {
  console.log('[FATAL] ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
