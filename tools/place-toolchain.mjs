#!/usr/bin/env node
/*
 * 把端侧工具链归档放进应用内置资源（entry/src/main/resources/resfile/toolchain/）。
 *
 * 【资产来源】（third_party/ 下手工取得，字节不进库、方法进库）：
 *   · python/cpython-3.12.14-aarch64-musl-install_only_stripped.tar.gz
 *       —— astral-sh/python-build-standalone release 20260901，musl aarch64。
 *         核心扩展（_ssl/_socket/zlib/_sqlite3 …）静态内建进 libpython（musl 变体
 *         特性），lib-dynload 仅 3 个可选模块；运行只依赖系统 musl loader
 *         （busybox 同 loader 已实测可跑）。
 *   · git/*.tar.gz —— Alpine v3.21 main aarch64：git-2.47.3-r0 + so 闭包 14 包
 *         （libcurl/openssl/pcre2/zlib/...）+ ca-certificates-bundle。
 *         源文件是 Alpine v2 包，端侧 busybox tar 直接解。**扩展名一律 .tar.gz**：
 *         应用市场审核按**路径**判"包内带 apk 相关目录/文件"就判"安装失败"，见 docs/148。
 *
 * 【为什么原样放归档而不是解开的目录】hmfs 禁 symlink（D6 §4.1.3），Windows 侧
 * 解包会把 git-core 里 180+ 个指向 git 本体的 symlink 变成 1.3GB 拷贝；tar.gz
 * 原样带 symlink 元数据进 HAP，端侧 busybox tar 解包时 symlink 失败仅告警跳过，
 * 真身 ELF 全在（main.js finishToolchainExtraction 复制补齐关键 symlink）。
 *
 * 产物目录已 gitignore（生成物）。用法：node tools/place-toolchain.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { devecoPath, devecoSdkHomeCandidates } from './lib/deveco-home.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PY_SRC = join(ROOT, 'third_party', 'python');
const GIT_SRC = join(ROOT, 'third_party', 'git', 'packages');
/*
 * 【2026-11-02 修正】目标必须是**共享 HSP**（hostruntime）的 resfile，不是 entry。
 * 依据：端侧 `main.js` 的 `RES_ROOT = resolve(__dirname,'..','..')`，而 main.js 本身就装在
 * HSP 的 `resfile/resources/app/` 里 ⇒ 它读的是 **HSP** 的 resfile。放 entry 侧的话
 * 归档会随包发出去、但端侧永远找不到（本轮实测：entry 里多出 26.4MB python + git 副本，
 * 而 HSP 里本来就有同样一份）。放错位置既浪费体积又不生效。
 */
const DEST = join(ROOT, 'hostruntime', 'src', 'main', 'resources', 'resfile', 'toolchain');

// main.js 的 PYTHON_TARBALL_REL 与此对应；改名时两处同步
const PY_NAME = 'cpython-3.12.14-aarch64-musl.tar.gz';
const PY_SRC_FILE = 'cpython-3.12.14-aarch64-musl-install_only_stripped.tar.gz';

/*
 * ── 工具链 ELF 的构建期自签名（报告 4 ③，2026-09-26）────────────────────────
 *
 * 【为什么必须签】端侧 execve 对**第三方 ELF** 一律拒绝（签名域策略），与权限位/
 * 创建者无关——rg 已实证：构建期 `binary-sign-tool sign -selfSign 1` 后
 * `exec 探测` 由 `rg=denied` 变为 `rg=ok`。git / python3.12 同属"要被 exec 的
 * 独立 ELF"，只是它们躺在**归档**里（tar.gz），解包发生在设备上，
 * 所以构建期要先把归档解到临时目录 → 签名 → 重新打包。
 *
 * 【为什么连 .so 一起签】git 依赖 musl loader 与一批 so（libcurl/libssl/…）：
 * execve 放行主程序后，动态链接阶段仍要加载它们。本轮把 `*.so*` 一并签，
 * 与"主程序能起来"是同一件事的两半。
 *
 * 【为什么 python 只签 bin/* + 少量 .so】python-build-standalone 的 musl 变体把
 * 核心扩展静态内建进 libpython（见文件头注释），动态件很少；全树签名会把
 * 27 MB 归档膨胀数倍且没必要。
 *
 * 【为什么要写 .dshm-signed 版本标记】设备侧解包是"存在即跳过"（gitReady()/
 * pythonReady() 只看文件在不在）。若不改判据，**重新打包的已签名归档永远不会被解包**
 * ——那正是报告里"git mtime 仍是 09-22"的原因。因此这里把标记写进归档目录，
 * 端侧据此判"归档换代了、需重解"。
 *
 * 【标记为什么是"前缀 + 内容摘要"而不是固定常量】见写标记处的长注释。
 * 简短版：固定常量会让"未签名版 → 已签名版"这类换代**测不出来**，
 * 端侧以为没变、不重解 ⇒ 白签一场。
 */
