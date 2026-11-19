#!/usr/bin/env node
/**
 * 生成「关于」页要展示的开源组件声明与版权信息。
 *
 * ── 为什么要有这个工具（合规口径）────────────────────────────────────────────
 * 上架规范要求：**列出应用中所有使用的第三方开源库的名称与许可证类型**，
 * 并对 GPL 系列给出源码获取地址或版权所有者信息。手抄这份清单必然漂移
 * （上一次 LICENSES.txt 里的"Bundled third-party components"整段是模糊描述，
 * 既没列名字也没列许可证，甚至把 PC 工程已移除的 VM 组件写成"相关组件"）。
 * 所以清单**从实际随包内容生成**，并带**完整性强校验**：
 *
 *   ① 核心树 npm 依赖 —— 遍历 `dist/core/work/dsh-core-<ver>/node_modules` 的**包根**；
 *   ② ohpm 第三方 HAR —— **`OHPM_COMPONENTS` 现已为空**（sherpa_onnx 已移除，语音走系统 CoreSpeechKit）；
 *      输出中的 ohpm 小节保留为空段以兼容既有声明格式；
 *   ③ 随包运行时/工具/VM 件 —— 逐条**验存在**才登记（不存在即自动不出现，例如工程
 *      真的移除了 VM 时，QEMU 那几条会自己消失，而不是像旧文本那样继续宣称有）；
 *   ④ 随包原生库 —— `hostruntime/libs/arm64-v8a/*` 里**每一个**第三方 `.so` 都必须
 *      在 `NATIVE_LIBS` 里有归属；**有任何一个没登记就判失败**（fail-closed），
 *      避免"新加了个库、声明没跟上"这种最典型的合规事故。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────────
 *   node tools/gen-oss-notices.mjs            # 生成/刷新 rawfile/licenses/OSS-NOTICES.{json,txt}
 *   node tools/gen-oss-notices.mjs --check    # 只校验"已生成的文件是否与当前随包内容一致"
 *                                             # （核心升级或加了随包件后忘了重跑 ⇒ 判红）
 *
 * 退出码：0 = 成功/一致；1 = 不一致（--check）；2 = 完整性问题（有未登记的随包件）。
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const CORE = RECIPE.coreVersion;
const TREE = join(ROOT, 'dist', 'core', 'work', `dsh-core-${CORE}`);
const NM = join(TREE, 'node_modules');
const LIBS = join(ROOT, 'hostruntime', 'libs', 'arm64-v8a');
const RESFILE_ENTRY = join(ROOT, 'entry', 'src', 'main', 'resources', 'resfile');
const RESFILE_HOST = join(ROOT, 'hostruntime', 'src', 'main', 'resources', 'resfile');
/*
 * 【必须给**每个** HAP 模块各写一份】（2026-10-31，docs/328 复核发现）
 *
 * 本工具原先硬编码只写 `entry`（`OUT_DIR` 单值）。后果有两个，都很隐蔽：
 *   ① `phone` 的 `OSS-NOTICES.json` **永远停在生成它的那一天**：实测 phone 那份仍是
 *      `+dshm.97`、且含已被剥离的 `@deepseek-ai/dshm-meeting-ai`；
 *   ② `--check` 也只校验 entry ⇒ **phone 的过期永远不会被发现**。
 * 而 phone 那份**会随 phone HAP 打进上架包** —— AGC 审核看第三方开源声明时看到的就是它。
 *
 * ⇒ 改成按模块列表生成/校验，两个模块逐份比对（含"多一份/少一份"）。
 */
const OUT_MODULES = ['entry', 'phone'];
const outDirOf = (mod) => join(ROOT, mod, 'src', 'main', 'resources', 'rawfile', 'licenses');
const outJsonOf = (mod) => join(outDirOf(mod), 'OSS-NOTICES.json');
const outTxtOf = (mod) => join(outDirOf(mod), 'OSS-NOTICES.txt');
/* 兼容旧引用：默认模块（= entry）的输出路径，日志与单模块分支继续用它 */
const OUT_DIR = outDirOf('entry');
const OUT_JSON = outJsonOf('entry');
const OUT_TXT = outTxtOf('entry');

/* ── 技术支持（改这里一处即可）───────────────────────────────────────────────
 * 项目里**没有**任何邮箱（全仓 grep `@` 只命中代码与链接），所以反馈入口用的是
 * 公开的 Issues；若后续有正式邮箱，只改 `SUPPORT.feedback` 这一行即可。
 * 文档链接用上游仓库（README 即官方说明）。
 */
const SUPPORT = {
  feedback: 'https://github.com/sol5766/dshm/issues',
  docs: 'https://github.com/sol5766/dshm',
  privacy: 'https://agreement-drcn.hispace.dbankcloud.cn/index.html?lang=zh&agreementId=2058241561019327424',
};

