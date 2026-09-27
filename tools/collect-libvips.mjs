/**
 * 把 libvips 全套依赖搬进 HAP 的 `entry/libs/<abi>/`（E93）。
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `attachment-local`（图片附件）需要真 sharp；而真 sharp 需要 libvips 及其 46 个
 * 依赖库。之前我们用 stub 让它"能挂载但图片处理不可用"（E79），那是诚实的降级；
 * 这一轮把真件搬进去，把降级取消。
 *
 * 难点有三个，缺一不可（E64 早已量化：46 个文件 / 30.5 MB，且 SONAME 普遍带版本号）：
 *
 *   1. **hvigor 只打包 `libs/<abi>/*.so`（E40 实测）**，而 vips 的依赖文件名带版本号
 *      （`libglib-2.0.so.0.8800.2`）⇒ 必须**改名**成 `*.so`；
 *   2. 改名后**必须同步改它自己的 SONAME**（否则依赖方按新名字 DT_NEEDED 去加载时，
 *      加载器拿库内旧 SONAME 对不上 ⇒ `cannot open shared object`）；
 *   3. **每个依赖方的 DT_NEEDED 也要跟着改**（`libvips-cpp.so.42` → `libvips-cpp.so`），
 *      否则链子在第一环就断。
 *
 * 另外还有一个不注意就会白忙一场的点：sharp 的原生件里写死了一串 **RPATH**
 * （`$ORIGIN/../../sharp-libvips-openharmony-arm64/lib:…`，指向 npm 安装布局），
 * 那个布局在 HAP 里**不存在**。所以还要把 RPATH 改成 **`$ORIGIN`**：让所有依赖
 * 就在它自己旁边解析——这也正是"全部扁平化到同一个目录"的前提。
 *
 * 事实来源：`llvm-readelf` 读出的真实 SONAME/NEEDED/RPATH（ELF 解析复用
 * `tools/patch-native-needed.mjs`，只此一处实现）。本脚本只做**写入**，验证交给
 * `tools/check-native-closure.mjs`（静态依赖闭包检查，可在开发机上跑）。
 *
 * 用法：
 *   node tools/collect-libvips.mjs                 # 收集到 entry/libs/arm64-v8a
 *   node tools/collect-libvips.mjs --abi arm64-v8a --src <libvips lib 目录>
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const PATCH_TOOL = join(ROOT, 'tools', 'patch-native-needed.mjs');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const ABI = arg('--abi', 'arm64-v8a');
// 核心树目录名跟随 recipe（coreVersion 变了这里不用改——写死版本号曾让 0.1.6-alpha.2
// 时代"找不到源目录"变成一种静默错位，见 CMakeLists.txt:170 同一课）
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const STAGE_NAME = `dsh-core-${RECIPE.coreVersion}`;
const SRC = resolve(arg('--src',
  join(ROOT, 'dist', 'core', 'work', STAGE_NAME, 'node_modules', '@ohos-ports',
    'img-sharp-libvips-openharmony-arm64', 'lib')));
const DEST = resolve(join(ROOT, 'entry', 'libs', ABI));
const MANIFEST = join(ROOT, 'dist', 'core', 'libvips-libs.json');
/** 随包一起改写的消费者（它们 DT_NEEDED 里点名了 vips）。 */
const EXTRA_CONSUMERS = ['libsharp-openharmony-arm64.so'];
/** 这些是系统提供的，我们既不打包也不改写。 */
const SYSTEM_LIBS = new Set([
  'libc.so', 'libc++_shared.so', 'libdl.so', 'libm.so', 'libz.so', 'liblog.so',
  'libhilog.so', 'libhilog_ndk.z.so', 'libace_napi.z.so', 'libuv.so', 'libnode.so.127',
  'ld-musl-aarch64.so.1', 'libpthread.so', 'librt.so', 'libatomic.so',
]);

/*
 * 本 ABI 下实际存在的 libnode（soname 随 Node 版本走：26.x=.137、24.x=.127）。
 * 【为什么不写死】E44/E93 时代闭包改写的目标是 libnode.so.127；换 26.x 运行时后
 * 它变成 libnode.so.137——写死会让"把 libnode 拉进依赖闭包"改写到一个**不存在**
 * 的名字上，设备上表现为 dlopen 直接失败（cannot open shared object）。
 * 与 entry/src/main/cpp/CMakeLists.txt:108 的候选探测同一套做法。
 */
