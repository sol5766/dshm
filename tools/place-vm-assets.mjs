#!/usr/bin/env node
/*
 * 把 handheld 档「guest 虚拟机」的资产放进 HAP 能带的两个位置。
 *
 * 【资产来源】third_party/vmhish/（手工取得的原始素材；**字节不进库、方法进库**，
 * 与 third_party/python、third_party/git 同一纪律）。出处与许可证见同目录 NOTICE.md：
 *   · libqemu-system-aarch64.so —— 由 HiSH `hish-libqemu` 配方自建的 OHOS TCI 档
 *     （`-march=armv8-a`、`CNTW=0`、strip 过；上游 QEMU 是 GPLv2）。
 *   · libslirp.so.0 —— 随同一份 QEMU 构建产出的 user-mode 网络后端。
 *   · efi-virtio.rom / kernel_aarch64 / rootfs_aarch64.qcow2 —— HiSH release
 *     `release-20260516` 里的 guest 运行件（rootfs 是 Alpine 3.22 aarch64）。
 *     rootfs 现在**不再是上游原档**：它是本仓在上游档基础上烘出来的（docs/157）——
 *     预装 bash 闭包 + 最小 init（inittab 只留 sysinit/once 两条，OpenRC 与 getty 全撤），
 *     冷启动就绪从 104.9 s（真机 TCI）压到个位数秒。上游原档留在
 *     `rootfs_aarch64.openrc-seed.qcow2`（重建种子，sha256 367962e0…c834）。
 *   · guestpkgs/*.tar.gz —— Alpine v3.22 main aarch64 的 bash + SSH 客户端闭包，由
 *     `node tools/fetch-vm-guest-pkgs.mjs` 取（**离线装**用：设备侧安装要外网
 *     且实测 30.9 s，不适合做成"首次启动请联网"）。
 *     内容仍是 Alpine v2 包，扩展名统一成 `.tar.gz`，**目录名与文件名都不含
 *     `.apk`**：应用市场审核按**路径**判"包内带 apk 相关目录/文件"，命中即判安装
 *     失败（见 docs/148 / docs/156）；guest 侧安装前会先在 guest 的 /tmp 里补一层
 *     `.apk` 名字，见 hostcore/plugins/dshm-vm-bash/lib/vm.js 的 provision()。
 *
 * 【为什么两个目标目录】判据是**加载方式**，不是习惯：
 *   · `<module>/libs/arm64-v8a/` —— 只有 HAP 安装的 libs/<abi>/ 允许 dlopen
 *     （main.js :3203-3213 的 E16/E17b 结论：resfile 与 el2 files/ 都不行）。
 *     QEMU 是 `koffi.load()` 加载的 ⇒ **必须**在这里。
 *   · `resfile/vm/` —— kernel / rootfs / 固件是**被当文件读**的（QEMU 的 `-kernel`
 *     `-L` `-drive file=`），跟 toolchain 归档同性质 ⇒ 放 resfile。
 *     注意 HAP 打包会丢掉以点开头的条目（place-toolchain.mjs 的后缀注释里记过这条），
 *     所以这里的文件名一律不以点开头。
 *
 * 【为什么逐个校验 sha256】这 5 个件加起来 ~103 MB，其中三个是**设备上唯一的一份**：
 * 抄错/截断不会在编译期暴露，只会在真机上表现成 "VM 起不来"。而"是不是同一份"这个问题
 * 只有字节级能回答 ⇒ 布置前对 source 校验 sha256（值在下面 FINGERPRINTS 里，来自上一轮
 * 的实测），布置后再复核目标。
 *
 * 用法：
 *   node tools/place-vm-assets.mjs            # 布置（默认）
 *   node tools/place-vm-assets.mjs --check    # 只校验（门禁/CI 用，不写任何文件）
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUEST_PKG_DIR, VM_ASSETS } from '../hostcore/plugins/dshm-vm-bash/lib/paths.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'third_party', 'vmhish');
const LIBS_DEST = join(ROOT, 'entry', 'libs', 'arm64-v8a');
const RESFILE_DEST = join(ROOT, 'entry', 'src', 'main', 'resources', 'resfile', 'vm');

/**
 * source 文件名 → 目标名的映射，以及每个件的实测 sha256。
 * 目标名与 `VM_ASSETS`（插件运行期清单，唯一真源）逐项对齐 —— 本表只补"源叫什么、
 * 期望的字节指纹是什么"这两件构建期才需要的信息。
 */