const SIGN_MARKER_PREFIX = 'dshm-signed-v1';
/**
 * 标记文件名（**不能以点开头**）。
 *
 * 踩坑实录：最初用 `.dshm-signed`，结果 HAP 打包把 **所有** dotfile 条目丢掉
 * （实测：打包产物里以点开头的条目数为 0）⇒ 端侧读不到标记 ⇒ 判"归档无标记"
 * ⇒ 走原有的"存在即跳过" ⇒ 新签名归档永远不会被解包，白签一场。
 * 故改用普通文件名。
 */
const SIGN_MARKER_FILE = 'dshm-signed.txt';

/**
 * 找 ELF 自签名工具，**原生优先**。
 *
 * 【为什么原生优先】鸿蒙 PC 的 CLT 里 `binary-sign-tool` 是**原生 ELF**（2.9 MB），
 * 根本没有 jar 也没有 JDK（本机实测：全机无 java，`jbr/` 不存在）。旧实现只认
 * `binary-sign-tool.jar` + `java`，于是**永远不会命中** ⇒ 每次构建都走"跳过签名"
 * 分支（早期是静默跳过，现在是 exit 1）。docs/225 记着这一条曾经修过，但代码里没有留下。
 *
 * 【两种形态的调用差异】原生不接受 jar 专有的 `-mode localSign`，参数顺序也敏感：
 *   native: binary-sign-tool sign -inFile <in> -outFile <out> -selfSign 1
 *   jar   : java -jar binary-sign-tool.jar sign -mode localSign -selfSign 1 -inFile … -outFile … -signAlg …
 * 由 sign-tar-elf.py 按"路径是否以 .jar 结尾"分派。
 */
function findBinarySignTool() {
  const nativeCandidates = devecoSdkHomeCandidates()
    .map((h) => join(h, 'default', 'openharmony', 'toolchains', 'lib', 'binary-sign-tool'))
    .filter((p) => existsSync(p));
  if (nativeCandidates.length > 0) {
    return { native: true, tool: nativeCandidates[0], java: '' };
  }
  const java = [
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java.exe') : '',
    devecoPath(join('jbr', 'bin', 'java.exe')),
  ].filter((p) => p !== null && p.length > 0 && existsSync(p));
  const jar = devecoSdkHomeCandidates()
    .map((h) => join(h, 'default', 'openharmony', 'toolchains', 'lib', 'binary-sign-tool.jar'))
    .filter((p) => existsSync(p));
  return java.length > 0 && jar.length > 0 ? { native: false, tool: jar[0], java: java[0] } : null;
}

/**
 * 项目自带 / 机器上已知的 python 解释器路径（存在才返回）。
 * 这样就不必依赖调用者的 PATH —— 静默跳过自签名是个陷阱，必须堵掉。
 */
function bundledPythonCandidates() {
  const out = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const probes = [
    /* `.dsh` runtime 里的 python（本机实测可用，带 tarfile） */
    join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    /* DevEco 自带的（若存在）。**不写死安装根**：DevEco 2026-10-10 从 C 盘搬到 D 盘，
       见 tools/lib/deveco-home.mjs。注意 DevEco 26 已不再随包带 python ⇒ 这本就返回 null。 */
    devecoPath(join('tools', 'python', 'python.exe')),
  ].filter((p) => p !== null && p.length > 0);
  for (const p of probes) {
    try {
      if (p.length > 0 && existsSync(p)) out.push(p);
    } catch { /* 忽略 */ }
  }
  return out;
}

