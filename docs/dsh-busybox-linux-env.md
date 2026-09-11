# DSHM busybox Linux 环境设计（dsh bash 运行时）

> 状态：已实现（2026-08-16）。本文档记录 DSHM 如何用 busybox 为 dsh 提供 bash/Linux 命令环境，
> 以及当前架构限制（x86_64 预编译产物缺失等）。

## 1. 背景

dsh 的 bash 工具（tool-bash / tool-terminal）依赖系统级 bash 与 Linux 命令集（ls/cat/grep/sed/awk/tar…）。
鸿蒙设备没有 `/bin/bash`，也没有 GNU coreutils，因此 DSHM 采用 **busybox** 作为 Linux 命令环境：

- busybox 是单一静态/动态链接 ELF，内置 300+ applet（sh/bash/ash + coreutils），按 `argv[0]` 分发；
- 1MB 级体积，适合随 HAP 分发并在沙箱内解压；
- 为 dsh 的 `tool-bash` 提供 `bash`/`sh` 可执行文件，其余命令（ls/grep/tar…）由同一 busybox 复制出的 applet 文件提供。

## 2. 环境事实（2026-08-16 已验证）

| 项 | 值 |
|---|---|
| busybox 来源 | `Harmonybrew/ohos-busybox` release 1.37.0：`busybox-1.37.0-ohos-arm64.tar.gz` |
| 二进制 | `bin/busybox`，ELF 64-bit AArch64，动态链接 musl（interpreter `/lib/ld-musl-aarch64.so.1`），stripped，约 1020K |
| 关键 applet | 含 `bash`（busybox bash 为 ash 兼容别名）、`sh`、`ash`、`hush`，以及 ls/cat/grep/sed/awk/tar/gzip/unzip/wget/vi 等 |
| 下载脚本 | `scripts/fetch-busybox.sh`（含 ELF magic / 64 位 / AArch64 e_machine 三重校验） |
| 分发位置 | `entry/src/main/resources/rawfile/busybox/busybox`（随 HAP 打包，gitignore 不提交） |
| 沙箱解压位置 | `context.filesDir/busybox/`（DshBootstrap.ensureBusybox） |

> 注意：busybox.net 的 `busybox-armv8l` 名义上是 aarch64，实测为 **32 位 ARM (armhf)** ELF，且缺 `bash`
> applet，不可作为备源；脚本已移除该备源。

## 3. 运行链路

```
HAP 打包
  rawfile/busybox/busybox ──────────────┐
                                        ▼
DshmWebPage.boot()
  ├─ DshBootstrap.ensureDshDir()        # rawfile/dsh → filesDir/dsh（DSH 运行环境）
  └─ DshBootstrap.ensureBusybox()       # rawfile/busybox → filesDir/busybox
        ├─ 复制 busybox 二进制
        ├─ chmod 0755
        └─ 软链 applet：sh/bash/ash/ls/cat/grep/… → busybox 本体
                                        ▼
  └─ DshBootstrap.launchDsh()           # startNativeChildProcess("libdsh_host.so:Main")
        └─ libdsh_host Main()（C++）
              ├─ InjectBusyboxEnv()     # PATH/SHELL/HOME/TERM 注入（见 §4）
              └─ dlopen(libnode.so) → node（--jitless）→ dsh web server :3080
                    └─ node::Start argv：`--jitless --expose-internals -r _fetch-shim.cjs <bin> web`
                        # --jitless：沙箱 W^X 禁可执行内存，必开（见 §6.3）
                        # _fetch-shim.cjs：垫 WebAssembly 全局，规避 undici llhttp WASM 崩溃（见 §5）
                                        ▼
  └─ DshBootstrap.waitForServer()       # 就绪判定轮询 filesDir/log/node-*.log 出现 "dsh web:" 标记
                                        # （真机实测 ArkTS http 到 loopback 请求被系统网络栈吞掉，不依赖 http 探测）
                                        ▼
  └─ ArkWeb 加载 http://127.0.0.1:3080  # dsh UI，bash 工具通过 PATH 找到 busybox bash
```

## 4. 环境变量注入（libdsh_host）

`entry/src/main/cpp/dsh_host.cpp::InjectBusyboxEnv()` 在 node 启动前注入：

| 变量 | 值 | 作用 |
|---|---|---|
| `PATH` | `<filesDir>/busybox:<原PATH>` | 使 `bash`/`sh`/`ls` 等直接可调（软链分发） |
| `SHELL` | `<filesDir>/busybox/sh` | dsh 定位默认 shell |
| `HOME` | `<filesDir>/home`（mkdir 0700） | 可写家目录，供 dsh 会话/配置 |
| `TERM` | `xterm` | 多数 CLI 工具需要 TERM 才不报错 |