const SOURCE_OF = {
  'libqemu-system-aarch64.so': 'libqemu-system-aarch64.so',
  'libslirp.so.0': 'libslirp.so.0',
  'kernel_aarch64': 'kernel_aarch64',
  'rootfs_aarch64.qcow2': 'rootfs_aarch64.qcow2',
  'efi-virtio.rom': 'efi-virtio.rom',
};

const FINGERPRINTS = {
  'libqemu-system-aarch64.so': '873c05ca732257fe75fb110e17657de2c5289b6c01d47b27595db727534f2e38',
  'libslirp.so.0': 'ec3b8e892f525c6583201dc88936779779810db38b46c566e091e9d6d84d0a16',
  'kernel_aarch64': '592eb21f5938b8f90b0ff7adfed424c212c1c8d0d0793b97d7d1813ff234f9e3',
  'rootfs_aarch64.qcow2': '4646a5011c5075e5bfe96d8c2e6ca7343483e5d0f9df0528e4ac954d5a9923a4',
  'efi-virtio.rom': '26be36901db7f8181c306cc62bd74891d8646528965a78e40cceadba5dd7c8e7',
};

/** guest bash + SSH 客户端闭包（版本随 Alpine 走，名字写死是刻意的：换了就是换代）。 */
const GUEST_PKG_FILES = [
  'bash-5.2.37-r0.tar.gz',
  'dropbear-2025.88-r1.tar.gz',
  'dropbear-dbclient-2025.88-r1.tar.gz',
  'dropbear-scp-2025.88-r1.tar.gz',
  'dropbear-ssh-2025.88-r1.tar.gz',
  'readline-8.2.13-r1.tar.gz',
  'skalibs-libs-2.14.4.0-r0.tar.gz',
  'libncursesw-6.5_p20250503-r0.tar.gz',
  'ncurses-terminfo-base-6.5_p20250503-r0.tar.gz',
  'utmps-libs-0.1.3.1-r0.tar.gz',
  'zlib-1.3.2-r1.tar.gz',
];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function die(message) {
  console.error(`[place-vm-assets] ${message}`);
  process.exit(1);
}

const checkOnly = process.argv.includes('--check');
const problems = [];

// ① 先把清单本身对齐：VM_ASSETS（运行期）与 SOURCE_OF/FINGERPRINTS（构建期）必须同集。
{
  const want = VM_ASSETS.map((a) => a.name).sort();
  const have = Object.keys(SOURCE_OF).sort();
  if (want.join() !== have.join()) {
    die(`资产清单不一致：运行期清单 [${want.join('、')}] ≠ 本工具 [${have.join('、')}]`);
  }
  for (const asset of VM_ASSETS) {
    if (FINGERPRINTS[asset.name] === undefined) die(`缺 ${asset.name} 的 sha256`);
  }
}

