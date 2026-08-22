# PtyDiagnostic — HarmonyOS/OpenHarmony PTY 诊断工具

## 工具用途

`PtyDiagnostic` 是一个 **Stage 模型 HAP**，用于在 HarmonyOS/OpenHarmony 设备上诊断应用沙箱内的 PTY（伪终端）权限和休眠恢复问题。

**问题场景：**
* HAP 正常启动时可以创建 PTY
* 系统运行一段时间后，PTY 可能返回 `EACCES`
* 合盖休眠再唤醒后，PTY 大概率或必然返回 `EACCES`
* 一旦发生，其他第三方 HAP 中使用 PTY 的程序也可能一起失败

本工具**只负责采集证据，不尝试修复系统**。

---

## 编译方法

1. 使用 **DevEco Studio** 打开当前目录（`build-profile.json5` 所在文件夹）
2. 等待 SDK 同步完成
3. 选择目标设备（2in1 / PC 设备），点击 **Build → Build Hap(s)**

或者命令行（需要 hvigorw）：
```sh
hvigorw assembleHap
```

---

## 安装运行方法

编译成功后，通过 DevEco Studio 将 HAP 部署到 HarmonyOS PC 设备：
1. 连接设备
2. 点击 **Run** 按钮
3. 应用启动后自动打开诊断界面

---

## 测试模式

### 1. 普通 PTY 测试

点击 **「普通PTY测试」** 按钮：
* 执行完整的 Unix98 PTY 创建流程
* 逐步记录每个系统调用的返回值、errno 和耗时
* 成功时验证双向读写、termios、窗口大小
* 失败时显示精确的失败步骤和 errno
* **不会崩溃**，可重复测试

### 2. Crash 测试模式

点击 **「Crash测试」** 按钮：
* 执行完整 PTY 测试
* 成功时不崩溃，记录所有步骤
* **失败时主动触发 `abort()` 崩溃**
* 崩溃前将诊断上下文写入全局 `PtyCrashContext` 结构体
* Magic number: `0x505459444941474E`（ASCII: "PTYDIAGN"）
* 日志在崩溃前已通过 `fsync()` 强制落盘

### 3. 连续测试模式

点击 **「连续测试」** 按钮：
* 按设定间隔持续执行 PTY 测试
* 可选间隔：100ms / 500ms / 1000ms / 5000ms
* 每次测试结果通过 callback 实时更新 UI
* 成功和失败都记录
* 日志上限 5000 条
* 点击 **「停止连续」** 终止

### 4. Shell 对照测试

点击 **「Shell对照」** 按钮：
* 使用 `pipe() + fork() + execve()` 启动 `/bin/sh`
* 执行 `echo SHELL_OK; id; pwd`
* **不使用任何 PTY API**
* 用于判断 shell/ELF 执行本身是否正常
* 如果 `fork()` 或 `execve()` 被沙箱阻止，会明确记录失败步骤

---

## 如何合盖复现

1. 启动应用，点击 **「连续测试」** 并设置间隔为 1000ms
2. 观察日志 — 初始应该全部成功（`✓`）
3. 合上设备盖子（或选择系统休眠）
4. 等待 10-30 秒
5. 打开盖子唤醒设备
6. 观察日志中是否出现 `EACCES` 失败
7. 一旦出现失败，点击 **「保存报告」** 保存诊断快照

---

## 日志查看

### HiLog

```sh
# 实时查看 PTY 诊断日志
hilog -x -e 'PTY_DIAG'

# 过滤 ERROR 级别
hilog -x -e 'PTY_DIAG' | grep ERROR

# 查看 FATAL 级别（crash 前日志）
hilog -x -e 'PTY_DIAG' | grep FATAL
```

### 应用文件日志

日志保存在应用沙箱 `filesDir` 目录下：
* `pty_diagnostic_latest.log` — 最近一次测试的完整日志
* `pty_diagnostic_history.log` — 历史日志（自动轮转，上限 10MB）
* `pty_crash_context.log` — Crash 上下文（仅在 crash 模式失败时生成）
* `pty_report_<timestamp>.txt` — 诊断报告快照

获取方式：
1. 通过 DevEco Studio 的 **Device File Browser** 导出
2. 或使用 `hdc file recv` 命令

```sh
# 查找应用沙箱中的日志文件
hdc shell find /data/storage/el2/base -name "pty_diagnostic*"

# 导出日志
hdc file recv /data/storage/el2/base/haps/entry/files/pty_diagnostic_latest.log ./
```

---

## 如何识别失败步骤

每次测试都会显示步骤列表，例如：

```
✓ POSIX_OPENPT: masterFd=5
✓ GRANTPT: grantpt succeeded
✗ UNLOCKPT: unlockpt failed errno=13 (EACCES)
```

* `EACCES` (errno=13) — **权限不足**，SELinux 或沙箱策略阻止
* `ENOENT` (errno=2) — 路径不存在，例如 `/dev/ptmx` 不可访问
* `EIO` (errno=5) — I/O 错误，可能是内核 PTY 子系统异常
* `ENOSPC` (errno=28) — PTY 实例数量达到上限
* `EINVAL` (errno=22) — 参数无效，可能是 fd 已被关闭

---

## 如何在 DevEco Studio 中查看 cppcrash

当 Crash 模式触发 `abort()` 后：

1. DevEco Studio 会显示 **cppcrash** 对话框
2. 展开 **Registers**、**Call Stack**、**Memory** 面板
3. 在 Memory 面板中搜索 magic number：**`0x505459444941474E`**
4. 找到后查看 `PtyCrashContext` 结构体内容
5. 关键字段：`savedErrno`、`failedStepName`、`errnoMessage`、`slavePath`、`mountInfoSummary`、`ptmxStatSummary`

