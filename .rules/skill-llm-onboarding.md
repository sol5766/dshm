# 技能：LLM 项目初始化与环境基线探针

**适用场景**：AI 代理（Agent/LLM）在开启一个新会话时，为了快速熟悉当前工程结构、自动核查本地 SDK 路径、定位构建工具以及推导正确的编译命令而执行的标准探针流程。

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- Agent 开启新会话，首次接触本项目（Onboarding / 初始化阶段）
- Agent 开始中等及以上复杂任务，需要先确认仓库结构、规则库、SDK 与构建工具基线
- 陌生环境中需要把本机探测结果写入 `.local-rules/`
- 遇到 `SDK path not found`、`hvigorw not found` 等环境异常
- 遇到 `targetSdkVersion` 或 `compatibleSdkVersion` 与本地不匹配的编译错误
- 需要执行任何形式的自动编译或预览但尚未构建正确的命令环境时

---

## 1. 背景

HarmonyOS Next 项目依赖特定的 DevEco Studio 与 SDK 路径，不同机器的安装环境往往不一致，且 `local.properties` 有时可能未记录 SDK 路径。如果 LLM 在缺乏本机环境认知的情况下盲目猜测路径或执行标准 npm/yarn 命令，将导致项目彻底破坏或陷入报错死循环。
本技能要求 LLM 执行一套标准的**动态探针流程**，在修改代码或执行构建前，先自我确认环境基线。探测到的新机器事实应写入 `.local-rules/*.local.md`，不要直接修改共享 `.rules/` 或 `AGENTS.md`。

## 2. 探针执行流程（LLM 必须运行的预检指令）

### 2.1 检查项目配置基线
请主动读取以下关键文件（务必使用 UTF-8 编码读取）：
- `build-profile.json5`：提取 `targetSdkVersion` 与 `compatibleSdkVersion`。
- `ngf_framework/oh-package.json5`：这是框架主模块配置，获取核心依赖和 `modelVersion`。
- `entry/oh-package.json5`：这是应用层模块配置。
- `AppScope/app.json5`：获取 `bundleName`。
- `.local-rules/README.md` 与 `.local-rules/base-local-rules.md`：如果存在，读取本地规则库边界。
- 相关 `.local-rules/*.local.md`：如果存在，优先读取本机已验证事实。
- `.agent-rules/README.md` 与 `project-rules.md`：如果存在，读取所有 `active` 项目规则；存在 `preferences.local.md` 时也读取，并仅在不与更高优先级规则冲突时应用。

### 2.2 扫描本地 SDK 与 IDE 路径
请运行 PowerShell 脚本来动态嗅探本地可能存在的 SDK 与构建工具路径，严禁凭空编造：

```powershell
# 嗅探可能的 SDK 根目录，路径来自本地规则库或现场观察
Test-Path "<可能的 HarmonyOS SDK 根目录>"
Test-Path "<可能的 DevEco Studio SDK 根目录>"

# 嗅探可能的 DevEco Studio 默认工具链
Test-Path "<可能的 DevEco Studio SDK 根目录>\default\openharmony"
Test-Path "<可能的 DevEco Studio SDK 根目录>\default\hms"
```

如果最新探测结果与 `.local-rules/*.local.md` 中的历史基线不同，应按实测结果执行当前任务，并把新路径、新版本或失败原因写入 `.local-rules/current-machine.local.md` 或 `.local-rules/build-commands.local.md`；不要直接回写本文件。

### 2.3 构建正确的环境变量与编译命令

一旦探针确认了有效的 IDE SDK 目录和 Hvigor 路径，在后续任何执行构建的 `run_command` 中，**必须采用显式声明环境变量配合绝对路径的方式**调用 `hvigorw.bat`：

**PowerShell 组合执行模式**：
```powershell
$env:DEVECO_SDK_HOME='<包含 default/openharmony 的 DevEco SDK 根目录>'; & '<本机 hvigorw.bat 绝对路径>' assembleHap --no-daemon --stacktrace
```
- `DEVECO_SDK_HOME` 指向包含 `default/openharmony` 的那层 sdk 目录。
- 必须使用 `&` 调用带空格的路径。
- 必须包含 `--no-daemon` 防止 Agent 进程挂起或锁死。
- 执行该命令的工作目录（Cwd）必须为当前仓库的根目录。

## 3. 常见环境问题与修复策略

### 3.1 Ninja 缓存冲突
**报错**：`generator : Ninja does not match the generator used previously...`
**对策**：清理指定模块内的 `.cxx` 和 `CMakeCache.txt` 缓存，然后重新执行构建。严禁使用 `rm -rf` 无差别清空整个 `entry` 目录。
**命令**：
```powershell
$env:DEVECO_SDK_HOME='<包含 default/openharmony 的 DevEco SDK 根目录>'; & '<本机 hvigorw.bat 绝对路径>' clean --no-daemon
```

### 3.2 找不到对应版本的 SDK
**报错**：`The compatibleSdkVersion X is not found.`
**对策**：先对照根目录 `build-profile.json5`、本机 SDK 目录、DevEco Studio 默认 SDK 目录和用户实际报错确认根因。当前仓库默认应保持 API26，不要为了让本机临时通过而随意降级 `targetSdkVersion` / `compatibleSdkVersion`；只有在用户明确要求切换 SDK 版本或目标分支确实使用旧 SDK 时，才修改 `build-profile.json5`。

### 3.3 工具链路径在后续步骤中丢失
**对策**：Agent 的每次 `run_command` 会话可能并不继承上一次的环境变量。**在同一轮对话中，如果需要多次构建，每一次执行 `hvigorw.bat` 都必须带上前置的 `$env:DEVECO_SDK_HOME=...` 声明。**

## 4. 本地规则库写入要求

完成环境探测后，如果发现新的本机事实，按以下格式追加到 `.local-rules/current-machine.local.md`：

```markdown
## YYYY-MM-DD 环境探测

**适用范围**：当前机器 / 当前工作区  
**验证命令**：`Test-Path '...'`  
**结果**：...  
**结论**：...  
**验证状态**：已实测  
```

只记录本机事实，不复制共享规则。不要记录密钥、证书密码、token、账号等敏感信息。
