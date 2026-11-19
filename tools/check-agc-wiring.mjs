#!/usr/bin/env node
/**
 * 门禁：AGC 接线与本仓签名身份一致（离线可跑，联网可选）。
 *
 * ## 它守什么
 *
 * 2026-10-25 接入 AGC CLI 时实测到三件会让"发版前校验"静默失效的事，
 * 每一件都只会在真去上传/装机那一刻才炸：
 *
 *   A. **`build-profile.json5` 的 release profile ≠ AGC 上的现行 profile**。
 *      仓里配的是 `DSHM-multihap-release-20261024-newacl.p7b`（uuid `20263a20…`，
 *      磁盘上没有任何工具生成它），而 AGC 上 `DSHM-multihap-release-20261024`
 *      下载下来是 `DSHM-multihap-release-20261024.p7b`（uuid `fa61dce6…`，
 *      与本仓那份**逐字节一致**，sha256 `ee4a510b…`）。
 *      两者的 ACL 都是 7 条、app-identifier 都是 `6917614360926110054`，
 *      所以**任何只看 ACL/包名的门禁都不会报警** —— 但签名身份不是同一个。
 *
 *   B. **profile 的 ACL 数会悄悄变成 0**。AGC 上 `provision` 列表里一旦出现
 *      `aclPermissionList: []` 的条目，用它签出来的包装到设备会被
 *      `PERMISSION_ACL_RULE` 拒装。
 *
 *   C. **包名与 App ID 的对应关系**。`com.dshm.dshclient` 必须唯一对应
 *      `6917614360926110054`；写成别的 ID 能签名能打包，只有在 AGC 上传时才发现。
 *
 * ## 判据分两层（默认只跑离线层）
 *
 *   L1 离线（默认）：P7B 可解析 + type/ACL/app-identifier 与 AGENTS.md 口径一致
 *      + `build-profile.json5` 指向的文件真实存在 + 包名与 App ID 对得上。
 *      **不需要网络、不需要登录**，CI 与干净克隆都能跑。
 *
 *   L2 联网（`--online`）：调 `tools/agc.mjs` 拿 AGC 侧的 profile 列表与 App ID，
 *      比对"仓里配的那份是否就是 AGC 现行那份"。**需要登录态**；
 *      未登录 / 403 时按 **exit 3（环境不具备）** 退出，绝不报成通过。
 *
 * ## 为什么不直接比 uuid 就完事
 * AGC 的 `provision` 列表**不返回 uuid**，只回 `id` / `provisionName` / `provisionType` /
 * `aclPermissionList` / `provisionDownloadUrl`。所以 L2 的判据是：
 * 名字匹配 → 用下载链接取回真实字节 → **sha256 比对**。这也顺带证明了
 * "本地这份 p7b 就是 AGC 能重新签发出来的那一份"。
 *
 * 用法：
 *   node tools/check-agc-wiring.mjs
 *   node tools/check-agc-wiring.mjs --online
 *   node tools/check-agc-wiring.mjs --self-test
 *
 * 退出码：0 通过 / 1 失败 / 2 用法错 / 3 环境不具备（缺 p7b、未登录、403）
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const C = process.env.NO_COLOR ? {} : { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', reset: '\x1b[0m' };
const ok = (m) => console.log(`${C.green ?? ''}✓${C.reset ?? ''} ${m}`);
const warn = (m) => console.log(`${C.yellow ?? ''}!${C.reset ?? ''} ${m}`);
const bad = (m) => console.log(`${C.red ?? ''}✗${C.reset ?? ''} ${m}`);
const info = (m) => console.log(`${C.yellow ?? ''}${C.reset ?? ''}  ${m}`);

/* ───────────── 口径（改这里就是改判据，别在下面另写字面量） ───────────── */

/** AGENTS.md 铁律：AGC 正式 App ID 唯一。 */
const EXPECTED_APP_ID = '6917614360926110054';

