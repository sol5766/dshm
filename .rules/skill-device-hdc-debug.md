# 技能：设备连接、HDC/HDB 调试与应用启动

**适用场景**：需要通过命令行连接 HarmonyOS 模拟器或真机、安装 HAP、启动/停止应用、查看运行状态、采集 HiLog、生成 bugreport、设置应用等待调试状态时，按本技能执行。

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- 用户提到 `hdb`、`hdc`、模拟器、真机、设备连接、设备列表、设备调试、命令行启动应用。
- 需要安装 HAP、启动 Ability、停止应用、查看前台 Ability、确认进程是否存在。
- 需要清理或采集 HiLog、筛选日志、导出 bugreport、设置 `aa appdebug` 等应用调试状态。
- 运行时崩溃、白屏、启动失败、点击后无响应等问题需要设备端证据。
- 新机器上 HDC/HDB 路径、设备 target、命令返回值与本地记录不同，需要写入 `.local-rules/device-hdc.local.md`。

---

## 1. 核心原则

- 先探测本机到底可用 `hdc` 还是 `hdb`，不要凭 Android/ADB 经验猜命令。
- 先读取 `.local-rules/device-hdc.local.md`；如果不存在或已过期，执行非破坏性探测命令后再写入。
- 共享技能只记录通用流程和命令形态；具体 HDC/HDB 路径、设备 target、版本号、失败命令原因写入 `.local-rules/device-hdc.local.md`。
- 多设备环境必须显式使用 `-t <target>`，不要依赖默认设备。
- 会改变设备状态的命令（安装、启动、停止、清日志、等待调试）只在任务需要运行/调试时执行。

---

## 2. 推荐变量模板

实际值来自 `.local-rules/device-hdc.local.md` 或现场探测结果：

```powershell
$HDC = '<本机 hdc 或 hdb 绝对路径>'
$TARGET = '<设备或模拟器 target>'
$BUNDLE = '<bundleName>'
$MODULE = '<moduleName>'
$ENTRY_ABILITY = '<入口 Ability 名称>'
$SIGNED_HAP = '<本机已构建签名 HAP 路径>'
```

NGF 当前项目的 `bundleName`、`moduleName`、入口 Ability 应从 `AppScope/app.json5` 和 `entry/src/main/module.json5` 读取，不要从旧记忆猜测。

---

## 3. 工具与设备探测

### 3.1 探测 hdc / hdb

```powershell
Get-Command hdc,hdb -ErrorAction SilentlyContinue | Select-Object Name,Source,Version
Test-Path '<可能的 DevEco SDK>\default\openharmony\toolchains\hdc.exe'
Test-Path '<可能的 DevEco SDK>\default\openharmony\toolchains\hdb.exe'
```

把可用工具路径、不可用工具和验证日期写入 `.local-rules/device-hdc.local.md`。

### 3.2 查看版本、服务状态、设备列表

```powershell
& $HDC -v
& $HDC checkserver
& $HDC list targets
& $HDC list targets -v
```

如果 `list targets` 为空，先确认模拟器/真机是否启动；不要继续执行安装或启动命令。

### 3.3 查看设备基础信息

```powershell
& $HDC -t $TARGET shell param get const.product.model
& $HDC -t $TARGET shell param get const.ohos.apiversion
```

把设备型号/API 版本写入 `.local-rules/device-hdc.local.md`，用于后续判断 SDK 与设备是否匹配。

---

## 4. 安装与包信息

### 4.1 安装或覆盖安装

安装前应先通过 `skill-llm-onboarding.md` 确认构建命令和 HAP 产物路径。

```powershell
& $HDC -t $TARGET install -r $SIGNED_HAP
```

安装成功、失败码和 HAP 路径都应写入 `.local-rules/device-hdc.local.md` 或 `.local-rules/build-commands.local.md`。

### 4.2 查询包信息

```powershell
& $HDC -t $TARGET shell bm dump -n $BUNDLE
```

常用筛选：