/* ── 自有件（不是第三方，只做说明，不进"开源组件声明"清单）────────────────── */
const SELF_LIBS = new Set([
  'libdshhost.so', 'libdshm-gitcompat.so', 'libentryprobe.so', 'libpython_runner.so', 'libsystem.so',
]);

/**
 * 随包原生库 → 上游项目与许可证。
 * 键是 `hostruntime/libs/arm64-v8a/` 下的文件名；**没登记的任何第三方库都会判失败**。
 * 说明：其中一大部分（X11 / glib / cairo / pango / 图像编解码）来自
 * `@ohos-ports/img-sharp-libvips-openharmony-arm64` 这条 npm 依赖的闭包，
 * 这里逐条列出是为了让"哪个库、什么许可证"可被逐条核对，而不是一句"及其依赖"。
 */
const NATIVE_LIBS = {
  'libX11.so': { project: 'X11 (libX11)', license: 'MIT' },
  'libXau.so': { project: 'X11 (libXau)', license: 'MIT' },
  'libXdmcp.so': { project: 'X11 (libXdmcp)', license: 'MIT' },
  'libXext.so': { project: 'X11 (libXext)', license: 'MIT' },
  'libXrender.so': { project: 'X11 (libXrender)', license: 'MIT' },
  'libxcb.so': { project: 'XCB', license: 'MIT' },
  'libxcb-render.so': { project: 'XCB (render)', license: 'MIT' },
  'libxcb-shm.so': { project: 'XCB (shm)', license: 'MIT' },
  'libblkid.so': { project: 'util-linux (libblkid)', license: 'LGPL-2.1-or-later' },
  'libmount.so': { project: 'util-linux (libmount)', license: 'LGPL-2.1-or-later' },
  'libbz2.so': { project: 'bzip2', license: 'bzip2-1.0.6' },
  'libc++_shared.so': { project: 'LLVM libc++', license: 'Apache-2.0 WITH LLVM-exception' },
  'libcairo.so': { project: 'cairo', license: 'LGPL-2.1-or-later OR MPL-1.1' },
  'libexpat.so': { project: 'Expat', license: 'MIT' },
  'libffi.so': { project: 'libffi', license: 'MIT' },
  'libfontconfig.so': { project: 'fontconfig', license: 'MIT 风格（fontconfig 许可）', note: '以随包 LICENSE 为准' },
  'libfreetype.so': { project: 'FreeType', license: 'FTL OR GPL-2.0-or-later' },
  'libfribidi.so': { project: 'GNU FriBidi', license: 'LGPL-2.1-or-later' },
  'libgdk_pixbuf-2.0.so': { project: 'gdk-pixbuf', license: 'LGPL-2.1-or-later' },
  'libgio-2.0.so': { project: 'GLib (GIO)', license: 'LGPL-2.1-or-later' },
  'libglib-2.0.so': { project: 'GLib', license: 'LGPL-2.1-or-later' },
  'libgmodule-2.0.so': { project: 'GLib (GModule)', license: 'LGPL-2.1-or-later' },
  'libgobject-2.0.so': { project: 'GLib (GObject)', license: 'LGPL-2.1-or-later' },
  'libgraphite2.so': { project: 'Graphite2', license: 'MIT OR LGPL-2.1-or-later' },
  'libharfbuzz.so': { project: 'HarfBuzz', license: 'MIT' },
  'libintl.so': { project: 'GNU gettext (libintl)', license: 'LGPL-2.1-or-later' },
  'libjpeg.so': { project: 'libjpeg-turbo', license: 'IJG OR BSD-3-Clause OR Zlib' },
  'libkoffi.so': { project: 'koffi（@ohos-ports 移植件）', license: 'MIT' },
  'liblcms2.so': { project: 'Little CMS 2', license: 'MIT' },
  'liblzma.so': { project: 'XZ Utils (liblzma)', license: '0BSD OR LGPL-2.1-or-later' },
  'libnode.so.137': { project: 'Node.js', license: 'MIT' },
  'libpango-1.0.so': { project: 'Pango', license: 'LGPL-2.1-or-later' },
  'libpangocairo-1.0.so': { project: 'Pango (cairo 后端)', license: 'LGPL-2.1-or-later' },
  'libpangoft2-1.0.so': { project: 'Pango (FreeType 后端)', license: 'LGPL-2.1-or-later' },
  'libpcre2-8.so': { project: 'PCRE2', license: 'BSD-3-Clause' },
  'libpixman-1.so': { project: 'Pixman', license: 'MIT' },
  'libpng16.so': { project: 'libpng', license: 'libpng-2.0' },
  'libpty.so': { project: 'node-pty（@ohos-ports 移植件）', license: 'MIT' },
  'libpython3.12.so.1.0': { project: 'CPython', license: 'PSF-2.0' },
  'libqemu-system-aarch64.so': { project: 'QEMU', license: 'GPL-2.0' },
  'librsvg-2.so': { project: 'librsvg', license: 'LGPL-2.1-or-later' },
  'libsharp-openharmony-arm64.so': { project: 'sharp（@ohos-ports 移植件）', license: 'Apache-2.0' },
  'libslirp.so.0': { project: 'libslirp', license: 'BSD-3-Clause' },
  'libtiff.so': { project: 'libtiff', license: 'libtiff（BSD 风格）' },
  'libvips.so': { project: 'libvips', license: 'LGPL-2.1-or-later' },
  'libvips-cpp.so': { project: 'libvips (C++ API)', license: 'LGPL-2.1-or-later' },
  'libxml2.so': { project: 'libxml2', license: 'MIT' },
  'libz.so': { project: 'zlib', license: 'Zlib' },
  'libzstd.so': { project: 'Zstandard', license: 'BSD-3-Clause' },
  'libwebp.so': { project: 'libwebp', license: 'BSD-3-Clause' },
  'libwebpdemux.so': { project: 'libwebp (demux)', license: 'BSD-3-Clause' },
  'libwebpmux.so': { project: 'libwebp (mux)', license: 'BSD-3-Clause' },
  'libsharpyuv.so': { project: 'libwebp (sharpyuv)', license: 'BSD-3-Clause' },
};

