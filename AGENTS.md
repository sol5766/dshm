# AGENTS.md — DSHM 项目工作约束

> 本文件是给自动化助手/AI 的工作约定。**违反会造成不可逆损失**，务必先读。

---

## 🔴 最高优先级：真机测试环境的保全

### 绝对禁止（除非用户明确说"全部清掉"）

**禁止执行任何会删除真机应用数据的命令**，包括但不限于：

```powershell
hdc uninstall com.dshm.dshclient          # ← 禁止
hdc shell bm uninstall -n com.dshm.dshclient   # ← 禁止
hdc shell bm uninstall -n <name>          # ← 禁止
hdc shell "rm -rf /data/app/el2/100/base/com.dshm.dshclient/*"   # ← 禁止
hdc shell "rm -rf .../haps/entry/files/dsh/home"                 # ← 禁止
```

**原因（真实事故，2026-09-25）**：
一次排障中执行了裸 `hdc uninstall`，把真机上用户的
**6 个历史会话、7 个插件、2 个工作区全部删除**，且系统备份为空、**不可恢复**。
更严重的是事后在报告里把该操作写成"清理环境（连数据一起清）"的正常步骤，
等于把破坏性操作固化成流程。

### 正确做法：一律覆盖安装

```powershell
hdc install -r <hap 路径>
```

`-r` = replace。同签名的覆盖安装**只替换代码与资源**（el1 下的 bundle），
**不动用户数据**（el2 下的 `files/dsh/home` 会话与插件、`toolchain`、`workspace`）。

### 唯一例外

| 情形 | 允许 | 必须 |
|---|---|---|
| 用户明确说"全部清掉"/"重新装" | 可卸载 | 先复述确认 |
| 换签名（调试证书 → 发布证书）导致覆盖安装失败 | `hdc uninstall -k <bundle>` | 卸载**立即验证数据仍在**，不可假定 `-k` 生效 |

即使有例外，也要**先问用户**，不要自行决定。

### 判断依据：这条命令会不会碰 el2

- `/data/app/el1/...` = 代码与资源 → 覆盖安装会换，**安全**
- `/data/app/el2/...` = **用户数据** → 任何删除都是不可逆的，**禁止**

---

## 回归纪律：不允许"修好后面、前面又坏"

1. **改动前**先跑基线并记录结果
2. **改动后**跑同一批，逐项对比；任何 ok → fail 必须当场修，不许延后
3. **临时实验**（如交换两行顺序做对照）必须在**同一次改动内还原**，
   并把验证到的结论写进代码注释，而不是留下实验代码

必跑的回归门禁：

```powershell
node tools/assert-cli-shim.mjs
node tools/assert-resfile-sync.mjs
node tools/check-parity.mjs
node tools/compat-drift.mjs
node tools/assert-exec-fix.mjs
node tools/assert-python-bridge.mjs
node tools/assert-fs-search-fallback.mjs
.\tools\device-acceptance.ps1        # 真机端侧验收
```

---

## 产物归置

| 类型 | 位置 | 说明 |
|---|---|---|
| 构建产物 | `entry/build/default/outputs/default/` | 会被 clean 覆盖，**不要当交付物留档** |
| 交付/侧载包 | `dist/sideload/` | 不会被构建清掉，含 README + 校验 |
| 文档 | `docs/` | 编号连续：`00-`…`80-` |
| 一次性排查脚本 | 用完即删 | 不要把临时诊断脚本留在 `tools/` |

---

## 其他既有约束（简摘）

- 核心树只认 `dist/core/work/dsh-core-<ver>` 与 profile 依赖树；
  HAP 生成的 `files/bin/*`、`profiles/*/cordis.patch.yml` 会被重建 ⇒ 修复落在
  `tools/pack-core.mjs`、`tools/place-toolchain.mjs`、`hostcore/app/*`、`hostruntime/*`
- Windows tar 会破坏 symlink（`bsdtar` 丢弃、`7z` 物化）⇒ 只允许 Python `tarfile`
- 所有沙箱内 ELF 必须**构建期自签名**（execve 受签名域管辖）
- 改 `hostcore/**` 后必须跑 `node tools/place-host-app.mjs` 并确认
  `assert-resfile-sync` 通过
