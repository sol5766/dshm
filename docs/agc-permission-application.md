# AGC 权限申请材料（DSHM 调试 profile 补齐）

> 用途：在 [AppGallery Connect](https://developer.huawei.com/agc) 重新生成 `com.dshm.dshclient`
> 的调试 Profile（HarmonyOS App Signing → 证书/APP ID/Profile → Profile 编辑/新建 →
> 受限权限申请）时，把下表权限一次性全部勾选提交。
> 生成后下载新 p7b 覆盖仓库根目录的 `dshmDebug.p7b`，告诉我一声，我重签验证。
>
> 背景一句话：应用（DSHM，HarmonyOS PC/2in1 本地 AI 智能体工作台）在进程内集成 Node.js
> 运行时（V8）与随包签名的原生工具，提供本地终端、工作区文件操作与 AI 会话能力。
> 全部能力作用于**应用自身沙箱与用户显式授权的工作区目录**，不采集、不上传任何用户数据。

---

## 申请权限清单（共 5 条）

| # | 权限名 | 类型 | 用途一句话 |
|---|---|---|---|
| 1 | `ohos.permission.kernel.ALLOW_EXECUTABLE_FORT_MEMORY` | 内核级 / JIT | 内嵌 V8 JIT 编译（上批已含，**保留**） |
| 2 | `ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE` | 加载执行随包原生代码（上批已含，**保留**） |
| 3 | `ohos.permission.ACCESS_USER_FULL_DISK` | 全盘文件访问（工作区） | **本轮补申** |
| 4 | `ohos.permission.CUSTOM_SANDBOX` | 自定义沙箱映射 | **本轮补申** |
| 5 | `ohos.permission.READ_WRITE_USER_FILE` | 用户文件读写 | **本轮补申** |

> `ohos.permission.FILE_ACCESS_PERSIST` 上批已含（持久化文件授权），无需重复申请。

---

## 各权限的申请理由（可直接粘贴到 AGC 的"使用场景说明"）

### 1. ohos.permission.kernel.ALLOW_EXECUTABLE_FORT_MEMORY

**使用场景说明：**

本应用（DSHM，面向 HarmonyOS PC/2in1 的本地 AI 智能体工作台）在应用进程内集成了 Node.js
运行时（V8 引擎，随应用包签名分发），作为本机 AI Agent 的执行内核。

V8 的即时编译器（JIT）在初始化时需要创建可写且可执行的匿名内存页（mmap/mprotect
PROT_EXEC）。未持有本权限时，应用沙箱禁止 W+X 内存，V8 启动即崩溃（V8 Fatal），因此
当前被迫以 `--jitless` 解释模式运行，带来两个无法绕过的产品问题：

1. **性能**：解释执行使应用冷启动时间约为 JIT 模式的 2 倍（同一真机实测：JIT 环境约
   4.7 秒，解释模式约 13.6 秒），运行期 CPU 占用也显著升高，用户可直接感知；
2. **兼容性**：`--jitless` 会移除 WebAssembly 全局对象，而 Node 内建网络栈 undici
   （fetch/HTTP 客户端）依赖 llhttp 的 WASM 实现。为维持基本联网能力，我们不得不维护
   一整层 JS 垫片替换全局 fetch/Request/Response，稳定性与上游升级适配成本都很高。

**安全性说明：** JIT 仅用于提升应用自身内嵌 JS 运行时的执行效率。应用执行的全部
JavaScript 均随应用包签名分发，不存在执行任何网络下载的未签名代码的场景；应用也不提供
让第三方注入代码的通道。

**替代方案说明：** 无系统级替代方案。`--jitless` 回退模式已实现（当前状态），但上述性能
与 WebAssembly 缺失问题在 jitless 下无法解决。华为官方文档《JSVM-API 申请JIT权限指导》
明确说明此类场景应通过 AGC 申请本权限。同类桌面 AI 工作台应用（内置 Electron/Node
运行时）已在应用市场分发并正常使用 JIT 能力。

### 2. ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE

**使用场景说明：**

本应用按官方《应用程序包集成 bin 文件（PC/2in1）》的方式，在 HAP 内集成了原生可执行
组件（busybox 及其命令行 applet、终端 pty 助手），用于向 PC 用户提供本地终端与命令执行
能力——这是 AI 智能体的核心功能之一：在工作区内安全地执行用户项目的构建/脚本命令。
应用需要在自身沙箱内加载并执行这些**随应用包统一签名分发**的原生二进制。

**安全性说明：** 所有被加载/执行的原生二进制均包含在应用安装包内、随应用统一签名，不
执行任何来自网络或外部存储的未签名二进制。

### 3. ohos.permission.ACCESS_USER_FULL_DISK（本轮补申）

**使用场景说明：**

本应用是面向鸿蒙 PC 的 AI 编码/工作台工具，其核心工作流是：用户选择一个工作区目录
（默认为个人文件夹 `/storage/Users/currentUser`，或用户通过系统目录选择器指定的任意
项目目录），应用的 AI Agent 在该目录内读取代码/文档、执行构建命令、写入生成结果。

用户的项目可能位于个人文件夹下的任意位置（如 `Documents`、桌面、外接盘符挂载点等），
仅申请文档/下载目录的固定授权无法覆盖"用户自选工作区"这一核心场景。该权限为
`manual_settings` 授予形态：应用内会引导用户到系统设置中手动开启，由用户显式控制，
且应用只在用户选定的目录范围内读写。

**用户告知方式：** 应用内权限引导页说明用途；文件读写仅发生在用户选择的工作区内，
会话历史与生成文件在应用内可见可删。

### 4. ohos.permission.CUSTOM_SANDBOX（本轮补申）

**使用场景说明：**

应用内嵌的 Node.js 运行时（`libnode`）以原生子进程形态运行，需要在沙箱内建立自己的
`HOME` 与 `$DSH_HOME` 目录映射（会话库、插件依赖副本），并把用户授权的工作区目录映射
进沙箱供原生进程访问。自定义沙箱映射用于把这些路径挂接到应用沙箱内的真实位置，使
ArkTS 宿主与原生子进程对同一份用户数据有一致的视图。

**安全性说明：** 映射仅指向应用自身沙箱目录与用户显式授权的工作区目录，不触碰其他
应用数据。

### 5. ohos.permission.READ_WRITE_USER_FILE（本轮补申）

**使用场景说明：**

应用的终端功能（pty 会话）与 AI 工具（文件读写工具）需要在用户授权的工作区（默认个人
文件夹）内读写用户项目文件：读取代码上下文、写入 AI 生成的新文件、执行用户项目自带的
构建脚本（脚本自身会读写其目录内文件）。该能力与 `ACCESS_USER_FULL_DISK` 配合使用：
用户开启全盘授权后，本权限保证应用进程内的文件 API 在这些路径上可用。

**用户告知方式：** 应用内说明 + 所有文件操作记录在会话轨迹中，用户可随时查看与删除。

---

## 提交步骤提醒

1. AGC → 我的证书/APP ID/Profile → 找到 `com.dshm.dshclient` 的调试 Profile → 编辑
   （或新建）→ 在"受限权限"里**勾选上表 5 条** → 提交；
2. 审核通过（调试 profile 一般即时或 1-3 个工作日）→ **下载新 p7b**；
3. 用新 p7b 覆盖本仓库根目录的 `dshmDebug.p7b`，然后告诉我，我重签 HAP 并装机验证
   （manifest 里权限声明我已备好，加回即可）；
4. 有效期 7 天（当前这份到 9/18），以后每次重新生成记得带上全部 5 条。

## 备注：为什么这 3 条可能"不用审"就能进 profile

本机历史证据（`docs/device-runtime-fixes.md` §5.4）：同机另一工程（旧 dshm 工程）的调试
profile 的 `acls.allowed-acls` **本来就包含** `ACCESS_USER_FULL_DISK` / `CUSTOM_SANDBOX` /
`READ_WRITE_USER_FILE` 三条——说明该开发者账号可以直接配发这三条 ACL。生成 profile 时
acls 由「那一刻 manifest 声明的权限 + 账号资格」共同决定。所以最快路径是：**在 DevEco
Studio 里对当前工程重新执行一次自动签名**（它会按 manifest 当前声明重新生成 p7b），或按
上面材料在 AGC 手动勾选。两条路任选其一。
