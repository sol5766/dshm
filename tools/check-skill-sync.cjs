'use strict';
/**
 * P0-1 回归：内置技能同步必须按**内容**判等，等长改动必须被检出。
 *
 * 【为什么单独一个门禁 —— 真机证据 2026-09-28】
 * 旧实现（main.js 的 ensureBundledSkills）用 `statSize(dst) === statSize(src)` 判等。
 * 把 skill 里的 `hdsh-*` 端点整体改名成 `dshm-*`（**等长替换**）后，resfile 侧与设备
 * 侧副本字节数完全一致（6262 B）⇒ 判定"已是同一份"⇒ 永不复制 ⇒ 设备端 skill 永远
 * 写着旧端点 `/hdsh-python/*`（实际端点 `/dshm-python/*`），模型照文档手调必然 404。
 * 这种缺陷在真机上**只表现为"文档改了但没生效"**，没有任何报错，所以必须由本门禁
 * 用"大小相同、内容不同"的合成用例钉死。任何退回按大小/mtime 判等的改法都会红。
 *
 * 断言分组：
 *   A 首次同步全量复制；B 逐字节相同 ⇒ 真幂等（copied 0 且**不写目标**）；
 *   C **等长改动** ⇒ 必被复制且内容真的更新（旧实现在此必红）；
 *   D 目标被等长篡改 ⇒ 以源为准恢复；E 非 .md 与"目录名以 .md 结尾"都不参与；
 *   F 源目录缺失 ⇒ 记 failed 不抛错；G 写入原子性（不留临时文件）+ 崩溃残留被清扫；
 *   H 源不可读（目录占位）⇒ 记 failed 且不破坏目标同名文件。
 *
 * 不依赖网络。跑法：node tools/check-skill-sync.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { syncSkills, contentFingerprint, TMP_PREFIX } = require('../hostcore/app/dshm-skills.js');

let passed = 0;
let failed = 0;

/** ASCII-only 输出（PS 5.1 / GBK 控制台安全）。 */
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log('[PASS] ' + label);
  } else {
    failed += 1;
    console.log('[FAIL] ' + label + (detail === undefined ? '' : ' :: ' + String(detail)));
  }
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-skills-' + tag + '-'));
}