/** 随包运行时 / 工具 / VM 件：`evidence` 是"它到底在不在包里"的判据，不存在即不登记。 */
const RUNTIME_COMPONENTS = [
  {
    name: 'Node.js', version: '', license: 'MIT',
    copyright: 'Copyright (c) OpenJS Foundation and Node.js contributors',
    source: 'https://github.com/nodejs/node',
    evidence: [join(RESFILE_HOST, 'toolchain', 'node')],
  },
  {
    name: 'CPython', version: '3.12', license: 'PSF-2.0',
    copyright: 'Copyright (c) Python Software Foundation',
    source: 'https://www.python.org/',
    evidence: [join(RESFILE_HOST, 'toolchain', 'python')],
  },
  {
    name: 'Git', version: '', license: 'GPL-2.0',
    copyright: 'Copyright (c) Junio C Hamano and the Git contributors',
    source: 'https://git-scm.com/',
    note: 'GPL 系列：随包仅提供可执行件，源码获取见上游地址',
    evidence: [join(RESFILE_HOST, 'toolchain', 'git')],
  },
  {
    name: 'FFmpeg', version: '9.0.1', license: 'GPL-2.0-or-later（构建含 GPL 组件；随包另附 LGPL-2.1-or-later 文本）',
    copyright: 'Copyright (c) FFmpeg developers',
    source: 'https://ffmpeg.org/download.html',
    note: 'GPL/LGPL 系列：随包内附 COPYING.GPLv2 / COPYING.GPLv3 / COPYING.LGPLv2.1 / COPYING.LGPLv3 全文',
    evidence: [join(RESFILE_ENTRY, 'toolchain', 'ffmpeg')],
  },
  {
    name: 'BusyBox', version: '', license: 'GPL-2.0',
    copyright: 'Copyright (c) Erik Andersen, Rob Landley, Denys Vlasenko and others',
    source: 'https://busybox.net/',
    note: 'GPL 系列：随包仅提供可执行件，源码获取见上游地址',
    evidence: [join(RESFILE_ENTRY, 'busybox'), join(RESFILE_HOST, 'busybox')],
  },
  {
    name: 'QEMU', version: '', license: 'GPL-2.0',
    copyright: 'Copyright (c) QEMU contributors',
    source: 'https://www.qemu.org/',
    note: 'GPL 系列：随包内附 LICENSE.GPL-2.0.txt 全文；源码获取见上游地址',
    evidence: [join(LIBS, 'libqemu-system-aarch64.so'), join(RESFILE_HOST, 'vm')],
  },
  {
    name: 'HiSH 运行件（guest VM 资产与构建配方）', version: 'release-20260516',
    license: 'MIT',
    copyright: 'Copyright (c) 2025 hackeris',
    source: '随包 NOTICE：resfile/vm/NOTICE.md',
    evidence: [join(RESFILE_HOST, 'vm', 'LICENSE.HiSH-MIT.txt')],
  },
  {
    name: 'Linux kernel（guest 内核）', version: '6.12.60', license: 'GPL-2.0',
    copyright: 'Copyright (c) Linus Torvalds and the Linux kernel contributors',
    source: 'https://www.kernel.org/',
    note: 'GPL 系列：随包内附 LICENSE.GPL-2.0.txt 全文；源码获取见上游地址',
    evidence: [join(RESFILE_HOST, 'vm', 'kernel_aarch64')],
  },
  {
    name: 'Alpine Linux root filesystem', version: '3.22 (aarch64)',
    license: '集合许可（含 BusyBox GPL-2.0、musl MIT 等）',
    copyright: 'Copyright (c) Alpine Linux contributors',
    source: 'https://alpinelinux.org/',
    evidence: [join(RESFILE_HOST, 'vm', 'rootfs_aarch64.qcow2')],
  },
  {
    name: 'QEMU virtio option ROM (efi-virtio.rom)', version: '', license: 'GPL-2.0',
    copyright: 'Copyright (c) QEMU contributors',
    source: 'https://www.qemu.org/',
    evidence: [join(RESFILE_HOST, 'vm', 'efi-virtio.rom')],
  },
];