/** 当前正式包名。 */
const EXPECTED_BUNDLE = 'com.dshm.dshclient';

/** 发布 Profile 必须覆盖的 8 条 ACL（AGENTS.md §4.3：ACL 以发布 Profile 为准；2026-11-11 起 ACCESS_USER_FULL_DISK 获批入 Profile）。 */
const EXPECTED_RELEASE_ACLS = [
  'ohos.permission.ACCESS_USER_FULL_DISK',
  'ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE',
  'ohos.permission.CUSTOM_SANDBOX',
  'ohos.permission.FILE_ACCESS_PERSIST',
  'ohos.permission.READ_PASTEBOARD',
  'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY',
  'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
  'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
];

/* ───────────── P7B 解析（纯函数，供自检注入） ───────────── */

/**
 * 从 p7b 的二进制里取出内嵌的 provision JSON。
 *
 * 为什么不引依赖：p7b 是 PKCS#7 包裹，但里面那段 provision JSON 是**明文**的 ASCII，
 * 从 `{"version-name"` 起按花括号配平截取即可。本仓此前所有同类核对都是这么做的
 * （见 docs/141 记录的手工核对），无需 openssl。
 *
 * @param {Buffer} buf 整个 p7b 文件
 * @returns {object|null} 解析出的 provision 对象；失败返回 null
 */
export function parseP7b(buf) {
  const s = buf.toString('latin1');
  const i = s.indexOf('{"version-name');
  if (i < 0) return null;
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(i, k + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 抽出本门禁关心的那几个字段。
 * 注意 ACL 在 `acls["allowed-acls"]`，**不在** `bundle-info` 里
 * （第一次写就是找错层级，得出"0 条 ACL"的假读数）。
 */
export function summarize(provision) {
  const bi = provision['bundle-info'] ?? {};
  return {
    uuid: provision.uuid ?? '',
    type: provision.type ?? '',
    bundleName: bi['bundle-name'] ?? '',
    appIdentifier: bi['app-identifier'] ?? '',
    notAfter: provision.validity?.['not-after'] ?? 0,
    acls: provision.acls?.['allowed-acls'] ?? [],
  };
}

/** 比较两个 ACL 集合（顺序无关）。返回缺失/多余。 */
export function diffAcls(actual, expected) {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    missing: expected.filter((x) => !a.has(x)),
    extra: actual.filter((x) => !e.has(x)),
  };
}

/* ───────────── 读配置 ───────────── */

function readBundleName() {
  try {
    const text = readFileSync(join(ROOT, 'AppScope', 'app.json5'), 'utf8');
    return /"bundleName"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? '';
  } catch {
    return '';
  }
}

/** 从 build-profile.json5 里找出 release 产品实际使用的 profile 路径（相对仓库根）。 */
export function releaseProfileRel(text) {
  // 先定位 signingConfigs 里 name=release 的那一块，再取它的 material.profile
  const m = /"name"\s*:\s*"release"[\s\S]{0,600}?"profile"\s*:\s*"([^"]+)"/.exec(text);
  return m?.[1] ?? '';
}

/* ───────────── L1 离线 ───────────── */

