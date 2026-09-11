# 技能：框架业务化与 AGC 上架发布指南 (App Release)

**适用场景**：当需要将纯净的 NGF 框架工程转变为你自己的真实业务 App，修改包名、图标、版本号，配置真实的签名证书（调试/发布），以及最终打包推送到 AppGallery Connect (AGC) 上架或内测时。绝对禁止使用针对 Android 的打包流程。

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- 收到“修改应用名”、“替换 App 图标”、“更换包名(bundleName)”等业务化指令。
- 收到“如何生成签名证书”、“如何获取 p12/p7b 文件”、“帮我打包正式版”等上架相关指令。
- 试图执行构建应用级别的包（如 `.app` 或 `.hap`）以准备对外发布时。

---

## 阶段一：本地定制化 (Local Customization)

在正式签名之前，必须先将本框架完全剥离“NGF”印记，定制为你自己的 App。

### 1. 修改唯一包名 (Bundle Name)
这是你在应用市场的唯一标识，必须与 AGC 后台创建应用时的包名**完全一致**。
- **修改位置 1**：`AppScope/app.json5` 中的 `bundleName` 字段。
  ```json5
  // AppScope/app.json5
  {
    "app": {
      "bundleName": "com.yourcompany.yourapp", // 必须全局唯一
      // ...
    }
  }
  ```
- **同步要求**：修改后请全局搜索旧包名 `com.dlzz.ngf`，确保没有任何历史硬编码残留。

### 2. 修改应用名称与多语言
- **应用内部资源**：`AppScope/resources/base/element/string.json` 中的 `app_name`。
- **中文覆盖**：`AppScope/resources/zh_CN/element/string.json` 中的 `app_name`。
桌面最终显示的名称由这里决定。

### 3. 替换应用图标 (App Icon)
- **修改位置**：将你的新图标替换到 `AppScope/resources/base/media/` 目录下。
- **规范（推荐使用分层图标）**：优先建议像当前工程一样正确使用鸿蒙的**分层图标**结构（包含前景 `foreground` 和背景 `background`），以完美适配系统的视差动画与动态圆角裁剪。请避免直接丢入一张扁平的单层 PNG。

### 4. 版本号管理
每次提交 AGC 新版本时，必须自增 `versionCode`。
- **修改位置**：`AppScope/app.json5`
  ```json5
  "versionCode": 1000000,    // 用于商店的版本对比，必须递增
  "versionName": "1.0.0"     // 面向用户的展示版本号
  ```

---

## 阶段二：真实的 AGC 上架与签名流程 (AGC Process)

HarmonyOS Next 的应用签名体系非常严格，禁止使用未经授权的测试签名上架。

