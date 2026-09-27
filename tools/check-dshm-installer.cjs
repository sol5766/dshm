'use strict';
/**
 * dshm-installer.js 的 PC 侧验证（D26 运行时安装通道）。
 * 在本机 Node 上跑安装器全链路：spec 解析 → registry 拉取 → 解包落位 →
 * merge → 用户行。端侧 Node（libnode.so）与本机 node:https/zlib 同构，
 * 此处通过即端侧问题面缩小到「网络可达性 + 文件系统差异」。
 * 输出刻意用 ASCII（PS 5.1 控制台 GBK 兼容）。
 * 用法：node tools/check-dshm-installer.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const installer = require('../hostcore/app/dshm-installer.js');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('[PASS] ' + label);
  } else {
    fail += 1;
    console.log('[FAIL] ' + label + (detail ? ' -- ' + detail : ''));
  }
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-inst-'));
  const profileDir = path.join(home, 'profiles', 'ondevice');
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'ondevice', dependencies: {} }, null, 2));
  return home;
}

// ── 1. tar-slip 防护：恶意条目必须抛错 ──
function tarHeader(name, size, type) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8'); // name
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8'); // size
  h.write(type, 156, 'utf8'); // typeflag
  h.write('        ', 148, 'utf8'); // checksum 占位（148-155，8 字节，勿溢出到 156）
  // checksum
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
  return h;
}

(async () => {
  // ── 1. extractTar 安全 ──
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-tar-'));
    const evil = Buffer.concat([tarHeader('../evil.txt', 4, '0'), Buffer.from('boom'), Buffer.alloc(512)]);
    let threw = false;
    try {
      installer.extractTar(evil, tmp);
    } catch (e) {
      threw = true;
    }
    check('extractTar rejects ../ path', threw);
    check('extractTar leaves no ../ file', !fs.existsSync(path.join(tmp, '..', 'evil.txt')));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ── 2. symlink 条目跳过（沙箱禁 link）──
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-tar-'));
    const sym = Buffer.concat([tarHeader('link.txt', 4, '2'), Buffer.from('/etc'), Buffer.alloc(512)]);
    const r = installer.extractTar(sym, tmp);
    check('extractTar skips symlink entry', r.skipped.length === 1 && !fs.existsSync(path.join(tmp, 'link.txt')));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ── 3. resolveSpec：GitHub 三形态（不下载）──
  {
    const r1 = await installer.resolveSpec('https://github.com/foo/bar.git', installer.DEFAULT_REGISTRY).catch((e) => ({ err: e.message }));
    check('resolveSpec github https', r1.tarballUrl === 'https://codeload.github.com/foo/bar/tar.gz/HEAD', JSON.stringify(r1));
    const r2 = await installer.resolveSpec('github.com/foo/bar#dev', installer.DEFAULT_REGISTRY).catch((e) => ({ err: e.message }));
    check('resolveSpec github shorthand #branch', r2.tarballUrl === 'https://codeload.github.com/foo/bar/tar.gz/dev', JSON.stringify(r2));
    const r3 = await installer.resolveSpec('git@github.com:foo/bar.git', installer.DEFAULT_REGISTRY).catch((e) => ({ err: e.message }));
    check('resolveSpec git@ form', r3.tarballUrl === 'https://codeload.github.com/foo/bar/tar.gz/HEAD', JSON.stringify(r3));
  }

  // ── 4. 全链路：debug@4.3.4（递归依赖 ms）──
  const home = makeHome();
  const profileDir = path.join(home, 'profiles', 'ondevice');
  {
    const r = await installer.installSpec('debug@4.3.4', { homeDir: home, profile: 'ondevice', log: (m) => console.log('       ' + m) });
    check('installSpec debug ok', r.ok === true, JSON.stringify(r).slice(0, 300));
    if (r.ok) {
      const names = r.installed.map((i) => i.name).sort();
      check('recursive dep ms installed', names.join(',') === 'debug,ms', 'got: ' + names.join(','));
      check('debug files extracted', fs.existsSync(path.join(profileDir, 'node_modules', 'debug', 'src', 'index.js')));
      check('ms files extracted', fs.existsSync(path.join(profileDir, 'node_modules', 'ms', 'index.js')));
      const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
      // 只写顶层行（对齐真 pnpm add，2026-09-23 修复）：上游 installBundle 用
      // dependencies 的 diff 确定"装了哪一个包"（新增 key 恰好 1，否则
      // ManagementFailure("ambiguous-install")——真机 dshmarket 依赖树整写所致
      // web UI 报"无法从依赖变更中确定装了哪一个包"）。子依赖 ms 落位
      // node_modules 但不进顶层 dependencies（端侧该字段唯一读者是该 diff）。
      check('package.json top-level row only', pkg.dependencies.debug === '^4.3.4' && pkg.dependencies.ms === undefined, JSON.stringify(pkg.dependencies));
      check('upstream diff sees exactly 1 new dep', Object.keys(pkg.dependencies).length === 1, JSON.stringify(pkg.dependencies));
      const rows = fs.readFileSync(path.join(profileDir, '.dshm-plugin-rows.yml'), 'utf8');
      check('user row appended (top only)', rows.trim() === '- id: debug', JSON.stringify(rows));
    }
  }

  // ── 5. 幂等：重复安装 → 不再落盘 ──
  {
    const r = await installer.installSpec('ms@2.1.3', { homeDir: home, profile: 'ondevice' });
    check('idempotent skip installed', r.ok === false && /already|没有新装/.test(r.error || ''), JSON.stringify(r).slice(0, 200));
    const rows = fs.readFileSync(path.join(profileDir, '.dshm-plugin-rows.yml'), 'utf8');
    check('user rows unchanged', rows.trim() === '- id: debug', JSON.stringify(rows));
  }

  // ── 6. 失败路径：不存在的包 ──
  {
    const r = await installer.installSpec('dshm-no-such-pkg-xyz-123', { homeDir: home, profile: 'ondevice' });
    check('missing package fails cleanly', r.ok === false && (r.error || '').length > 0, JSON.stringify(r).slice(0, 200));
  }

  // ── 7. semver 范围 ──
  {
    const r = await installer.resolveSpec('ms@^2.0.0', installer.DEFAULT_REGISTRY);
    check('semver ^2.0.0 picks 2.x latest', r.version !== undefined && r.version.startsWith('2.'), JSON.stringify(r).slice(0, 200));
  }

  fs.rmSync(home, { recursive: true, force: true });
  console.log('');
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('[ERROR] ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
