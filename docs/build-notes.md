# DSHM 构建与环境说明

记录本仓库的构建环境、命令和踩坑点，供成员/Agent 快速复现。

## 版本基线

- `hvigor/hvigor-config.json5` 与根 `oh-package.json5` 的 `modelVersion`：`6.1.0`
- 本机 hvigor：`6.23.15-next`（仅支持 `6.1.0`）
- 目标 API：`HarmonyOS NEXT`；README 待办为升级 `compatibleSdkVersion → 7.0.0(26)`
- native 编译器：`Original`（`build-profile.json5` 中 `nativeCompiler`）

> 变动 `modelVersion` 前先确认本机 DevEco / hvigor 支持范围，否则同步失败。

## SDK / 工具链

- IDE 沙箱对系统目录可能 `EACCES`，改用 brew 安装的 node + `DEVECO_SDK_HOME` 指向 brew 的 OHOS SDK 镜像。
- npm registry 直连 SSL 不稳定（`ERR_SSL_DECRYPTION_FAILED` / 断流），用
  `npm_config_registry=https://registry.npmmirror.com`。
- GitHub release 下载不稳定，用 `https://ghfast.top/https://github.com/...` 镜像；
  git 可注入 `url.<mirror>.insteadOf`，不污染全局配置。

## 出包命令

```sh
/data/app/node.org/node_22.7.0/bin/node /data/app/hvigor.org/hvigor_1.0.0/bin/hvigorw.js \
  --mode module -p product=default -p buildMode=debug assembleHap --no-daemon
```

## 签名

- 使用 DevEco 自动签名（Project Structure → Signing Configs），26.0.0 以下非企业受限权限支持自动签名授权。
- 第三方自签（`hap-sign-tool`）无法授权 ACL 权限，带受限权限的 HAP 装不上。
- 签名材料（`*.cer` / `*.p12` / `*.p7b`）不提交仓库，仅本机。

## 运行时产物（不提交 git）

以下目录由脚本生成或下载，默认 `gitignore`，需手动运行后再构建 HAP：

- `entry/src/main/resources/rawfile/busybox/` → `scripts/fetch-busybox.sh`
- `entry/src/main/resources/rawfile/pnpm/` → `scripts/fetch-pnpm.sh`
- `entry/src/main/resources/rawfile/dsh/` → `scripts/prepare-dsh-env.sh`
- `libnode.so`（若启用内置运行时）→ `scripts/build-libnode.sh`

## 已知坑

- OHOS SDK clang 15 不编译 OpenSSL `crypto/aarch64cpuid.S` → 补 stub；zlib `zlib_arm_crc32` 需在 openharmony 目标禁用。
- 应用沙箱 W^X：node 需 `--jitless`；node 22 内置 undici 的 llhttp（WASM）会崩，node 24+ 修复。
- `CUSTOM_SANDBOX` 等 `system_basic` 权限为 `system_grant`，安装时由签名 ACL 授予，运行时只需 `checkAccessTokenSync` 记录状态。