function runOffline() {
  const problems = [];
  console.log('# L1 离线：本仓签名身份自洽性\n');

  const bundle = readBundleName();
  if (bundle !== EXPECTED_BUNDLE) problems.push(`AppScope 包名 ${JSON.stringify(bundle)} ≠ ${EXPECTED_BUNDLE}`);
  else ok(`包名 ${bundle}`);

  let text = '';
  try {
    text = readFileSync(join(ROOT, 'build-profile.json5'), 'utf8');
  } catch {
    problems.push('缺 build-profile.json5（本机签名配置，机器绑定；见 .gitignore）');
  }

  const rel = text === '' ? '' : releaseProfileRel(text);
  if (rel === '') {
    problems.push('build-profile.json5 里找不到 release 产品的 material.profile');
  } else {
    const abs = join(ROOT, rel.replace(/^\.\//, ''));
    if (!existsSync(abs)) {
      problems.push(`release profile 不存在：${rel}`);
    } else {
      ok(`release profile 存在：${rel}`);
      const buf = readFileSync(abs);
      const sha = createHash('sha256').update(buf).digest('hex');
      const provision = parseP7b(buf);
      if (provision === null) {
        problems.push(`解析不出 provision JSON：${rel}`);
      } else {
        const s = summarize(provision);
        ok(`  可解析：uuid=${s.uuid} type=${s.type}`);
        if (s.type !== 'release') problems.push(`type=${s.type}，release 产品必须用 type=release 的 profile`);
        if (s.bundleName !== EXPECTED_BUNDLE) problems.push(`profile bundle-name=${s.bundleName} ≠ ${EXPECTED_BUNDLE}`);
        if (s.appIdentifier !== EXPECTED_APP_ID) problems.push(`profile app-identifier=${s.appIdentifier} ≠ ${EXPECTED_APP_ID}`);
        if (s.notAfter > 0 && s.notAfter * 1000 < Date.now()) problems.push(`profile 已过期（not-after=${new Date(s.notAfter * 1000).toISOString()}）`);
        const d = diffAcls(s.acls, EXPECTED_RELEASE_ACLS);
        if (d.missing.length > 0) problems.push(`profile 缺 ACL：${d.missing.map((x) => x.replace('ohos.permission.', '')).join(', ')}`);
        if (d.extra.length > 0) warn(`profile 多出未登记 ACL：${d.extra.join(', ')}（表外权限 = 会被拒装，见 AGENTS.md）`);
        if (s.acls.length === 0) problems.push('profile 的 allowed-acls 是 0 条');
        else ok(`  ACL ${s.acls.length} 条，与 AGENTS.md 的 ${EXPECTED_RELEASE_ACLS.length} 条口径一致`);
        console.log(`  sha256 = ${sha}`);
      }
    }
  }

  // 【文件名与 AGC 上的 profile 名不一致，是核实过的事实，不是偏差】
  // 实测（docs/257，逐条下载 AGC 上 4 条 type=2 profile 做 sha256 比对）：
  //   本地 `...-newacl.p7b`（18a9a3da…）== AGC `dshm_three`
  //   本地 `...-release-20261024.p7b`（ee4a510b…）== AGC `DSHM-multihap-release-20261024`
  // 即：**两个文件各对应 AGC 上一条**，都合法。只是磁盘文件名（newacl / multihap）
  // 与 AGC 上的名字（dshm_three / multihap-release-20261024）不同 ——
  // 光看名字会以为 AGC 上没有 newacl（我第一版就判断反了）。
  // ⇒ 判据只能是**字节**，不是名字。L2 的下载比对就是在做这件事。
  if (rel.includes('newacl')) {
    info('提示：本仓 release 指向 `*-newacl.p7b`，它在 AGC 上的名字是 `dshm_three`（字节一致）。');
    info('  文件名 ≠ AGC profile 名，别按名字找。见 docs/257 §4。');
  }

  return problems;
}

/* ───────────── L2 联网 ───────────── */

async function runOnline() {
  const problems = [];
  console.log('\n# L2 联网：AGC 侧一致性\n');

  const agc = join(ROOT, 'tools', 'agc.mjs');
  if (!existsSync(agc)) {
    warn('缺 tools/agc.mjs ⇒ 跳过 L2');
    return { problems, skip: true };
  }

  const { spawnSync } = await import('node:child_process');
  const env = (args) => spawnSync(process.execPath, [agc, 'raw', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

  const st = env(['auth', 'status']);
  const stText = `${st.stdout ?? ''}${st.stderr ?? ''}`;
  if (st.status !== 0 || /Missing AGC credentials/.test(stText)) {
    warn('AGC 未登录（或读不到 .env）⇒ L2 无法判定，按 exit 3 处理');
    console.log('   修法：node tools/agc.mjs status 看登录态；必要时 auth login（交互式，需浏览器）');
    return { problems, skip: true };
  }

  const ai = env(['publish', 'app-id', '-p', EXPECTED_BUNDLE]);
  let appId = '';
  try {
    appId = JSON.parse(ai.stdout).appids?.[0]?.value ?? '';
  } catch { /* 下面统一处理 */ }
  if (appId === '') {
    if (/\b403\b/.test(`${ai.stdout ?? ''}${ai.stderr ?? ''}`)) {
      warn('403：该 API 客户端对 publish app-id 无权限 ⇒ L2 无法判定（exit 3）');
      return { problems, skip: true };
    }
    problems.push('AGC 上查不到该包名的 App ID');
    return { problems, skip: false };
  }
  if (appId !== EXPECTED_APP_ID) problems.push(`AGC 返回 App ID ${appId} ≠ ${EXPECTED_APP_ID}`);
  else ok(`AGC App ID = ${EXPECTED_APP_ID}`);

  const pl = env(['provision', 'profile-list', '-a', appId]);
  let list = [];
  try {
    list = JSON.parse(pl.stdout).provisionList ?? [];
  } catch {
    warn('取不到 AGC profile 列表 ⇒ L2 部分跳过');
    return { problems, skip: true };
  }

  // 本仓配的那份 p7b 的 uuid（用来提示"AGC 侧不返回 uuid，只能按名字+字节比"）
  let localSha = '';
  try {
    const text = readFileSync(join(ROOT, 'build-profile.json5'), 'utf8');
    const rel = releaseProfileRel(text);
    if (rel !== '') localSha = createHash('sha256').update(readFileSync(join(ROOT, rel.replace(/^\.\//, '')))).digest('hex');
  } catch { /* 前面 L1 已报 */ }

  const zeroAcl = list.filter((p) => (p.aclPermissionList ?? []).length === 0);
  if (zeroAcl.length > 0) {
    problems.push(`AGC 上有 ${zeroAcl.length} 条 0 ACL 的 profile（用它签的包装不上设备）：${zeroAcl.map((p) => p.provisionName).join(', ')}`);
  } else {
    ok(`AGC ${list.length} 条 profile 的 ACL 均非空`);
  }

  // 只对 type=2（正式 release）做字节比对：下载 → sha256
  const releases = list.filter((p) => p.provisionType === 2 && p.provisionDownloadUrl);
  let matched = '';
  for (const p of releases) {
    const got = await fetchBytes(p.provisionDownloadUrl);
    if (got === null) { warn(`下载失败：${p.provisionName}（链接 5 分钟过期，重跑即可）`); continue; }
    const sha = createHash('sha256').update(got).digest('hex');
    if (sha === localSha) matched = p.provisionName;
  }
  if (matched !== '') ok(`本仓 release profile 与 AGC 现行件逐字节一致（${matched}）`);
  else if (localSha !== '') {
    problems.push('本仓 build-profile 的 release profile 与 AGC 上任何一条 release 都不逐字节一致 ⇒ 签名身份对不上');
  }

  return { problems, skip: false };
}

async function fetchBytes(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/* ───────────── 自检 ───────────── */

function selfTest() {
  let pass = 0;
  let fail = 0;
  const t = (name, cond) => {
    if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; bad(`FAIL ${name}`); }
  };

  const sample = {
    uuid: 'fa61dce6-2934-41f6-bf78-984faab68654',
    type: 'release',
    'bundle-info': { 'bundle-name': 'com.dshm.dshclient', 'app-identifier': '6917614360926110054' },
    validity: { 'not-after': 1886496580 },
    acls: { 'allowed-acls': [...EXPECTED_RELEASE_ACLS] },
  };
  const s = summarize(sample);
  t('summarize 取出 uuid/type', s.uuid === sample.uuid && s.type === 'release');
  t('ACL 从 acls["allowed-acls"] 取（不是 bundle-info）', s.acls.length === EXPECTED_RELEASE_ACLS.length);
  t('app-identifier 来自 bundle-info', s.appIdentifier === EXPECTED_APP_ID);

  t('diffAcls：完全相同 ⇒ 无缺失', diffAcls(EXPECTED_RELEASE_ACLS, EXPECTED_RELEASE_ACLS).missing.length === 0);
  t('diffAcls：少一条 ⇒ 报缺失', diffAcls(EXPECTED_RELEASE_ACLS.slice(1), EXPECTED_RELEASE_ACLS).missing.length === 1);
  t('diffAcls：多一条 ⇒ 报多余', diffAcls([...EXPECTED_RELEASE_ACLS, 'ohos.permission.X'], EXPECTED_RELEASE_ACLS).extra.length === 1);
  t('diffAcls：顺序无关', diffAcls([...EXPECTED_RELEASE_ACLS].reverse(), EXPECTED_RELEASE_ACLS).missing.length === 0);

  t('parseP7b：无 JSON ⇒ null', parseP7b(Buffer.from('not a p7b')) === null);
  // 【fixture 必须让 `{"version-name"` 打头】真实 p7b 里 provision JSON 就是从
  // `{"version-name"` 开始的（解析器按这个标记定位）。JSON.stringify 依**键的插入顺序**
  // 输出，所以先把 version-name 放进去 —— 否则 marker 不在开头，解析器直接返回 null，
  // 自测会用"假失败"掩盖解析器本身是对的。
  const withMarker = (o) => Buffer.from(JSON.stringify({ 'version-name': '2.0.0', ...o }), 'latin1');
  const wrapped = Buffer.concat([Buffer.from([0x30, 0x82, 0x01]), withMarker(sample), Buffer.from([0x30, 0x00])]);
  t('parseP7b：能从二进制里夹出 provision', parseP7b(wrapped)?.uuid === sample.uuid);
  const nested = withMarker({ ...sample, extra: { a: { b: 1 } } });
  t('parseP7b：嵌套花括号也能配平', parseP7b(Buffer.concat([Buffer.from([0]), nested, Buffer.from([0])]))?.extra?.a?.b === 1);
  t('parseP7b：截断的 JSON ⇒ null', parseP7b(Buffer.from('{"version-name":"x"')) === null);

  const bp = `{"signingConfigs":[{"name":"debug","material":{"profile":"./a.p7b"}},{"name":"release","material":{"profile":"./b.p7b"}}]}`;
  t('releaseProfileRel 取 release 那块', releaseProfileRel(bp) === './b.p7b');
  t('releaseProfileRel：缺 release ⇒ 空串', releaseProfileRel('{"signingConfigs":[]}') === '');

  console.log(`\n自测：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

/* ───────────── 入口 ───────────── */

const args = process.argv.slice(2);
if (args.includes('--self-test')) selfTest();
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法：node tools/check-agc-wiring.mjs [--online] [--self-test]');
  process.exit(0);
}

const problems = runOffline();
let skipped = false;
if (args.includes('--online')) {
  const r = await runOnline();
  problems.push(...r.problems);
  skipped = r.skip;
}

console.log('');
if (problems.length > 0) {
  for (const p of problems) bad(p);
  console.log(`\n${C.red ?? ''}FAIL${C.reset ?? ''}：${problems.length} 个问题`);
  process.exit(1);
}
if (skipped) {
  warn('L1 通过；L2 未判定（环境不具备）⇒ 整体按 exit 3，不报通过');
  process.exit(3);
}
console.log(`${C.green ?? ''}PASS${C.reset ?? ''}：AGC 接线与本仓签名身份一致`);
process.exit(0);