/**
 * Alpine guest 包（目录名即包名-版本-release）。
 *
 * 【2026-11-05 补齐】docs/362 P2 往 `resfile/vm/guestpkgs/` 放了 16 个新归档
 * （libcurl 闭包 + pnpm + dsh wrapper），但只补了 `check-guest-pkgs` 的资产门禁，
 * 没同步这份许可证登记表 ⇒ 生成器 fail-closed 判 exit 2，OSS 声明永远停在 `+dshm.110`。
 * 许可证取上游官方声明（Alpine v3.22 包元数据口径），归档内自带 LICENSE 的以随包件为准；
 * `dsh-guest` 是本仓自生成的 wrapper，不含第三方代码，如实标注为自有。
 */
const GUEST_PKG_LICENSES = {
  bash: { license: 'GPL-3.0-or-later', project: 'GNU Bash', source: 'https://www.gnu.org/software/bash/' },
  'brotli-libs': { license: 'MIT', project: 'Google Brotli', source: 'https://github.com/google/brotli' },
  'c-ares': { license: 'MIT', project: 'c-ares', source: 'https://c-ares.org/' },
  dropbear: { license: 'MIT', project: 'Dropbear SSH', source: 'https://matt.ucc.asn.au/dropbear/dropbear.html' },
  'dropbear-dbclient': { license: 'MIT', project: 'Dropbear SSH (dbclient)', source: 'https://matt.ucc.asn.au/dropbear/dropbear.html' },
  'dropbear-scp': { license: 'MIT', project: 'Dropbear SSH (scp)', source: 'https://matt.ucc.asn.au/dropbear/dropbear.html' },
  'dropbear-ssh': { license: 'MIT', project: 'Dropbear SSH', source: 'https://matt.ucc.asn.au/dropbear/dropbear.html' },
  'dsh-guest': { license: 'DSHM 自有（本仓生成的 wrapper，无第三方代码）', project: 'DSHM guest wrapper', source: '本仓 hostcore/dsh-guest' },
  git: { license: 'GPL-2.0-only', project: 'Git', source: 'https://git-scm.com/' },
  'github-cli': { license: 'MIT', project: 'GitHub CLI', source: 'https://github.com/cli/cli' },
  libcrypto3: { license: 'Apache-2.0', project: 'OpenSSL 3 (libcrypto)', source: 'https://www.openssl.org/' },
  libcurl: { license: 'curl（MIT 风格，以随包 LICENSE 为准）', project: 'curl / libcurl', source: 'https://curl.se/' },
  libevent: { license: 'BSD-3-Clause', project: 'libevent', source: 'https://libevent.org/' },
  libidn2: { license: 'LGPL-3.0-or-later OR GPL-2.0-or-later', project: 'GNU libidn2', source: 'https://www.gnu.org/software/libidn/' },
  libncursesw: { license: 'MIT', project: 'ncurses (wide)', source: 'https://invisible-island.net/ncurses/' },
  libpsl: { license: 'MIT', project: 'libpsl', source: 'https://github.com/rockdaboot/libpsl' },
  libssl3: { license: 'Apache-2.0', project: 'OpenSSL 3 (libssl)', source: 'https://www.openssl.org/' },
  libunistring: { license: 'LGPL-3.0-or-later OR GPL-2.0-or-later', project: 'GNU libunistring', source: 'https://www.gnu.org/software/libunistring/' },
  'ncurses-terminfo-base': { license: 'MIT', project: 'ncurses (terminfo)', source: 'https://invisible-island.net/ncurses/' },
  'nghttp2-libs': { license: 'MIT', project: 'nghttp2', source: 'https://nghttp2.org/' },
  pnpm: { license: 'MIT', project: 'pnpm', source: 'https://pnpm.io/' },
  readline: { license: 'GPL-3.0-or-later', project: 'GNU Readline', source: 'https://tiswww.case.edu/php/chet/readline/rltop.html' },
  'skalibs-libs': { license: 'ISC', project: 'skalibs', source: 'https://skarnet.org/software/skalibs/' },
  tmux: { license: 'ISC', project: 'tmux', source: 'https://github.com/tmux/tmux' },
  'utmps-libs': { license: 'ISC', project: 'utmps', source: 'https://skarnet.org/software/utmps/' },
  zlib: { license: 'Zlib', project: 'zlib', source: 'https://zlib.net/' },
  'zstd-libs': { license: 'BSD-3-Clause OR GPL-2.0-only', project: 'Zstandard', source: 'https://github.com/facebook/zstd' },
};

