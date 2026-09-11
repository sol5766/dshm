# 国际化 (i18n) 自动化适配规范

**自动触发条件**：当 Agent 涉及“新建 UI 界面、修改页面文案、输出面向用户的 Toast/Dialog、配置 HdsNavigation/HdsNavDestination 标题”时，必须在动手前阅读本规范。

## 1. 核心目标：拒绝硬编码中文
在 HarmonyOS 开发中，所有面向用户展示的文本（包括但不限于 `Text()`, `Button()`, `TextInput({placeholder: ''})`, `showToast()`, 页面标题）都**绝对禁止**直接写死中文文本（如 `Text('确认')`）。必须全部抽离到 `string.json` 中，并使用 `$r('app.string.xxx')` 引用。

## 2. 键名与翻译规范
为了保持代码可读性和跨平台一致性：
- **键名格式**：采用蛇形命名法（Snake Case），如 `module_page_action`（例如 `settings_btn_clear_cache`）。
- **中文 (zh)**：遵循地道、简洁的口语化表达，避免机器翻译感。
- **英文 (en)**：
  - 必须使用符合移动端（iOS/Android/HarmonyOS）平台标准的术语，例如使用 "Settings" 而不是 "Setting"，"OK" 而不是 "Confirm"（在普通确认场景）。
  - 对于标题、按钮文本，使用 **首字母大写的 Title Case 规范**（如 "Clear All Data"）。
  - 避免中式英语。

## 3. 自动化资源注册脚本指南
为了避免手动修改 `string.json` 时破坏 JSON 语法，或者因多文件切换导致上下文丢失，你必须使用项目提供的批量注册脚本：

```powershell
python scripts/i18n_updater.py '[{"name":"btn_ok","zh":"确定","en":"OK"}, {"name":"title_settings","zh":"设置","en":"Settings"}]'
```

- 该脚本会自动解析传入的 JSON 数组，并将这些键值对分别去重追加到 `base/element/string.json`（中文）和 `en_US/element/string.json`（英文）中。
- 如果你的修改是针对子模块（例如 `ngf_framework`）的资源文件，可以增加 `--module` 参数：
  ```powershell
  python scripts/i18n_updater.py '[{"name":"xxx","zh":"中","en":"EN"}]' --module ngf_framework
  ```

## 4. 标准执行流程
当你需要为页面添加一段新文本时：
1. **生成翻译对**：在脑海中确定其 `name`、`zh` 和 `en`。
2. **运行脚本**：使用 `run_command` 调用 `scripts/i18n_updater.py` 写入资源配置。
3. **编写代码**：在 `.ets` 文件中，安全地使用 `$r('app.string.name')` 引用你刚才创建的文本。
