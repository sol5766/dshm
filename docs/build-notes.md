# DSHM 构建说明

本文档描述公开仓库的通用构建流程，不记录具体用户路径、设备标识、签名材料或凭据。

## 环境前置

- 安装与 `build-profile.json5` 中 `targetSdkVersion` 兼容的 DevEco Studio/HarmonyOS SDK。
- 安装项目声明的 Node.js、npm 和 Hvigor 依赖。
- 将 `DEVECO_SDK_HOME` 设置为当前机器的 SDK 根目录。
- 需要设备测试时，将 `hdc` 加入 `PATH`，或设置 `DSHM_HDC` 为 `hdc` 可执行文件路径。

## 构建命令

```bash
export DEVECO_SDK_HOME=<harmonyos-sdk-root>
npm ci
# 使用 DevEco Studio 配套的 hvigor.js
node <devtools-hvigor-root>/bin/hvigor.js assembleHap --no-daemon
```

Windows PowerShell 可使用：

```powershell
$env:DEVECO_SDK_HOME = '<harmonyos-sdk-root>'
node '<devtools-hvigor-root>/bin/hvigor.js' assembleHap --no-daemon
```

> **Windows Git Bash 注意**：`build_hap.cmd`（本机便捷脚本，封装 hvigorw.js）不能直接
> `cmd /c build_hap.cmd` 或 `./build_hap.cmd` 调用——Git Bash 下会静默失败（exit 0 但
> 无产物）。正确方式是管道：`cat build_hap.cmd | cmd /c`。判断构建是否真的成功看
> `entry/build/default/outputs/default/entry-default-signed.hap` 的时间戳或构建日志尾部
> `BUILD SUCCESSFUL`，不要只看命令退出码。

签名配置只在本地 DevEco Studio 或本机安全存储中提供，证书、私钥和密码禁止提交到仓库。

## DSH 运行环境准备

- `scripts/prepare-dsh-env.sh`：npm 安装 `@deepseek-ai/dsh@0.1.2-rc.1` 与 `dshmarket@1.13.1` → rawfile/dsh（gitignore）
- `scripts/_fetch-shim.cjs`：`--jitless` 下的 fetch/WebAssembly 垫片模板，`prepare-dsh-env.sh` 在环境重建后自动注入（该文件非 npm 分发件，勿删除）
- `scripts/fetch-libnode.sh`：下载 libnode.so → entry/libs/arm64-v8a/
- `scripts/fetch-busybox.sh`：下载 busybox → rawfile/busybox/
- `scripts/apply-dsh-ohos-adapt.sh`：对 DSH 环境应用 OpenHarmony 适配（含 sandbox-policy `mode`/`approval` 权限补丁，见 bug-log）

## libnode native 加固（必须执行）

`fetch-libnode.sh` 下载的 libnode.so 不能直接使用，需两步加固，**每次重新下载后都要重新执行**：

1. **DT_NEEDED 链接**：`entry/src/main/cpp/CMakeLists.txt` 将 `libs/arm64-v8a/libnode.so`
   显式链入 `dsh_host` 的 `DT_NEEDED`，让 ld.so 在进程启动时装载并完成 thread_local 初始化
   （纯 dlopen 路径会触发 V8 `AllowHeapAllocationInRelease` TLS 断言失败）；运行时仍由
   `dlopen` 取同一份 `node::Start` 符号。
2. **io_uring 补丁**：`bash scripts/patch-libnode-io-uring.sh`
   - 背景：鸿蒙沙箱 seccomp 禁止 `io_uring_setup`（aarch64 syscall 425），触发即 SIGSYS；
     本预编译 libnode 的 `uv__iou_init` 绕过 `UV_USE_IO_URING` 环境变量检查、无条件执行该
     syscall，setenv 无效（已实测）。
   - 修复：把 `uv__iou_init` 里的 `bl syscall@plt` 指令替换为 `mov w0,#-1`（`movn w0,#0`
     = `0x12800000`），io_uring_setup 返回 -1，libuv 走失败路径回退 epoll。
   - 脚本幂等（已 patch 则跳过）且带校验；脚本默认 patch 主入口偏移 `0x44e15d8`
  （`bl syscall@plt` 出现在多个调用点，当前脚本处理一处足以来让 io_uring_setup
  返回 -1），若 `libnode.so` 版本变化导致偏移失配会报错并提示，需按头注释更新偏移。