/** ohpm（HarmonyOS 包管理器）第三方依赖。 */
/*
 * 2026-11-06：清空。`sherpa_onnx`（离线 ASR，内含 libonnxruntime + libsherpa-onnx）
 * 已从 entry / phone 的 oh-package 里移除 —— 语音识别全部走系统 CoreSpeechKit，
 * 代码里对这两个库**零引用**，却各占 15.8 MB × 2 个 HAP。
 */
const OHPM_COMPONENTS = [];


/**
 * 若本机已出过 Beta 包，则把它里面 **实际随包** 的原生库也纳入清点。
 *
 * 【为什么两个来源都要看】`hostruntime/libs/arm64-v8a/` 是"源码侧"的原生库目录；
 * 而 HAP 里还有**构建期由 SDK 复制进去**的库（实测 `libc++_shared.so` 就是这样进去的，
 * 源码目录里没有）。只看一个来源 ⇒ 声明会漏掉真正随包的库，正是合规最怕的漏项。
 * 这里做**并集**，并集里任何一个没登记都判失败。只解析 zip 目录，不解内容（省时且无依赖）。
 */
function zipEntryNames(buf) {
  const names = [];
  for (let i = 0; i + 30 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    if (nameLen <= 0 || nameLen > 4096) continue;
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    if (name.length !== nameLen && name.length === 0) continue;
    names.push(name);
    const size = buf.readUInt32LE(i + 18);
    i = i + 30 + nameLen + extraLen + size - 1;
  }
  return names;
}

/** 从 .app 里取出 hostruntime HSP 的字节（deflate 用 zlib 解，store 直接切）。 */
function hspBufferFromApp(appFile) {
  const buf = readFileSync(appFile);
  for (let i = 0; i + 30 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    const dataStart = i + 30 + nameLen + extraLen;
    if (name === 'hostruntime-default.hsp') {
      const raw = buf.subarray(dataStart, dataStart + compSize);
      return method === 8 ? inflateRawSync(raw) : raw;
    }
    i = dataStart + compSize - 1;
  }
  return null;
}

function shippedLibsFromBuiltApp() {
  const dir = join(ROOT, 'dist', 'beta');
  if (!existsSync(dir)) return { libs: [], from: '' };
  const stamps = readdirSync(dir).filter((s) => s.startsWith('DSHM-beta-')).sort();
  for (let i = stamps.length - 1; i >= 0; i--) {
    const appDir = join(dir, stamps[i]);
    const apps = existsSync(appDir) ? readdirSync(appDir).filter((f) => f.endsWith('.app')) : [];
    if (apps.length === 0) continue;
    try {
      const hsp = hspBufferFromApp(join(appDir, apps[0]));
      if (hsp === null) continue;
      const libs = zipEntryNames(hsp).filter((n) => n.startsWith('libs/arm64-v8a/')).map((n) => basename(n));
      return { libs, from: `${stamps[i]}/${apps[0]}` };
    } catch {
      continue;
    }
  }
  return { libs: [], from: '' };
}

/* ── 采集 ─────────────────────────────────────────────────────────────────── */
function isPackageRoot(dir) {
  const segs = dir.split(sep);
  const i = segs.lastIndexOf('node_modules');
  const after = i >= 0 ? segs.slice(i + 1) : segs;
  if (after.length === 1) return true;
  return after.length === 2 && after[0].startsWith('@');
}

function licenseOf(pkg) {
  const l = pkg.license;
  if (typeof l === 'string' && l.length > 0) return l;
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((x) => (typeof x === 'string' ? x : x && x.type)).filter(Boolean);
    if (types.length > 0) return types.join(' OR ');
  }
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type;
  return '';
}

function collectNpm() {
  if (!existsSync(NM)) {
    console.error(`找不到核心树：${NM}`);
    console.error('先跑 node tools/pack-core.mjs --place-in-app（或先从 dist/core 的容器解出该树）。');
    process.exit(2);
  }
  const out = [];
  const unknown = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    if (names.has('package.json') && isPackageRoot(dir)) {
      let pkg = null;
      try {
        pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      } catch {
        pkg = null;
      }
      if (pkg && typeof pkg.name === 'string') {
        const lic = licenseOf(pkg);
        const row = {
          name: pkg.name,
          version: typeof pkg.version === 'string' ? pkg.version : '',
          license: lic,
        };
        if (lic.length === 0) unknown.push(row.name);
        else out.push(row);
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules') {
        walk(join(dir, e.name));
        continue;
      }
      // 只在包根/作用域目录下继续下探，避免把包体内部目录当成包
      if (names.has('package.json')) continue;
      walk(join(dir, e.name));
    }
  };
  walk(NM);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { components: out, unknown };
}