const LIBS_DIR = join(ROOT, 'entry', 'libs', ABI);
const LIBNODE_NAME = (() => {
  if (!existsSync(LIBS_DIR)) return '';
  const candidates = readdirSync(LIBS_DIR).filter((n) => /^libnode\.so(\.|$)/.test(n)).sort();
  return candidates.length > 0 ? candidates[candidates.length - 1] : '';
})();

function die(message) {
  console.error(`collect-libvips: ${message}`);
  process.exit(1);
}

/** 用 patch 工具读一个 ELF 的 SONAME/NEEDED/RPATH（ELF 解析只此一处）。 */
function elfInfo(path) {
  const raw = execFileSync(process.execPath, [PATCH_TOOL, path, '-', '-', '--list'], { encoding: 'utf8' });
  return JSON.parse(raw);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

if (!existsSync(SRC)) die(`libvips 源目录不存在：${SRC}（先跑 tools/pack-core.mjs 物化核心树？）`);
if (!existsSync(PATCH_TOOL)) die(`缺少 ${PATCH_TOOL}`);
mkdirSync(DEST, { recursive: true });

/*
 * 播种 sharp 原生件（全新克隆时 `entry/libs` 是空的）。
 *
 * `entry/libs/` 在 .gitignore 里（体积与签名考虑），所以这些库必须**能从核心树重建**。
 * sharp 的 `.node` 由我们的原生重定向按 `lib<stem>.so` 规则加载（见 hostcore/app/main.js），
 * 所以这里按那个约定落位；已存在时不覆盖（避免把手工调过的版本冲掉）。
 */
const SHARP_NODE_SRC = join(ROOT, 'dist', 'core', 'work', STAGE_NAME, 'node_modules',
  '@ohos-ports', 'img-sharp-openharmony-arm64', 'lib', 'sharp-openharmony-arm64.node');
const SHARP_DEST = join(DEST, 'libsharp-openharmony-arm64.so');
if (!existsSync(SHARP_NODE_SRC)) {
  die(`缺少 sharp 原生件源：${SHARP_NODE_SRC}（先跑 tools/pack-core.mjs）`);
}
// 无条件覆盖播种（不做 existsSync 幂等）：核心树版本升级后源会变，残留旧件必须刷新。
copyFileSync(SHARP_NODE_SRC, SHARP_DEST);
console.log(`collect-libvips: 播种 ${SHARP_DEST}`);

/*
 * 播种 node-pty 原生件（同一个"沙箱 .node 不可 dlopen"的坑，E39）。
 * pty.node 是 Node-API addon 但 DT_NEEDED 只有 libc++_shared.so + libc.so —— napi
 * 符号不在它的解析闭包里（E44 的同一课）。所以除了改名，还要把
 * `libc++_shared.so` 原地改写成实际的 libnode soname（更短 ⇒ 零结构风险；
 * libc++ 由 libnode 传递依赖带回闭包）。
 * SONAME 同步改成文件名：改名后若依赖方（或加载器）按新名字对 SONAME 会打不开
 * （E40 三件套）。真加载由入口脚本的原生重定向按 `lib<stem>.so` 接管。
 * spawn-helper（node-pty 的 fork 辅助可执行文件）**不进 HAP**：HAP libs 只收 .so，
 * 且鸿蒙对应用创建进程有平台级限制（E15）——pty.node 能 dlopen 只解锁插件挂载，
 * 终端会话能否真正建立属功能层验证，另行处理。
 */
const PTY_SRC = join(ROOT, 'dist', 'core', 'work', STAGE_NAME, 'node_modules',
  'node-pty', 'prebuilds', 'openharmony-arm64', 'pty.node');
const PTY_DEST = join(DEST, 'libpty.so');
{
  if (!existsSync(PTY_SRC)) {
    die(`缺少 pty.node 源：${PTY_SRC}（先跑 tools/pack-core.mjs）`);
  }
  if (LIBNODE_NAME.length === 0) {
    die(`entry/libs/${ABI} 里没有 libnode.so*——闭包改写（E44）没有目标，拒绝产出必挂的 libpty.so`);
  }
  // 无条件重做（不做 existsSync 幂等）：上次运行若在 copy 之后、patch 之前中断，
  // 残留的 libpty.so 会让幂等守卫整段跳过，NEEDED 改写就永远落不上（真机实测：
  // Error relocating libpty.so: napi_fatal_error: symbol not found）。
  copyFileSync(PTY_SRC, PTY_DEST);
  try {
    /*
     * SONAME 刻意**不改**：原值 `pty.node`（8 字节）比目标 `libpty.so`（9 字节）短，
     * 原地改写放不下；而 pty 是 dlopen 的**叶子库**（没有任何 DT_NEEDED 指向它），
     * SONAME 只在"依赖方按名字引用"时才必须与文件名一致（E40 三件套针对的是被依赖方）。
     * 同形态先例：libsharp-openharmony-arm64.so 的 SONAME 至今仍是
     * `sharp-openharmony-arm64.node`，E93 真机加载通过。
     */
    execFileSync(process.execPath, [PATCH_TOOL, PTY_DEST, 'libc++_shared.so', LIBNODE_NAME],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    die(`改写 libpty.so 失败：${String(e.stderr ?? e.message)}`);
  }
  console.log(`collect-libvips: 播种 ${PTY_DEST}（SONAME 保留 pty.node——dlopen 叶子库无需改名；闭包带入 ${LIBNODE_NAME}）`);
}

/** 扁平名：SONAME 截到 `.so` 为止（`libglib-2.0.so.0` → `libglib-2.0.so`）。 */
function flatNameOf(soname) {
  const at = soname.indexOf('.so');
  if (at < 0) return soname;
  return `${soname.slice(0, at)}.so`;
}

// ── 1. 读全量事实 ───────────────────────────────────────────────────────────
const sources = [];
const noSoname = [];
for (const name of readdirSync(SRC)) {
  const full = join(SRC, name);
  if (!statSync(full).isFile() || !/\.so(\.|$)/.test(name)) continue;
  const info = elfInfo(full);
  let soname = typeof info.soname === 'string' ? info.soname : '';
  let flat;
  if (soname.length === 0) {
    /*
     * 没有 SONAME 的库是真实存在的（实测 `libsharpyuv.so`）。它**不能**被别人按 SONAME
     * 引用；文件名本身就是扁平形态，直接按文件名收即可。若真有依赖，对方的 DT_NEEDED
     * 写的也是这个文件名，仍然命中。这里如实记下来，而不是"补一个猜出来的 SONAME"。
     */
    if (!name.endsWith('.so')) {
      die(`${name} 既没有 SONAME，文件名也不是扁平 *.so，无法安全收进 HAP`);
    }
    flat = name;
    soname = name;
    noSoname.push(name);
  } else {
    flat = flatNameOf(soname);
  }
  sources.push({ file: name, path: full, soname, flat, needed: info.needed, hadSoname: soname !== name || name.endsWith('.so') ? true : false });
}
if (sources.length === 0) die('源目录里没有可收集的 .so 文件');

const oldToNew = new Map();
for (const s of sources) {
  if (oldToNew.has(s.soname) && oldToNew.get(s.soname) !== s.flat) {
    die(`SONAME ${s.soname} 映射到两个不同新名（${oldToNew.get(s.soname)} / ${s.flat}）`);
  }
  oldToNew.set(s.soname, s.flat);
}
for (const [oldName, newName] of oldToNew) {
  if (newName.length > oldName.length) {
    die(`新名比旧 SONAME 长，无法原地改写：${oldName} → ${newName}`);
  }
}

// ── 2. 拷贝 + 改 SONAME ────────────────────────────────────────────────────
const collected = [];
for (const s of sources) {
  const dest = join(DEST, s.flat);
  copyFileSync(s.path, dest);
  if (s.soname !== s.file || !s.file.endsWith('.so')) {
    // 只有"改过名"的库才需要同步 SONAME；本来就扁平的库不必动它。
    try {
      execFileSync(process.execPath, [PATCH_TOOL, dest, s.soname, s.flat, '--set-soname'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      die(`改 SONAME 失败：${s.flat}：${String(e.stderr ?? e.message)}`);
    }
  }
  collected.push({ ...s, dest });
}

// ── 3. 改所有依赖方的 DT_NEEDED + RPATH ───────────────────────────────────
const consumers = [...collected.map((c) => c.dest)];
for (const extra of EXTRA_CONSUMERS) {
  const p = join(DEST, extra);
  if (existsSync(p)) consumers.push(p);
}

let neededRewrites = 0;
let rpathRewrites = 0;
for (const consumer of consumers) {
  let info = elfInfo(consumer);
  for (const needed of info.needed) {
    const flat = oldToNew.get(needed);
    if (flat === undefined || flat === needed) continue;
    try {
      const out = execFileSync(process.execPath, [PATCH_TOOL, consumer, needed, flat],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (out.includes('→')) neededRewrites += 1;
    } catch (e) {
      die(`改 DT_NEEDED 失败：${consumer} ${needed} → ${flat}：${String(e.stderr ?? e.message)}`);
    }
  }
  info = elfInfo(consumer);
  const rpath = info.rpath ?? info.runpath;
  if (typeof rpath === 'string' && rpath.length > 0 && rpath !== '$ORIGIN') {
    try {
      execFileSync(process.execPath, [PATCH_TOOL, consumer, '-', '$ORIGIN', '--set-rpath'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      rpathRewrites += 1;
    } catch (e) {
      die(`改 RPATH 失败：${consumer}：${String(e.stderr ?? e.message)}`);
    }
  }
}

// ── 3.5 sharp 原生件必须把 libnode 拉进自己的依赖闭包（E44 的同一课，真机实测） ──
//
// 真机读数（E93 首次上设备）：
//   W MUSL-LDSO: relocating failed: symbol not found.
//     dso=/data/storage/el1/bundle/libs/arm64/libsharp-openharmony-arm64.so
//     s=napi_open_escapable_handle_scope
// 与 koffi 当年**完全同一类**问题：dlopen 出来的对象只按「自身 + 自身依赖闭包 + 全局组」
// 解析符号，而 libnode **既不（有效地）进全局组，也不在 sharp 的闭包里** ⇒ 所有 napi 符号
// 都找不到。修法也同一套：把 `DT_NEEDED libc++_shared.so`（16 字节）原地改成实际的
// libnode soname（更短 ⇒ 零结构风险）；libc++ 不会丢——libnode 自己就
// NEEDED libc++_shared.so，会随之进入闭包。
//
// 【为什么必须写在这里而不是靠"反正是 dlopen"】这一步不做，sharp 在设备上永远加载不了，
// 而症状只有一行 MUSL-LDSO 警告 + 图片附件静默降级——正是最难查的那种。
if (LIBNODE_NAME.length === 0) {
  die(`entry/libs/${ABI} 里没有 libnode.so*——sharp 的 napi 闭包改写（E44/E93）没有目标，拒绝产出必挂的真件`);
}
for (const consumer of consumers) {
  if (!consumer.endsWith('libsharp-openharmony-arm64.so')) continue;
  const info = elfInfo(consumer);
  if (info.needed.includes(LIBNODE_NAME)) continue;
  if (!info.needed.includes('libc++_shared.so')) {
    die('sharp 原生件的 NEEDED 里既没有 libnode 也没有 libc++_shared.so，无法原地改写（需人工核对）');
  }
  try {
    execFileSync(process.execPath, [PATCH_TOOL, consumer, 'libc++_shared.so', LIBNODE_NAME],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    neededRewrites += 1;
  } catch (e) {
    die(`把 libnode 拉进 sharp 依赖闭包失败：${String(e.stderr ?? e.message)}`);
  }
}

// ── 4. 清掉工具留下的 .orig 备份（源文件从未被改动，无需回滚点） ────────────
let removedBackups = 0;
for (const name of readdirSync(DEST)) {
  if (!name.endsWith('.orig')) continue;
  rmSync(join(DEST, name), { force: true });
  removedBackups += 1;
}

// ── 5. 清单（证据：映射 + 新名 + 依赖） ─────────────────────────────────────
const manifest = {
  generatedAt: new Date().toISOString(),
  abi: ABI,
  source: SRC,
  dest: DEST,
  count: collected.length,
  bytes: collected.reduce((sum, c) => sum + statSync(c.dest).size, 0),
  neededRewrites,
  rpathRewrites,
  removedBackups,
  libs: collected.map((c) => {
    const info = elfInfo(c.dest);
    return {
      file: c.flat,
      fromFile: c.file,
      sonameNow: info.soname,
      rpathNow: info.rpath ?? info.runpath ?? '',
      needed: info.needed,
      sha256: sha256(c.dest),
    };
  }),
};
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`collect-libvips: ${collected.length} 个库 → ${DEST}`);
console.log(`  DT_NEEDED 改写 ${neededRewrites} 处，RPATH→$ORIGIN ${rpathRewrites} 处，清理备份 ${removedBackups} 个`);
console.log(`  体积 ${(manifest.bytes / 1048576).toFixed(1)} MB`);
console.log(`  清单 ${MANIFEST}`);
if (existsSync(PTY_DEST)) {
  console.log(`  另有 libpty.so（node-pty，闭包 libnode=${LIBNODE_NAME}）`);
}
if (existsSync(SHARP_DEST)) {
  console.log(`  另有 libsharp-openharmony-arm64.so（sharp 真件，闭包 libnode=${LIBNODE_NAME}）`);
}
console.log('');
console.log('下一步：node tools/check-native-closure.mjs   # 静态依赖闭包检查（必须 PASS）');
