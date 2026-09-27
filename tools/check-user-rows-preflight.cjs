'use strict';
/**
 * dshm-user-rows.js 的 PC 侧验证（D27 用户插件行预检 + 启动失败自愈，2026-09-23）。
 *
 * 【为什么需要】真机死锁事故（批次备注十一）：web UI 装的 dshmarket 用户行被
 * composeUserRows 拼进 cordis.patch.yml，而设备上 node_modules/dshmarket/lib/index.js
 * 缺失 ⇒ dsh loader import 抛错 ⇒ Host fatal ⇒ 无 HTTP/python 桥，files/dsh/home
 * 700 hdc 不可写 ⇒ 无外部恢复通道。本断言锁住两层防线：
 *   1. 预检：坏行不拼（且 diag 留取证）；
 *   2. 自愈：启动失败标记 ⇒ 下次启动把用户行文件隔离改名（保数据不删）。
 * 端侧 Node 与本机 node:fs 同构，此处通过即端侧问题面缩小到文件系统差异。
 * 输出刻意用 ASCII（PS 5.1 控制台 GBK 兼容）。
 * 用法：node tools/check-user-rows-preflight.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

const MOD = path.join(__dirname, '..', 'hostcore', 'app', 'dshm-user-rows.js');
const mod = require(MOD);

// ── 造一个 profile 目录，node_modules 下放"好包/坏包" ──
function makeProfileDir() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-rows-'));
  const profileDir = path.join(home, 'profiles', 'ondevice');
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  return { home, profileDir };
}

function makePkg(profileDir, name, pkgJson, files) {
  const dir = path.join(profileDir, 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson));
  for (const rel of files) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// stub\n');
  }
  return dir;
}

(() => {
  // ── 1. 常量与导出面 ──
  check('导出 composeUserRows', typeof mod.composeUserRows === 'function');
  check('导出 prefilterUserRows', typeof mod.prefilterUserRows === 'function');
  check('导出 userRowLoadable', typeof mod.userRowLoadable === 'function');
  check('导出 entryCandidates', typeof mod.entryCandidates === 'function');
  check('导出 writeBootFailMarker', typeof mod.writeBootFailMarker === 'function');
  check('导出 quarantineAfterBootFailure', typeof mod.quarantineAfterBootFailure === 'function');
  check('USER_ROWS_FILENAME 与 dshm-installer 硬编码一致',
    mod.USER_ROWS_FILENAME === '.dshm-plugin-rows.yml',
    `got ${mod.USER_ROWS_FILENAME}`);

  // ── 2. entryCandidates：入口候选解析（Node 语义：exports 优先，无则 main/index.js） ──
  check('仅 main', JSON.stringify(mod.entryCandidates({ main: 'lib/a.js' })) === '["lib/a.js"]',
    JSON.stringify(mod.entryCandidates({ main: 'lib/a.js' })));
  check('无 main 无 exports → index.js', JSON.stringify(mod.entryCandidates({})) === '["index.js"]');
  check('exports 字符串（./ 前缀剥掉）',
    JSON.stringify(mod.entryCandidates({ exports: './b.js' })) === '["b.js"]',
    JSON.stringify(mod.entryCandidates({ exports: './b.js' })));
  check('exports["."] 为对象：node 与 default 条件入口全收（任一缺失即判坏）',
    JSON.stringify(mod.entryCandidates({ exports: { '.': { node: './n.js', default: './d.js' } }, main: 'm.js' }))
      === '["n.js","d.js"]',
    JSON.stringify(mod.entryCandidates({ exports: { '.': { node: './n.js', default: './d.js' } }, main: 'm.js' })));
  check('exports["."] 嵌套 require.default',
    JSON.stringify(mod.entryCandidates({ exports: { '.': { require: { default: './r.js' } } } }))
      === '["r.js"]',
    JSON.stringify(mod.entryCandidates({ exports: { '.': { require: { default: './r.js' } } } })));
  check('main 带 ./ 前缀也剥掉',
    JSON.stringify(mod.entryCandidates({ main: './lib/a.js' })) === '["lib/a.js"]');

  // ── 3. userRowLoadable：单行判定 ──
  {
    const { profileDir } = makeProfileDir();
    makePkg(profileDir, 'good-main', { main: 'lib/a.js' }, ['lib/a.js']);
    makePkg(profileDir, 'good-default', {}, ['index.js']);
    makePkg(profileDir, 'no-entry', { main: 'lib/missing.js' }, ['lib/a.js']);
    const brokenJson = path.join(profileDir, 'node_modules', 'broken-json');
    fs.mkdirSync(brokenJson, { recursive: true });
    fs.writeFileSync(path.join(brokenJson, 'package.json'), '{oops');

    check('好包（main）→ 空串', mod.userRowLoadable(profileDir, 'good-main') === '',
      mod.userRowLoadable(profileDir, 'good-main'));
    check('好包（index.js 兜底）→ 空串', mod.userRowLoadable(profileDir, 'good-default') === '',
      mod.userRowLoadable(profileDir, 'good-default'));
    const r1 = mod.userRowLoadable(profileDir, 'no-entry');
    check('入口缺失 → 报"入口文件缺失"', r1.includes('入口文件缺失'), r1);
    const r2 = mod.userRowLoadable(profileDir, 'not-installed');
    check('未安装 → 报 package.json 不存在', r2.includes('package.json 不存在'), r2);
    const r3 = mod.userRowLoadable(profileDir, 'broken-json');
    check('坏 JSON → 报解析失败', r3.includes('解析失败'), r3);
  }

  // ── 4. prefilterUserRows：块解析（注释/disabled 续行/多包） ──
  {
    const { profileDir } = makeProfileDir();
    makePkg(profileDir, 'pkg-a', { main: 'lib/a.js' }, ['lib/a.js']);
    makePkg(profileDir, 'pkg-c', { main: 'lib/c.js' }, ['lib/c.js']);
    const rows = [
      '# 手写注释，必须原样保留',
      '- id: pkg-a',
      '  disabled: true',
      '',
      '- id: pkg-b    # 未安装，必须被跳过',
      '- id: pkg-c',
    ].join('\n');
    const { keptText, dropped } = mod.prefilterUserRows(rows, profileDir);
    check('好包块保留（含 disabled 续行）', keptText.includes('- id: pkg-a') && keptText.includes('disabled: true'), keptText);
    check('注释保留', keptText.includes('# 手写注释'), keptText);
    check('坏包跳过且只跳一个', dropped.length === 1 && dropped[0].id === 'pkg-b',
      JSON.stringify(dropped));
    check('坏包原因可读', dropped.length === 1 && dropped[0].reason.length > 0,
      JSON.stringify(dropped));
    check('好包 pkg-c 保留', keptText.includes('- id: pkg-c'), keptText);
  }

  // ── 5. composeUserRows 端到端：一好一坏 → patch 只含好行 ──
  {
    const { profileDir } = makeProfileDir();
    makePkg(profileDir, 'pkg-a', { main: 'lib/a.js' }, ['lib/a.js']);
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '# seed\n- id: dsh-web-app\n');
    fs.writeFileSync(path.join(profileDir, '.dshm-plugin-rows.yml'),
      '- id: pkg-a\n- id: pkg-b\n');
    const logs = [];
    const diags = [];
    mod.composeUserRows(profileDir, { log: (m) => logs.push(m), diag: (m) => diags.push(m) });
    const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    check('patch 含种子', patch.includes('- id: dsh-web-app'), patch);
    check('patch 含好行', patch.includes('- id: pkg-a'), patch);
    check('patch 不含坏行', !patch.includes('pkg-b'), patch);
    check('patch 含 BEGIN/END 标记', patch.includes(mod.USER_ROWS_BEGIN) && patch.includes(mod.USER_ROWS_END), patch);
    check('diag 留取证（预检跳行）', diags.some((d) => d.includes('pkg-b') && d.includes('预检')), JSON.stringify(diags));
    check('log 提示跳过数量', logs.some((l) => l.includes('1 行')), JSON.stringify(logs));
  }

  // ── 6. composeUserRows：全坏 → patch 不写入（保持纯种子） ──
  {
    const { profileDir } = makeProfileDir();
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '# seed only\n');
    fs.writeFileSync(path.join(profileDir, '.dshm-plugin-rows.yml'), '- id: pkg-b\n');
    const logs = [];
    mod.composeUserRows(profileDir, { log: (m) => logs.push(m), diag: () => {} });
    const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    check('全坏 → patch 保持纯种子', patch === '# seed only\n', JSON.stringify(patch));
    check('全坏 → log 说明不拼接', logs.some((l) => l.includes('不拼接')), JSON.stringify(logs));
  }

  // ── 7. composeUserRows：无 rows 文件 → 原样返回（不炸） ──
  {
    const { profileDir } = makeProfileDir();
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '# seed\n');
    let threw = false;
    try {
      mod.composeUserRows(profileDir, { log: () => {}, diag: () => {} });
    } catch (e) {
      threw = true;
    }
    check('无 rows 文件不抛错', !threw);
  }

  // ── 8. writeBootFailMarker + quarantineAfterBootFailure：自愈闭环 ──
  {
    const { home, profileDir } = makeProfileDir();
    const rowsPath = path.join(profileDir, '.dshm-plugin-rows.yml');
    fs.writeFileSync(rowsPath, '- id: pkg-a\n');

    // 无标记 → no-op（rows 不动）
    const diags1 = [];
    mod.quarantineAfterBootFailure(profileDir, home, { log: () => {}, diag: (m) => diags1.push(m) });
    check('无标记 → 用户行不动', fs.existsSync(rowsPath));
    check('无标记 → 不产生自愈日志', diags1.length === 0, JSON.stringify(diags1));

    // homeDir 空串 → no-op（fail 早期场景防御）
    mod.writeBootFailMarker('', 'BOOT_10', 'x');
    let threw = false;
    try {
      mod.quarantineAfterBootFailure(profileDir, '', { log: () => {}, diag: () => {} });
    } catch (e) {
      threw = true;
    }
    check('homeDir 空串不抛错', !threw);

    // 写标记 → 隔离 → rows 改名保留 + 标记删除 + diag 取证
    mod.writeBootFailMarker(home, 'BOOT_40_PROFILE_BOOT', 'loader import failed');
    const markerPath = path.join(home, '.dshm-boot-failed');
    check('标记已写入', fs.existsSync(markerPath));
    const diags2 = [];
    mod.quarantineAfterBootFailure(profileDir, home, { log: () => {}, diag: (m) => diags2.push(m) });
    check('隔离后原 rows 文件不存在', !fs.existsSync(rowsPath));
    const leftovers = fs.readdirSync(profileDir).filter((n) => n.startsWith('.dshm-plugin-rows.yml.quarantine-'));
    check('rows 改名为 .quarantine-*（保数据不删）', leftovers.length === 1,
      JSON.stringify(fs.readdirSync(profileDir)));
    check('标记已删除（自愈只触发一次）', !fs.existsSync(markerPath));
    check('diag 说明失败原因与隔离动作', diags2.length === 1
      && diags2[0].includes('BOOT_40_PROFILE_BOOT') && diags2[0].includes('启动自愈'),
      JSON.stringify(diags2));

    // 二次调用（标记已清）→ no-op，quarantine 不叠加
    mod.quarantineAfterBootFailure(profileDir, home, { log: () => {}, diag: () => {} });
    const leftovers2 = fs.readdirSync(profileDir).filter((n) => n.startsWith('.dshm-plugin-rows.yml.quarantine-'));
    check('自愈幂等（不叠加隔离副本）', leftovers2.length === 1, JSON.stringify(leftovers2));
  }

  // ── 9. sanitizeDependencies：profile package.json 的坏依赖行移除 ──
  // 【为什么连 package.json 也要管】dsh-app-boot 的 resolveModuleFallbackEntries
  // （0.1.6 树 lib/index.js:579-604）把 profile package.json 的 dependencies/
  // peerDependencies 逐个变成 loader 可见的 import 入口——旧版 mergeDependencies
  // 写入的 dshmarket 行就是 BOOT_ERR 的真源（patch 被种子覆盖，package.json 不覆盖）。
  {
    check('导出 sanitizeDependencies', typeof mod.sanitizeDependencies === 'function');
    const { profileDir } = makeProfileDir();
    makePkg(profileDir, 'good-dep', { main: 'lib/a.js' }, ['lib/a.js']);
    makePkg(profileDir, 'half-dep', { main: 'lib/missing.js' }, []);
    makePkg(profileDir, 'peer-half', { main: 'lib/missing.js' }, []);
    const pkgPath = path.join(profileDir, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: 'ondevice',
      dependencies: { 'good-dep': '^1.0.0', 'half-dep': '^2.0.0' },
      peerDependencies: { 'peer-half': '^3.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2));
    const diags = [];
    const out = mod.sanitizeDependencies(profileDir, {
      log: () => {},
      diag: (m) => diags.push(m),
      seedBundles: ['@deepseek-ai/dsh-base'],
    });
    const after = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    check('坏 dependencies 行移除', after.dependencies['half-dep'] === undefined, JSON.stringify(after.dependencies));
    check('好 dependencies 行保留', after.dependencies['good-dep'] === '^1.0.0', JSON.stringify(after.dependencies));
    check('坏 peerDependencies 行移除', after.peerDependencies['peer-half'] === undefined, JSON.stringify(after.peerDependencies));
    check('其他字段不动（bundles 保留）', after.dsh.profile.bundles[0] === '@deepseek-ai/dsh-base', JSON.stringify(after.dsh));
    check('移除清单可读', out.removed.length === 2
      && out.removed.some((r) => r.id === 'half-dep') && out.removed.some((r) => r.id === 'peer-half'),
      JSON.stringify(out.removed));
    check('diag 留取证', diags.some((d) => d.includes('half-dep') && d.includes('入口文件缺失')), JSON.stringify(diags));
  }
  {
    // 无 package.json / 无 dependencies → no-op 不炸
    const { profileDir } = makeProfileDir();
    let threw = false;
    try {
      mod.sanitizeDependencies(profileDir, { log: () => {}, diag: () => {} });
    } catch (e) {
      threw = true;
    }
    check('sanitize 无 package.json 不抛错', !threw);
  }

  // ── 10. quarantine 扩展：package.json 备份 + dependencies 清空 ──
  {
    const { home, profileDir } = makeProfileDir();
    const pkgPath = path.join(profileDir, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: 'ondevice',
      dependencies: { stale: '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2));
    fs.writeFileSync(path.join(profileDir, '.dshm-plugin-rows.yml'), '- id: pkg-a\n');
    mod.writeBootFailMarker(home, 'BOOT_40_PROFILE_BOOT', 'boom');
    const diags = [];
    mod.quarantineAfterBootFailure(profileDir, home, { log: () => {}, diag: (m) => diags.push(m) });
    const after = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    check('quarantine 后 dependencies 清空', Object.keys(after.dependencies).length === 0, JSON.stringify(after.dependencies));
    check('quarantine 后其他字段保留', after.dsh.profile.bundles[0] === '@deepseek-ai/dsh-base' && after.name === 'ondevice');
    const pkgBackups = fs.readdirSync(profileDir).filter((n) => n.startsWith('package.json.quarantine-'));
    check('package.json 已备份（保数据不删）', pkgBackups.length === 1, JSON.stringify(fs.readdirSync(profileDir)));
    const backup = JSON.parse(fs.readFileSync(path.join(profileDir, pkgBackups[0]), 'utf8'));
    check('备份里保留原 dependencies（可手工恢复）', backup.dependencies.stale === '^1.0.0');
    check('diag 说明 package.json 动作', diags.some((d) => d.includes('dependencies') || d.includes('package.json')), JSON.stringify(diags));
  }

  // ── 11. sanitizeHomePatch：home 层 cordis.patch.yml 的坏行隔离 ──
  // 【为什么需要第三层】readProfilePatches（0.1.6 树 dsh-app-boot lib/index.js:1010）
  // 每次启动都把 $DSH_HOME/cordis.patch.yml 读进 patch 栈；真机实证（批次备注十一
  // 第三轮）：rows 隔离 + dependencies 清空后 BOOT_ERR 原样复现 ⇒ home 层是
  // 唯一在场源。home 层不在 profile 目录里，种子覆盖/依赖预检都够不着它。
  {
    check('导出 sanitizeHomePatch', typeof mod.sanitizeHomePatch === 'function');
    // 坏名命中：home patch 文本含半残包名 → 整体改名隔离
    {
      const { home, profileDir } = makeProfileDir();
      makePkg(profileDir, 'halfmarket', { main: 'lib/missing.js' }, []);
      const homePatch = path.join(home, 'cordis.patch.yml');
      fs.writeFileSync(homePatch, '- id: dsh-market\n  name: halfmarket\n');
      const diags = [];
      const out = mod.sanitizeHomePatch(profileDir, home, { log: () => {}, diag: (m) => diags.push(m) });
      check('home patch 坏名命中后原文件消失', !fs.existsSync(homePatch));
      const q = fs.readdirSync(home).filter((n) => n.startsWith('cordis.patch.yml.quarantine-'));
      check('home patch 改名隔离（保数据不删）', q.length === 1, JSON.stringify(fs.readdirSync(home)));
      check('返回 quarantined=true', out.quarantined === true, JSON.stringify(out));
      check('diag 说明 home 层隔离与坏名', diags.some((d) => d.includes('home') && d.includes('halfmarket')), JSON.stringify(diags));
    }
    // name 字段引用 node_modules 里不存在的包 → 也隔离（防"行在包不在"死锁）
    {
      const { home, profileDir } = makeProfileDir();
      const homePatch = path.join(home, 'cordis.patch.yml');
      fs.writeFileSync(homePatch, '- id: ghost\n  name: ghost-pkg\n');
      const out = mod.sanitizeHomePatch(profileDir, home, { log: () => {}, diag: () => {} });
      check('幽灵包名（node_modules 不存在）也隔离', out.quarantined === true && !fs.existsSync(homePatch), JSON.stringify(out));
    }
    // 好包名/纯 {id, disabled} 行 → 不动
    {
      const { home, profileDir } = makeProfileDir();
      makePkg(profileDir, 'goodmarket', { main: 'lib/a.js' }, ['lib/a.js']);
      const homePatch = path.join(home, 'cordis.patch.yml');
      fs.writeFileSync(homePatch, '- id: goodmarket\n  name: goodmarket\n- id: other\n  disabled: true\n');
      const out = mod.sanitizeHomePatch(profileDir, home, { log: () => {}, diag: () => {} });
      check('好包与纯禁用行不动 home patch', out.quarantined === false && fs.existsSync(homePatch), JSON.stringify(out));
    }
    // 无 home patch → no-op 不炸
    {
      const { home, profileDir } = makeProfileDir();
      let threw = false;
      try {
        mod.sanitizeHomePatch(profileDir, home, { log: () => {}, diag: () => {} });
      } catch (e) {
        threw = true;
      }
      check('无 home patch 不抛错', !threw);
    }
  }

  // ── 12. quarantineBrokenPackages：半残包目录改名（卫生措施） ──
  // 行被清干净后目录只是残留；但任何未来机制再引用它都会回到同一死锁，
  // 且目录本身是"已装坏"的取证现场——改名隔离比留着或删除都稳。
  {
    check('导出 quarantineBrokenPackages', typeof mod.quarantineBrokenPackages === 'function');
    const { profileDir } = makeProfileDir();
    makePkg(profileDir, 'halfmarket', { main: 'lib/missing.js' }, []);
    makePkg(profileDir, 'goodmarket', { main: 'lib/a.js' }, ['lib/a.js']);
    const diags = [];
    const out = mod.quarantineBrokenPackages(profileDir, { log: () => {}, diag: (m) => diags.push(m) });
    const names = fs.readdirSync(path.join(profileDir, 'node_modules'));
    check('半残目录已改名', names.some((n) => n.startsWith('halfmarket.dshm-broken-')), JSON.stringify(names));
    check('好包目录不动', names.includes('goodmarket'), JSON.stringify(names));
    check('返回坏包名单', Array.isArray(out.quarantined) && out.quarantined.some((n) => n === 'halfmarket'), JSON.stringify(out));
    check('diag 留取证', diags.some((d) => d.includes('halfmarket')), JSON.stringify(diags));
    // 幂等：再跑一遍不叠加
    mod.quarantineBrokenPackages(profileDir, { log: () => {}, diag: () => {} });
    const again = fs.readdirSync(path.join(profileDir, 'node_modules')).filter((n) => n.startsWith('halfmarket.dshm-broken-'));
    check('半残目录隔离幂等（不叠加）', again.length === 1, JSON.stringify(again));
    // 无 node_modules → no-op 不炸
    {
      const { profileDir: pd } = makeProfileDir();
      let threw = false;
      try {
        mod.quarantineBrokenPackages(path.join(pd, 'nope'), { log: () => {}, diag: () => {} });
      } catch (e) {
        threw = true;
      }
      check('无 node_modules 不抛错', !threw);
    }
  }

  // ── 13. quarantine 扩展：home patch 无条件隔离 + 半残目录 ──
  // 自愈语义=回到纯种子：home 层不属于种子（种子只覆盖 profile 目录），
  // 上次失败时它可能就是肇事层——无条件隔离，干净与否不逐行判定。
  {
    const { home, profileDir } = makeProfileDir();
    makePkg(profileDir, 'halfmarket', { main: 'lib/missing.js' }, []);
    fs.writeFileSync(path.join(home, 'cordis.patch.yml'), '- id: any\n  disabled: true\n');
    mod.writeBootFailMarker(home, 'BOOT_40_PROFILE_BOOT', 'boom');
    const diags = [];
    mod.quarantineAfterBootFailure(profileDir, home, { log: () => {}, diag: (m) => diags.push(m) });
    const homeQ = fs.readdirSync(home).filter((n) => n.startsWith('cordis.patch.yml.quarantine-'));
    check('自愈时 home patch 无条件隔离', homeQ.length === 1 && !fs.existsSync(path.join(home, 'cordis.patch.yml')), JSON.stringify(fs.readdirSync(home)));
    const pkgQ = fs.readdirSync(path.join(profileDir, 'node_modules')).filter((n) => n.startsWith('halfmarket.dshm-broken-'));
    check('自愈时半残包目录也隔离', pkgQ.length === 1, JSON.stringify(fs.readdirSync(path.join(profileDir, 'node_modules'))));
    check('自愈 diag 覆盖 home 层动作', diags.some((d) => d.includes('home')), JSON.stringify(diags));
  }

  // ── 14. sanitizeDependencies 洗 bundles：dsh.profile.bundles 的坏行移除 ──
  // 【第四落点】loadProfileDirectory（0.1.6 树 dsh-app-boot lib/index.js:917-920）
  // 把 bundles 列表逐个 resolveBundleDir + 读 dsh.bundle.patch——真机实证（批次
  // 备注十一第四轮）：目录被隔离后错误提前到 "cannot resolve profile bundle
  // dshmarket"——旧版安装把用户包写进了 bundles，而 ensureProfile 的 merge
  // 刻意保留现有 bundles（当时认为是用户自己加的）。判据：种子 bundles
  // （io.seedBundles）白名单保留；其余必须在 node_modules 里可解析且有
  // dsh.bundle.patch 声明 + patch 文件存在（与 loadProfileDirectory 同语义）。
  {
    const { profileDir } = makeProfileDir();
    /*
     * 【fixture 必须像真 bundle（2026-09-26 修正）】`good-bundle` 原先只写
     * `dsh.bundle.patch`，**没有 main、也没有 JS 入口**——那是 2026-09-24 加
     * "补入口判据"之前的写法。加判据后它按设计被判为半残（bundle 悬空引用会让
     * setBundleEnabled 恒报 cannot resolve），于是本断言开始红。
     * 红的是**fixture 陈旧**，不是判据错：核心树里 9 个声明 dsh.bundle.patch 的包
     * **全部**有 `main: lib/index.js`（实测），所以这里也补上真实入口。
     */
    makePkg(profileDir, 'good-bundle',
      { main: 'lib/index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } } },
      ['lib/index.js', 'cordis.patch.yml']);
    // 【入口判据的负测试】声明齐全但 JS 入口缺失 ⇒ 仍须移除（防止判据被静默丢掉）
    makePkg(profileDir, 'bundle-no-entry',
      { main: 'lib/index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } } },
      ['cordis.patch.yml']);
    // 【候选链语义】main 不写扩展名（靠 require 补 .js）⇒ 任一候选可解析即通过
    makePkg(profileDir, 'bundle-ext-fallback',
      { main: 'lib/index', dsh: { bundle: { patch: 'cordis.patch.yml' } } },
      ['lib/index.js', 'cordis.patch.yml']);
    makePkg(profileDir, 'no-decl', { main: 'lib/a.js' }, ['lib/a.js']);
    makePkg(profileDir, 'decl-missing-file', { dsh: { bundle: { patch: 'gone.patch.yml' } } }, []);
    const pkgPath = path.join(profileDir, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: 'ondevice',
      dependencies: {},
      dsh: { profile: { bundles: [
        '@deepseek-ai/dsh-base', 'good-bundle', 'bundle-no-entry', 'bundle-ext-fallback',
        'no-decl', 'decl-missing-file', 'ghost-bundle',
      ] } },
    }, null, 2));
    const diags = [];
    const out = mod.sanitizeDependencies(profileDir, {
      log: () => {},
      diag: (m) => diags.push(m),
      seedBundles: ['@deepseek-ai/dsh-base'],
    });
    const after = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    check('种子 bundle 白名单保留', after.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'), JSON.stringify(after.dsh.profile.bundles));
    check('好 bundle（可解析+有声明+文件在）保留', after.dsh.profile.bundles.includes('good-bundle'), JSON.stringify(after.dsh.profile.bundles));
    check('入口缺失的 bundle 移除（入口判据在位）', !after.dsh.profile.bundles.includes('bundle-no-entry'), JSON.stringify(after.dsh.profile.bundles));
    check('main 缺扩展名但候选可解析 ⇒ 保留（与 userRowLoadable 同口径）', after.dsh.profile.bundles.includes('bundle-ext-fallback'), JSON.stringify(after.dsh.profile.bundles));
    check('无 dsh.bundle.patch 声明的移除', !after.dsh.profile.bundles.includes('no-decl'), JSON.stringify(after.dsh.profile.bundles));
    check('声明指向缺失文件的移除', !after.dsh.profile.bundles.includes('decl-missing-file'), JSON.stringify(after.dsh.profile.bundles));
    check('node_modules 里不存在的移除', !after.dsh.profile.bundles.includes('ghost-bundle'), JSON.stringify(after.dsh.profile.bundles));
    check('返回 bundles 清单只含真坏行（4 条：入口缺/无声明/patch 缺/幽灵）',
      Array.isArray(out.removedBundles) && out.removedBundles.length === 4
      && out.removedBundles.every((b) => !['good-bundle', 'bundle-ext-fallback'].includes(b.id)), JSON.stringify(out));
    check('diag 留 bundles 取证', diags.some((d) => d.includes('ghost-bundle') && d.includes('bundle')), JSON.stringify(diags));
    // 不传 seedBundles → 种子 bundle 也被洗（调用方必须传；main.js 传种子列表）
    {
      const { profileDir: pd } = makeProfileDir();
      const pp = path.join(pd, 'package.json');
      fs.writeFileSync(pp, JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
      mod.sanitizeDependencies(pd, { log: () => {}, diag: () => {} });
      const a = JSON.parse(fs.readFileSync(pp, 'utf8'));
      check('不传 seedBundles 时无白名单（全按可解析性洗）', a.dsh.profile.bundles.length === 0, JSON.stringify(a.dsh.profile.bundles));
    }
  }

  {
    // anchorDirs 判据：resolveBundleDir（0.1.6 树 dsh-app-boot lib/index.js:899-904）
    // 先查核心树（installAnchor）再查 profile/node_modules——OPTIONAL_BUNDLES
    // 这类"核心树里的可选 bundle"必须能从 anchorDirs 解析，否则误杀（真机实证：
    // 第四轮装机把 dsh-experimental-agent-team-* 两行洗掉了，功能开关会失效）。
    const { home, profileDir } = makeProfileDir();
    const coreNm = path.join(home, 'core', 'node_modules');
    const teamProfileDir = path.join(coreNm, '@deepseek-ai', 'dsh-experimental-agent-team-profile');
    fs.mkdirSync(teamProfileDir, { recursive: true });
    /*
     * 【fixture 必须像真 bundle（2026-09-26 修正）】核心树里这个包实测是
     * `main: "lib/index.js"` 且 `lib/index.js` 在位。原 fixture 只写
     * `dsh.bundle.patch`、没有 main ⇒ 加"补入口判据"后按设计被判半残 ⇒ 断言红。
     * 红的同样是 fixture 陈旧：**anchorDirs 的语义是"到核心树去解析"**，
     * 能解析到就必须保留，这与"包本身是否完整"是两件事，所以入口也要按真实形态给。
     */
    fs.writeFileSync(path.join(teamProfileDir, 'package.json'),
      JSON.stringify({ main: 'lib/index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
    fs.mkdirSync(path.join(teamProfileDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(teamProfileDir, 'lib', 'index.js'), '// stub\n');
    fs.writeFileSync(path.join(teamProfileDir, 'cordis.patch.yml'), '[]\n');
    const pkgPath = path.join(profileDir, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-experimental-agent-team-profile', 'dshmarket'] } },
    }));
    const out = mod.sanitizeDependencies(profileDir, {
      log: () => {},
      diag: () => {},
      seedBundles: ['@deepseek-ai/dsh-base'],
      anchorDirs: [coreNm],
    });
    const after = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    check('anchorDirs 里的核心树 bundle 保留', after.dsh.profile.bundles.includes('@deepseek-ai/dsh-experimental-agent-team-profile'), JSON.stringify(after.dsh.profile.bundles));
    check('profile 侧坏行仍被移除', !after.dsh.profile.bundles.includes('dshmarket'), JSON.stringify(after.dsh.profile.bundles));
    check('返回清单只含真坏行', out.removedBundles.length === 1 && out.removedBundles[0].id === 'dshmarket', JSON.stringify(out.removedBundles));
    // anchorDirs 里声明残缺（patch 文件缺失）→ 仍判坏移除
    fs.mkdirSync(path.join(coreNm, 'no-file-bundle'), { recursive: true });
    fs.writeFileSync(path.join(coreNm, 'no-file-bundle', 'package.json'),
      JSON.stringify({ dsh: { bundle: { patch: 'gone.yml' } } }));
    fs.writeFileSync(pkgPath, JSON.stringify({ dsh: { profile: { bundles: ['no-file-bundle'] } } }));
    mod.sanitizeDependencies(profileDir, { log: () => {}, diag: () => {}, seedBundles: [], anchorDirs: [coreNm] });
    const after2 = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    check('anchorDirs 里声明残缺的仍移除', after2.dsh.profile.bundles.length === 0, JSON.stringify(after2.dsh.profile.bundles));
  }

  console.log(`\ncheck-user-rows-preflight：${pass} 项通过，${fail} 项失败`);
  process.exit(fail > 0 ? 1 : 0);
})();
