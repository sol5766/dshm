# BrewDSH

BrewDSH 是面向 HarmonyOS Next 的 DeepSeek Harness 客户端（**Harmonybrew 桥接路线**）：
运行时由 [Harmonybrew](https://harmonybrew.atomgit.com/) 提供（`brew install deepseek-harness`，
原生 node + JIT），App 提供图形壳、会话管理与内嵌 jitless 兜底环境。

姊妹项目 `dsh-OHDSH` 为内置运行时路线（整环境打包进 HAP），见其仓库 tag `embedded-runtime-complete`。

## 当前状态

- **宿主模式（默认推荐）**：自动检测 `~/.harmonybrew/bin/dsh`，检测到即以 brew 安装的
  dsh（0.1.5-rc.2_2）+ 原生 node（v26.8.1，JIT 可用）运行；未检测到时回退内嵌 jitless 环境
- **运行环境面板**（Harness 菜单）：逐项展示 Harmonybrew / node / deepseek-harness / 全盘访问
  状态，一键安装 Harmonybrew（官方 install.sh）、一键更新运行时——命令送入 pty 终端执行，
  进度实时可见
- **终端**：内嵌侧边栏终端（zsh），宿主模式下由壳侧 `dshm-terminal` bundle 提供
  （经 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 声明接入 brew dsh）
- **沉浸光感**：面板卡片使用 `uiMaterial.ImmersiveMaterial`（API 26 空间化材质），
  带三层能力探测与降级；顶栏因系统窗口按钮浮层问题保持实色
- **权限引导**：`ACCESS_USER_FULL_DISK` / `CUSTOM_SANDBOX` 等受限权限通过
  `openPermissionOnSetting` 引导用户到系统设置开启
- 包名 `com.brewdsh.app`；权限仅保留必需项（ACL 3 条 + 普通权限）

## 运行时约束（真机实测）

- **`--jitless` 必须**（仅 `embedded` 模式）：沙箱 W^X 禁止创建可执行内存，内置 node 以 `--jitless --expose-internals` 启动，由 `_fetch-shim.cjs` 提供 Web 全局与 WebAssembly 垫片
- **ArkTS http 探测 loopback 不可靠**：UI 就绪判定改为读 node 日志标记（`dsh web:`），不依赖 ArkTS http 探测 3080
- **libnode 需 native 加固**：`DT_NEEDED` 链接固定加载顺序 + io_uring `bl syscall` 打补丁回退 epoll，由准备脚本完成后进入 `entry/libs/arm64-v8a/`
- **HAP 不压缩存储**：`rawfile` 每减 1MB，HAP 就少 1MB —— 体积优化主要靠裁剪环境文件（判据必须是"平台构建产物"形状，不能按路径里出现 `win32` 就删，详见升级手册 §4.1）
- **两种模式 $DSH_HOME 不同**：host = `~/.dsh`（个人文件夹）、embedded = `<filesDir>/home/.dsh`，**会话库互不可见** —— 排查"会话没了"先看 `runtime-mode-active.txt`
- **宿主插件接入两步缺一不可**：模块放 `~/.dsh/profiles/node_modules/` 且插件名列入 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，后者由 `DshBootstrap.ensureHostModeTerminal` 自动维护
- **跨仓库复制 rawfile 禁用 /XD node_modules**：robocopy 的目录名排除是全树生效的，会整树漏拷内嵌环境

## 目录

```text
DSHM/
├── entry/                 # 主应用层、EntryAbility、ArkWeb 页面与运行时桥接
├── tools/                 # 图标生成等开发工具
└── AGENTS.md              # 工作区协作规范
```

`entry/src/main/resources/rawfile/dsh/`、`busybox/` 与 native 运行时文件随 HAP 分发，设备端由引导流程解压。

## 开发环境

1. 使用 DevEco Studio 打开仓库根。
2. 在 DevEco Studio 签名设置中配置开发签名（调试机登录后自动签名）。
3. 使用 Hvigor 构建 `entry` 模块并安装到设备。

## 许可证

MIT，见 [LICENSE](LICENSE)。