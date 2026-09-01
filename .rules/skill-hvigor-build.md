# skill: 构建 / hvigor

适用：构建失败、同步失败、`modelVersion` / SDK / toolchain 调整、出包。

## 基线

- `modelVersion` 为 `6.1.0`；本机 hvigor `6.23.15-next` 仅支持 6.1.0，改动前确认兼容。
- `nativeCompiler` 为 `Original`；native 源在 `entry/src/main/cpp`。
- IDE 沙箱对系统目录 `EACCES` 时，改用 brew node + `DEVECO_SDK_HOME` 指向 brew 的 OHOS SDK 镜像。

## 排查顺序

1. 先查官方文档与声明定义；2. 读本地构建/同步报错日志；3. 结合 `docs/build-notes.md` 已知坑；4. 才动配置。
- 不要为了「收尾」自动触发构建；仅在用户要求或任务本身是构建排查时才执行。
- npm 网络问题用 `npm_config_registry=https://registry.npmmirror.com`；GitHub 用 `ghfast.top` 镜像。
