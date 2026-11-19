/**
 * DevEco Studio 安装根的**唯一解析口**（node 侧；PowerShell 侧是同目录的 `deveco-home.ps1`）。
 *
 * 【为什么要有这个文件】本仓一堆脚本要用 DevEco 自带的 node / jbr / hvigor / sdk /
 * hap-sign-tool，而这些路径原先**逐个写死**在脚本里（`C:\Program Files\Huawei\DevEco Studio`）。
 * 2026-10-10 用户把 DevEco 从 C 盘卸载、改装到 `D:\Program Files\Huawei\DevEco Studio`，
 * 于是**每一个**写死路径的脚本当场失效：装机（`update-device.ps1`）、发布签名
 * （`sign-release-hap.ps1`）、端侧验收（`device-acceptance.ps1` / `device-code-fingerprint.ps1`）全断。
 * 再写死另一个盘符只是把同一颗雷埋到下一位用户脚下，故收缩成一个候选列表。
 *
 * 【判据】候选根必须**真的含 hvigorw.js** 才算命中 —— 只看目录存在会把
 * 卸载后残留的空目录 `C:\Program Files\Huawei` 误判成安装根（实测：存在但为空）。
 * 2026-10-21 起为**双判据**（工作区迁鸿蒙 PC，DevEco Studio 鸿蒙版是 CLT 布局，
 * hvigorw 无 `tools/` 前缀；先例：check-arkts-entry.mjs 的 CLT 判据）：
 *   · `DEVECO_ROOT_MARKER`（Windows IDE 布局）：`tools/hvigor/bin/hvigorw.js`
 *   · `DEVECO_ROOT_MARKER_CLT`（鸿蒙 PC / CLT 布局）：`hvigor/bin/hvigorw.js`
 * 两条任一命中即算安装根；Windows 侧真根的判定结果不变。
 *
 * 【顺序】`DEVECO_HOME` → `~/devecostudio/Contents`（鸿蒙 PC 官方符号链接，
 * 用 `os.homedir()` 展开）→ `/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0`
 * （鸿蒙 PC hnp 安装根）→ `%ProgramFiles%` / `%ProgramFiles(x86)%` →
 * 逐盘符 `X:\Program Files\Huawei\DevEco Studio` → `X:\Huawei\DevEco Studio`。
 * 盘符 C 优先、A/B（软驱盘符）垫底，不为不存在的盘符白等。
 * 鸿蒙 PC 候选追加在 `DEVECO_HOME` 之后、Windows 候选之前：POSIX 候选路径在
 * Windows 上 existsSync 恒 false，零干扰；Windows 候选顺序与原版逐字一致。
 * 找不到返回 `null`：调用方自己决定 exit 3（没跑成）还是抛错，**不返回假路径**。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 命中判据（Windows IDE 布局）：安装根下必须有这个文件（相对路径）。导出与语义不变。 */
export const DEVECO_ROOT_MARKER = join('tools', 'hvigor', 'bin', 'hvigorw.js')

/** 命中判据（鸿蒙 PC / CLT 布局，2026-10-21 新增）：`hvigor/bin/hvigorw.js`（无 tools 前缀）。 */
export const DEVECO_ROOT_MARKER_CLT = join('hvigor', 'bin', 'hvigorw.js')

/**
 * 是不是一份可用的 DevEco 安装根。
 * 双判据任一命中即真（Windows 真根 / 鸿蒙 PC 真根都认）；两边都不含则为假。
 */
export function isDevecoRoot(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return false
  try {
    if (existsSync(join(dir, DEVECO_ROOT_MARKER))) return true
    if (existsSync(join(dir, DEVECO_ROOT_MARKER_CLT))) return true
    return false
  } catch {
    return false
  }
}

/** 盘符枚举顺序：C 优先，A/B 垫底（软驱盘符探测会卡）。 */
function driveOrder() {
  const out = ['C:']
  for (let c = 68; c <= 90; c++) out.push(String.fromCharCode(c) + ':')
  out.push('A:', 'B:')
  return out
}

/** 候选安装根（顺序即优先级；**不保证存在**，也**不保证可用**）。 */
export function devecoRootCandidates() {
  const out = []
  const push = (p) => {
    if (typeof p === 'string' && p.length > 0 && !out.includes(p)) out.push(p)
  }
  push(process.env.DEVECO_HOME)
  // 鸿蒙 PC 候选（2026-10-21 新增；追加在 DEVECO_HOME 之后、Windows 候选之前）：
  // ~/devecostudio/Contents 是 DevEco Studio 鸿蒙版装的官方符号链接；hnp 根是
  // 免链接的兜底（符号链接被删也能解析）。两条都是既定豁免位置——本仓其它工具
  // 一律经本解析口取路径，不许各自写死（check-deveco-paths 门禁守着）。
  push(join(homedir(), 'devecostudio', 'Contents'))
  push('/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0')
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'ProgramW6432']) {
    const base = process.env[key]
    if (base !== undefined && base.length > 0) push(join(base, 'Huawei', 'DevEco Studio'))
  }
  for (const drive of driveOrder()) {
    let reachable = false
    try {
      reachable = existsSync(drive + '\\')
    } catch {
      reachable = false
    }
    if (!reachable) continue
    push(join(drive + '\\', 'Program Files', 'Huawei', 'DevEco Studio'))
    push(join(drive + '\\', 'Huawei', 'DevEco Studio'))
  }
  return out
}

/** 解析安装根；找不到返回 `null`。 */
export function resolveDevecoRoot() {
  for (const c of devecoRootCandidates()) {
    if (isDevecoRoot(c)) return c
  }
  return null
}

/** 候选清单的人话（进错误信息用）。 */
export function devecoCandidatesHint() {
  return devecoRootCandidates().join(' / ')
}

/** 安装根下的一个相对路径；不存在返回 `null`（`root` 缺省时实时解析）。 */
export function devecoPath(relative, root = undefined) {
  const base = root === undefined ? resolveDevecoRoot() : root
  if (base === null || base === undefined || base === '') return null
  try {
    const p = join(base, relative)
    return existsSync(p) ? p : null
  } catch {
    return null
  }
}

/** DevEco 自带 SDK 根：`DEVECO_SDK_HOME` / `OHOS_SDK_HOME` 优先，其次 `<IDE>/sdk`。 */
export function devecoSdkHomeCandidates() {
  const out = []
  for (const v of [process.env.DEVECO_SDK_HOME, process.env.OHOS_SDK_HOME]) {
    if (v !== undefined && v.length > 0 && !out.includes(v)) out.push(v)
  }
  const root = resolveDevecoRoot()
  if (root !== null) out.push(join(root, 'sdk'))
  return out
}

/** 解析 SDK 根；找不到返回 `null`。 */
export function resolveDevecoSdkHome() {
  for (const c of devecoSdkHomeCandidates()) {
    try {
      if (existsSync(c)) return c
    } catch { /* 忽略 */ }
  }
  return null
}