```powershell
& $HDC -t $TARGET shell bm dump -n $BUNDLE |
  Select-String -Pattern 'bundleName|versionName|versionCode|debug|mainAbility|mainElementName|apiTargetVersion|compileSdkVersion'
```

如果包未安装，不要继续启动 Ability；先构建并安装，或向用户说明缺少安装产物。

---

## 5. 启动、停止与状态确认

### 5.1 强制停止应用

```powershell
& $HDC -t $TARGET shell aa force-stop $BUNDLE
```

停止后用 `pidof` 和 `aa dump -r` 确认。不要只用 `jpid` 判断应用是否存活，因为调试进程列表可能短暂残留。

```powershell
& $HDC -t $TARGET shell pidof $BUNDLE
& $HDC -t $TARGET shell aa dump -r
```

### 5.2 启动入口 Ability

```powershell
& $HDC -t $TARGET shell aa start -a $ENTRY_ABILITY -b $BUNDLE -m $MODULE
```

启动后确认 PID、前台任务和运行进程：

```powershell
& $HDC -t $TARGET shell pidof $BUNDLE
& $HDC -t $TARGET shell aa dump -l
& $HDC -t $TARGET shell aa dump -r
```

### 5.3 带参数启动 Ability

如果需要验证 `Want.parameters`，使用 `--ps`、`--pi`、`--pb` 等参数。参数名必须来自目标 Ability 的实际读取逻辑。

```powershell
& $HDC -t $TARGET shell aa start -a <AbilityName> -b $BUNDLE -m $MODULE --ps <key> <value>
```

---

## 6. HiLog 采集

### 6.1 清理日志

```powershell
& $HDC -t $TARGET shell hilog -r
```

### 6.2 读取日志

```powershell
& $HDC -t $TARGET shell hilog -a 5
& $HDC -t $TARGET shell hilog --tail=100
```

### 6.3 筛选日志

```powershell
& $HDC -t $TARGET shell hilog --tail=200 --regex <关键字>
& $HDC -t $TARGET shell hilog --tail=200 --level=ERROR
```

如果没有匹配输出，不等于没有日志；应扩大关键字、级别或时间窗口继续确认。

### 6.4 命令组合黑名单

如果某个日志命令组合在本机失败或超时，把失败命令和原因写入 `.local-rules/device-hdc.local.md`。不要把未验证命令写入共享流程。

---

## 7. 应用等待调试与 bugreport

### 7.1 查看、设置、取消等待调试

```powershell
& $HDC -t $TARGET shell aa appdebug -g
& $HDC -t $TARGET shell aa appdebug -b $BUNDLE
& $HDC -t $TARGET shell aa appdebug -g
& $HDC -t $TARGET shell aa appdebug -c
```

默认不要使用 `-p/--persist` 设置持久等待调试。只要设置过等待调试，任务结束前必须执行 `aa appdebug -c` 取消。

### 7.2 导出 bugreport

```powershell
& $HDC -t $TARGET bugreport "$env:TEMP\ngf_bugreport.txt"
```

bugreport 文件路径、大小和采集时间写入本地规则库；不要提交 bugreport 文件。

---

## 8. 本地记录格式

将设备调试事实写入 `.local-rules/device-hdc.local.md`：

```markdown
## YYYY-MM-DD HDC / 设备探测

**适用范围**：当前机器 / 当前工作区 / 当前设备  
**验证命令**：`& $HDC list targets -v`  
**结果**：...  
**结论**：当前 target 使用 ...  
**失败命令**：如有，写明命令和错误输出  
**验证状态**：已实测  
```

---

## 9. 官方参考

- Huawei HarmonyOS `hdc` 命令：`https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/hdc`
- Huawei HarmonyOS `aa` 工具：`https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/aa-tool`
- Huawei HarmonyOS `bm` 工具：`https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/bm-tool`
- Huawei HarmonyOS HiLog 工具：`https://developer.huawei.com/consumer/en/doc/harmonyos-guides/hilog-tool`
