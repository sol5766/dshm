'use strict';

/**
 * 为需要独立 `node` 可执行文件的插件准备运行时。
 *
 * 背景：
 *   DSHM Host 自己运行在内嵌 `libnode.so` 里，`process.execPath` 是 appspawn，
 *   不能把它当成 Node CLI 再 spawn。多数插件只依赖 Host 即可；`dsh-bili-whale`
 *   这类插件却会明确执行 `node tools/*.mjs`，因此必须拿到一个真正的 CLI。
 *
 * 设计：
 *   1. 只针对已安装且已知需要 CLI 的插件启用，避免所有用户无端多复制 100+ MB；
 *   2. 优先复用 `DSHM_NODE` / 公共下载目录里已验证的副本；
 *   3. 没有可执行副本时，从 Harmonybrew、现有 DSH runtime 或显式
 *      `DSHM_NODE_SOURCE` 读取，复制到 DSHM 自己的
 *      `$DSH_HOME/dsh-runtimes/dshm-node-cli/dependencies/node/bin/node`；
 *   4. 复制后用插件相同的 `-e` 方式真跑一次，成功才注入 `DSH_NODE`；
 *   5. 失败只记录明确原因，不阻断 Host 启动。
 *
 * 安全边界：
 *   - 源路径采用固定、可覆盖白名单，不接受插件传入的任意路径；
 *   - 目标只在 DSHM_HOME 与已认领的公共下载目录内；
 *   - 不修改第三方插件文件；
 *   - `DSHM_NODE_PROVISION=off` 可完全关闭，`=force` 可跳过插件名判断。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NODE_CLI_PLUGINS = new Set([
  // 当前已知在运行期直接 spawn node 的插件。新增同类插件时在这里显式登记，
  // 避免仅凭源码里出现 "node" 字样就复制整套运行时。
  'dsh-bili-whale',
]);

const RUNTIME_REL = path.join(
  'dsh-runtimes',
  'dshm-node-cli',
  'dependencies',
  'node',
  'bin',
  process.platform === 'win32' ? 'node.exe' : 'node',
);
const BUNDLED_SOURCE_REL = path.join('toolchain', 'node', 'nodecli');

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function profileNeedsNodeCli(homeDir, profile) {
  const profileDir = path.join(homeDir, 'profiles', profile);
  const pkg = readJson(path.join(profileDir, 'package.json'));
  const dependencies = pkg && pkg.dependencies && typeof pkg.dependencies === 'object'
    ? pkg.dependencies : {};
  for (const name of NODE_CLI_PLUGINS) {
    if (Object.prototype.hasOwnProperty.call(dependencies, name)) {
      return true;
    }
    if (fileExists(path.join(profileDir, 'node_modules', name, 'package.json'))) {
      return true;
    }
  }
  return false;
}

function userRootFromPublicDownload(publicDownload) {
  const value = typeof publicDownload === 'string' ? publicDownload.trim() : '';
  if (!value.startsWith('/storage/Users/')) {
    return '';
  }
  const downloadDir = path.dirname(value);
  return path.basename(downloadDir) === 'Download' ? path.dirname(downloadDir) : '';
}

function cellarNodeCandidates(userRoot) {
  if (userRoot.length === 0) {
    return [];
  }
  const root = path.join(userRoot, '.harmonybrew', 'Cellar', 'node');
  let versions = [];
  try {
    versions = fs.readdirSync(root).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
  } catch {
    return [];
  }
  return versions.map((version) => path.join(root, version, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'));
}

/**
 * 返回有序候选。`copyOnly` 中只列"可读源"；直接可执行的候选也放进同一列表，
 * 调用方先 probe，失败后才复制。
 */