/**
 * 找宿主 python3（sign-tar-elf.py 需要它）。
 * 【为什么用 Python】见 tools/sign-tar-elf.py 头注释：归档里有 symlink，Windows 的
 * bsdtar/7z 都会破坏结构。Windows 上通常是 `python.exe`（Store 版或官方安装版）
 * 或 `py.exe` 启动器；两者都试。
 *
 * ── 2026-09-27 修：追加"项目自带 python"这条候选 ──────────────────────────
 * 【真实事故，独立审查发现】本机 PATH 里**没有** python3/python/py
 * （只有 DevEco 的 jbr 与 node），于是 `findHostPython()` 返回 null
 * ⇒ **静默跳过工具链自签名**（只打一行 ⚠），而脚本仍 **exit=0**、构建照常成功。
 * 后果：设备上 `exec 探测` 长期为
 * `python3.12=denied，git=denied，git-core/git=denied`（只有 rg 因在核心树里已被签而 ok），
 * 而**没有任何门禁会红** —— AGENTS.md 要求"所有沙箱内 ELF 必须构建期自签名"，
 * 却被静默绕过了。
 *
 * 项目其实**自带了可用的宿主 python**（`.dsh` runtime 里那份，带 tarfile）。
 * 所以把它加为候选：不依赖调用者 PATH，"忘配 PATH"不会再导致静默降级。
 */