busybox 未解压时（首次启动失败等）静默跳过注入，不阻塞 DSH 核心功能，仅 bash 工具不可用。

## 5. 适配脚本联动

`scripts/apply-dsh-ohos-adapt.sh`：

- 沙箱链（`sandbox`/`sandbox-policy`/`fs-sandbox`/`bash-sandbox`/`pwsh-sandbox`/`permission-presets`）与 `hmr`
  继续禁用 —— 鸿蒙 AAF 权限模型天然替代 Landlock/权限预设，无需重复沙箱；
- `tool-bash` / `tool-terminal` **保留启用**（busybox 提供 bash 环境）；如需强制禁用加 `--no-bash` 参数；
- node-pty/sharp/koffi 仍为 stub（鸿蒙无 PTY、无预编译 binding）。
- `_fetch-shim.cjs`（rawfile/dsh/node_modules/@deepseek-ai/dsh/lib/）由 `-r` 预加载：在 node 内置
  undici 触碰 `WebAssembly` 前安装 Web 全局（fetch/Headers/Request/Response/FormData/WebSocket/…）
  与**永不 resolve 的 FauxWebAssembly**（compile/instantiate 等返回挂起 Promise）。顺序是命门：
  stub 必须先于任何全局安装，否则 undici 模块级 `WebAssembly` 标识符解析失败（详见
  `.agent-rules/bug-log.md` [2026-09-08] 条目）。

## 6. 已知限制

1. **x86_64 设备（2in1/PC 模拟器）暂无 busybox/libnode 预编译产物**：
   - ohos-node prebuilt 仅提供 arm64-v8a（`libnode-v26.7.0-openharmony-arm64.tar.gz`）；
   - busybox 同样只有 arm64 产物；x86_64 需自行交叉编译 busybox（musl/x86_64）并在
     `scripts/fetch-busybox.sh` 中按 abi 选择，或等待上游发布；
   - 当前 module.json5 的 deviceTypes 含 `2in1`/`car`/`tv`/`wearable`，但 arm64 真机（phone/tablet）
     是 M1 主目标；x86_64 平台运行时依赖补齐前，2in1 等设备不可完整运行。
2. **沙箱 exec 权限**：busybox 由 startNativeChildProcess fork 的 C++ 子进程内使用；
   子进程内 `dlopen` libnode.so 已验证可行；直接 `exec` busybox 二进制依赖设备沙箱策略，
   若设备禁止数据目录 ELF 执行，bash 工具需改为 C++ 侧 `system()`/`posix_spawn` 透传（后续里程碑）。
3. **`--jitless` 硬约束与 WebAssembly**：鸿蒙沙箱 W^X 禁止 app 创建可执行内存，V8 初始化
   即 Fatal，故 embedded node 必须以 `--jitless` 启动；`--jitless` 移除 `globalThis.WebAssembly`，
   node 内置 undici 首次使用即崩溃（`ReferenceError: WebAssembly is not defined`）。依赖
   `_fetch-shim.cjs`（`-r` 预加载）垫 WebAssembly 全局规避——详见 §5 与 bug-log [2026-09-08] 条目。
4. **bash 兼容性**：busybox 的 `bash` 是 ash 兼容别名，非 GNU bash 全集；dsh 工具若依赖 bash 特有
   语法（`[[ ]]`、数组、`process substitution`）可能受限，可另行启用 busybox `--install -s` 增强。
5. **首次解压耗时**：rawfile 解压为同步文件 IO，大 DSH 环境首次启动较慢（已有 READY_FLAG 缓存跳过）。

## 7. 相关文件

| 文件 | 说明 |
|---|---|
| `scripts/fetch-busybox.sh` | busybox 下载 + 校验（ELF/64 位/AArch64） |
| `entry/src/main/resources/rawfile/busybox/` | busybox 分发位置（gitignore） |
| `entry/src/main/ets/dshm/bootstrap/DshBootstrap.ets` | ensureBusybox：解压/chmod/软链；waitForServer 就绪探测（轮询 node 日志 `dsh web:` 标记） |
| `entry/src/main/ets/pages/dshm/DshmWebPage.ets` | 启动流程接线（ensureBusybox、waitForServer 调用） |
| `entry/src/main/cpp/dsh_host.cpp` | InjectBusyboxEnv：PATH/SHELL；node（--jitless）启动参数；崩溃 /proc/self/maps 打印 |
| `entry/src/main/resources/rawfile/dsh/node_modules/@deepseek-ai/dsh/lib/_fetch-shim.cjs` | `-r` 预加载：Web 全局 + FauxWebAssembly 垫片（顺序敏感，须在一切全局安装前） |
| `scripts/apply-dsh-ohos-adapt.sh` | bundle patch：tool-bash 保留启用 |
| `docs/migration-plan.md` | 总迁移方案（M1/M2/M3/M4 里程碑） |