function write(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

// ── 夹具：两个 skill，其中「等长替换」正是真机现场的那一对 ────────────────
// 长度：'hdsh-python' 与 'dshm-python' 完全同长（4+7 vs 4+7）。
const OLD_ENDPOINT = '/hdsh-python/exec';
const NEW_ENDPOINT = '/dshm-python/exec';
const SKILL_OLD = '# Python\n\n端点：' + OLD_ENDPOINT + '\n';
const SKILL_NEW = '# Python\n\n端点：' + NEW_ENDPOINT + '\n';
const SKILL_OTHER = '# Shell\n\n用 busybox。\n';

function makeFixture(tag) {
  const root = tmpDir(tag);
  const src = path.join(root, 'resfile', 'ohos-skills');
  const dst = path.join(root, 'home', 'skills');
  fs.mkdirSync(src, { recursive: true });
  write(path.join(src, 'ohos-python.md'), SKILL_NEW);
  write(path.join(src, 'ohos-shell.md'), SKILL_OTHER);
  return { src, dst };
}

// ── A：首次同步全量复制 ────────────────────────────────────────────────
{
  const f = makeFixture('first');
  const r = syncSkills(f.src, f.dst);
  check('A1 首次同步复制全部 .md', r.copied.length === 2, JSON.stringify(r));
  check('A2 首次同步无 unchanged', r.unchanged.length === 0, JSON.stringify(r.unchanged));
  check('A3 首次同步无 failed', r.failed.length === 0, JSON.stringify(r.failed));
  check('A4 目标内容与源逐字节一致（python）',
    read(path.join(f.dst, 'ohos-python.md')) === SKILL_NEW);
  check('A5 目标内容与源逐字节一致（shell）',
    read(path.join(f.dst, 'ohos-shell.md')) === SKILL_OTHER);
}

// ── B：真幂等 —— 内容相同就不写目标 ────────────────────────────────────
{
  const f = makeFixture('idem');
  syncSkills(f.src, f.dst);
  const target = path.join(f.dst, 'ohos-python.md');
  const stamp = new Date(Date.now() - 86400000); // 昨天：一旦被重写 mtime 就会变
  fs.utimesSync(target, stamp, stamp);
  const before = fs.statSync(target).mtimeMs;
  const r = syncSkills(f.src, f.dst);
  check('B1 内容相同 ⇒ copied 为空', r.copied.length === 0, JSON.stringify(r.copied));
  check('B2 内容相同 ⇒ unchanged 计满', r.unchanged.length === 2, JSON.stringify(r.unchanged));
  check('B3 内容相同 ⇒ 目标文件未被触碰（mtime 不变）',
    fs.statSync(target).mtimeMs === before, before + ' vs ' + fs.statSync(target).mtimeMs);
}

// ── C：等长改动（本门禁存在的理由）─────────────────────────────────────
{
  const f = makeFixture('equallen');
  // 先让设备侧是"旧端点"版本 —— 这正是真机上卡住的现场。
  // 另一个文件（shell）写成与源一致，用来同时验证"改的那个要复制、没改的那个仍幂等"。
  write(path.join(f.dst, 'ohos-python.md'), SKILL_OLD);
  write(path.join(f.dst, 'ohos-shell.md'), SKILL_OTHER);
  const srcSize = fs.statSync(path.join(f.src, 'ohos-python.md')).size;
  const dstSize = fs.statSync(path.join(f.dst, 'ohos-python.md')).size;
  check('C0 夹具前提：新旧两份字节数相同（等长替换）', srcSize === dstSize,
    srcSize + ' vs ' + dstSize);
  check('C0b 夹具前提：内容确实不同',
    read(path.join(f.dst, 'ohos-python.md')) !== SKILL_NEW);

  const r = syncSkills(f.src, f.dst);
  check('C1 等长改动必须出现在 copied 里',
    r.copied.indexOf('ohos-python.md') >= 0, JSON.stringify(r));
  check('C2 等长改动之后目标内容 = 源内容（旧实现此处必红）',
    read(path.join(f.dst, 'ohos-python.md')) === SKILL_NEW,
    read(path.join(f.dst, 'ohos-python.md')));
  check('C3 新端点确实落地、旧端点已消失',
    (read(path.join(f.dst, 'ohos-python.md')) || '').indexOf(NEW_ENDPOINT) >= 0
    && (read(path.join(f.dst, 'ohos-python.md')) || '').indexOf(OLD_ENDPOINT) < 0);
  check('C4 未变的那个文件仍走 unchanged',
    r.unchanged.indexOf('ohos-shell.md') >= 0, JSON.stringify(r.unchanged));
  // 复跑一次应回到幂等：证明 C 的复制是收敛的，不是每次都重写
  const r2 = syncSkills(f.src, f.dst);
  check('C5 收敛：等长改动同步一次后再跑即幂等',
    r2.copied.length === 0 && r2.unchanged.length === 2, JSON.stringify(r2));
}

// ── D：目标被等长篡改 ⇒ 以源为准恢复 ──────────────────────────────────
{
  const f = makeFixture('tamper');
  syncSkills(f.src, f.dst);
  write(path.join(f.dst, 'ohos-python.md'), SKILL_OLD); // 设备侧被改回旧端点（等长）
  const r = syncSkills(f.src, f.dst);
  check('D1 目标被等长篡改 ⇒ 重新复制', r.copied.indexOf('ohos-python.md') >= 0,
    JSON.stringify(r.copied));
  check('D2 篡改被恢复为源内容',
    read(path.join(f.dst, 'ohos-python.md')) === SKILL_NEW);
}

// ── E：非 .md 与"名字以 .md 结尾的目录"都不参与 ─────────────────────────
{
  const f = makeFixture('filter');
  write(path.join(f.src, 'notes.txt'), 'not a skill');
  write(path.join(f.src, 'README'), 'no ext');
  fs.mkdirSync(path.join(f.src, 'trap.md')); // 目录名以 .md 结尾
  write(path.join(f.src, 'trap.md', 'inner.md'), 'nested');
  const r = syncSkills(f.src, f.dst);
  check('E1 只复制两个真 skill', r.copied.length === 2, JSON.stringify(r.copied));
  check('E2 .txt 未被复制', read(path.join(f.dst, 'notes.txt')) === null);
  check('E3 无扩展名文件未被复制', read(path.join(f.dst, 'README')) === null);
  check('E4 以 .md 结尾的目录未被当作技能', read(path.join(f.dst, 'trap.md')) === null);
  check('E5 子目录内容未被复制', read(path.join(f.dst, 'inner.md')) === null);
}

// ── F：源目录缺失 ⇒ 记 failed、不抛错 ─────────────────────────────────
{
  const root = tmpDir('missing');
  const dst = path.join(root, 'home', 'skills');
  let threw = false;
  let r = null;
  try {
    r = syncSkills(path.join(root, 'nope'), dst);
  } catch (e) {
    threw = true;
  }
  check('F1 源目录缺失不抛错', threw === false);
  check('F2 源目录缺失记入 failed', r !== null && r.failed.length === 1,
    r === null ? 'null' : JSON.stringify(r.failed));
}

// ── G：写入原子性 + 崩溃残留清扫 ───────────────────────────────────────
{
  const f = makeFixture('atomic');
  // 伪造上次崩溃残留的中间文件
  fs.mkdirSync(f.dst, { recursive: true });
  write(path.join(f.dst, TMP_PREFIX + 'ohos-python.md'), 'half written');
  const r = syncSkills(f.src, f.dst);
  check('G1 同步成功', r.failed.length === 0, JSON.stringify(r.failed));
  const left = fs.readdirSync(f.dst).filter((n) => n.indexOf(TMP_PREFIX) === 0);
  check('G2 正常同步后不留临时文件', left.length === 0, JSON.stringify(left));
  check('G3 目录内恰好是两个技能文件',
    fs.readdirSync(f.dst).sort().join(',') === 'ohos-python.md,ohos-shell.md',
    fs.readdirSync(f.dst).sort().join(','));
}

// ── H：源不可读（目录占位）⇒ 记 failed、不动目标 ───────────────────────
{
  const f = makeFixture('srcdir');
  syncSkills(f.src, f.dst); // 先正常同步一次
  fs.rmSync(path.join(f.src, 'ohos-python.md'));
  fs.mkdirSync(path.join(f.src, 'ohos-python.md')); // 用同名目录顶掉源文件
  const r = syncSkills(f.src, f.dst);
  check('H1 源侧是目录 ⇒ 不误判为"需要复制"', r.copied.indexOf('ohos-python.md') < 0,
    JSON.stringify(r.copied));
  check('H2 源侧是目录 ⇒ 目标原文件保持完好（未被清空/覆盖）',
    read(path.join(f.dst, 'ohos-python.md')) === SKILL_NEW,
    read(path.join(f.dst, 'ohos-python.md')));
}

// ── I：指纹函数本身 ────────────────────────────────────────────────────
{
  const f = makeFixture('fp');
  const a = contentFingerprint(path.join(f.src, 'ohos-python.md'));
  check('I1 指纹是 sha256 十六进制（64 字符）', /^[0-9a-f]{64}$/.test(a), a);
  write(path.join(f.src, 'ohos-python.md'), SKILL_OLD); // 等长改写
  const b = contentFingerprint(path.join(f.src, 'ohos-python.md'));
  check('I2 等长改写的指纹必须不同（这是判据成立的前提）', a !== b, a + ' vs ' + b);
  check('I3 读不到的文件指纹为空串',
    contentFingerprint(path.join(f.src, 'no-such.md')) === '');
}

console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