function findHostPython() {
  const candidates = [];
  const explicit = process.env.DSHM_HOST_PYTHON;
  if (explicit && explicit.length > 0) candidates.push(explicit);
  for (const p of bundledPythonCandidates()) candidates.push(p);
  candidates.push('python3', 'python', 'py');

  for (const cmd of candidates) {
    try {
      const out = execFileSync(cmd, ['-c', 'import tarfile,sys;print(sys.executable)'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out.length > 0) return cmd;
    } catch { /* 试下一个 */ }
  }
  return null;
}

mkdirSync(join(DEST, 'python'), { recursive: true });
mkdirSync(join(DEST, 'git'), { recursive: true });

const src = join(PY_SRC, PY_SRC_FILE);
if (!existsSync(src)) {
  console.error(`place-toolchain: 缺 ${src}
  取法：curl -LO https://github.com/astral-sh/python-build-standalone/releases/download/20260901/${PY_SRC_FILE.replace('+', '%2B')}`);
  process.exit(1);
}
copyFileSync(src, join(DEST, 'python', PY_NAME));
console.log(`placed   : python/${PY_NAME}  (${(statSync(join(DEST, 'python', PY_NAME)).size / 1048576).toFixed(1)}MB)`);

const pkgs = readdirSync(GIT_SRC).filter((n) => n.endsWith('.tar.gz')).sort();
if (pkgs.length === 0) {
  console.error(`place-toolchain: ${GIT_SRC} 下没有 tar.gz 归档
  取法：见 docs/device-validation.md 工具链批次（Alpine v3.21 main aarch64，git-2.47.3-r0 闭包）`);
  process.exit(1);
}
for (const name of pkgs) {
  copyFileSync(join(GIT_SRC, name), join(DEST, 'git', name));
}
console.log(`placed   : git/*.tar.gz  ×${pkgs.length}  (${(pkgs.reduce((s, n) => s + statSync(join(DEST, 'git', n)).size, 0) / 1048576).toFixed(1)}MB)`);

/*
 * ── tmux / gh（2026-11-02，docs/342）────────────────────────────────────
 *
 * 为什么走"每个 Alpine 包一个 tar.gz"而不是合并成一个大归档：
 * 端侧解包逻辑是**把目录里所有归档依次解到同一个 root**（git 就是这么做的，
 * 43 个包解进 gitroot）。沿用同一形状 ⇒ main.js 只需照抄 git 的三处改动，
 * 不需要新的解包器，也不会因为"一个包里坏一个文件"整包失败。
 *
 * 为什么从 dist/alpine-stage 取而不是 third_party：
 * 这些包由 `tools/fetch-alpine-toolchain.mjs` 按需从 Alpine CDN 采集（含 so: 依赖解析），
 * 体积 16MB/7 包，不必入库；缺了就跳过并告警（不阻断其他人构建 git/python）。
 */
const ALPINE_STAGE = join(ROOT, 'dist', 'alpine-stage');
/** bash/procps 单独采集目录（2026-11-03）：保持与既有 stage 分离，避免互相覆盖。 */
const ALPINE_STAGE_BP = join(ROOT, 'dist', 'alpine-stage-bp');
/** sub = 端侧解包目录名；pkgs = 该 root 需要的 Alpine 包（顺序无关）。 */
const EXTRA_ROOTS = [
  { sub: 'tmux', pkgs: ['tmux', 'libevent', 'libncursesw', 'ncurses-terminfo-base'] },
  { sub: 'gh', pkgs: ['github-cli', 'libssl3', 'libcrypto3'] },
  /*
   * 【bash 真身（2026-11-03，把"垫片"换成"环境组件"第 1 项）】
   * 旧形态：`bin/bash` 是 463 B 文本垫片 → busybox hush（busybox 未编 bash applet）。
   * 现在：Alpine bash 5.2.37 真 ELF + 它的依赖库（readline / libncursesw / terminfo /
   * utmps / skalibs）。端侧解包仍走"同目录多归档依次解到同一 root"的既有形状。
   */
  { sub: 'bash', pkgs: ['bash', 'readline', 'libncursesw', 'ncurses-terminfo-base', 'utmps-libs', 'skalibs-libs'] },
];
const extraArchives = [];

/*
 * ── npm / pnpm（2026-11-02，第一批"绕过 pnpm 假壳"）──────────────────────
 *
 * 【为什么要随包】端侧 `bin/pnpm` 是安装队列假壳，`pnpm install/build` 全废。
 * 而 pnpm 本体就是**纯 JS**（9.15.9 的 `bin/pnpm.cjs`），只要有能跑的 node 就能执行 ——
 * 宿主侧实测 `node v24.2.0` 可用（env-probe 证据），于是这条路不需要任何 ACL。
 *
 * 【为什么锁 pnpm 9 而不是 12】pnpm 12 的 npm 包已改成"下载平台预编译二进制"的引导器，
 * openharmony-arm64 没有对应产物 ⇒ 直接失败（本机实测报
 * `pnpm does not provide a pre-built binary for openharmony-arm64`）。9.15.9 是纯 JS 实现。
 *
 * 来源：`node tools/fetch-alpine-toolchain.mjs` 之外单独取的 npm registry 包，
 * 解到 `dist/npm-stage/{npm,pnpm}`（不入库）。
 */
const NPM_STAGE = join(ROOT, 'dist', 'npm-stage');
const JS_TOOL_ROOTS = [
  { sub: 'npm', dir: join(NPM_STAGE, 'npm'), probe: 'bin/npm-cli.js' },
  { sub: 'pnpm', dir: join(NPM_STAGE, 'pnpm'), probe: 'bin/pnpm.cjs' },
];
for (const spec of JS_TOOL_ROOTS) {
  const out = join(DEST, spec.sub);
  mkdirSync(out, { recursive: true });
  if (!existsSync(join(spec.dir, spec.probe))) {
    console.error(`place-toolchain: ⚠ 缺 ${spec.dir}/${spec.probe} —— 跳过 ${spec.sub}`);
    continue;
  }
  const name = `${spec.sub}-js.tar.gz`;
  try {
    execFileSync('tar', ['-czf', join(out, name), '-C', spec.dir, '.'], { stdio: 'pipe' });
    extraArchives.push(join(out, name));
    console.log(`placed   : ${spec.sub}/${name}  (${(statSync(join(out, name)).size / 1048576).toFixed(1)}MB)`);
  } catch (e) {
    console.error(`place-toolchain: ⚠ 打包 ${spec.sub} 失败：${String(e && e.message ? e.message : e).slice(0, 120)}`);
  }
}
for (const spec of EXTRA_ROOTS) {
  const dir = join(DEST, spec.sub);
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  let made = 0;
  for (const pkg of spec.pkgs) {
    /* bash/procps 从独立采集目录取；其余仍从既有 stage 取 */
    const srcDir = existsSync(join(ALPINE_STAGE_BP, pkg))
      ? join(ALPINE_STAGE_BP, pkg)
      : join(ALPINE_STAGE, pkg);
    if (!existsSync(srcDir)) {
      continue;
    }
    const name = `${pkg}-alpine.tar.gz`;
    const out = join(dir, name);
    try {
      /* -C 进包目录、打包 `.`：与 Alpine apk 的内部布局一致（usr/…、lib/… 直接在根） */
      execFileSync('tar', ['-czf', out, '-C', srcDir, '.'], { stdio: 'pipe' });
      bytes += statSync(out).size;
      made += 1;
      extraArchives.push(out);
    } catch (e) {
      console.error(`place-toolchain: ⚠ 打包 ${pkg} 失败：${String(e && e.message ? e.message : e).slice(0, 120)}`);
    }
  }
  if (made > 0) {
    console.log(`placed   : ${spec.sub}/*.tar.gz  ×${made}  (${(bytes / 1048576).toFixed(1)}MB)`);
  } else {
    console.error(`place-toolchain: ⚠ ${spec.sub} 无归档（先跑 node tools/fetch-alpine-toolchain.mjs --out dist/alpine-stage）`
      + ' —— 跳过该 root，不影响 git/python');
  }
}

/*
 * ── 构建期自签名（报告 4 ③）─────────────────────────────────────────────
 * 只签"要被 exec / 被动态链接加载"的 ELF：
 *   · git 归档：usr/bin/git、usr/libexec/git-core/*（43 个可执行）、usr/lib/*.so*
 *   · python 归档：bin/*（8 个）+ lib/*.so*（10 个）
 * 【为什么 python 也要签】报告指出"真 python3.12 可从桥模式切回真身"——那需要
 * python3.12 本身能 execve 通过；桥模式（libpython 在进程内 dlopen）只是替代通道。
 * 两者可并存：签好后 exec 探测会转 ok，wrapper 自然走真身分支。
 *
 * 【实现走 Python 的 tarfile，不用 tar/7z】见 tools/sign-tar-elf.py 的头注释：
 * 归档里有 symlink 条目，Windows 上 bsdtar 会丢条目、7z 会把 symlink 物化
 * （git-core 会从 8MB 涨到 1.3GB）。tarfile 逐条目搬运是唯一既保结构又能改字节的路。
 *
 * 【失败不退出】签名工具/宿主 python 缺失时只告警：归档仍可放置（桥模式与降级路径
 * 照常工作），只是 git/python 真身继续被拒。如实打印，不在验收上撒谎。
 */
const tool = findBinarySignTool();
const hostPython = findHostPython();
/*
 * 标记值 = 前缀 + 归档内容摘要。
 *
 * 【为什么必须带摘要】端侧判据是"解包目录标记 ≠ 归档目录标记 ⇒ 重解"。
 * 固定常量会让"未签名 → 已签名"这种换代**测不出来**（两边都是 v1）⇒ 不重解
 * ⇒ 新签名到不了设备。带摘要后归档一变、标记就变，换代必然触发。
 *
 * 【摘要取什么】取**该归档目录内文件大小之和**，因为：
 *   · 签名会**改变文件字节**（追加签名块），大小必然变 ⇒ 能捕捉签名前后差异；
 *   · 不需要读全文件算哈希（27MB 归档，读一遍没必要）；
 *   · 端侧只做字符串比较，长度无所谓。
 *
 * 【为什么 python 与 git 各算各的，而不是共用一个大数】
 * 端侧是**分别**比较两个目录的标记（main.js 对 python/ 与 git/ 各判一次）。
 * 若两边写同一个"总和"，则"只有 git 换代、python 没变"时两个标记都会变，
 * python 被无谓重解（27MB / 4530 文件）；更糟的是本仓新增的门禁
 * `check-toolchain-sign.mjs` 是**按目录**核算的，共用总和会让它误报不一致。
 * 所以：**每个目录写自己的摘要**。
 */
function archiveDigest(sub) {
  let sum = 0;
  try {
    for (const f of readdirSync(join(DEST, sub))) {
      if (f === SIGN_MARKER_FILE) continue;      // 标记本身不计入
      try { sum += statSync(join(DEST, sub, f)).size; } catch { /* 忽略 */ }
    }
  } catch { /* 目录缺失 */ }
  return sum;
}
/*
 * ⚠️ 标记值必须在**签名之后**才算 —— 签名会改变文件大小。
 * 早先写成"签名前算"，于是标记记的是签名前的摘要，与落盘文件对不上，
 * 新建的 check-toolchain-sign.mjs 立刻报不一致（它替我们抓住了这个顺序错误）。
 * 现在把计算挪到文件末尾的写标记处。
 */

/* 签名是否真的执行了（用于后面把"静默跳过"变成显式失败） */
let signOk = false;
if (tool === null) {
  console.error('sign     : ⚠ 找不到 binary-sign-tool/JDK，跳过工具链自签名（git/python 真身仍会被 execve 拒）');
} else if (hostPython === null) {
  console.error('sign     : ⚠ 找不到宿主 python3（tarfile 需要它保 symlink 结构），跳过工具链自签名');
} else {
  const signer = join(ROOT, 'tools', 'sign-tar-elf.py');
  const targets = [
    join(DEST, 'python', PY_NAME),
    ...pkgs.map((n) => join(DEST, 'git', n)),
    ...extraArchives,   // tmux / gh（含其 .so：gh 动态链接，库不签也会被拒）
  ];
  try {
    const out = execFileSync(hostPython, [signer, tool.tool, tool.java || '-', ...targets],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const line of out.split('\n')) {
      if (line.trim().length > 0) console.log(`           ${line.trim()}`);
    }
    signOk = true;
  } catch (e) {
    console.error(`sign     : ⚠ 工具链签名器失败（归档可继续使用，只是真身仍被拒）：${String(e && e.message ? e.message : e).slice(0, 200)}`);
  }
  /*
   * 版本标记：端侧据此判"归档换代，需重解"（否则"存在即跳过"会永远用旧文件）。
   *
   * 【为什么标记内容要**随归档内容变化**，而不是固定 'dshm-signed-v1' 】
   * 端侧判据是 `解包目录的标记 !== 归档目录的标记 ⇒ 重解`（main.js needsReextractForSign）。
   * 若标记是**常量**：
   *   · 09-22 那版（**未签名**）的归档也写同一个常量，且设备已解包并记下该常量；
   *   · 今天这版（**已签名**）的归档标记仍是同一常量
   *   ⇒ 端侧判成"没换代" ⇒ **不重解** ⇒ 新签名的 ELF 永远到不了设备，
   *     exec 探测继续 `python3.12=denied, git=denied`，白签一场。
   *   （这正是本项目历史上"白签一场"的同一类坑，只是换了个触发点。）
   * 改成**内容摘要**后：归档一变，标记就变，换代判定必然触发。
   * 端侧只做字符串比较，不需要任何改动。
   */
  const markerPy = `${SIGN_MARKER_PREFIX}+${archiveDigest('python')}`;
  const markerGit = `${SIGN_MARKER_PREFIX}+${archiveDigest('git')}`;
  writeFileSync(join(DEST, 'git', SIGN_MARKER_FILE), `${markerGit}\n`, 'utf8');
  writeFileSync(join(DEST, 'python', SIGN_MARKER_FILE), `${markerPy}\n`, 'utf8');
  console.log(`sign     : 已写版本标记 python=${markerPy} git=${markerGit}（端侧据此强制重解归档）`);
  /* tmux / gh：按目录各写一份摘要标记（与 python/git 同口径，绝不共用总和） */
  for (const spec of [...EXTRA_ROOTS, ...JS_TOOL_ROOTS.map((x) => ({ sub: x.sub }))]) {
    const dir = join(DEST, spec.sub);
    let any = false;
    try { any = readdirSync(dir).some((f) => f.endsWith('.tar.gz')); } catch { any = false; }
    if (!any) continue;
    const marker = `${SIGN_MARKER_PREFIX}+${archiveDigest(spec.sub)}`;
    writeFileSync(join(dir, SIGN_MARKER_FILE), `${marker}\n`, 'utf8');
    console.log(`sign     : 已写版本标记 ${spec.sub}=${marker}`);
  }
}

/*
 * 【终检：签名没跑就必须**显式失败**，不能静默放过】
 *
 * 真实事故（2026-09-27，独立审查发现）：本机 PATH 里没有 python3/python/py，
 * `findHostPython()` 返回 null ⇒ 只打一行 ⚠ 就跳过自签名，而脚本 **exit=0**。
 * 于是 AGENTS.md 的硬要求"所有沙箱内 ELF 必须构建期自签名"被**静默绕过**，
 * 设备上长期 `python3.12=denied，git=denied`，且没有任何门禁会红。
 *
 * "只告警不失败"在这里是错的：签名不是可选项 —— 少了它，工具链真身根本起不来，
 * 而症状要到设备上才显现（构建端一切正常）。所以这里改为**非零退出**，
 * 并给出可直接照做的修复步骤。
 *
 * 【为什么允许显式绕过】保留 `DSHM_ALLOW_UNSIGNED_TOOLCHAIN=1` 逃生阀，
 * 供"只改 ArkTS、不碰工具链"的快速迭代使用；但它会在输出里高声提示。
 */
if (!signOk) {
  if (process.env.DSHM_ALLOW_UNSIGNED_TOOLCHAIN === '1') {
    console.error('sign     : ⚠⚠ 工具链**未签名**，因 DSHM_ALLOW_UNSIGNED_TOOLCHAIN=1 继续。'
      + '此包在设备上 git/python 真身会被 execve 拒（仅桥模式可用）。');
  } else {
    console.error('');
    console.error('place-toolchain: ✗ 工具链自签名**未执行**，拒绝继续（exit 1）。');
    console.error('  原因见上面的 sign 行。修法（任一）：');
    console.error('    · 设 DSHM_HOST_PYTHON=<python.exe 绝对路径> 后重跑（该解释器需带 tarfile）');
    console.error('    · 或把可用 python 放进 PATH（本机通常可用项目自带那份：');
    console.error('      %USERPROFILE%\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python）');
    console.error('    · 确信本次不需要工具链时，设 DSHM_ALLOW_UNSIGNED_TOOLCHAIN=1 显式绕过');
    console.error('  背景：未签名的 ELF 在设备上 execve 被签名域拒绝，');
    console.error('        表现为 exec 探测 python3.12=denied / git=denied，且构建端无任何报错。');
    process.exit(1);
  }
}

/*
 * —— python 归档成员提取（供 el1 libs 段使用）——
 * 【历史】曾有"HAP 裸 ELF 段"（resfile/toolchain/elf/，52.4MB：python3.12/
 * libpython/git/git-remote-http/rg 五件裸放 HAP 期望直接 exec）——E1-E19 实验
 * 证明 resfile 只读挂载下的 execve 同样被签名域拒绝，该段沦为 execDiagnostics
 * 的实验素材；Phase 5 拆除诊断后零引用，已整体移除（体积回收 -52.4MB，
 * 记录见 docs/device-validation.md 批次备注八）。python-build-standalone
 * musl 变体核心扩展静态内建（lib-dynload 仅 3 个可选模块）。
 */
function untarMembers(gzPath, wanted) {
  const raw = gunzipSync(readFileSync(gzPath));
  const out = new Map();
  let off = 0;
  while (off + 512 <= raw.length) {
    const name = raw.slice(off, off + 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(raw.slice(off + 124, off + 136).toString('ascii').trim(), 8) || 0;
    const type = String.fromCharCode(raw[off + 156] || 0);
    if (wanted.has(name) && (type === '0' || type === '\0')) {
      out.set(name, raw.slice(off + 512, off + 512 + size));
      if (out.size === wanted.size) {
        break;
      }
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const pyMembers = untarMembers(src, new Set(['python/lib/libpython3.12.so.1.0']));
if (pyMembers.size !== 1) {
  console.error(`place-toolchain: python 归档缺 libpython（实得 ${[...pyMembers.keys()].join(', ')}）`);
  process.exit(1);
}
console.log(`dest     : ${DEST}`);

/*
 * 【2026-11-02 移除：不再把 libpython 写进 entry/libs】
 * `check-mobile-upgrade-migration` 的判据是"libpython 只随共享 HSP 一份，entry HAP 不重复携带"。
 * 旧代码每次跑都往 entry/libs/arm64-v8a/ 复制一份 22MB，跑一次就红一次
 * （本轮实测：581MB 那版就是这么来的；删掉后回到 560MB 且门禁转绿）。
 * 端侧 dlopen 用的是 HSP 里那份，entry 侧这份从来没有消费者。
 */