// ② 逐个：源存在 + 大小对 + sha256 对 ⇒ 拷贝 ⇒ 目标复核。
for (const asset of VM_ASSETS) {
  const source = join(SRC, SOURCE_OF[asset.name]);
  if (!existsSync(source)) {
    problems.push(`源缺失：${source}（先备齐 third_party/vmhish/）`);
    continue;
  }
  const actualSize = statSync(source).size;
  if (actualSize !== asset.size) {
    problems.push(`源大小不符：${asset.name} ${actualSize} ≠ 登记 ${asset.size}`);
    continue;
  }
  const digest = sha256(source);
  if (digest !== FINGERPRINTS[asset.name]) {
    problems.push(`源 sha256 不符：${asset.name} ${digest}`);
    continue;
  }
  const destDir = asset.dest === 'libs' ? LIBS_DEST : RESFILE_DEST;
  const dest = join(destDir, asset.name);
  if (checkOnly) {
    if (!existsSync(dest)) {
      problems.push(`目标缺失：${dest}`);
      continue;
    }
    const destSize = statSync(dest).size;
    const destDigest = sha256(dest);
    if (destSize !== asset.size || destDigest !== FINGERPRINTS[asset.name]) {
      problems.push(`目标与源不一致：${dest}`);
      continue;
    }
    console.log(`[place-vm-assets] ok  ${asset.name}（${destSize} B）`);
    continue;
  }
  mkdirSync(destDir, { recursive: true });
  copyFileSync(source, dest);
  const copied = sha256(dest);
  if (copied !== FINGERPRINTS[asset.name]) {
    problems.push(`布置后校验失败：${dest}`);
    continue;
  }
  console.log(`[place-vm-assets] 放置 ${asset.name} → ${asset.dest}（${asset.size} B）`);
}

// ③ guest bash 闭包（离线装 bash 用；少一个就会在 guest 里退化成"只有 ash"）。
{
  const pkgSrc = join(SRC, GUEST_PKG_DIR);
  const pkgDest = join(RESFILE_DEST, GUEST_PKG_DIR);
  const listing = existsSync(pkgSrc) ? readdirSync(pkgSrc) : [];
  for (const name of GUEST_PKG_FILES) {
    if (!listing.includes(name)) problems.push(`guest 包缺失：${name}（跑 node tools/fetch-vm-guest-pkgs.mjs）`);
  }
  if (problems.length === 0 && !checkOnly) {
    mkdirSync(pkgDest, { recursive: true });
    for (const name of GUEST_PKG_FILES) {
      copyFileSync(join(pkgSrc, name), join(pkgDest, name));
    }
    console.log(`[place-vm-assets] 放置 guest bash/SSH 闭包 ${GUEST_PKG_FILES.length} 个包（.tar.gz）→ resfile/vm/${GUEST_PKG_DIR}/`);
  }
}

// ④ 署名与许可证随包（GPLv2 的"随分发提供许可证文本"这一步）。
//
// 【为什么源在插件目录、而不是 third_party/】`third_party/` 整目录 gitignore（"字节不
// 入库"），而**出处与许可证说明是文档、必须可评审**。放插件包里正合适：它随核心树分发，
// 与它署名的那些字节同处一处；`.gitignore` 不会碰到它。
{
  const pluginDir = join(ROOT, 'hostcore', 'plugins', 'dshm-vm-bash');
  const attribution = [
    ['NOTICE.md', 'NOTICE.md'],
    ['licenses/GPL-2.0.txt', 'LICENSE.GPL-2.0.txt'],
    ['licenses/HiSH-MIT.txt', 'LICENSE.HiSH-MIT.txt'],
  ];
  let missing = 0;
  for (const [from] of attribution) {
    if (!existsSync(join(pluginDir, from))) {
      problems.push(`缺 ${join(pluginDir, from)}（出处与许可证说明，必须随包）`);
      missing += 1;
    }
  }
  if (missing === 0) {
    if (!checkOnly) {
      mkdirSync(RESFILE_DEST, { recursive: true });
      for (const [from, to] of attribution) copyFileSync(join(pluginDir, from), join(RESFILE_DEST, to));
      console.log(`[place-vm-assets] 放置署名与许可证 ${attribution.length} 件 → resfile/vm/`);
    } else {
      for (const [, to] of attribution) {
        if (!existsSync(join(RESFILE_DEST, to))) problems.push(`目标缺失：${join(RESFILE_DEST, to)}`);
      }
    }
  }
}

if (problems.length > 0) {
  die(`${problems.length} 项未通过：\n  - ${problems.join('\n  - ')}`);
}
console.log(`[place-vm-assets] ${checkOnly ? '校验通过（未写文件）' : '布置完成'}：${VM_ASSETS.length} 个运行件 + ${GUEST_PKG_FILES.length} 个 guest 包`);