---

## 为什么 WMS 的 permission denied 与 PTY 无关

`EACCES` 可能来自：
* **SELinux 策略** — HarmonyOS 文档明确指出 `posix_openpt`/`openpty`/`forkpty` 等受 SELinux 影响
* **devpts 挂载选项** — 检查 `/proc/self/mountinfo` 中 `devpts` 的挂载选项
* **PTY 实例计数** — 检查 `/proc/sys/kernel/pty/nr`

这个 `EACCES` 与窗口管理（WMS）的 `permission denied` 是不同的层次，请不要混淆。

---

## 当前限制

* 本工具**只读取状态并调用普通应用可调用的原生 PTY API**
* 不会尝试 `chmod`、`chown`、`mount` 或修改 `/dev`
* 不会尝试规避系统沙箱
* 不会申请与测试无关的权限
* `fork()` 在 HarmonyOS HAP 沙箱中可能存在限制，Shell 对照测试会如实记录

---

## 独立 ELF 执行测试

测试 HAP 能否通过 `fork+execve` 运行独立 ELF 文件。

### 构建 hello ELF

在 HarmonyOS 构建机上运行：
```sh
bash hello/build-hello.sh
```

或在 DevEco Studio 的 Terminal 中：
```sh
cd hello && bash build-hello.sh
```

生成：
- `hello/hello-unsigned` — 未签名 ELF
- `hello/hello-signed` — 未签名副本（需通过 DevEco Studio 或 `codesign` 签名）

### 签名

方法 1：DevEco Studio → Build → Sign  
方法 2：设备上执行 `hdc shell codesign sign /path/to/hello-signed`

### 打包到 HAP

`build-hello.sh` 自动将 ELF 复制到 `entry/src/main/resources/rawfile/`。

需导入的也编译好后放到沙箱目录：
```sh
hdc file send hello-unsigned /data/storage/el2/base/haps/entry/files/imported-unsigned
hdc file send hello-signed /data/storage/el2/base/haps/entry/files/imported-signed
```

### 执行测试

点击「**ELF测试**」按钮，自动运行 4 组：

| # | 来源 | 签名状态 |
|---|------|----------|
| 1 | rawfile（HAP附带） | 已签名 |
| 2 | rawfile（HAP附带） | 未签名 |
| 3 | 导入 | 已签名 |
| 4 | 导入 | 未签名 |

每组输出：SHA-256、`.codesign` section 检测、`chmod` 结果、`execve` errno、stdout/stderr、最终结论。

## AF_UNIX 与 SO_PEERCRED 测试

界面中的 **「PeerCred」** 按钮会启动 HAP 内部的抽象 Unix Socket 服务，并由独立 ELF
客户端连接。服务端会记录：

* `SO_PEERCRED` 返回的客户端 PID、UID、GID；
* `/proc/<pid>/exe` 是否可以读取，以及解析出的真实 ELF 路径；
* 客户端是否能完成双向通信。

如果结果包含：

```text
PEER_CREDENTIALS: peer_pid=... peer_uid=... peer_gid=... peer_exe=...
CONCLUSION: AF_UNIX + SO_PEERCRED WORKS
```

说明设备内核能向 HAP 服务提供 Unix Socket 对端凭据。`peer_exe` 读取失败并不等于
`SO_PEERCRED` 失败，需根据具体 errno 判断 HAP 是否被 `/proc` 访问策略限制。

界面中的 **「FileSock」** 按钮会在可写的用户挂载路径：

```text
/storage/Users/currentUser/hapi_peercred.sock
```

创建文件型 Unix Socket。HNP 安装目录是只读的，不能作为运行时 socket 目录；该测试
用于确认 HAP 与 HNP ELF 是否都能访问这个可写挂载点。失败时会保留 `bind()` 的 errno。

该测试依赖以下目录权限：

```text
ohos.permission.READ_WRITE_USER_FILE
ohos.permission.FILE_ACCESS_PERSIST
ohos.permission.ACCESS_USER_FULL_DISK
```

独立 ELF 执行另外依赖：

```text
ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE
```

该权限允许 PC/2in1 工具类应用加载外部 native 程序，包括二进制文件和动态库。

其中全盘访问属于 system grant。demo 已在 `entry/src/main/module.json5` 中声明，并按照
PivotDock 的方式在 `EntryAbility.onForeground()` 中检查权限，未授权时调用
`openPermissionOnSetting()` 打开系统设置进行手动授权。修改权限后必须重新编译并重新安装
HAP，单纯重新打开页面不会刷新安装权限。

---

## 文件清单

| 文件 | 说明 |
|------|------|
| `entry/src/main/cpp/pty_diagnostic.h` | 数据结构与类声明 |
| `entry/src/main/cpp/napi_init.cpp` | 全部原生 PTY 测试逻辑与 NAPI 接口 |
| `entry/src/main/cpp/CMakeLists.txt` | CMake 构建配置 |
| `entry/src/main/cpp/types/libentry/Index.d.ts` | TypeScript 类型定义 |
| `entry/src/main/ets/pages/Index.ets` | ArkTS 诊断界面 |
| `entry/src/main/ets/entryability/EntryAbility.ets` | UIAbility 入口 |
| `hello/hello.c` | 最小 CLI ELF 源码 |
| `hello/build-hello.sh` | ELF 构建脚本 |
| `entry/src/main/resources/rawfile/hello-*` | HAP 附带的测试 ELF |
| `README.md` | 本文档 |
