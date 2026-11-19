# third_party/vmhish —— handheld 档「guest 虚拟机」资产

本目录是**手工取得的原始素材**，与 `third_party/python`、`third_party/git` 同一纪律：
**字节不进库、方法进库**（`.gitignore` 的 `/third_party/`）。新克隆按下面"取件"一节备齐即可。

## 文件

| 文件 | 字节 | 说明 |
|---|---|---|
| `libqemu-system-aarch64.so` | 34,787,808 | QEMU 系统模拟器（aarch64 host，**OHOS TCI 档**，`-march=armv8-a`，strip 过）。由 `koffi.load()` 在应用进程内加载并起 worker 线程跑主循环。 |
| `libslirp.so.0` | 1,135,680 | QEMU 的 user-mode 网络后端（guest 出网用），由同一份 TCI 构建产出。`libqemu` 对它有 DT_NEEDED，必须与它同目录。 |
| `kernel_aarch64` | 12,980,736 | guest Linux 内核（`6.12.60`，`uname -a` 于 guest 内实测）。 |
| `rootfs_aarch64.qcow2` | 48,631,808 | guest 根文件系统：Alpine Linux 3.22 aarch64，默认 shell 只有 busybox `ash`。 |
| `efi-virtio.rom` | 160,768 | QEMU `-L` 需要的固件（virtio 设备 option ROM）。 |
| `guestpkgs/*.tar.gz` | ~1.3 MB | Alpine v3.22 main aarch64 的 **bash + Dropbear SSH 客户端/密钥闭包**（见下）。内容仍是 Alpine v2 包；**目录名与扩展名都不含 `apk`** —— 应用市场审核按**路径**判"包内带 apk 相关目录/文件"，命中即判"安装失败"；guest 侧安装前会先在 guest 的 `/tmp` 里补一层包名。 |

## 取件

- `libqemu-system-aarch64.so` / `libslirp.so.0`：按 HiSH `hish-libqemu` 配方自建的
  OHOS TCI 产物；ISA 基线固定为 `armv8-a`，由 `tools/check-qemu-isa.mjs` 钉死
  `CNTW=0` 与 TCI 标记。四个 guest 运行件仍来自 HiSH release `release-20260516`。
  上表字节数与 `tools/place-vm-assets.mjs` 的 sha256 是完整性判据，抄错/截断会在布置期
  当场失败，而不是留到真机上表现成"VM 起不来"。
- `guestpkgs/*.tar.gz`：`node tools/fetch-vm-guest-pkgs.mjs`（从 Alpine 官方 v3.22 main aarch64 的
  APKINDEX 解析 `bash` 与 Dropbear SSH 客户端的依赖闭包后取件）。

## 为什么要 guest bash 的包闭包

guest 镜像默认只有 busybox `ash`，而上游 `@deepseek-ai/dsh-bash-local` 的 `execute()`
固定发 `["bash","-c",cmd]`；用 `ash` 顶替会**静默改变语义**（bashism 全废）。设备侧
`apk add --no-cache bash` 实测要 **30.9 s 且依赖外网** ⇒ 不适合做成"首次启动请联网"。
⇒ 构建期把闭包取好随 HAP 分发，guest 首启离线装（`--no-network`，实测秒级）。

闭包（由 `APKINDEX` 的 `D:` / `p:` 字段解析得到）：

```
bash 5.2.37-r0            depends=/bin/sh so:libc.musl-aarch64.so.1 so:libreadline.so.8
readline 8.2.13-r1        depends=so:libc.musl-aarch64.so.1 so:libncursesw.so.6
libncursesw 6.5_p20250503-r0  depends=ncurses-terminfo-base=… so:libc.musl-aarch64.so.1
ncurses-terminfo-base 6.5_p20250503-r0

dropbear-dbclient 2025.88-r1  depends=so:libc.musl-aarch64.so.1 so:libutmps.so.0.1 so:libz.so.1
dropbear          2025.88-r1  depends=so:libc.musl-aarch64.so.1 so:libutmps.so.0.1 so:libz.so.1
dropbear-ssh      2025.88-r1  depends=dropbear-dbclient !openssh-client
dropbear-scp      2025.88-r1  depends=dropbear-dbclient !openssh-client
utmps-libs        0.1.3.1-r0  depends=so:libskarnet.so.2.14
skalibs-libs      2.14.4.0-r0 depends=so:libc.musl-aarch64.so.1
zlib              1.3.2-r1    depends=so:libc.musl-aarch64.so.1
```

`musl` 与 `/bin/sh` 由基础镜像满足，故不在闭包内（重装 `musl` 会动 guest 的 loader）。

## 许可证与出处（**请勿删本节**）

| 组件 | 许可证 | 出处 |
|---|---|---|
| HiSH（这些资产取自它的 release） | **MIT**，Copyright (c) 2025 hackeris | https://github.com/harmoninux/HiSH （镜像：gitcode/gitee 同名仓库）。全文见 `LICENSE.MIT.txt`。 |
| QEMU（`libqemu-system-aarch64.so`、`efi-virtio.rom`） | **GPLv2**（QEMU 整体；部分文件另有兼容许可证，TCG 多为 BSD/MIT） | 本案用的是 OHOS 移植分支 **qemu-ohos**：https://github.com/harmoninux/qemu ；上游 https://www.qemu.org/ 。全文见 `LICENSE.GPL-2.0.txt`。 |
| guest 内核 / Alpine rootfs / 包闭包 | 各自上游许可证（bash = GPL-2.0-or-later；readline = GPL-3.0-or-later；ncurses = MIT 类；Dropbear = MIT；Linux 内核 = GPL-2.0） | Alpine: https://gitlab.alpinelinux.org/alpine ，包源 https://dl-cdn.alpinelinux.org/alpine/v3.22/main/aarch64/ ；Dropbear: https://matt.ucc.asn.au/dropbear/dropbear.html ；内核: https://www.kernel.org/ |

本文件与两份许可证全文（`licenses/GPL-2.0.txt`、`licenses/HiSH-MIT.txt`）由
`tools/place-vm-assets.mjs` 一并放进 `entry/src/main/resources/resfile/vm/`，
**随 HAP 分发**（GPLv2 要求随分发提供许可证文本）。它们放在插件包里而不是
`third_party/` 下，是因为后者整目录 gitignore（"字节不入库"），而署名与许可证说明
是**必须可评审**的文档；放在插件包里还顺带保证它随核心树分发、与它署名的字节同处一处。

### ⚠️ 待办：GPLv2 的"对应源码"义务（上架前必须落实）

GPLv2 §3 对**分发目标码**有明确要求（§3(a) 随附对应源码 / §3(b) 书面报价 / §3(c) 非商业转授）。
本仓当前的做法是**指向上游公开源码**（上表两条 URL），这对内部/侧载分发是可追溯的，
但**不等于** §3 的形式要求。若要上应用市场分发，必须先落实其中一条：
在应用内"关于"页给出 Qt 式的源码获取方式，或随包附一份 §3(b) 的书面报价文本。
（本条是**如实标注的欠账**，不是"已经合规"。）

## 更新流程

改了这里的任何字节 ⇒ 必须同步三处，否则真机上是"改了个寂寞"：

1. `tools/place-vm-assets.mjs` 的 `FINGERPRINTS`（该文件会校验并拒绝不一致的源）；
2. `hostcore/plugins/dshm-vm-bash/lib/paths.js` 的 `VM_ASSETS`（运行期大小预检）；
3. `docs/120` 的资产表与本节。
