# BrewDSH 开发进度记录

> 本文档记录 BrewDSH（Harmonybrew 桥接路线）的开发进度、已解决问题与待办事项。
> 与 `dsh-OHDSH`（内置运行时线，tag `embedded-runtime-complete`）互为姊妹项目。

---

## 项目定位

| 项 | 内容 |
|---|---|
| 仓库 | `D:\desktop\temp\BrewDSH`（独立 git，main 分支） |
| 包名 | `com.brewdsh.app`（AGC APP ID `6918742044333223461`） |
| 路线 | **Harmonybrew 深度集成**：brew 提供原生 node/dsh（JIT 可用），App 做壳 + 内嵌 jitless 兜底 |
| 姊妹项目 | `dsh-OHDSH`（内置运行时），待 AGC 权限正式审批后继续开发 |

## 2026-09-13 进度（阶段：双模式收敛 + 系统集成 + 市场可用）

### ✅ 本轮完成（均为真机验证）

| 项 | 结果 |
|---|---|
| **插件市场真正可用** | 市场安装链路改走 dsh 自带「同进程 pnpm」（worker_threads + 内置 `pnpm/dist/pnpm.cjs`）：`/dsh-market/status` 的 `pnpm` 由恒 `false` 变 `true`；真实安装 `dsh-status-rotator@0.17.2` 成功（`Done in 2.4s using pnpm v10.6.3`）、卸载也正常；两种模式均通过 |
| **遮蔽副本治理** | pnpm 会把 dshmarket 装成 `profiles/web/node_modules/dshmarket`（未打补丁）遮蔽壳侧镜像 → 启动时检测并解除（符号链接只删链接、真实目录连目录一起删） |
| **宿主模式终端 = 真 PTY** | 新增不链接 libnode 的 `libpty_host_napi.so`（N-API 符号交宿主 node 解析）+ native 导出 `DSHM_LIB_DIR`；宿主终端从 `pipe` 变 `pty` |
| **Tab 补全** | ArkUI `TextInput` 吞 Tab → `onKeyEvent` 拦截直通 pty（Tab/↑/↓/Esc/Ctrl-C）+ 触摸按钮；`/dshm-terminal/write` 支持 `raw`（不补换行）。实测 `ec`+Tab 补全成 `echo` 且不误执行 |
| **模式切换干净可靠** | 统一「停旧（等标记）→ 清日志 → 重做镜像 → 按新模式拉起 → 等就绪」；宿主守候进程收到信号后**自身退出**、内嵌停机改由 native 父进程 `kill-request` 接管。停机 **0.8s**、就绪 ~12s；两个方向均验证 |
| **环境树不再被误删** | `removeDirRecursive` 入口补 `lstatSync`（原先顺符号链接把 242 个包的真实内容删光，两种模式都起不来） |
| **宿主 profile 启动修复** | 壳侧写的 `cordis.patch.yml` 必须是顶层 YAML 数组（原来只写注释 → 解析成 null → dsh abort `status=256`） |
| **Dock 右键「重启」** | `quickBarManager`（仅 2in1）+ 后台 Ability 收 WantParams + 公共事件转主进程执行 + 完成后页面换新 token 重载；菜单只保留「重启」（退出用系统自带）；幂等清理 + 诊断文件 |
| **托盘菜单简化** | 只留「重启」（打开靠左键唤回、退出用系统自带）；左键唤回补 `Window.restore()` 优先 |
| **退出更干净** | `exitApp` 先停 dsh 再 `terminateSelf`：实测退出后应用与 dsh 进程数 9 → 0 |
| **启动画面 = 白底黑鲸鱼** | 重做启动图图标（透明底黑鲸鱼）、应用图标（白底 + 黑鲸鱼）、深色字标；生成脚本 `scripts/gen-brand-assets.ps1` 可复现 |
| **环境版本** | `ENV_VERSION` 116 → **120**（rawfile 内容多次变更，必须同步提升） |
| **文档** | 新增 `docs/pitfalls-and-gotchas.md`（踩坑点总表）与 `docs/harmonyos-pc-dock-menu-research.md`；README 重写；bug-log 追加 4 条 |

### 交付物

- `entry/build/default/outputs/default/entry-default-signed.hap`（约 243 MB，全新完整构建）
- 侧载：`hdc install -r <上面那个 hap>`

### 待办

