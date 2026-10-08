#!/usr/bin/env node
/**
 * check-denial-hints.mjs —— 「落盘/改名/解析被平台拒绝」的 errno 人话化 **离线**门禁
 * （真机 P1-1 / P1-2，见 docs/109）。不需要核心树、不需要设备、不需要 HarmonyOS SDK。
 *
 * 【为什么要有它】两个自带插件各自带一份逐字节相同的 `lib/denial-hints.js`
 * （`dshm-fs-write-nonchmod` 的 write/edit 落盘、`dshm-tool-fs-remove` 的 publish/move/remove
 * 与路径解析）。它们**不在同一个 npm 包里**，靠"复制两份 + 一条会红的判据"维持一致 ——
 * 这份门禁就是那条判据。同时它把"三个工具的调用点真的接上了"钉死：真机复测里
 * move/publish 仍抛裸 EPERM，正是"改了 write、忘了推广"这一类缺口（docs/108→109）。
 *
 * 【钉住什么】
 *   A 两份 `denial-hints.js` **逐字节一致**（否则就是"只改了一侧"，未来必然漂移）。
 *   B 该模块的**行为**：EPERM/EACCES/EROFS 三档命中后的完整文案；非三档（ENOENT/EXDEV…）
 *     原样返回（同一个对象、message 一字不动 —— 反向判据，禁止"把不存在说成没权限"）；
 *     `code`/`errno` 不被改写（调用方按 code 分派，见模块注释）；自定义 label。
 *   C `dshm-tool-fs-remove` 的**真行为**：把插件源码放进临时舞台（只补 `@deepseek-ai/dsh-tools`
 *     与 `dsh-fs` 两个桩），用假 ctx 注册三个工具，再让 `ctx.fs.lstat` 抛三档错误：
 *     `remove`/`move`/`publish` 的解析步骤必须翻成人话（正），ENOENT 必须原样上抛（反）。
 *   D 接线与反向判据（源码级）：publish 的落盘 catch、move 的 rename、remove 的 rm 三处必须走
 *     `describeWriteFailure`，而**上游的裸上抛形态必须已消失**；pack-core 里的
 *     `patchFsLocalPermissionHint()` 及其调用行必须在（否则产物里没有补丁，而门禁却全绿）。
 *
 * 用法：`node tools/check-denial-hints.mjs`
 * 退出码：0 通过 / 1 有真实问题
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WRITE_PLUGIN = join(ROOT, 'hostcore', 'plugins', 'dshm-fs-write-nonchmod');
const REMOVE_PLUGIN = join(ROOT, 'hostcore', 'plugins', 'dshm-tool-fs-remove');
const HINTS_REL = 'lib/denial-hints.js';
const PACK_CORE = join(ROOT, 'tools', 'pack-core.mjs');

let passed = 0;
const failures = [];
function ok(name, detail = '') {
  passed += 1;
  console.log(`ok   ${name}${detail ? `（${detail}）` : ''}`);
}
function bad(name, detail) {
  failures.push(`${name}：${detail}`);
  console.log(`FAIL ${name}：${detail}`);
}
function check(name, cond, detail = '') {
  if (cond) ok(name, detail);
  else bad(name, detail);
}

/** 三档命中后的**完整文案**（尾句是契约：改它必须同改这里，见模块注释）。 */
function expectedDenial(hint, absPath, label, original) {
  return `${hint}：${dirname(absPath)}（${label} ${basename(absPath)}）。`
    + `这是平台策略拒绝，重试无效；请改写到有权限的位置（如本应用认领的 `
    + `Download/<包名>/ 或沙箱），并如实告诉用户。原始报错：${original}`;
}

/** 造一个带 code 的合成错误（message 与真机逐字同形）。 */
function synth(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ══ A) 两份副本逐字节一致 ═══════════════════════════════════════════════
console.log('\n# A) 两份 lib/denial-hints.js 必须逐字节一致（漂移守卫）');
const hintsWrite = readFileSync(join(WRITE_PLUGIN, HINTS_REL), 'utf8');
const hintsRemove = readFileSync(join(REMOVE_PLUGIN, HINTS_REL), 'utf8');
check('两份 denial-hints.js 逐字节一致', hintsWrite === hintsRemove,
  `write=${hintsWrite.length}B remove=${hintsRemove.length}B`);