function collectNativeLibs() {
  if (!existsSync(LIBS)) {
    console.error(`找不到随包原生库目录：${LIBS}`);
    process.exit(2);
  }
  const shipped = shippedLibsFromBuiltApp();
  const source = readdirSync(LIBS).filter((f) => f.endsWith('.so') || f.includes('.so.'));
  const all = [...new Set([...source, ...shipped.libs])].sort();
  const third = [];
  const self = [];
  const unregistered = [];
  for (const f of all) {
    if (!f.endsWith('.so') && !f.includes('.so.')) continue;
    if (SELF_LIBS.has(f)) {
      self.push(f);
      continue;
    }
    const meta = NATIVE_LIBS[f];
    if (meta === undefined) {
      unregistered.push(f);
      continue;
    }
    third.push({ file: f, project: meta.project, license: meta.license, note: meta.note ?? '' });
  }
  return { third, self, unregistered, sourceCount: source.length, shippedFrom: shipped.from, shippedCount: shipped.libs.length };
}

function collectGuestPkgs() {
  const dir = join(RESFILE_HOST, 'vm', 'guestpkgs');
  if (!existsSync(dir)) return { rows: [], unregistered: [] };
  const rows = [];
  const unregistered = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^(.+)-(\d[^-]*(?:-[^-]*)*)\.tar\.gz$/.exec(f);
    const pkgName = m === null ? f.replace(/\.tar\.gz$/, '') : m[1];
    const meta = GUEST_PKG_LICENSES[pkgName];
    if (meta === undefined) {
      unregistered.push(f);
      continue;
    }
    rows.push({
      name: `${pkgName} (Alpine guest)`,
      version: m === null ? '' : m[2],
      license: meta.license,
      copyright: `Copyright (c) ${meta.project} contributors`,
      source: meta.source,
      evidence: [join(dir, f)],
    });
  }
  return { rows, unregistered };
}

function evidenceOk(paths) {
  for (const p of paths) {
    if (existsSync(p)) return true;
  }
  return false;
}

/* ── 组装 ─────────────────────────────────────────────────────────────────── */
function build() {
  const npm = collectNpm();
  const native = collectNativeLibs();
  const guest = collectGuestPkgs();

  const problems = [];
  if (native.unregistered.length > 0) {
    problems.push(`未登记许可证的随包原生库（${native.unregistered.length} 个）：${native.unregistered.join('、')}`);
    problems.push('修复：在 tools/gen-oss-notices.mjs 的 NATIVE_LIBS 里补上"上游项目 + 许可证"；不许默认放过。');
  }
  if (guest.unregistered.length > 0) {
    problems.push(`未登记许可证的 guest 包（${guest.unregistered.length} 个）：${guest.unregistered.join('、')}`);
  }
  for (const c of OHPM_COMPONENTS) {
    if (!evidenceOk(c.evidence)) problems.push(`ohpm 组件缺证据文件：${c.name}`);
  }
  const runtimes = RUNTIME_COMPONENTS.filter((c) => evidenceOk(c.evidence));
  const dropped = RUNTIME_COMPONENTS.filter((c) => !evidenceOk(c.evidence)).map((c) => c.name);

  const summary = new Map();
  for (const c of npm.components) {
    const key = c.license;
    summary.set(key, (summary.get(key) ?? 0) + 1);
  }

  const copyleft = [];
  const pushCopyleft = (name, license, source, note) => {
    if (/GPL|MPL|AGPL|LGPL/i.test(license)) copyleft.push({ name, license, source, note: note ?? '' });
  };
  for (const r of runtimes) pushCopyleft(r.name, r.license, r.source, r.note);
  for (const o of OHPM_COMPONENTS) pushCopyleft(o.name, o.license, o.source, '');
  for (const g of guest.rows) pushCopyleft(g.name, g.license, g.source, '');
  for (const l of native.third) pushCopyleft(l.project, l.license, '', l.note);
  for (const c of npm.components) pushCopyleft(`${c.name}@${c.version}`, c.license, '', '');

  return {
    data: {
      generatedAt: new Date().toISOString(),
      coreVersion: CORE,
      app: {
        name: 'DSHM',
        license: 'MIT License',
        copyright: 'Copyright (c) 2026 sol',
      },
      upstream: {
        name: 'DeepSeek Harness',
        version: '',
        license: 'MIT License',
        copyright: 'Copyright (c) 2026 DeepSeek',
        source: 'https://github.com/deepseek-ai/deepseek-harness',
      },
      summary: [...summary.entries()].sort((a, b) => b[1] - a[1]).map(([license, count]) => ({ license, count })),
      npm: npm.components,
      ohpm: OHPM_COMPONENTS.map((c) => ({ name: c.name, version: c.version, license: c.license, source: c.source })),
      runtimes: runtimes.map((c) => ({
        name: c.name, version: c.version, license: c.license,
        copyright: c.copyright, source: c.source, note: c.note ?? '',
      })),
      nativeLibs: native.third,
      nativeLibsSource: { dirCount: native.sourceCount, builtApp: native.shippedFrom, builtCount: native.shippedCount },
      selfLibs: native.self,
      copyleft,
      support: SUPPORT,
      droppedRuntimes: dropped,
    },
    problems,
  };
}