- **在线更新环境包**（`plan-lite-env-online.md`）：目前环境只随 HAP 分发。
- **HNP 路线**（可选）：把内置 node 打成 HNP 内嵌进 HAP，可获得**执行位**（`execv` 而非只能 `dlopen`）。前置：手工 repack + 签名（需签名口令）、设备 HNP 开关状态未知。
- **JIT**：需 release/上架签名才能过 XPM 代码页签名校验。
- **手机/平板形态**：当前 UI 与交互按 2in1 打磨。

---

## 当前进度总览（2026-09-12）

### ✅ 已打通的完整链路

```
App 启动 → 解压内嵌环境（ENV_VERSION=20260911-110）
  → 权限检查（ACCESS_USER_FULL_DISK / CUSTOM_SANDBOX 已生效）
  → pnpm wrapper 生成（filesDir/bin/pnpm → brew node）
  → 宿主插件接入 ~/.dsh/profiles（dshm-terminal 等 3 个 bundle）
  → web profile bundles 声明（~/.dsh/profiles/web/package.json）
  → libdsh_host 探测 hostDsh = ~/.harmonybrew/bin/dsh (executable)
  → 宿主模式启动：brew dsh 0.1.5-rc.2_2 + 原生 node v26.8.1（JIT 可用）
  → 3080 LISTEN，ArkWeb 加载 WebUI
  → 终端可用（pty 回退管道，输出已清爽化）
```

### 已验证的运行状态

| 项 | 值 |
|---|---|
| 运行模式 | `host`（`runtime-mode-active.txt`） |
| dsh 版本 | 0.1.5-rc.2_2（brew Cellar） |
| node 版本 | v26.8.1（原生，非 jitless） |
| HOME | `/storage/Users/currentUser` |
| 3080 | LISTEN + WebUI 正常加载 |

---

## 已解决的关键问题（按时间线）

### 1. 项目拆分与签名统一
- 从 `dsh-OHDSH`（`ENV_VERSION=20260911-109`）剥离，改包名 `com.brewdsh.app`
- 清理签名实验残留（`executableBinaryPaths` / `hnpPackages` / 手动拷贝的 ELF）
- 修复重复的 `libpty_host.so`（CMake 已输出，删 libs 下手动拷贝）
- DevEco 自动签名为新包名生成证书/profile

### 2. rawfile 大面积缺失（robocopy 陷阱）
- **现象**：首次构建 HAP 仅 127MB，启动后功能大面积失效（`dshm-terminal` 只剩 vendor 目录）
- **根因**：`robocopy /XD build oh_modules node_modules .hvigor .cxx .git` 把 `rawfile/dsh/node_modules` **整个排除**了（同名目录 `node_modules` 被误杀），只复制了 13 个文件
- **修复**：用 `/XC /XN /XO`（仅复制缺失）增量同步，12,485 文件补齐，HAP 恢复 239MB
- **教训**：跨仓库复制带 node_modules 的资源树时，`/XD` 的目录名匹配是**全树生效**的

### 3. 权限与 profile 联动（9568289 安装失败）
- **现象**：manifest 加回 ACL 后安装报 `grant request permissions failed. PermissionName: ohos.permission.ACCESS_USER_FULL_DISK`
- **根因**：DevEco 自动签名的调试 profile，其 ACL 是**按 manifest 声明申请**的。先删权限再加回，旧 profile 不会自动更新
- **修复**：Project Structure → 重新勾选 Automatically generate signature → 新 profile 带上 3 条 ACL
- **验证**：安装成功 + `hostDsh` 探测从 `(missing)` 变 `(executable)`
- **延伸**：`ACCESS_USER_FULL_DISK` 是 `manual_settings` 类型，profile 只给资格，还需用户在系统设置手动开启；App 已内置 `openPermissionOnSetting` 引导（EntryAbility.ensureRuntimePermissions）