// ══ B) 模块行为 ═════════════════════════════════════════════════════════
console.log('\n# B) describeWriteFailure 的行为（三档命中 + 非三档放行）');
const hints = await import(pathToFileURL(join(WRITE_PLUGIN, HINTS_REL)).href);
const HINTS = hints.WRITE_DENIAL_HINTS;
check('WRITE_DENIAL_HINTS 恰好三档 EPERM/EACCES/EROFS',
  JSON.stringify(Object.keys(HINTS).sort()) === JSON.stringify(['EACCES', 'EPERM', 'EROFS']),
  JSON.stringify(Object.keys(HINTS)));

const REF = '/storage/Users/currentUser/Documents/报告.md';
for (const code of ['EPERM', 'EACCES', 'EROFS']) {
  const original = `${code}: operation not permitted, open '${REF}.41230.abc.partial'`;
  const error = synth(code, original);
  error.errno = -1;
  const returned = hints.describeWriteFailure(error, REF);
  check(`${code}：改写的是同一个对象（调用方分派不变）`, returned === error);
  check(`${code}：文案逐字命中`, error.message === expectedDenial(HINTS[code], REF, '目标文件', original),
    error.message);
  check(`${code}：code 未被改写`, error.code === code, String(error.code));
  check(`${code}：errno 未被改写`, error.errno === -1, String(error.errno));
  check(`${code}：原始报错附在末尾（可追溯）`, error.message.endsWith(original));
}
{
  const error = synth('ENOENT', "ENOENT: no such file or directory, stat '/tmp/nope'");
  const before = error.message;
  const returned = hints.describeWriteFailure(error, '/tmp/nope');
  check('反向：ENOENT 原样返回（不许把「不存在」说成「没权限」）',
    returned === error && error.message === before, error.message);
}
{
  const error = synth('EXDEV', 'EXDEV: cross-device link not permitted, rename');
  const before = error.message;
  hints.describeWriteFailure(error, '/tmp/x');
  check('反向：EXDEV 原样返回（改名跨设备不是权限问题）', error.message === before, error.message);
}
{
  const error = synth('EPERM', 'EPERM: operation not permitted, rename');
  hints.describeWriteFailure(error, '/tmp/x', '源文件');
  check('自定义 label 生效', error.message.includes('（源文件 x）'), error.message);
}
check('非 Error 输入原样返回', hints.describeWriteFailure('boom', '/tmp/x') === 'boom');