/* ── 文本渲染（按上架规范的示例格式）──────────────────────────────────────── */
function renderTxt(d) {
  const lines = [];
  const npmRows = d.npm.map((c) => `${c.name}${c.version ? ` ${c.version}` : ''} - ${c.license}`);
  const boundaryRows = [];
  for (const r of d.runtimes) boundaryRows.push(`${r.name}${r.version ? ` ${r.version}` : ''} - ${r.license}`);
  for (const g of d.nativeLibs) boundaryRows.push(`${g.project}（${g.file}） - ${g.license}`);
  boundaryRows.push(`Alpine guest 包（${d.copyleft.filter((c) => c.name.includes('(Alpine guest)')).length} 个，见榜单）`);
  const ohpmRows = d.ohpm.map((c) => `${c.name} ${c.version} - ${c.license}`);

  lines.push('DSHM 关于 —— 版本、开源组件声明与版权信息');
  lines.push('');
  lines.push(`核心版本：${d.coreVersion}`);
  lines.push(`生成时间：${d.generatedAt}`);
  lines.push('');
  lines.push('一、版本信息');
  lines.push('  应用：DSHM（HarmonyOS 客户端）');
  lines.push(`  上游：${d.upstream.name}（${d.upstream.license}，${d.upstream.copyright}）`);
  lines.push('');
  lines.push('二、开源组件声明');
  lines.push('');
  lines.push('  （1）随包运行时与工具');
  let i = 1;
  for (const r of boundaryRows) lines.push(`  ${i++}. ${r}`);
  lines.push('');
  lines.push('  （2）随包原生共享库');
  lines.push(`  共 ${d.nativeLibs.length} 个第三方库；DSHM 自有件（不计入第三方）：${d.selfLibs.join('、')}`);
  lines.push('');
  lines.push('  （3）HarmonyOS 侧依赖（ohpm）');
  for (const r of ohpmRows) lines.push(`  ${i++}. ${r}`);
  lines.push('');
  lines.push(`  （4）核心树 npm 依赖（共 ${npmRows.length} 个包）`);
  for (const r of npmRows) lines.push(`  ${i++}. ${r}`);
  lines.push('');
  lines.push('  以上为随包全部第三方开源组件；本应用未使用上述清单之外的第三方开源库。');
  lines.push('');
  lines.push('三、许可证分布（核心树 npm 依赖）');
  for (const s of d.summary) lines.push(`  ${s.license}：${s.count} 个`);
  lines.push('');
  lines.push('四、源码与版权信息');
  lines.push(`  DSHM 应用与鸿蒙适配：${d.app.license}，${d.app.copyright}`);
  lines.push(`  上游 DeepSeek Harness：${d.upstream.license}，${d.upstream.copyright}`);
  lines.push(`  上游源码：${d.upstream.source}`);
  lines.push('  采用 GPL / LGPL / MPL 等需要提供源码的组件，逐一列明上游获取地址：');
  const seen = new Set();
  for (const c of d.copyleft) {
    const key = `${c.name}|${c.source}`;
    if (seen.has(key) || c.source.length === 0) continue;
    seen.add(key);
    lines.push(`    - ${c.name}：${c.source}${c.note ? `（${c.note}）` : ''}`);
  }
  lines.push('');
  lines.push('五、技术支持');
  lines.push(`  问题反馈：${d.support.feedback}`);
  lines.push(`  官方文档：${d.support.docs}`);
  lines.push(`  隐私政策：${d.support.privacy}`);
  lines.push('');
  lines.push('  "DeepSeek"、"DeepSeek Harness" 及相关名称与标识归其权利人所有；');
  lines.push('  MIT 许可只授予版权权利，不授予商标、服务标记、标识、背书或官方隶属关系。');
  lines.push('  DSHM 与 DeepSeek 不存在隶属、授权、代理、背书或其他特定关系。');
  lines.push('');
  return lines.join('\n');
}