### 4. 宿主模式终端 405（★ 最重要的机制发现）
- **现象**：终端面板「会话启动失败」，`POST /dshm-terminal/start` 返回 405 Method Not Allowed
- **根因**：`dsh-app-boot` 的 profile bundle 机制要求**两步缺一不可**：
  1. 模块可达：插件目录在 `$DSH_HOME/profiles/node_modules/`
  2. **显式声明**：插件名列在 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles` 数组
  只放 node_modules 不写 bundles 列表**不会被加载**（官方注释原文：bundles are composed by applying each bundle's patch list **in `dsh.profile.bundles` order**）
- **修复**：`ensureHostModeTerminal()` 镜像 3 个壳侧插件到 `~/.dsh/profiles/node_modules` + 写 `~/.dsh/profiles/web/package.json`（`mergeWebProfileBundles` 保留官方 bundle 顺序与 patchReload，去重追加）+ 创建 profile patch 层 `cordis.patch.yml`
- **验证**：pty start 405 → 200，sid 分配正常，zsh 提示符出现
- **对照**：内嵌环境靠适配脚本改 `dsh-app-boot` 源码的 `PROFILE_TEMPLATES.web.bundles`；宿主模式改不了 brew 源码，改写 profile 的 package.json 正是该字段的设计用途

### 5. 终端输出清爽化
- **问题 A**：OSC 9278 序列泄漏（`"SetupComplete"}` 半截 JSON）—— 旧 `stripAnsi` 只匹配 CSI（`ESC[...字母`），漏了 OSC（`ESC]...BEL/ST`）与独立 BEL
- **修复**：四类过滤（OSC / CSI / BEL / 其余 C0 控制符，保留 `\n\r\t`），本地 node 单测 + 设备端到端验证
- **问题 B**：`.zshrc:225 brew: bad interpreter: /usr/bin/zsh` —— Harmonybrew 的 brew 脚本 shebang 是 `#!/usr/bin/zsh`，沙箱内无此路径，`eval "brew shellenv"` 必报错
- **修复**（设备侧一次性）：恢复 `.zshrc.bak-dshm` 备份 → 删除 225 行裸 eval → 末尾追加直接 `export PATH`（等价 shellenv 的 PATH 部分，无脚本执行）→ `zsh -n` 校验 RC:0
- **遗留**：`brew --version` 本身仍报 bad interpreter（brew 脚本 shebang 问题），**App 侧不可修**，需 Harmonybrew 上游改 shebang；node/pnpm/dsh 等实际工具不受影响
- **附带教训**：修 `.zshrc` 时第一版用 sed 中间插入，把 guard 行插进了函数定义内部导致 165 行 parse error；二分定位（`head -N | zsh -n`）+ md5 对比才找到；最终方案是**恢复备份 + 文件末尾追加**

### 6. 顶栏沉浸光感回归（视觉）
- **现象**：顶栏加 `systemMaterial(ImmersiveMaterial)` 后菜单文字与右上角系统窗口按钮全部不可见
- **根因**：`setWindowDecorVisible(false)` 后系统窗口按钮浮在应用顶栏之上，由系统按浅色模式画深色图标；`systemMaterial` 会把 `backgroundColor` 恢复为透明，深色文字/深色按钮图标同时落在透明底上，对比度崩溃
- **修复**：顶栏回退 `#ffffff` 实色 + 底部分隔线（注释写明禁止用材质）；沉浸光感仅保留在面板卡片（`ULTRA_THICK` + 遮罩 `#33000000`）
- **验证**：像素量化——顶栏文字带对比差 237（最暗 18 / 最亮 255）
- **沉淀**：`apiAvailable('26.0.0')` 编译期被拒（SDK 校验器只收 1-25 整数），改用 `deviceInfo.sdkApiVersion` 数值比较

### 7. profiles/node_modules heal 残留 → SIGNAL 6
- **根因**：沙箱禁 symlink → dsh 的 heal 退化为整目录复制 → 下次启动 `ensureSymlink` 检测到真实目录直接 throw abort
- **修复**：`cleanUnmanagedHealFallback()` 启动前扫描 `profiles/node_modules/@deepseek-ai/*`，删除非托管副本（保留 dsh 托管代理包），幂等
- **效果**：「重启后会话无法对话」根治

### 8. hostDsh 路径被工作区回退污染
- **根因**：`hostDsh = wsDir + "/.harmonybrew/bin/dsh"`，而 `wsDir` 在个人文件夹未授权时回退 `filesDir`，把 brew 绝对路径带偏
- **修复**：独立探测绝对路径（用户级根优先、filesDir 兜底），不复用 `wsDir`

---

## 🔄 进行中：工作区选择问题（当前任务）

### 现象
Token 鉴权进入主页后，无法选择工作区（点「添加工作区」无反应/失败）。

### 已查明的机制

- dsh 前端是 **client-modules 架构**（`window.__DSH_BOOT__` 声明 50+ 个 client.js 模块）
- 「添加工作区」来自 **`@deepseek-ai/dsh-client-ui-directory-picker-browse`**——**浏览文件树选目录**（API 驱动），不是系统 picker
- 数据源：`@deepseek-ai/dsh-api-workspace-files` + `@deepseek-ai/dsh-api-workspace-controller` → 服务端读 **workspace root** 下的目录树
- 宿主模式的 workspace root = `libdsh_host chdir` 的目录（个人文件夹 `/storage/Users/currentUser`）