### 第 1 步：AGC 创建项目与应用
1. 登录 [AppGallery Connect](https://developer.huawei.com/consumer/cn/service/josp/agc/index.html)。
2. 在“APP与元服务”中创建新发布。
3. **应用包名**：填入你在阶段一中设定的 `bundleName`（例如 `com.yourcompany.yourapp`）。
4. **应用名称**: 填入你在阶段一中设定的 `app_name`（例如 `NGF`）。
5. **支持设备**: 一般选择 `手机` 与 `平板` 与 `PC/2in1` 。
6. **默认语言**: 一般选择 `简体中文` 。

### 第 2 步：生成密钥库 (.p12) 与证书请求 (.csr)
你需要使用 DevEco Studio 本地生成加密凭据，不要让第三方代为生成。
1. 在 DevEco Studio 顶部菜单栏选择 `Build > Generate Key and CSR` 或 `构建 > 生成私钥和证书请求文件` 。
2. 创建一个新的 `Key Store` 或 `密钥库名称`（会生成一个 `.p12` 文件），牢记 `Store password` 或 `密钥库密码`。
3. 填写 `Alias` 或 `别名`，点击下一步。
4. 填写 `CSR File Name` 或 `证书请求文件名`。
5. 点击 Finish，IDE 会在指定目录下同时生成一个 `.csr`（Certificate Signing Request）文件（建议与 `.p12` 文件放一起）。

### 第 3 步：在 AGC 申请证书 (.cer) 与 Profile (.p7b)
这是鸿蒙独有的授权机制。
1. **申请证书 (Certificate)**：
   - 进入 AGC -> "证书、APP ID和Profile" -> "证书" -> "新增证书"。
   - 证书名称随意，建议为 项目/ APP 名称。
   - 证书类型选择 **“发布” (Release)**（如果是真机联调则选“调试”，邀请测试和正式上架都需要发布证书）。
   - 上传你刚才生成的 `.csr` 文件。
   - AGC 审核通过后，下载生成的 `.cer` 证书文件。
2. **生成 Profile (Profile)**：
   - 进入 AGC -> "证书、APP ID和Profile" -> Profile -> "添加"。
   - 应用名称选择你新建应用的名称，包名会自动解析。
   - Profile名称建议为应用名称。
   - 类型为 **“发布” (Release)** 。
   - 选择你刚刚创建的**发布证书** 。
   - 下载生成的 `.p7b` 配置文件。

### 第 4 步：在 DevEco Studio 配置正式签名
将 `.p12`、`.cer`、`.p7b` 三个文件放到安全目录（切勿提交到开源 Git，该类型文件已被添加到gitignore）。
1. 打开 `File > Project Structure > Project > Signing Configs` 或点击 DevEco Studio 右上角的 `项目结构 > 签名配置` 。
2. 取消勾选 `Automatically generate signature` 或 `自动生成签名文件` 。
3. 新增一个名为 `release` 的配置，依次填入：
   - `Store file` 或 `密钥库文件`: 你的 `.p12` 文件路径
   - `Store password` 或 `密钥库密码`: 你的密钥库密码
   - `Key alias` 或 `密钥库别名`: 你的密钥别名
   - `Key password` 或 `密钥密码`: 密钥密码
   - `Sign alg` 或 `签名算法`: 通常为 `SHA256withECDSA`
   - `Profile file` 或 `Profile文件`: 从 AGC 下载的 `.p7b`
   - `Certpath file` 或 `证书文件`: 从 AGC 下载的 `.cer`
4. 确认 `build-profile.json5` 中的 `products` 节点，`default` product 的 `signingConfig` 指向了 `"release"`。

### 第 5 步：构建用于上架的最终包 (App/Hap)
构建 Release 包时，**最推荐且最快捷的方式是直接使用 DevEco Studio 现成的 UI 按钮**：
- 在 IDE 顶部菜单栏依次点击：`Build > Build Hap(s)/APP(s) > Build APP(s)`。
- IDE 会自动根据你在第 4 步配置的 release 签名，在 `build/outputs/default/` 目录下生成用于上架的 `.app` 包。

如果必须使用命令行环境自动构建，请确保显式设置 SDK 路径并带上 `--release` 标志：
```powershell
$env:DEVECO_SDK_HOME='<包含 default/openharmony 的 DevEco SDK 根目录>'; & '<本机 hvigorw.bat 绝对路径>' assembleApp --release --no-daemon
```
> **注意**：上架使用的是 `.app` 包，而局域网单模块测试分发使用的是 `.hap` 包。

### 第 6 步：AGC 邀请测试或正式上架
1. 回到 AGC 的“我的应用” -> "分发" -> "版本信息"。
2. 点击“软件包管理”，上传刚刚构建出的 `.app` 包。
3. **如需开放测试 (Open Testing)**：在后台找到“开放测试”菜单，创建测试列表，通过邀请码分发给用户。
4. **如需正式上架**：填写完善的应用介绍、隐私政策网址、应用分级（年龄），选择截图，点击“提交审核”。审核期通常为 1-3 个工作日。

---

## 3. Agent 执行本规则的底线要求

作为 AI 助手，在响应用户的发布需求时：
- **绝对禁止**使用任何与 Android APK 相关的签名工具（如 `apksigner`、`keytool`）来处理 HarmonyOS Next 产物。
- **绝对禁止**在没有任何 `.p7b` 授权配置的情况下，强行劝导用户执行 release 打包并承诺可以直接安装。
- 当用户询问上架步骤时，必须严格按照本文件中**六个步骤**的顺序进行解释，并明确指出必须要去“AppGallery Connect”操作。
