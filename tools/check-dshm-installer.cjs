'use strict';
/**
 * dshm-installer.js 的 PC 侧验证（D26 运行时安装通道）。
 * 在本机 Node 上跑安装器全链路：spec 解析 → registry 拉取 → 解包落位 →
 * merge 依赖 → 幂等/漂移判决。端侧 Node（libnode.so）与本机 node:https/zlib 同构，
 * 此处通过即端侧问题面缩小到「网络可达性 + 文件系统差异」。
 * 输出刻意用 ASCII（PS 5.1 控制台 GBK 兼容）。
 * 用法：node tools/check-dshm-installer.cjs
 *
 * 【2026-09-28 修两处失配（本门禁自首次提交起就一直在红，见 docs/90 §2.4 / §2.5）】
 *   ① 语义前缀漂移：断言期望 `debug: '^4.3.4'`，而 2026-09-26 起依赖值优先写**请求
 *      spec**（`dependencyValueFor`）——`debug@4.3.4` 带显式版本 ⇒ 记 `4.3.4`，无 `^`。
 *      期望值改为与实现同源（见 hostcore/app/dshm-installer.js:477-528）。
 *   ② 断言用户行：安装器写 `.dshm-plugin-rows.yml` 这件事已于 2026-09-25 **有意删除**
 *      （`appendUserRow` 被删，理由见 dshm-installer.js:607-638），
 *      `tools/assert-cli-shim.mjs:110-111` 正是在锁"不再写用户行"。
 *      本门禁原先读该文件 ⇒ ENOENT。改为断言该文件**不被安装器创建**（与那条锁同向）。
 *      `.dshm-plugin-rows.yml` 仍由端侧「插件」页维护，只是不归安装器写。
 *
 * 【2026-09-28 同时补 P1-2 的双向极端用例】旧第 5 组只断言"重复装 ⇒ ok:false"，
 * 与实现语义相反：真幂等的已装同版本走 `installed.length===0` 分支返回 **ok:true**。
 * 现改为两向：同版本重装 ⇒ ok:true 且 installed 为空（真幂等、不重下）；
 * **版本漂移**（磁盘 2.1.2 ≠ 目标 2.1.3）⇒ 必须重落位并回报 beforeVersion→afterVersion。
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
      // 值写**请求 spec**（2026-09-26 起，见 dependencyValueFor）：`debug@4.3.4`
      // 带显式版本 ⇒ 记 `4.3.4`，**不再**记 `^4.3.4`（那会让市场的
      // installedSpecMatches 比对失败）。
      check('package.json top-level row only', pkg.dependencies.debug === '4.3.4' && pkg.dependencies.ms === undefined, JSON.stringify(pkg.dependencies));
      check('upstream diff sees exactly 1 new dep', Object.keys(pkg.dependencies).length === 1, JSON.stringify(pkg.dependencies));
      // 安装器**不写**用户行、也不登记 plain 依赖为 profile 层（2026-09-25 有意删除
      // appendUserRow，理由见 hostcore/app/dshm-installer.js:607-638）。原先此处读
      // `.dshm-plugin-rows.yml`，于是门禁自首次提交起就 ENOENT 恒红。
      // `.dshm-plugin-rows.yml` 现由端侧「插件」页维护，语义是"用户对**已有条目**的
      // 启停覆盖"——不是安装器凭空写包名（那样必然是孤儿行）。
      check('installer does not write user rows', !fs.existsSync(path.join(profileDir, '.dshm-plugin-rows.yml')));
      check('plain dependency is not registered as profile layer', pkg.dsh === undefined, JSON.stringify(pkg.dsh || null));
    }
  }

  // ── 5. P1-2 双向：真幂等（同版本）/ 版本漂移必须重落位 ──
  // 【为什么是两向】旧断言写的是 `r.ok === false && /already|没有新装/`，与实现语义
  // 恰好相反：真幂等的已装同版本走 `installed.length === 0` 分支返回 ok:true
  // （见 hostcore/app/dshm-installer.js:845-886）。而 P1-2 修的正是"只判入口可加载、
  // 不判版本"——所以这里必须同时锁住"该跳过时确实跳过"与"该重装时确实重装"，
  // 否则改回大小/存在性判据也能蒙混过关（真机现场：声明 1.66.2、磁盘 1.65.1）。
  {
    const msPkgPath = path.join(profileDir, 'node_modules', 'ms', 'package.json');
    const before = fs.readFileSync(msPkgPath, 'utf8');
    const beforeMtime = fs.statSync(msPkgPath).mtimeMs;
    const have = JSON.parse(before).version;

    // 5a. 已装同版本（debug@4.3.4 已把 ms 落到磁盘）⇒ 真幂等：不重下、磁盘不动。
    const r = await installer.installSpec('ms@' + have, { homeDir: home, profile: 'ondevice' });
    check('same-version reinstall is idempotent (ok:true)', r.ok === true, JSON.stringify(r).slice(0, 200));
    check('same-version reinstall downloads nothing', Array.isArray(r.installed) && r.installed.length === 0, JSON.stringify(r.installed || null));
    check('same-version reinstall leaves disk untouched', fs.statSync(msPkgPath).mtimeMs === beforeMtime && fs.readFileSync(msPkgPath, 'utf8') === before);

    // 5b. 版本漂移：磁盘 2.1.2 vs 目标 2.1.3 ⇒ 必须重落位并把新旧版本回报出来。
    //     这是 P1-2 的极端用例——两者盘上"目录在 + 入口可加载"，旧判据必然跳过。
    const target = have === '2.1.3' ? '2.1.2' : '2.1.3';
    const r2 = await installer.installSpec('ms@' + target, { homeDir: home, profile: 'ondevice' });
    check('version drift triggers reinstall', r2.ok === true && Array.isArray(r2.installed) && r2.installed.length === 1, JSON.stringify(r2).slice(0, 300));
    check('drift reports beforeVersion -> afterVersion', r2.beforeVersion === have && r2.afterVersion === target, JSON.stringify({ beforeVersion: r2.beforeVersion, afterVersion: r2.afterVersion, have, target }));
    const diskNow = JSON.parse(fs.readFileSync(msPkgPath, 'utf8')).version;
    check('drift rewrites disk version', diskNow === target, JSON.stringify({ diskNow, target }));
    check('drift actually replaced old contents', fs.statSync(msPkgPath).mtimeMs !== beforeMtime);

    // 5c. 漂移收敛：再装同一目标版本 ⇒ 回到幂等（证明"重装一次即追平"，不无限重下）。
    const r3 = await installer.installSpec('ms@' + target, { homeDir: home, profile: 'ondevice' });
    check('after drift, reinstall converges to idempotent', r3.ok === true && Array.isArray(r3.installed) && r3.installed.length === 0, JSON.stringify(r3).slice(0, 300));
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

  // ── 8. monorepo 下探 + 回退守卫（纯函数，零网络）──
  // 这两条判据都是"猜测"性质的（下探哪个目录 / 回退到哪个包），集成测试只能覆盖手上
  // 恰好有的那几个仓库 ⇒ 用临时目录把边界逐条钉住。详见 dshm-installer.js 的
  // findPackageRoots / repositoryMatchesRequest 注释。
  {
    // 8a. 恰好一个子包 ⇒ 认它；node_modules / 点目录 / 深层嵌套都必须被排除。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-mono-'));
    fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'package.json'), '{}');
    fs.mkdirSync(path.join(root, '.github', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'deep', 'package.json'), '{}');
    fs.mkdirSync(path.join(root, 'only'), { recursive: true });
    fs.writeFileSync(path.join(root, 'only', 'package.json'), '{"name":"only"}');
    const r1 = installer.findPackageRoots(root, 2);
    check('findPackageRoots finds the single subpackage', r1.join(',') === 'only', JSON.stringify(r1));

    // 8b. 多候选 ⇒ 全部列出（不猜）。dsh-deep-whale 的三个子包**都**声明 dsh.bundle，
    //     "挑那个像插件的"没有区分度 ⇒ 只能列出来让用户指定。
    fs.mkdirSync(path.join(root, 'second'), { recursive: true });
    fs.writeFileSync(path.join(root, 'second', 'package.json'), '{"name":"second"}');
    const r2 = installer.findPackageRoots(root, 2);
    check('findPackageRoots lists all candidates sorted', r2.join(',') === 'only,second', JSON.stringify(r2));

    // 8c. 一个目录本身是包 ⇒ 不再往下钻（嵌套 workspace 属于"要用户明说"）。
    fs.mkdirSync(path.join(root, 'only', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(root, 'only', 'inner', 'package.json'), '{"name":"inner"}');
    const r3 = installer.findPackageRoots(root, 3);
    check('findPackageRoots does not descend into a package dir', r3.indexOf('only/inner') === -1, JSON.stringify(r3));

    // 8d. 根目录有 package.json ⇒ 不算候选（depth 0 永不出现在结果里）。
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-mono-'));
    fs.writeFileSync(path.join(root2, 'package.json'), '{"name":"root"}');
    const r4 = installer.findPackageRoots(root2, 2);
    check('findPackageRoots never returns the root itself', r4.length === 0, JSON.stringify(r4));

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }

  // 8e-8h. 同一性守卫：回退到 npm 包**必须**是同一个仓库，否则宁可失败。
  {
    const spec = 'https://github.com/dsh-market/dsh-market';
    check('repositoryMatchesRequest accepts git+https', installer.repositoryMatchesRequest(
      { repository: { type: 'git', url: 'git+https://github.com/dsh-market/dsh-market.git' } }, spec) === true);
    check('repositoryMatchesRequest accepts plain https', installer.repositoryMatchesRequest(
      { repository: 'https://github.com/dsh-market/dsh-market' }, spec) === true);
    check('repositoryMatchesRequest accepts git@ form', installer.repositoryMatchesRequest(
      { repository: { url: 'git@github.com:dsh-market/dsh-market.git' } }, spec) === true);
    check('repositoryMatchesRequest rejects a different repo', installer.repositoryMatchesRequest(
      { repository: { url: 'https://github.com/someone-else/dsh-market' } }, spec) === false);
    check('repositoryMatchesRequest rejects a different owner', installer.repositoryMatchesRequest(
      { repository: { url: 'https://github.com/dsh-market/fork-of-something' } }, spec) === false);
    check('repositoryMatchesRequest rejects a missing repository', installer.repositoryMatchesRequest(
      { name: 'dshmarket', version: '1.0.0' }, spec) === false);
    check('repositoryMatchesRequest rejects a non-github host', installer.repositoryMatchesRequest(
      { repository: { url: 'https://gitlab.com/dsh-market/dsh-market' } }, spec) === false);
    check('repositoryMatchesRequest is case-insensitive', installer.repositoryMatchesRequest(
      { repository: { url: 'https://github.com/DSH-Market/DSH-Market' } }, spec) === true);
  }

  // ── 9. GitHub 装不上时的两条出路（网络集成，2026-09-30 用户报的问题本体）──
  // 9a. 源码树缺构建产物 ⇒ 回退 registry 同名包（dsh-market 的 lib/ 只随 npm 发布物
  //     存在，GitHub tarball 里没有 ⇒ 旧实现必报"落位校验失败"）。
  // 9b. monorepo 多候选 ⇒ 如实列候选让用户补 `&path:`（不猜）。
  {
    const ghHome = makeHome();
    const r = await installer.installSpec('https://github.com/dsh-market/dsh-market',
      { homeDir: ghHome, profile: 'ondevice', log: (m) => console.log('       ' + m) });
    check('github source-without-build falls back to npm', r.ok === true && r.name === 'dshmarket', JSON.stringify(r).slice(0, 400));
    check('github fallback installs a loadable entry', r.ok === true
      && fs.existsSync(path.join(ghHome, 'profiles', 'ondevice', 'node_modules', 'dshmarket', 'lib', 'index.js')));
    check('github fallback keeps the reviewed spec as the dependency value',
      JSON.parse(fs.readFileSync(path.join(ghHome, 'profiles', 'ondevice', 'package.json'), 'utf8'))
        .dependencies.dshmarket === 'https://github.com/dsh-market/dsh-market');
    check('github fallback registers the bundle', r.ok === true
      && JSON.parse(fs.readFileSync(path.join(ghHome, 'profiles', 'ondevice', 'package.json'), 'utf8'))
        .dsh.profile.bundles.includes('dshmarket'));
    // 幂等分支必须认得回退后的真名（dshmarket），否则会回 `name: dsh-market--dsh-market`。
    const r2 = await installer.installSpec('https://github.com/dsh-market/dsh-market', { homeDir: ghHome, profile: 'ondevice' });
    check('github reinstall is idempotent under the real package name', r2.ok === true && r2.name === 'dshmarket', JSON.stringify(r2).slice(0, 300));
    fs.rmSync(ghHome, { recursive: true, force: true });
  }
  {
    const monoHome = makeHome();
    const r = await installer.installSpec('Small-tailqwq/dsh-deep-whale', { homeDir: monoHome, profile: 'ondevice' });
    check('monorepo without path fails with candidates listed', r.ok === false
      && /多个子包/.test(r.error || '') && /maid-atelier/.test(r.error || ''), JSON.stringify(r).slice(0, 400));
    const r2 = await installer.installSpec('github:Small-tailqwq/dsh-deep-whale#path:/maid-atelier', { homeDir: monoHome, profile: 'ondevice' });
    check('monorepo with #path: installs (INSTALL.md spelling)', r2.ok === true
      && r2.name === '@smalltailqwq/dsh-client-ui-skin-maid-atelier', JSON.stringify(r2).slice(0, 300));
    fs.rmSync(monoHome, { recursive: true, force: true });
  }

  fs.rmSync(home, { recursive: true, force: true });
  console.log('');
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('[ERROR] ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