function candidateSources(env = process.env, publicDownload = '') {
  const explicit = String(env.DSHM_NODE_SOURCE || '').trim();
  const configured = String(env.DSH_NODE || '').trim();
  const desktop = String(env.DSH_DESKTOP_NODE_EXECUTABLE || '').trim();
  const publicRoot = typeof publicDownload === 'string' ? publicDownload.trim() : '';
  const userRoot = userRootFromPublicDownload(publicRoot);
  const home = String(env.HOME || '').trim();
  const out = [];
  const add = (value) => {
    if (value && !out.includes(value)) {
      out.push(value);
    }
  };

  add(configured);
  add(desktop);
  if (publicRoot) {
    add(path.join(publicRoot, 'node-brew'));
  }
  add(explicit);
  if (userRoot) {
    add(path.join(userRoot, '.harmonybrew', 'opt', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'));
    for (const candidate of cellarNodeCandidates(userRoot)) {
      add(candidate);
    }
  }
  if (home) {
    add(path.join(home, '.harmonybrew', 'opt', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'));
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir) {
      add(path.join(dir.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'node.exe' : 'node'));
    }
  }
  return out;
}

function probeNode(file, env = process.env) {
  let dir = '';
  try {
    if (!fileExists(file)) {
      return { ok: false, error: '文件不存在' };
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-node-cli-'));
    const proof = path.join(dir, 'proof');
    const result = spawnSync(file, [
      '-e',
      'require("fs").writeFileSync(process.argv[1],process.versions.node)',
      proof,
    ], {
      env: Object.assign({}, env, { UV_USE_IO_URING: '0' }),
      stdio: 'ignore',
      timeout: 10000,
    });
    if (result.error) {
      return { ok: false, error: result.error.code || result.error.message };
    }
    if (result.status !== 0) {
      return { ok: false, error: `exit=${result.status}${result.signal ? `/${result.signal}` : ''}` };
    }
    const version = fs.readFileSync(proof, 'utf8').trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      return { ok: false, error: '探测页不是合法 Node 版本' };
    }
    return { ok: true, version };
  } catch (e) {
    return { ok: false, error: e && e.code ? e.code : String(e && e.message ? e.message : e) };
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 临时探测目录清理失败不影响运行时结论。
      }
    }
  }
}

function copyAndProbe(source, destination, env) {
  const parent = path.dirname(destination);
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(parent, { recursive: true });
    fs.copyFileSync(source, temp);
  /*
   * 【hmfs 注记（docs/267 §4）】目标若落在 hmfs（仓库 / 公共存储），`chmodSync` 会
   * **静默无效**（实测权限恒 660）；落在 el2 沙箱时正常。这里保留 chmod 是为了
   * 沙箱场景正确，判据用随后的 probeNode() 实跑，而不是权限位。
   */
    fs.chmodSync(temp, 0o755);
    const probe = probeNode(temp, env);
    if (!probe.ok) {
      return probe;
    }
    fs.renameSync(temp, destination);
    return probe;
  } catch (e) {
    return { ok: false, error: e && e.code ? e.code : String(e && e.message ? e.message : e) };
  } finally {
    try {
      if (fileExists(temp)) {
        fs.rmSync(temp, { force: true });
      }
    } catch {
      // 下次启动可再次覆盖，不把清理失败升级成启动失败。
    }
  }
}