// ══ C) 三个工具的真行为（假 ctx + 注入到解析步骤的错误） ═════════════════
console.log('\n# C) remove/move/publish 的解析步骤：三档翻人话、ENOENT 放行');
const stage = mkdtempSync(join(tmpdir(), 'dshm-denial-hints-'));
let tools = null;
try {
  const pkgRoot = join(stage, 'node_modules', '@deepseek-ai');
  mkdirSync(join(pkgRoot, 'dshm-tool-fs-remove', 'lib'), { recursive: true });
  mkdirSync(join(pkgRoot, 'dsh-tools'), { recursive: true });
  mkdirSync(join(pkgRoot, 'dsh-fs'), { recursive: true });
  copyFileSync(join(REMOVE_PLUGIN, 'lib', 'index.js'),
    join(pkgRoot, 'dshm-tool-fs-remove', 'lib', 'index.js'));
  copyFileSync(join(REMOVE_PLUGIN, HINTS_REL),
    join(pkgRoot, 'dshm-tool-fs-remove', HINTS_REL));
  /*
   * 两个桩只补**导出面**，不含任何行为：`defineTool` 原样返回定义；`FsError` 只要带 code。
   * 判据全部落在插件自己的代码上。
   */
  writeFileSync(join(pkgRoot, 'dsh-tools', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', main: 'index.js' }));
  writeFileSync(join(pkgRoot, 'dsh-tools', 'index.js'), 'export const defineTool = (definition) => definition;\n');
  writeFileSync(join(pkgRoot, 'dsh-fs', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-fs', type: 'module', main: 'index.js' }));
  writeFileSync(join(pkgRoot, 'dsh-fs', 'index.js'), [
    'export class FsError extends Error {',
    '  constructor(message, code, options) {',
    '    super(message);',
    "    this.name = 'FsError';",
    '    this.code = code;',
    '    if (options && options.cause !== undefined) this.cause = options.cause;',
    '  }',
    '}',
    'export const FsVersion = (value) => value;',
    'export class FileSystem {}',
    '',
  ].join('\n'));

  const plugin = await import(
    pathToFileURL(join(pkgRoot, 'dshm-tool-fs-remove', 'lib', 'index.js')).href);
  const registered = new Map();
  /** lstat 替身：由每个用例决定抛什么（三档 / ENOENT / 正常返回）。 */
  let lstatImpl = async () => ({ version: 'v1', type: 'file', size: 1 });
  const ctx = {
    tools: {
      register: (definition) => { registered.set(definition.name, definition); },
      get: (n) => registered.get(n),
    },
    fs: {
      resolve: async (requestedPath) => ({ displayPath: requestedPath, targetKey: `k:${requestedPath}` }),
      lstat: (requestedPath) => lstatImpl(requestedPath),
    },
    systemPrompt: { section: () => {} },
    emit: () => {},
  };
  plugin.apply(ctx);
  tools = registered;
  check('apply() 注册了 remove/move/publish 三个工具',
    ['remove', 'move', 'publish'].every((n) => registered.has(n)),
    [...registered.keys()].join(','));

  const exec = { agent: { session: { header: { cwd: '/ws' } } }, signal: undefined };
  const prevDownload = process.env.DSHM_PUBLIC_DOWNLOAD;
  process.env.DSHM_PUBLIC_DOWNLOAD = '/storage/Users/currentUser/Download/com.dshm.dshclient';
  try {
    const drive = async (name, args) => {
      try {
        await tools.get(name).execute(args, exec);
        return null;
      } catch (error) {
        return error;
      }
    };

    for (const code of ['EPERM', 'EACCES', 'EROFS']) {
      lstatImpl = async () => { throw synth(code, `${code}: operation not permitted, stat '/x'`); };
      const target = '/storage/Users/currentUser/Documents/报告.md';
      const error = await drive('remove', { path: target });
      check(`remove：解析被拒（${code}）⇒ 人话文案`,
        error !== null && error.message === expectedDenial(HINTS[code], target, '路径',
          `${code}: operation not permitted, stat '/x'`),
        error === null ? '没有抛错（判据失效）' : error.message);
      check(`remove：${code} 的 code 仍原样`, error !== null && error.code === code,
        error === null ? '(none)' : String(error.code));
    }

    const moveTo = '/storage/Users/currentUser/Documents/目标.md';
    // move 的两个操作数各解析一次：只让**目的地**那次被拒，才能确认报的是目的地那一端
    lstatImpl = async (p) => {
      if (p === moveTo) throw synth('EPERM', "EPERM: operation not permitted, stat '/x'");
      return { version: 'v1', type: 'file', size: 1 };
    };
    const moveError = await drive('move', { source: '/ws/源.md', destination: moveTo });
    check('move：目的地解析被拒 ⇒ 人话文案',
      moveError !== null && moveError.message === expectedDenial(HINTS.EPERM, moveTo, '路径',
        "EPERM: operation not permitted, stat '/x'"),
      moveError === null ? '没有抛错（判据失效）' : moveError.message);
    lstatImpl = async () => { throw synth('EPERM', "EPERM: operation not permitted, stat '/x'"); };
    const publishError = await drive('publish', { source: '/ws/成品.md' });
    check('publish：源解析被拒 ⇒ 人话文案',
      publishError !== null && publishError.message === expectedDenial(HINTS.EPERM, '/ws/成品.md', '路径',
        "EPERM: operation not permitted, stat '/x'"),
      publishError === null ? '没有抛错（判据失效）' : publishError.message);

    // 反向：ENOENT 必须原样上抛（否则"文件不存在"会被讲成"没权限"）
    lstatImpl = async () => { throw synth('ENOENT', "ENOENT: no such file or directory, stat '/ws/无.md'"); };
    const gone = await drive('remove', { path: '/ws/无.md' });
    check('反向：remove 遇 ENOENT 原样上抛（不改写成没权限）',
      gone !== null && gone.message === "ENOENT: no such file or directory, stat '/ws/无.md'",
      gone === null ? '没有抛错（判据失效）' : gone.message);

    // 反向：非 Error 也原样上抛（不让包装层吞掉别人的异常形态）
    lstatImpl = async () => { throw 'plain-string-failure'; };
    const plain = await drive('remove', { path: '/ws/别的.md' });
    check('反向：非 Error 原样上抛', plain === 'plain-string-failure', String(plain));
  } finally {
    if (prevDownload === undefined) delete process.env.DSHM_PUBLIC_DOWNLOAD;
    else process.env.DSHM_PUBLIC_DOWNLOAD = prevDownload;
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}

// ══ D) 接线与反向判据（源码级） ═════════════════════════════════════════
console.log('\n# D) 三个落盘/改名/删除点必须走 describeWriteFailure（上游裸上抛形态必须消失）');
const removeSrc = readFileSync(join(REMOVE_PLUGIN, 'lib', 'index.js'), 'utf8');
const has = (needle) => removeSrc.includes(needle);
// 正
check('publish 落盘 catch：接上 describeWriteFailure',
  has('throw isAbortError(error) ? new FsError("publish aborted", "FS_ABORTED") : describeWriteFailure(error, absolutePath);'));
check('move 的 rename：接上 describeWriteFailure',
  has('throw describeWriteFailure(error, to.path);'));
check('remove 的 rm：接上 describeWriteFailure',
  has('throw describeWriteFailure(error, path, "路径");'));
check('解析步骤 lstat：接上 describeWriteFailure',
  has('throw describeWriteFailure(error, target.displayPath, "路径");'));
check('import 了 ./denial-hints.js', has('from "./denial-hints.js"'));
// 反（上游裸上抛形态必须已消失；逐字带缩进，避免命中同形副本）
check('反向：publish 旧的 `: error;` 已消失',
  !has('throw isAbortError(error) ? new FsError("publish aborted", "FS_ABORTED") : error;'));
check('反向：move 旧的裸 rename 已消失',
  !has('\n\t\t\tawait rename(from.path, to.path);'));
check('反向：remove 旧的裸 rm 已消失',
  !has('\n\t\t\tawait rm(path, { recursive: info.type === "directory", force: false });'));

console.log('\n# D2) pack-core 的 fs-local 权限补丁必须接线（否则产物里没补丁、门禁却全绿）');
const packCore = readFileSync(PACK_CORE, 'utf8');
check('pack-core 里有 patchFsLocalPermissionHint() 定义', packCore.includes('function patchFsLocalPermissionHint() {'));
check('pack-core 里有 patchFsLocalPermissionHint() 调用', packCore.includes('\npatchFsLocalPermissionHint();'));
check('pack-core 里的标记名与树内一致', packCore.includes("'DSHM_FS_LOCAL_PERMISSION_HINT'"));
check('pack-core 的待替换片段仍在（上游结构未变）',
  packCore.includes('async function readFileAbortable(absolutePath, verb, signal) {')
  && packCore.includes('readFileAbortable(target.targetKey, "read", signal);')
  && packCore.includes('readFileAbortable(absolutePath, "edit", signal);'));
check('pack-core 的权限判据用的是上游已有的 isPermissionError()',
  packCore.includes('isPermissionError(error)') && packCore.includes('"FS_PERMISSION_DENIED"'));

// ══ 收尾 ═══════════════════════════════════════════════════════════════
console.log(`\n断言 ${passed} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('OK 全部通过');
