# rc.2 「无法新增工作区」根因分析

结论先说：**rc.2 给"新增工作区"加了一道新守卫，而它依赖一个端侧从未注册成功的槽位。**
这不是渲染问题，也不是权限问题，而是**版本升级引入的兼容性回归**。

---

## 一、判据链（全部来自设备实测，非推测）

### 1. 选择器在 rc.2 上**从未被调用过**

设备上遗留的诊断文件（宿主自己写的）：

| 文件 | 最后写入时间 | 内容 |
|---|---|---|
| `diag-pick-called` | **2026-09-24 14:21** | `id=pmuf58l1bjgdq2x` |
| `diag-resolve-dispatched` | 2026-09-24 14:21 | `cancelled` |
| `diag-select-returned` | 2026-09-24 14:21 | `count=0` |

对比：rc.2 核心树落地时间是 **2026-09-25 09:47**，当前设备时间 **09-25 16:10**。

⇒ **选择器最后一次被调用，比 rc.2 部署早 25 小时以上。** 在 rc.2 上点"新增工作区"时，
`pick()` 根本没被执行到 —— 与用户描述的"无法新增"一致。

### 2. rc.2 确实改了工作区 UI（rc.1 → rc.2 有实质差异）

设备上并存两棵树，直接对比 `dsh-client-ui-workspace/lib/client.js`：

| 关键词 | rc.1 | rc.2 | 说明 |
|---|---|---|---|
| `directoryBusy` | 0 | **9** | rc.2 新增"忙碌"状态 |
| `addRequested` | 0 | **4** | rc.2 新增"请求新增"状态 |
| `createWorkspaceShortcutControls` | 无 | **有** | rc.2 新增控制器 |
| `AddWorkspace` | 0 | **9** | rc.2 新增组件引用 |
| 文件大小 | 186,781 B | **197,861 B** | **+11,080 B** |

而 picker 包本身**逐字节相同**（`directory-picker-native` 3030+501 B，
`directory-picker-browse` 9309 B，两版一致）——
⇒ **变化在"调用方"，不在"选择器"。**

### 3. 断点定位到 rc.2 新增的这一行

`dsh-client-ui-workspace/lib/client.js:106`：

```js
const addReason = () => ctx.slots.entries("sidebar.workspaces.directoryFlow").length === 0
  ? t("shortcut.noPicker")                      // ← 槽位为空 → 判定"没有选择器"
  : controls.state.getSnapshot().directoryBusy
    ? t("shortcut.directoryBusy")
    : null;
```

line 149-158 是它的**唯一用途**，而且它是**硬门禁**（不是提示文案）：

```js
register("workspace.add", () => t("workspace.add"), ["add workspace","open folder"], "KeyO", …, () => {
  const reason = addReason();
  return reason === null
    ? { status: "handled", run: controls.add }   // 槽位在 → 可执行
    : { status: "blocked", reason };             // 槽位空 → 直接阻断
});
```

⇒ **`sidebar.workspaces.directoryFlow` 槽位为空 ⇒ "新增工作区"被 `blocked`。**

### 4. 该槽位由 native picker 的 `apply()` 注册

`dsh-client-ui-directory-picker-native/lib/client.js:62-76`：

```js
function apply(ctx) {
  const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
  const pick = desktop === void 0 ? () => ctx.uiWorkspace.pickDirectory() : () => desktop.pick();
  const injected = () => ({ pick });
  ctx.slots.inject("conversation.hero.workspace.directoryFlow", () =>
    ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
      yield ctx.slots.register({ name: "sidebar.workspaces.directoryFlow", inject: injected }, NativeDirectoryFlow);
    }));
}
```

**只有这段 `apply()` 跑起来，槽位才有内容。** rc.1 的按钮渲染守卫是
`directoryFlowAvailable`（较宽松）；rc.2 换成 `slots.entries(...).length === 0`
（严格计数）——**同一份配置，rc.2 下更容易判定为"不可用"。**

---

## 二、已排除的可能（避免走错方向）

| 假设 | 实测结果 |
|---|---|
| 配置漏了 picker | ✗ 排除。**部署版** profile（从 HAP 的 zip 里解出并核对）patch 完整保留 `- id: directory-picker / disabled: true` + 两条 `insert:` |
| 包缺失 | ✗ 排除。设备两棵树各有 **6 个** directory-picker 包；zip 里 `native` 14 个条目、`browse` 10 个条目 |
| 与官方 bundle 行 id 冲突 | ✗ 排除。官方仅定义 `- id: directory-picker`，与我们 insert 的 `directory-picker-browse` / `ui-directory-picker-native` 不重名 |
| 请求没发出去（网络/401） | ✗ 排除。宿主 HTTP 存活（`GET /` → 401，符合预期） |
| 宿主日志缺记录 | ⚠ 已澄清。日志里 336 条 `IN-` 中，**真正的请求记录为 0 条** —— 因为 `IN-REQ` 被 `DSHM_IN_LOG=1` 开关挡着（`main.js:218`）。所以"日志里没有"**不能**证明"请求没发"。这一条我一开始判断错了，已更正。 |

---

## 三、修复方向（三个层次，从轻到重）

### 方案 A：让槽位注册成功（治本，推荐先试）

native picker 的 `apply()` 需要 `globalThis.__DSH_DIRECTORY_PICKER__` 存在。
ArkTS 侧已有 `PICKER_SHIM_JS` 在 `javaScriptOnDocumentStart` 注入，但
**rc.2 的客户端 roster 是否真的扫描并加载了该包的 client 半边**，需要验证。

验证手段（**不是猜**）：临时设 `DSHM_IN_LOG=1` 起宿主，在页面里注入探针读取
```js
typeof globalThis.__DSH_DIRECTORY_PICKER__      // 期望 "object"
```
以及通过 cordis 客户端上下文查 `slots.entries("sidebar.workspaces.directoryFlow").length`。
若为 0，即确认本假设。

### 方案 B：把 insert 换成"官方 auto 面"（避开计数守卫）

rc.2 官方 bundle 默认挂 `directory-picker`（= `dsh-host-directory-picker-auto`）。
它会在启动时**动态挂载** native/browse 之一。若能让 auto 在端侧正确选中
native 面，则槽位由官方路径注册，我们不必自己 insert。
代价：auto 的平台探测逻辑不在我们控制内（现有注释记录：端侧被判定成 browse）。

### 方案 C：升级兼容层（不改行为，只让 UI 恢复可用）

在 `dshcompat` 里为 rc.2 记录本次形状变化，并在端侧补一个**兜底槽位注册**：
由宿主在前端 bootstrap 后注入一个最小的 directoryFlow 占用者，
使 `slots.entries(...).length > 0`。这样 rc.2 的守卫放行，
真正的选择动作仍走我们的 `__DSH_DIRECTORY_PICKER__` 三段式。

> 方案 C 是"针对上游守卫的适配"，不是改上游代码；但要守住一条纪律：
> **兜底槽位必须真的能完成选择**，否则按钮可点却点了没结果 —— 只是把
> "没反应"变成"点了报错"，不算修好。

---

## 四、下一步需要的验证（待执行）

1. 起一个 `DSHM_IN_LOG=1` 的宿主会话，抓 `IN-REQ` 确认点击时是否有 `workspace/*` 请求；
2. 注入探针读 `slots.entries("sidebar.workspaces.directoryFlow").length`，
   直接判定槽位是否为空（**这一步能一刀定性**）；
3. 读取 cordis 客户端 roster 日志，确认 native picker 的 client 半边是否被加载。

三项中第 2 项最关键 —— 它把"槽位为空"从推断变成实测。