function writeIfChanged(file, data, mode) {
  try {
    if (fs.readFileSync(file).equals(Buffer.isBuffer(data) ? data : Buffer.from(data))) {
      return false;
    }
  } catch {
    // 文件不存在或不可读：继续走重写。
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, data, { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    try {
      if (fileExists(temp)) {
        fs.rmSync(temp, { force: true });
      }
    } catch {
      // 下一次启动会覆盖。
    }
  }
  return true;
}

/**
 * 布置随包 `nodecli` 与 `node` wrapper。
 *
 * `nodecli` 只有约几十 KB，真正的 Node/V8/ICU 复用 HAP 里已有的
 * `libnode.so.137`。wrapper 在每次执行时注入 libnode 的绝对路径与动态库目录。
 */
function ensureBundledNodeCli(options = {}) {
  const binDir = String(options.binDir || '').trim();
  const resRoot = String(options.resRoot || '').trim();
  const nativeLibs = String(options.nativeLibs || '').trim();
  /*
   * 已验证的完整 Node（ArkTS 认领的 `Download/<包名>/node-brew`）。
   *
   * 【P0-2 修复（docs/267 §2）】旧包装器只走「随包 nodecli + libnode.so.137」，
   * 而那条路在真机进程域里**必然失败**：node-cli 需要 libc++_shared.so，它落在
   * el1 bundle libs 与随包路径上，两者在当前域都不能被动态加载器映射
   * （dlopen 返回 EACCES，实测 2026-10-26/28 两次复现，包装器恒 rc=127）。
   * 于是 PATH 上的 `node` 是坏的，凡 spawn `node` 的路径（含开发期跑门禁）全废。
   * 现在改为：先委托这个完整 Node（存在且可执行时直接 exec），失败才回退旧路线。
   */
  const fullNode = String(options.fullNode || '').trim();
  const log = typeof options.log === 'function' ? options.log : () => {};
  const diag = typeof options.diag === 'function' ? options.diag : () => {};
  const base = { requested: true, ready: false, file: '', source: '', version: '', action: 'none', error: '' };
  if (binDir.length === 0) {
    return Object.assign(base, { requested: false, error: 'busybox bin 未就绪' });
  }
  if (nativeLibs.length === 0) {
    return Object.assign(base, { error: 'NATIVE_LIBS 为空' });
  }
  const source = path.join(resRoot, BUNDLED_SOURCE_REL);
  const cli = path.join(binDir, 'node-cli');
  const wrapper = path.join(binDir, 'node');
  try {
    if (!fileExists(source) || fs.statSync(source).size <= 0) {
      return Object.assign(base, { error: `缺少随包 nodecli：${source}` });
    }
    const changedCli = writeIfChanged(cli, fs.readFileSync(source), 0o755);
    const script = [
      '#!/system/bin/sh',
      '# DSHM node wrapper：优先委托已验证的完整 Node（node-brew），否则回退随包 nodecli + libnode。',
      '# 【P0-2（docs/267）】回退路线在真机进程域拿不到可映射的 .so（node-cli 加载',
      '# libc++_shared.so 失败）⇒ 没有下面这段短接时，PATH 上的 node 恒 rc=127。',
      `NODE_FULL=${JSON.stringify(fullNode)}`,
      'if [ -n "$NODE_FULL" ] && [ -x "$NODE_FULL" ]; then',
      '  export UV_USE_IO_URING=0',
      '  exec "$NODE_FULL" "$@"',
      'fi',
      `CLI=${JSON.stringify(cli)}`,
      `LIBS=${JSON.stringify(nativeLibs)}`,
      'if [ ! -x "$CLI" ]; then',
      '  echo "node：随包 nodecli 尚未就位" >&2',
      '  exit 127',
      'fi',
      'if [ ! -f "$LIBS/libnode.so.137" ]; then',
      '  echo "node：找不到 $LIBS/libnode.so.137" >&2',
      '  exit 127',
      'fi',
      'export DSHM_NODE_LIBNODE="$LIBS/libnode.so.137"',
      'case ":${LD_LIBRARY_PATH:-}:" in',
      '  *":$LIBS:"*) ;;',
      '  *) export LD_LIBRARY_PATH="$LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;',
      'esac',
      'export UV_USE_IO_URING=0',
      '# 插件子进程使用 JIT：fetch/undici 需要 WebAssembly；Host 主进程仍独立运行 --jitless。',
      'exec "$CLI" "$@"',
    ].join('\n') + '\n';
    const changedWrapper = writeIfChanged(wrapper, script, 0o755);
    if (changedCli || changedWrapper) {
      diag(`Node CLI（随包）：已布置 ${cli}${changedCli ? '（更新）' : ''}`
        + ` / ${wrapper}${changedWrapper ? '（更新）' : ''}`);
    }
    log('插件 Node CLI 已布置（随包 nodecli + 现有 libnode）');
    return Object.assign(base, {
      ready: true,
      file: wrapper,
      source: fullNode.length > 0 ? 'wrapper(full-node→bundled)' : 'bundled-libnode',
      action: 'bundle',
    });
  } catch (e) {
    const error = e && e.code ? e.code : String(e && e.message ? e.message : e);
    diag(`Node CLI（随包）：布置失败：${error}`);
    return Object.assign(base, { error });
  }
}

/**
 * 确保当前 profile 的 Node CLI 依赖已就绪。
 *
 * @returns {{
 *   requested: boolean,
 *   ready: boolean,
 *   file: string,
 *   source: string,
 *   version: string,
 *   action: string,
 *   error: string
 * }}
 */
function ensureForProfile(options = {}) {
  const env = options.env || process.env;
  const homeDir = String(options.homeDir || env.DSHM_HOME || '').trim();
  const profile = String(options.profile || env.DSHM_PROFILE || 'ondevice').trim();
  const publicDownload = String(options.publicDownload || env.DSHM_PUBLIC_DOWNLOAD || '').trim();
  const mode = String(env.DSHM_NODE_PROVISION || '').trim().toLowerCase();
  const requested = mode === 'force' || (mode !== 'off' && homeDir.length > 0
    && profileNeedsNodeCli(homeDir, profile));
  const base = { requested, ready: false, file: '', source: '', version: '', action: 'none', error: '' };

  if (!requested) {
    return base;
  }
  if (homeDir.length === 0) {
    base.error = 'DSHM_HOME 为空';
    return base;
  }

  const destination = path.join(homeDir, RUNTIME_REL);
  if (fileExists(destination)) {
    const existing = probeNode(destination, env);
    if (existing.ok) {
      return Object.assign(base, {
        ready: true,
        file: destination,
        source: 'persistent-copy',
        version: existing.version,
        action: 'reuse',
      });
    }
  }

  let lastError = '';
  for (const candidate of candidateSources(env, publicDownload)) {
    if (!fileExists(candidate) || path.resolve(candidate) === path.resolve(destination)) {
      continue;
    }
    const direct = probeNode(candidate, env);
    if (direct.ok) {
      return Object.assign(base, {
        ready: true,
        file: candidate,
        source: 'existing',
        version: direct.version,
        action: 'use',
      });
    }
    const copied = copyAndProbe(candidate, destination, env);
    if (copied.ok) {
      return Object.assign(base, {
        ready: true,
        file: destination,
        source: candidate,
        version: copied.version,
        action: 'copy',
      });
    }
    lastError = `${candidate}: ${copied.error || direct.error || '不可执行'}`;
  }

  base.error = lastError || '系统未提供可执行的 OHOS Node；可设置 DSHM_NODE_SOURCE 指向 Node CLI';
  return base;
}

module.exports = {
  BUNDLED_SOURCE_REL,
  NODE_CLI_PLUGINS,
  RUNTIME_REL,
  candidateSources,
  ensureBundledNodeCli,
  ensureForProfile,
  profileNeedsNodeCli,
  probeNode,
};