### 已修复的关联问题

**`/dshm-admin/version` 返回「未找到 DSH 环境根」**：
- 根因：`dshm-terminal` 的 `resolveDshRoot()` 四个候选全部基于「HOME 在 `<filesDir>/home`」假设；宿主模式 HOME 改指个人文件夹后全部 miss
- 修复：`dsh_host.cpp` 导出 `DSHM_FILES_DIR` 环境变量；`resolveDshRoot` 增加最高优先级候选 `DSHM_FILES_DIR/dsh`；插件 1.0.11→1.0.12，ENV_VERSION→110
- 已验证：`~/.dsh` 副本已是 1.0.12、`DSHM_FILES_DIR` 已传到宿主进程、`<filesDir>/dsh/.dshm-version` 与 `@deepseek-ai/dsh/package.json` 都存在

### 待办

1. ⬜ 从 `dsh-client-ui-directory-picker-browse/client.js` 找到**真实的 browse API 路径**
2. ⬜ 设备上复现：点「添加工作区」→ 抓实际请求与响应（确认是 404 还是空树还是权限问题）
3. ⬜ 按根因修复（可能是 API 端点未注册 / workspace root 配置 / web profile 缺 workspace 相关 bundle）
4. ⬜ 修复后完整回归：选工作区 → 新建会话 → 对话 → 终端
5. ⬜ UI 回归断言（`scripts/ui-test-phone.sh`）：顶栏对比度 + 终端可打开
6. ⬜ README 更新（当前状态段落仍是 DSHM 旧文案，需改写为 BrewDSH 视角）

---

## 已知限制与遗留

| 项 | 说明 | 归属 |
|---|---|---|
| `brew --version` 报 bad interpreter | brew 脚本 shebang `#!/usr/bin/zsh` 沙箱内不存在 | Harmonybrew 上游 |
| pty 回退管道模式 | `pty_host.node` 按 libnode 编译（NEEDED libnode.so.137 + RUNPATH 指开发机），brew node 进程 dlopen 失败 | 后续为 brew node 重编 addon |
| 会话库分家 | host 模式 `~/.dsh`、embedded 模式 `<filesDir>/home/.dsh` | 待统一（方案 A 阶段 2） |
| python3 | 无 ohos-arm64 预编译；brew 有 python formula，待引导安装 | 阶段 2 |
| zstd | busybox/toybox 均无 zstd applet；会话轨迹读取暂缺 | 低优先级 |

## 关键文件索引

| 文件 | 职责 |
|---|---|
| `entry/src/main/cpp/dsh_host.cpp` | native 宿主：模式探测（host/embedded）、PATH 注入、DSHM_FILES_DIR 导出、hostDsh 探测 |
| `entry/src/main/ets/dshm/bootstrap/DshBootstrap.ets` | 环境解压、pnpm wrapper、宿主插件接入、heal 清理、ENV_VERSION |
| `entry/src/main/ets/dshm/access/WorkspaceAccess.ets` | 工作区授权/选择/同步 |
| `entry/src/main/ets/dshm/ui/ImmersiveMaterialUtil.ets` | 沉浸光感能力探测与降级 |
| `entry/src/main/ets/dshm/ui/BrewEnvProbe.ets` | Harmonybrew 环境探测（brew/node/dsh/全盘） |
| `entry/src/main/ets/pages/dshm/DshmWebPage.ets` | 主页面：顶栏、面板、终端、Web 容器 |
| `entry/src/main/ets/entryability/EntryAbility.ets` | 权限引导、托盘、窗口管理 |
| `docs/runtime-environment-research.md` | 路线调研（embedded vs Harmonybrew） |

## Git 提交索引

```
6a38346 fix(terminal): 终端输出清爽化 —— stripAnsi 全类型覆盖 + zshrc 治理
e27a054 fix(terminal): 宿主模式终端打通 —— 写 web profile 的 bundles 声明
81ff85d feat(permission): 运行时权限引导（openPermissionOnSetting 系统级设置页）
4bec83f fix: 顶栏可读性回归 + hostDsh 路径 + heal 残留自动清理 + 权限对齐
fd52983 docs(bug-log): 沉淀 apiAvailable 点分版本号编译期被拒的坑
1338fca feat(ui): 沉浸光感（空间化 Spatial UI）+ 运行环境面板
2e08a71 init: BrewDSH —— 基于 Harmonybrew 运行时的 DSH 鸿蒙客户端
```