/* ── 主流程 ───────────────────────────────────────────────────────────────── */
/*
 * 【为什么包一层】本工具要读的东西里有一件是"已出包件"（`.app` 里的 HSP 目录）——
 * 那是本仓自己手写的极简 zip 解析。任何解析异常都**不许**以 uncaught dump 的形式结束
 * （现场只剩一行 Node 版本号，看不出是"读不到"还是"内容不一致"）：
 * 统一转成明确的 exit 2「无法判定」，并在报文里说明重跑方法。
 */
let built;
try {
  built = build();
} catch (err) {
  console.error('❌ 无法判定：清点随包内容时抛错（不是"声明不一致"）：');
  console.error(`   ${err && err.message ? err.message : String(err)}`);
  console.error('   修复：重跑 node tools/gen-oss-notices.mjs；若仍复现，检查 dist/beta 下最新那个 .app 是否完整。');
  process.exit(2);
}
const { data, problems } = built;

if (problems.length > 0) {
  console.error('❌ 完整性校验失败（**不许**带着漏项出包）：');
  for (const p of problems) console.error(`   · ${p}`);
  process.exit(2);
}

const json = JSON.stringify({ ...data, selfLibsNote: 'DSHM 自有原生件，不属于第三方开源组件' }, null, 2) + '\n';
const txt = renderTxt(data);

if (process.argv.includes('--check')) {
  /*
   * 【比较时必须忽略 generatedAt】它是"生成那一刻"的时间戳，重新生成必然不同 ⇒
   * 直接比文本会**永远判红**（本工具第一版就是这么错的，本轮自查抓到）。
   * 忽略它之后，--check 判的才是真问题：清单内容（组件、许可证、库集合）有没有跟包漂移。
   */
  /* 逐模块读（见 OUT_MODULES 的注释：此前只读 entry ⇒ phone 过期永远发现不了） */
  const curByMod = {};
  for (const mod of OUT_MODULES) {
    const f = outJsonOf(mod);
    curByMod[mod] = existsSync(f) ? readFileSync(f, 'utf8') : '';
  }
  const cur = curByMod.entry;
  const strip = (text) => {
    try {
      const obj = JSON.parse(text);
      obj.generatedAt = '<ignored>';
      /* `nativeLibsSource.builtApp` 记的是"从哪个出包件清点的"——每次重编都会变，
         属于**出处**而不是**内容**，同样不参与一致性判定（内容看 builtCount 与库集合）。 */
      if (obj.nativeLibsSource !== undefined && obj.nativeLibsSource !== null) {
        obj.nativeLibsSource.builtApp = '<ignored>';
      }
      return JSON.stringify(obj, null, 2);
    } catch {
      return '';
    }
  };
  const stale = OUT_MODULES.filter((mod) => curByMod[mod].length === 0 || strip(curByMod[mod]) !== strip(json));
  if (stale.length > 0) {
    console.error('❌ 声明文件与当前随包内容不一致（核心升级或更换随包件后忘了重跑）：');
    for (const mod of stale) {
      const cur0 = curByMod[mod];
      let why = '文件不存在';
      if (cur0.length > 0) {
        try {
          const got = JSON.parse(cur0);
          why = `内容是核心 ${got.coreVersion ?? '?'}、生成于 ${got.generatedAt ?? '?'}`;
        } catch {
          why = '文件不可解析';
        }
      }
      console.error(`   · ${mod}: ${why}`);
    }
    console.error('   修复：node tools/gen-oss-notices.mjs');
    process.exit(1);
  }
  console.log(`✅ 一致：${OUT_MODULES.join(' / ')} 的 ${basename(OUT_JSON)} 均与当前随包内容相符（核心 ${CORE}）`);
  process.exit(0);
}

for (const mod of OUT_MODULES) {
  mkdirSync(outDirOf(mod), { recursive: true });
  writeFileSync(outJsonOf(mod), json, 'utf8');
  writeFileSync(outTxtOf(mod), txt, 'utf8');
}
const sha = createHash('sha256').update(json).digest('hex').slice(0, 16);
console.log(`开源组件声明已生成（核心 ${CORE}）：`);
console.log(`  npm 组件      ${data.npm.length} 个（许可证种类 ${data.summary.length}）`);
console.log(`  ohpm 组件     ${data.ohpm.length} 个`);
console.log(`  随包运行时    ${data.runtimes.length} 项${data.droppedRuntimes.length > 0 ? `（未随包未登记：${data.droppedRuntimes.join('、')}）` : ''}`);
console.log(`  随包原生库    ${data.nativeLibs.length} 个第三方 + ${data.selfLibs.length} 个自有件`);
console.log(`  需给源码的    ${data.copyleft.length} 条`);
console.log(`  输出          ${OUT_MODULES.map((m) => m + '/…/' + basename(outJsonOf(m))).join('、')}（json sha256 前 16 位 ${sha}）`);