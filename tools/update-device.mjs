#!/usr/bin/env node
/**
 * DSHM 真机安全更新 —— 唯一允许的装机入口（node / 鸿蒙 PC 版）。
 *
 * 【来源】逐段移植自 `tools/update-device.ps1`（Windows 原版**保留不删**，
 * 双平台并存：Windows 侧继续用 .ps1，鸿蒙 PC / POSIX 侧用本文件，FR-011）。
 * 移植原则 = 忠实移植（plan.md D3）：每个判定、注释、输出文案逐项保留，
 * PowerShell → node 语义等价；CLI 参数换 kebab-case（-Hap → --hap 等）。
 *
 * 【为什么必须用这个脚本而不是手敲 hdc install】
 * 2026-09-25 的事故：为「清理环境」执行了裸 `hdc uni`+`nstall`，删掉了真机上
 * 用户的 6 个会话、7 个插件、2 个工作区，且不可恢复。
 * 根因不是「不知道 -r」，而是**把破坏性操作当成了流程的正常一步**。
 *
 * 所以本脚本的设计目标是：**让「删数据」这件事在流程里不存在**。
 *   · 全程只用 `hdc install -r`（覆盖安装），不出现任何卸载
 *   · 装完必须验证用户数据仍在，否则明确失败
 *   · 任一步失败就停，不静默继续
 *
 * 【用法】（CLI 对照 .ps1：-Target→--target / -SkipRebuild→--skip-build /
 *          -Hap→--hap / 新增 --build-mode；$BootWaitSec→--boot-wait-sec）
 *   node tools/update-device.mjs                          # 默认构建产物（debug）
 *   node tools/update-device.mjs --hap <路径>             # 指定 HAP
 *   node tools/update-device.mjs --skip-build             # 不重编，只装现有产物
 *   node tools/update-device.mjs --target <connectKey>    # 多台设备在线时指定装哪台
 *   node tools/update-device.mjs --build-mode release     # release 构建（默认 debug）
 *   node tools/update-device.mjs --boot-wait-sec 90       # 启动等待上限（默认 90s）
 *
 * 【鸿蒙 PC 适配差异（相对 .ps1，逐条留档）】
 *   · DevEco 布局：鸿蒙 PC 是 CLT 布局（hvigorw 在 <根>/hvigor/bin/，无 tools/ 前缀），
 *     经 tools/lib/deveco-home.mjs 双判据解析（DEVECO_ROOT_MARKER_CLT）。
 *   · 构建用**系统 node** 跑 hvigorw.js（.ps1 用 DevEco 自带 node.exe；鸿蒙 PC 按
 *     批次 A 契约用系统 node）。hvigor 参数与 .ps1 逐字一致。
 *   · hdc 一律经 tools/lib/hdc-client.mjs（多设备 -t 契约 / 宿主侧 Buffer 捕获）。
 *   · JAVA_HOME 只在 <DevEco 根>/jbr 存在时设置（Windows 布局；鸿蒙 PC 根下无 jbr）。
 *   · 默认 HAP 路径先找 entry-default-signed.hap，不存在时回退 entry-default-unsigned.hap
 *     （鸿蒙 PC 上 SignHap 预期失败 00303107——build-profile 的签名配置是 Windows 路径，
 *     晨间 DevEco GUI 自动签名解决，见 docs/212；回退时打 WARN，不静默）。
 *
 * 【退出码】0 成功；1 各失败段（与 .ps1 段落对应）；3 设备不在线。
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import {
  DEVECO_ROOT_MARKER,
  DEVECO_ROOT_MARKER_CLT,
  devecoCandidatesHint,
  devecoPath,
  resolveDevecoRoot,
} from './lib/deveco-home.mjs'
import { listTargets, probeHdc, resolveHdc, runHdc } from './lib/hdc-client.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)) // tools/.. = 仓库根
const SELF = fileURLToPath(import.meta.url)

// ── CLI ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opt = { target: '', skipBuild: false, hap: '', hsp: '', buildMode: 'debug', bootWaitSec: 90 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      printUsage()
      process.exit(0)
    } else if (a === '--target') {
      opt.target = argv[++i] ?? ''
    } else if (a === '--skip-build') {
      opt.skipBuild = true
    } else if (a === '--hap') {
      opt.hap = argv[++i] ?? ''
    } else if (a === '--hsp') {
      opt.hsp = argv[++i] ?? ''
    } else if (a === '--build-mode') {
      opt.buildMode = argv[++i] ?? 'debug'
    } else if (a === '--boot-wait-sec') {
      opt.bootWaitSec = parseInt(argv[++i] ?? '90', 10)
    } else {
      console.error(`未知参数：${a}`)
      printUsage()
      process.exit(2)
    }
  }
  if (opt.buildMode !== 'debug' && opt.buildMode !== 'release') {
    console.error(`--build-mode 只接受 debug|release，收到：${opt.buildMode}`)
    process.exit(2)
  }
  if (!Number.isInteger(opt.bootWaitSec) || opt.bootWaitSec <= 0) {
    console.error(`--boot-wait-sec 需为正整数，收到：${opt.bootWaitSec}`)
    process.exit(2)
  }
  return opt
}

function printUsage() {
  console.log('用法：node tools/update-device.mjs [--target <connectKey>] [--skip-build]')
  console.log('                       [--hap <路径>] [--hsp <路径>] [--build-mode debug|release] [--boot-wait-sec <秒>]')
}

const OPT = parseArgs(process.argv.slice(2))

// 【为什么必须有 --target（2026-10-13 加）】原先 hdc 调用一律不带 `-t`，而 `hdc list targets`
// 在多台设备同时在线时返回多行 —— 此时 hdc 自己会**拒绝执行**（实测原文：
// `[Fail]ExecuteCommand need connect-key? please confirm a device by help info`），
// 或者落到其中一台（取决于 hdc 版本）。PC + 手机同时连着时就无法「逐台指定」。
// 环境变量 HDC_TARGET 实测**不被 hdc 识别**，只有命令行 `-t <key>` 有效。
// 默认空 = 完全保持原行为（单设备时不受影响）。--target 非空时 hdc-client 的
// runHdc() 自动前插 `-t <target>`；本脚本自身不拼 `-t`（与 .ps1 的 $targs 同构）。

// ── 输出助手（对照 .ps1 的 Step/Ok/Bad/Info + Write-Host -ForegroundColor）──
const C = process.env.NO_COLOR ? {} : { cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', gray: '\x1b[90m', reset: '\x1b[0m' }
function Step(n, msg) { console.log(`\n${C.cyan ?? ''}[${n}] ${msg}${C.reset ?? ''}`) }
function Ok(msg) { console.log(`  ${C.green ?? ''}OK   ${msg}${C.reset ?? ''}`) }
function Bad(msg) { console.log(`  ${C.red ?? ''}FAIL ${msg}${C.reset ?? ''}`) }
function Info(msg) { console.log(`       ${C.gray ?? ''}${msg}${C.reset ?? ''}`) }
function Note(msg) { console.log(`  ${C.yellow ?? ''}NOTE ${msg}${C.reset ?? ''}`) }

function fail(msg, code = 1) {
  console.error(`\n${C.red ?? ''}错误：${msg}${C.reset ?? ''}`)
  process.exit(code)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 路径 ─────────────────────────────────────────────────────────────────
// 【为什么不写死】原先写死 `C:\Program Files\Huawei\DevEco Studio\tools`；2026-10-10
// 用户把 DevEco 从 C 盘卸载、改装到 D 盘，本脚本（**唯一允许的装机入口**）当场失效：
// 找不到 hvigorw 就没法构建，装机链条整条断。解析口收在 tools/lib/deveco-home.mjs
// （候选列表 + 双判据：`tools/hvigor/bin/hvigorw.js`〔Windows IDE〕或
// `hvigor/bin/hvigorw.js`〔鸿蒙 PC CLT〕，任一命中才算安装根）。可用 DEVECO_HOME 覆盖。
const hvigorw = devecoPath(DEVECO_ROOT_MARKER) ?? devecoPath(DEVECO_ROOT_MARKER_CLT)
if (hvigorw === null) {
  fail(`找不到 DevEco 的 hvigorw（装机要它的 hvigor 构建）。\n  候选：${devecoCandidatesHint()}\n  可用环境变量 DEVECO_HOME 指定 DevEco 安装根`)
}
// clt = 含 hvigor/ 的那一层目录：Windows IDE 布局 = <安装根>/tools；鸿蒙 PC CLT 布局 = 安装根本身。
const cltDir = resolve(hvigorw, '..', '..', '..')
const devEcoRoot = resolveDevecoRoot()

const hdcPath = resolveHdc()
if (hdcPath === null) {
  fail('找不到 hdc：DSHM_HDC 环境变量、DevEco 根 sdk/default/openharmony/toolchains/、PATH 三处都没有')
}

// bundle 名不写死：先 build-profile.json5，再 AppScope/app.json5（2026-10-18 教训：
// beta 工作区里写死正式包名会让整套验收读错应用）。
let bundle = ''
const profileText = (() => {
  try { return readFileSync(join(ROOT, 'build-profile.json5'), 'utf8') } catch { return '' }
})()
const mBundle = profileText.match(/"bundleName"\s*:\s*"([^"]+)"/)
if (mBundle) {
  bundle = mBundle[1]
} else {
  const appText = readFileSync(join(ROOT, 'AppScope', 'app.json5'), 'utf8')
  const mApp = appText.match(/"bundleName"\s*:\s*"([^"]+)"/)
  if (mApp) bundle = mApp[1]
}
if (bundle === '') fail('无法从 build-profile.json5 / AppScope/app.json5 解析 bundleName')
/*
 * `--hap` 可以来自另一个 product（尤其是 beta：bundle=com.dshm.dshmbeta），
 * 而仓库源码在本轮构建结束后已经恢复成正式 bundle。若仍拿源码 bundle 去查
 * 数据基线和 pid，会看错应用、误判数据丢失。显式传入 HAP 时以包内身份为准。
 */
if (OPT.hap !== '' && OPT.hap.toLowerCase().endsWith('.hap') && existsSync(OPT.hap)) {
  try {
    const mjText = readZipEntryText(OPT.hap, 'module.json')
    const packagedBundle = mjText === null ? '' : (mjText.match(/"bundleName"\s*:\s*"([^"]+)"/)?.[1] ?? '')
    if (packagedBundle !== '' && packagedBundle !== bundle) {
      const sourceBundle = bundle
      bundle = packagedBundle
      Info(`bundle 以 --hap 包内身份为准：${sourceBundle} → ${bundle}`)
    }
  } catch {
    // 包不可读时保留源码 bundle；后面的 HAP 校验会给出明确失败。
  }
}
let moduleName = ''
let filesDir = ''

// hdc shell 封装（.ps1 的 Shell()：2>&1 合并后 trim；判定读取一律用宿主侧捕获）。
function shell(cmd) {
  const r = runHdc(hdcPath, OPT.target, ['shell', cmd])
  return (r.stdout + r.stderr).trim()
}

function selectModuleName(rawType) {
  if (/phone/.test(rawType)) return 'phone'
  return 'entry'
}

// ── 0) 硬约束自检：本脚本自身不得含破坏性命令 ────────────────────────────
// 【为什么不做全文本扫描】前两版都误报了：
//   v1 扫全文 → 被自己的注释命中，一运行就 throw
//   v2 去掉 # 开头的行 → 仍误报，因为块注释的内容不以 # 开头，
//      且提示文字**必须**提到这些命令名（否则没法向人解释禁止原因）
// 纯文本扫描分不清「提到」与「执行」。改成只检查**真正的命令调用形态**。
// （node 版形态对照：`& $hdc …`〔PS 调用〕→ runHdc/spawnSync 调用；其余判据同源。）
function selfCheck() {
  const violations = []
  const UNST = 'unin' + 'stall' // 片段拼接：避免模式串本身被后续匹配到
  const rmRf = new RegExp('rm' + '\\s+' + '-rf')
  const lines = readFileSync(SELF, 'utf8').split('\n')
  let inBlock = false
  for (const raw of lines) {
    const t = raw.trim()
    if (inBlock) {
      if (t.includes('*/')) inBlock = false
      continue
    }
    if (t === '' || t.startsWith('//') || t.startsWith('*')) continue
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true
      continue
    }
    // 形态一：真实调用 hdc（runHdc/spawnSync）且带卸载子命令
    if (/\b(?:runHdc|spawnSync)\s*\(/.test(t) && t.includes(UNST)) { violations.push(t); continue }
    // 形态二：shell 串里跑 bm 卸载
    if (/\bbm\b/.test(t) && t.includes(UNST)) { violations.push(t); continue }
    // 形态三：任何 rm -rf
    if (rmRf.test(t)) violations.push(t)
  }
  return violations
}

Step(0, '自检：确认本脚本不含任何卸载/删数据命令')
const violations = selfCheck()
if (violations.length > 0) {
  Bad('代码里出现了卸载/删数据调用：')
  for (const v of violations) console.log(`    ${v}`)
  fail('拒绝运行：本脚本只允许覆盖安装')
}
Ok('无卸载调用，符合「永不删数据」约束')

// ── 1) 设备 ──────────────────────────────────────────────────────────────
Step(1, '检查设备连接')
const hdcProbe = probeHdc(hdcPath)
const online = hdcProbe.targets
if (online.length === 0) {
  /*
   * 【2026-10-28】旧实现一律报"没有设备" —— 但 hdc **完全无输出**（应用域连不上服务端）
   * 与真·`[Empty]` 是两回事，混为一谈会把"工具跑错地方"说成"你没插设备"。
   */
  if (!hdcProbe.available) {
    Bad('hdc 不可用（不是"没有设备"）')
    console.log(`    ${hdcProbe.note}`)
    console.log('    下一步：在桌面终端 / DevEco 侧运行本脚本，或设 DSHM_HDC 指向可用的 hdc')
  } else {
    Bad('没有连接的设备')
    console.log(`    ${hdcProbe.note}`)
  }
  fail('请先连接设备', 3)
}
let dev = ''
if (OPT.target !== '') {
  // 【为什么在这里校验】`-t` 指到一台不在线的 key 时，后续每一条 hdc 调用都会各自报错，
  // 排障会被淹没在噪声里；不如在入口一次讲清楚「这台不在线、现在在线的是哪几台」。
  if (!online.includes(OPT.target)) {
    Bad(`指定设备 ${OPT.target} 不在线。当前在线：${online.join(', ')}`)
    fail(`设备 ${OPT.target} 未连接`, 3)
  }
  dev = OPT.target
  Ok(`设备 ${dev}（本次指定，共在线 ${online.length} 台）`)
} else {
  dev = online[0]
  Ok(`设备 ${dev}`)
  if (online.length > 1) {
    Note(`当前有 ${online.length} 台设备在线，本次按「首台」处理（${dev}）。要装另一台请加 --target <key>。`)
  }
}
const rawType = shell('param get const.product.devicetype').trim()
moduleName = selectModuleName(rawType)
filesDir = `/data/app/el2/100/base/${bundle}/haps/${moduleName}/files`
Ok(`设备形态=${rawType || 'unknown'}，本地 entry 模块=${moduleName}`)

// ── 2) 记录安装前的数据基线（用于装后比对）───────────────────────────────
Step(2, '记录安装前的用户数据基线')
const beforeHomeStat = shell(`stat -c 'links=%h size=%s' ${filesDir}/dsh/home 2>/dev/null`)
const beforeHomeCount = shell(`ls ${filesDir}/dsh/home 2>/dev/null | wc -l`)
const beforeCores = shell(`ls ${filesDir}/dsh/cores 2>/dev/null`)
// 【为什么用 stat 而不是 `ls | wc -l`（2026-10-05 修）】`dsh/home` 是 **0700**、`hdc shell` 是另一个 uid
// ⇒ `ls` 被拒、`| wc -l` **恒 0**，于是这里每次打「home 为空」、第 7 步必然 SKIP ——
// 那个「数据保全」校验是**结构性假通过**，还会把人误导成「数据被清了」。
// 实测：同一时刻 `stat` 给出 `links=13 size=3440`（数据完好）。`stat` 读目录本身可用 ⇒ 改用它做判据。
const mLinks = beforeHomeStat.match(/links=(\d+)/)
const beforeHomeLinks = mLinks ? parseInt(mLinks[1], 10) : -1
Info(`home 指纹：${beforeHomeStat}`)
Info(`核心树：${beforeCores.split('\n').filter((s) => s.trim() !== '').join(', ')}`)
if (beforeHomeLinks < 0) {
  Note('拿不到 home 指纹（路径不存在或权限受限）——本次无法比对数据保全')
} else if (parseInt(beforeHomeCount, 10) === 0) {
  Info('（`ls` 读不到条目是**预期**：home 是 0700、shell 是另一个 uid；以指纹为准，不要据此判断「数据被清」）')
}

// ── 2b) 日志台账基线（本轮「新鲜度」判据）──────────────────────────────────
// 【为什么必须有这一段（2026-10-06 真机踩到）】`dshm-host.log` 是**跨 boot 追加**的
// （首行至今仍是 2026-09-27 的 boot 标记），而第 8 步原先只取「最后一行 exec 探测」——
// 于是一次 `hdc install -r` 之后应用根本没起来，脚本照样报
//   OK   Host HTTP 已就绪（有 websocket 接入）
//   FAIL exec 探测未全通（共 13 项）：…（**上一轮**的读数）
// 即「端侧就绪」是**假绿**，而它正是「装机到底成没成」的唯一判据。改法：先记几个只增不减的
// 计数器，装后必须**增加**才认这一轮。
function LogCount(pattern) {
  // 【必须带 -e（2026-10-06 实测）】模式串以 `-` 开头时（如 `--- boot pid=`）会被 grep
  // 当成选项：`grep -c '--- boot pid='` 实测返回 **0**（不是报错），基线因此静默变成 0。
  const n = shell(`grep -c -e '${pattern}' ${filesDir}/dshm-host.log 2>/dev/null`)
  if (/^\d+$/.test(n.trim())) return parseInt(n, 10)
  return 0
}
const beforeBootCount = LogCount('--- boot pid=')
const beforeExecCount = LogCount('exec 探测：')
const beforeMuxCount = LogCount('IN-UPGRADE GET /api/remote.mux')
// 【插件市场重启也要计数（2026-10-09 加）】见第 6 步之后的说明：装完 1~2 分钟内插件市场页面**自己**
// 会 POST /dsh-market/restart 让宿主冷启动（`host-exit-mode=app-restart` ⇒ ArkTS 侧重新拉起）。
// 那一天现场就是被这个现象绕进去的（「App 怎么退出了？」），所以这里记个基线，末尾如实报出来。
const beforeMarketCount = LogCount('POST /dsh-market/restart')
Info(`日志台账基线：boot=${beforeBootCount} exec=${beforeExecCount} mux=${beforeMuxCount} market=${beforeMarketCount}`)

// ── 3) 构建 ──────────────────────────────────────────────────────────────
function buildEnv() {
  const env = { ...process.env }
  // .ps1：JAVA_HOME = <DevEco 根>\jbr；鸿蒙 PC 根下无 jbr（hvigor 为纯 node 实现），
  // 仅在存在时设置，不造假路径。
  const jbr = join(devEcoRoot, 'jbr')
  const pathPre = []
  if (existsSync(jbr)) {
    env.JAVA_HOME = jbr
    pathPre.push(join(jbr, 'bin'))
  }
  env.DEVECO_SDK_HOME = join(devEcoRoot, 'sdk')
  env.DEVECO_CLI_CLT_PATH = cltDir
  // PATH 前插 DevEco 自带 node（Windows 布局 <clt>/node；CLT 布局 <clt>/node/bin）
  for (const nd of [join(cltDir, 'node'), join(cltDir, 'node', 'bin')]) {
    if (existsSync(nd)) pathPre.push(nd)
  }
  env.PATH = [...pathPre, process.env.PATH ?? ''].filter((s) => s !== '').join(delimiter)
  return env
}

async function runBuild() {
  // 【口径订正（2026-10-15）】本步骤默认仍是 debug 构建（端侧调试用）。
  // 交付给用户的**侧载件**自 docs/148 起已统一为 release 构建（`dist/sideload/` 里那件，
  // release 构建 + 调试签名，可直接 install -r）⇒ 装侧载件请走 `--hap <dist/sideload/…> --skip-build`，
  // 不要用本步骤的产物去比对侧载件的读数。
  Step(3, `构建 ${OPT.buildMode} 版（端侧调试用；侧载交付件是 release 构建，走 --hap + --skip-build）`)
  const buildLog = join(ROOT, 'dist', '_update_build.log')
  const logFd = openSync(buildLog, 'a')
  const args = [hvigorw, 'assembleHap', '--mode', 'module', '-p', `module=${moduleName}@default`, '-p', 'product=default', '-p', `buildMode=${OPT.buildMode}`, '--no-daemon']
  const t0 = Date.now()
  // 构建调用 = 系统 node 跑 hvigorw.js（.ps1 是 DevEco 自带 node.exe；鸿蒙 PC 契约见头注）。
  // stdout/stderr 全量落 dist/_update_build.log（= .ps1 的 *> 重定向），退出码判定成败。
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: ['ignore', logFd, logFd], env: buildEnv() })
  closeSync(logFd)
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  if (r.status !== 0) {
    const tail = readFileSync(buildLog, 'utf8').split('\n').filter((l) => l !== '').slice(-25)
    for (const l of tail) console.log(l)
    // 【识别 hvigor 的「假 ENOENT」（2026-10-09 实测踩到）】hvigorw 在**装自己的构建工具**失败时，
    // 会用一个**硬编码**报文把任何异常都写成
    //   00308003 … ENOENT: no such file …\.hvigor\project_caches\<hash>\workspace\node_modules\@ohos\hvigor\bin\hvigor.js
    // 再附一句 `delete <workspace> and retry`。实测这**不是**文件真缺：`fs.realpathSync` 手测通过、
    // 目标目录 2577 个文件齐全 ⇒ 照那句话去删缓存白跑一趟。真因是**当前进程写不了
    // `~/.hvigor`**（在沙箱里跑 hvigor 就是这个症状：hvigor 要在 project_caches
    // 里建/更新自己的工具链）。故这里把人话讲清楚，别让人去删缓存。
    const logText = readFileSync(buildLog, 'utf8')
    if (logText.includes('00308003') || logText.includes('project_caches')) {
      console.log('')
      Note('上面这条 ENOENT 是 hvigor 的**硬编码假报文**（「装自己的构建工具失败」被一律写成缺 hvigor.js）。')
      Note('实测真因通常是**当前进程写不了 ~/.hvigor**：hvigor 要在 project_caches 里')
      Note('建/更新自己的工具链，写不进去就在这一步失败（它自己那句 "delete <workspace> and retry"')
      Note('**不解决**这类问题 —— 缓存删了照样失败）。')
      Note('⇒ 在**沙箱外**（`.hvigor` 可写）重跑本脚本；若仍报同一条，再查构建依赖能不能装。')
    }
    // 【鸿蒙 PC 迁移适配（2026-10-21）】SignHap 00303107 = build-profile.json5 的签名配置指向
    // Windows 侧物料路径（本机无 com.dshm.dshmbeta 的签名 profile）。这是**预期失败**：
    // 编译/打包已完成，entry-default-unsigned.hap 已产出；晨间 DevEco GUI 自动签名后消除。
    // 只解释、不吞错：构建仍按失败处理（fail-fast 契约不变）。
    if (logText.includes('00303107')) {
      console.log('')
      Note('SignHap 00303107（Invalid storeFile）：build-profile.json5 的签名配置还是 Windows 侧路径，')
      Note('本机（鸿蒙 PC）暂无 com.dshm.dshmbeta 的签名 profile —— 属**预期失败**：CompileArkTS/')
      Note('PackageHap 已完成，entry-default-unsigned.hap 已产出。晨间 DevEco GUI 自动签名后消除')
      Note('（步骤见 docs/212）；unsigned HAP 不能直接装机（设备会拒签）。')
    }
    fail(`构建失败（耗时 ${elapsed}s）`)
  }
  Ok(`构建成功（耗时 ${elapsed}s）`)
}

if (!OPT.skipBuild) {
  await runBuild()
} else {
  Step(3, '跳过构建（--skip-build）')
}

// ── 4) 定位 HAP ──────────────────────────────────────────────────────────
Step(4, '定位 HAP')
const outputsDir = join(ROOT, moduleName, 'build', OPT.buildMode, 'outputs', 'default')
if (OPT.hap === '') {
  const signed = join(outputsDir, `${moduleName}-default-signed.hap`)
  const unsigned = join(outputsDir, `${moduleName}-default-unsigned.hap`)
  if (existsSync(signed)) {
    OPT.hap = signed
  } else if (existsSync(unsigned)) {
    OPT.hap = unsigned
    Note(`默认的 ${moduleName}-default-signed.hap 不存在，回退未签名件：${unsigned}`)
    Note('未签名 HAP 装机会被设备拒签（signature verification failed 同族）——仅构建验证用；装机需已签名件。')
  } else {
    OPT.hap = signed
  }
}
if (OPT.hap.toLowerCase().endsWith('.app')) {
  fail('拒绝把 .app 交给本地安装器：本地一次只能安装一个 entry HAP + 一个 shared HSP')
}
if (!existsSync(OPT.hap)) fail(`找不到 HAP：${OPT.hap}`)
{
  const mjText = readZipEntryText(OPT.hap, 'module.json')
  const selected = mjText === null ? '' : (mjText.match(/"name"\s*:\s*"([^"]+)"/)?.[1] ?? '')
  if (selected !== '' && selected !== moduleName) {
    fail(`HAP 模块=${selected}，但当前设备需要 ${moduleName}；本地一次只能安装一个 entry`)
  }
}
if (OPT.hsp === '') {
  OPT.hsp = join(ROOT, 'hostruntime', 'build', OPT.buildMode, 'outputs', 'default',
    'hostruntime-default-signed.hsp')
}
if (OPT.hsp.toLowerCase().endsWith('.app')) {
  fail('拒绝把 .app 交给本地安装器：共享 HSP 必须单独传入')
}
if (!existsSync(OPT.hsp)) fail(`找不到 shared HSP：${OPT.hsp}`)
{
  const fdHap = openSync(OPT.hap, 'r')
  const st = fstatSync(fdHap)
  closeSync(fdHap)
  const hapSizeMiB = (st.size / 1024 / 1024).toFixed(1)
  Ok(`${hapSizeMiB} MiB  ${OPT.hap}`)
  Ok(`shared HSP  ${OPT.hsp}`)
}

// 【为什么要读包的 debug 标志（2026-10-15 加）】第 8 步的 exec 探针判据必须按**包的构建模式**分档：
//   · debug 件（module.json "debug":true）⇒ 平台给调试域，应用数据区里的可执行文件能 execve ⇒
//     「逐项全 ok」是强判据；
//   · release 件（"debug":false）⇒ 平台降级应用域（本机 PC 实测 `u:r:normal_hap:s0`），
//     应用数据区里的可执行文件一律 EPERM（python3.12 / rg / ash / bash），system-sh 连 stat 都被拒（=缺）。
//     这是 docs/140 / docs/154 已定案的平台行为，且三端终端与 bash 自 docs/155 起统一走 guest VM
//     ⇒ 宿主 execve 不再是产品依赖路径。release 件下再按「逐项全 ok」判 = **假红**（真实撞到：
//     2026-10-15 凌晨 .50 release 侧载件装机后本脚本 rc=1，而端侧 vm-bash 接管与功能都正常）。
// 读不到 debug 标志时保持从严（hapDebug = null ⇒ 仍按「逐项全 ok」），绝不因为解析失败而放宽。
//
// 最小 zip 读条目实现（EOCD → 中央目录 → 局部头 → inflateRaw）：只服务于读 HAP 里的
// module.json 判 debug 标志，node 标准库无 zip、不为一个标志引第三方依赖。
function readZipEntryText(zipPath, entryName) {
  const fd = openSync(zipPath, 'r')
  try {
    const size = fstatSync(fd).size
    const maxBack = Math.min(size, 22 + 65535)
    const tail = Buffer.alloc(maxBack)
    readSync(fd, tail, 0, maxBack, size - maxBack)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    }
    if (eocd < 0) return null
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    const cd = Buffer.alloc(cdSize)
    readSync(fd, cd, 0, cdSize, cdOffset)
    let p = 0
    while (p + 46 <= cdSize) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break
      const method = cd.readUInt16LE(p + 10)
      const compSize = cd.readUInt32LE(p + 20)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const localOffset = cd.readUInt32LE(p + 42)
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
      if (name === entryName) {
        const lh = Buffer.alloc(30)
        readSync(fd, lh, 0, 30, localOffset)
        if (lh.readUInt32LE(0) !== 0x04034b50) return null
        const lNameLen = lh.readUInt16LE(26)
        const lExtraLen = lh.readUInt16LE(28)
        const dataStart = localOffset + 30 + lNameLen + lExtraLen
        const data = Buffer.alloc(compSize)
        readSync(fd, data, 0, compSize, dataStart)
        if (method === 0) return data.toString('utf8')
        if (method === 8) return inflateRawSync(data).toString('utf8')
        return null
      }
      p += 46 + nameLen + extraLen + commentLen
    }
    return null
  } finally {
    closeSync(fd)
  }
}

let hapDebug = null
try {
  const mjText = readZipEntryText(OPT.hap, 'module.json')
  if (mjText !== null) {
    const mDebug = mjText.match(/"debug"\s*:\s*(true|false)/)
    if (mDebug) hapDebug = mDebug[1] === 'true'
  }
} catch (e) {
  Info(`读包内 module.json 失败（${e && e.message ? e.message : e}）—— 第 8 步判据按从严处理`)
}
if (hapDebug === null) {
  Info('包形态：未知（第 8 步 exec 判据按「逐项全 ok」从严）')
} else {
  Info(`包形态：${hapDebug ? 'debug（调试域，应用数据区可执行文件应可 execve）' : 'release（应用域降级：应用数据区可执行文件 EPERM 属预期，见 docs/140·155）'}`)
}

// ── 5) 覆盖安装（唯一的装机动作）─────────────────────────────────────────
Step(5, '覆盖安装（hdc install -r —— 保留用户数据）')
// 【为什么不能只看 `successfully`（2026-10-10 真机踩到）】`hdc install -r` 会**偶发回空输出**：
// 现场得到空串 ⇒ 旧判据「不含 successfully」当场判「安装失败」，可手动重跑同一条命令却
// `rc=0` + `install bundle successfully`（`docs/143` §7）。
// ⇒ 判据改三态：含 successfully ⇒ ok；含 fail ⇒ fail；**回空**（既非成功也非失败）⇒ 重跑一次，
//    仍空就改用 `bm dump` 的 `updateTime` 正面判定（那是安装/更新时刻的毫秒数，变了=这次真装上去了）。
function BundleUpdateTime() {
  const dump = shell(`bm dump -n ${bundle}`)
  const m = dump.match(/"updateTime"\s*:\s*(\d+)/)
  return m ? m[1] : ''
}
const before = BundleUpdateTime()
const installArgs = ['install', '-r', '-p', OPT.hap, OPT.hsp]
let installOut = runHdc(hdcPath, OPT.target, installArgs)
let out = (installOut.stdout + installOut.stderr).trim()
let verdict = 'unknown'
if (/successfully/.test(out)) { verdict = 'ok' }
else if (/fail/i.test(out)) { verdict = 'fail' }
else {
  Info(`hdc install -r 回空/无法判读（原文：'${out}'）⇒ 重跑一次`)
  installOut = runHdc(hdcPath, OPT.target, installArgs)
  out = (installOut.stdout + installOut.stderr).trim()
  if (/successfully/.test(out)) { verdict = 'ok' }
  else if (/fail/i.test(out)) { verdict = 'fail' }
  else {
    const after = BundleUpdateTime()
    if (before !== '' && after !== '' && after !== before) {
      verdict = 'ok'
      Info(`两次输出都判不出来，但 bm dump 的 updateTime 已变（${before} → ${after}）⇒ 认定安装成功`)
    }
  }
}
if (verdict !== 'ok') {
  Bad(`安装失败（判读=${verdict}），原始输出：`)
  console.log(out)
  console.log('')
  Note('若报签名冲突（signature verification failed）：')
  Note('    · 先问用户，不要自行卸载')
  Note('    · 确需卸载时用 hdc uni' + 'nstall -k，且卸载后立即验证数据仍在')
  fail('安装失败')
}
Ok('覆盖安装成功')

// ── 6) 冷启动 ────────────────────────────────────────────────────────────
Step(6, '冷启动应用')
// 【本步的判据是 `pidof`，不是 aa 返回的那句话（2026-10-09 加）】
// `pidof <bundle>` 实测给出 main.js 那条主进程 pid（与日志里 `--- boot pid=` 一致）；ps 里另有
// `:entry:BackGroundAbility` / `:gpu` 等子进程，它们不影响「是否走了 onNewWant」，故不参与判定。
function AppAlive() { return shell(`pidof ${bundle}`).trim() }
async function StopApp() {
  // 返回 true = 已确认不在跑（pidof 为空）。**重试是必需的**：实测那次 `aa force-stop` 明明回
  // `force stop process successfully.` 而进程**还在**（旧进程的事件循环正卡在 statSync 风暴里，
  // 日志有 `LOOP-GAP 17964ms`），隔几秒再停一次就停掉了。
  for (let tr = 1; tr <= 3; tr++) {
    const forceOut = shell(`aa force-stop ${bundle}`)
    await sleep(2000 * tr)
    const alive = AppAlive()
    if (alive === '') return true
    Info(`aa force-stop 第 ${tr} 次没停下来（pid ${alive} 还在）：${forceOut}`)
  }
  return false
}
// 【为什么必须判 force-stop（2026-10-09 真机踩到）】原先不看输出与返回值，随后只轮询
// 「本轮 exec 探测增加」。那次 force-stop 没生效 ⇒ 紧接着的 `aa start` 走的是 **onNewWant**
// （复用已有 ability）⇒ **不产生新 boot**、日志里没有新的 exec 探测，于是第 6 步报**假 FAIL**
// （现场表现：「装完就说端侧没起来」，而应用一直在跑、跑的也还是旧代码）。
// 判据用 `pidof` 而**不是** aa 那句 `force stop process successfully.` —— 后者实测会撒谎。
const stopped = await StopApp()
if (stopped) {
  Ok('旧进程已停（pidof 为空）')
} else {
  Note('三次 aa force-stop 后进程仍在（每拍的 pid 见上）—— 它一直活着的话，下面的 aa start 会走 onNewWant、不会产生新 boot')
}
await sleep(1000)
shell(`aa start -a EntryAbility -b ${bundle}`)
// 【为什么从「盲等 90 秒」改成「轮询到出现本轮 exec 探测」（2026-10-06 真机踩到）】
// 盲等只能保证「过了 90 秒」，不能保证「应用起来了」：实测 `hdc install -r` 之后那一次
// `aa start` 没把应用拉起来（日志停在上一轮的 LOOP-ALIVE），而第 8 步读到上一轮日志，
// 于是脚本报「端侧就绪」。轮询判据用 2b 记下的 exec 计数增量——它只在**真 boot** 时长。
// 【为什么要打进度（2026-10-09 加）】原先这 90 秒是**全静默**的（真机上让人以为脚本卡死），
// 而「卡在哪一拍」恰恰是排障最想要的读数 ⇒ 每 15 秒打一条 boot/exec/pid。
Info(`等待启动（最多 ${OPT.bootWaitSec} 秒；首次可能需解包核心树）`)
let booted = false
let waited = 0
while (waited < OPT.bootWaitSec) {
  await sleep(5000)
  waited += 5
  if (LogCount('exec 探测：') > beforeExecCount) { booted = true; break }
  if (waited % 15 === 0) {
    Info(`t=${waited} s：boot ${beforeBootCount} → ${LogCount('--- boot pid=')}，exec ${beforeExecCount} → ${LogCount('exec 探测：')}，pid=[${AppAlive()}]`)
  }
}
if (booted) {
  Ok(`端侧已起来（第 ${waited} 秒出现本轮 exec 探测）`)
} else {
  Info(`第 ${waited} 秒仍未见本轮 boot —— 再停一次再拉（实测 install 后首次 aa start 有概率不生效；旧进程没停掉的活 aa start 只会走 onNewWant）`)
  await StopApp()
  shell(`aa start -a EntryAbility -b ${bundle}`)
  await sleep(25000)
  if (LogCount('exec 探测：') > beforeExecCount) {
    Ok('重拉之后端侧已起来')
  } else {
    Bad('端侧没有起来：本轮没有任何新的 exec 探测行')
    // 【超时诊断（2026-10-09 加）】把现场就地打出来。原先只有一句 Bad，排障还得再连一次
    // hdc 挨个查（pid 在不在 / 有没有新 boot / 日志停在哪）—— 而这几条正是决定下一步的关键读数。
    const aliveEnd = AppAlive()
    if (aliveEnd !== '') {
      Info(`进程仍在（pid=[${aliveEnd}]）⇒ 旧进程没停掉、aa start 只能走 onNewWant：**不会有新 boot**。这不是装机失败，是「停不掉进程」`)
    } else {
      Info('进程已不在（pidof 为空）⇒ aa start 没能把它拉起来')
    }
    Info(`末次 boot 行：${shell(`grep -a -e '--- boot pid=' ${filesDir}/dshm-host.log 2>/dev/null | tail -1`)}`)
    Info('ps（主进程 + 子进程）：')
    for (const ln of shell(`ps -ef | grep ${bundle} | grep -v grep | head -4`).split('\n')) Info(`  ${ln.trim()}`)
    Info('日志末尾：')
    for (const ln of shell(`tail -n 6 ${filesDir}/dshm-host.log`).split('\n')) Info(`  ${ln.trim()}`)
  }
}

// ── 7) 验证：数据是否保留 ────────────────────────────────────────────────
Step(7, '验证用户数据仍在（这是关键一步）')
const afterHomeStat = shell(`stat -c 'links=%h size=%s' ${filesDir}/dsh/home 2>/dev/null`)
const afterCores = shell(`ls ${filesDir}/dsh/cores 2>/dev/null`)
const mAfterLinks = afterHomeStat.match(/links=(\d+)/)
const afterHomeLinks = mAfterLinks ? parseInt(mAfterLinks[1], 10) : -1
Info(`home 指纹：${beforeHomeStat} → ${afterHomeStat}`)
Info(`核心树：${afterCores.split('\n').filter((s) => s.trim() !== '').join(', ')}`)

let dataOk = true
let dataChecked = false
if (beforeHomeLinks < 0 || afterHomeLinks < 0) {
  Note('拿不到 home 指纹（路径不存在或权限受限）——本次无法比对')
} else {
  // 【判据：子目录数（links）不得减少】目录的 `size` 会随目录项增减而变、也可能因实现而异
  // ⇒ 只把它当参考值打印；**减少**才是数据丢失的信号（相等/增加都算保留）。
  dataChecked = true
  if (afterHomeLinks < beforeHomeLinks) {
    Bad(`home 子目录数减少（links ${beforeHomeLinks} → ${afterHomeLinks}）—— 数据可能丢失`)
    dataOk = false
  } else {
    Ok(`home 指纹：子目录数未减少（links ${beforeHomeLinks} → ${afterHomeLinks}；${afterHomeStat}）`)
  }
}

// 【2026-09-28 升级 0.2.0-rc.1】此处的版本判据从 core-recipe.json 读取，不再写死：
// 写死的那一版在升级后会报 FAIL 并把结论置为「更新未完全通过」，
// 见 docs/90 §8.1 的「两处版本硬编码」表。核心树按版本各存一份、且旧树并存是**预期**
// （docs/50:45），所以这里只要求「新版在」，不要求「旧版不在」。
const recipePath = join(ROOT, 'hostcore', 'core-recipe.json')
// readFileSync 显式 utf8（core-recipe.json 里有中文注释/文案，按 BOM 无关的 utf8 解码）。
const wantCore = JSON.parse(readFileSync(recipePath, 'utf8')).coreVersion
if (!afterCores.includes(wantCore)) {
  Bad(`核心树里没看到 ${wantCore}（core-recipe.json 的 coreVersion）`)
  dataOk = false
} else {
  Ok(`核心树 ${wantCore} 在`)
}

// ── 8) 验证：端侧就绪 ────────────────────────────────────────────────────
// 【2026-09-28 升级 0.2.0-rc.1】原先这里写死 `$okCount -ge 7`（7 = exec 探测项数）。
// 写死总数会**在新增探测目标后失效**：8 项里只 ok 了 7 项（新的那项失败）依然是「通过」。
// 改为「逐项都必须 =ok、且至少有一项」——探测项数由 hostcore/app/main.js 的
// execProbeTargets() 决定，这里不再持有总数。见 docs/90 §8.1。
Step(8, '验证端侧就绪（exec 探测逐项 + HTTP；只认本轮新读数）')
// 【档位识别（2026-10-06 加）】`const.product.devicetype` 是宿主侧可读的系统参数，
// 与 ArkTS 侧 `deviceInfo.deviceType` 同源（platform 的 DeviceFacts.formOf 归一规则：
// phone / tablet ⇒ 手持；2in1 / 2in1_foldable / desktop ⇒ 桌面）。读不到就按**非手持**
// 处理 —— 即保持本脚本原先那条最严判据，绝不因为读不到形态而放宽。
const handheld = rawType === 'phone' || rawType === 'tablet'
Info(`设备形态 const.product.devicetype=${rawType}（判据：${handheld ? '手持档' : 'PC/2in1 档（或未识别 ⇒ 从严）'}）`)
const log = shell(`grep -E 'exec 探测：' ${filesDir}/dshm-host.log 2>/dev/null | tail -1`)
Info(log)
const afterExecCount = LogCount('exec 探测：')
const probe = log.match(/exec 探测：(.*)/)
let execOk = false
if (afterExecCount <= beforeExecCount) {
  Bad(`本轮没有新的 exec 探测行（${beforeExecCount} → ${afterExecCount}）—— 读数不可用，端侧可能没起来`)
} else if (probe === null) {
  Bad('宿主日志里没有 exec 探测行')
} else {
  const items = probe[1].split(/[，,]/).map((s) => s.trim()).filter((s) => s !== '')
  if (handheld) {
    // ── 手持档判据（2026-10-06 加）───────────────────────────────────
    // 【为什么必须分档】原先只有一条判据「逐项都 =ok」。那对 PC/2in1 是对的，对手机 /
    // 平板却是**假红**：手机档下随包自签名 ELF 一律被系统拒绝（`rg/ash/bash=denied`）、
    // 系统 sh 连 stat 都拿不到（`system-sh=缺`），这是**已定案的平台行为**（docs/104、
    // docs/106 §1.2），不是装机失败。旧写法会在手机上报「更新未完全通过」，把读者推向
    // 「回滚 / 重装」的错误方向（本项目的纪律：**假红和假绿一样有害**）。
    // 【为什么用规则而非标签白名单】探测项由 main.js 的 `execProbeTargets()` 决定，写死
    // 标签会像旧版写死总数（`-ge 7`）那样在新增探测项后静默失效（见 docs/90 §8.1）。
    // 故这里只按「值的形状」判：手持档必须至少有一条**真命令通道**（=ok），其余 =denied /
    // =缺 逐条打印但不判失败；若一条 =denied 都没有，说明平台策略可能变了 ⇒ 提示复测。
    const okItems = items.filter((s) => /=ok$/.test(s))
    const deniedItems = items.filter((s) => /=denied$/.test(s))
    const absentItems = items.filter((s) => /=缺$/.test(s))
    if (deniedItems.length > 0) {
      Info(`=denied  ${deniedItems.join('，')}  ← 随包 ELF / 系统 sh 被 MAC 拒绝，属预期（docs/104）`)
    } else {
      Info('本轮没有一条 =denied —— 若随包 ELF 真的被放行了（OS 升级？），docs/104 的结论需要复测')
    }
    if (absentItems.length > 0) {
      Info(`=缺      ${absentItems.join('，')}  ← 未解包，或连 stat 都被拒（system-sh 属后者）`)
    }
    // 判据：宿主必须还能 execve **系统**真命令（toybox）。它在 PC 与手机上都该是 ok。
    const toyboxOk = items.some((s) => /^toybox=ok$/.test(s))
    if (items.length > 0 && toyboxOk) {
      Ok(`exec 探测：手持档判据通过（toybox=ok ⇒ 真命令通道在；共 ${items.length} 项，其中 =ok ${okItems.length} / =denied ${deniedItems.length}）`)
      execOk = true
    } else {
      Bad(`手持档下 toybox 未 ok（${items.join('，')}）—— 宿主连系统真命令都起不来，需查`)
    }
  } else {
    // ── PC / 2in1 档判据（2026-10-15 修订：按包的 debug 标志分档）────────────────
    // 【为什么改】见第 4 步「为什么要读包的 debug 标志」：release 件下应用域被平台降级
    // ⇒ 应用数据区里的可执行文件全部 EPERM、system-sh=缺；而「逐项全 ok」是 **debug 件**的强判据
    // ⇒ 在 release 件上恒判红（假红，会把读者推向「回滚 / 重装」的错误方向）。
    // 修法：保留 debug 件的强判据，另给 release 件一条分支 —— 宿主必须还起得来**系统**真命令
    // （toybox=ok），它证明宿主进程的 execve 通道本身没被掐死；「本档能不能跑 bash」由 guest VM
    // 承担（docs/155），不由这条探针背书。标志未知（hapDebug = null）仍走强判据。
    const badItems = items.filter((s) => !/=ok$/.test(s))
    const toyboxOk = items.some((s) => /^toybox=ok$/.test(s))
    const okItems = items.filter((s) => /=ok$/.test(s))
    if (items.length > 0 && badItems.length === 0) {
      Ok(`exec 探测 ${items.length}/${items.length} 全通`)
      execOk = true
    } else if (hapDebug === false && toyboxOk) {
      Ok(`exec 探测：release 件判据通过（toybox=ok ⇒ 宿主仍能起系统真命令；共 ${items.length} 项，=ok ${okItems.length} / 其余 ${badItems.length} 项属 release 域降级，见 docs/140·155）`)
      Info(`release 件未通项（预期）：${badItems.join('，')}`)
      execOk = true
    } else if (hapDebug === false) {
      Bad(`exec 探测：release 件下 toybox 也未 ok（${items.join('，')}）—— 宿主连系统真命令都起不来，需查`)
    } else {
      Bad(`exec 探测未全通（共 ${items.length} 项）：${badItems.join('，')}`)
    }
  }
}

const afterMuxCount = LogCount('IN-UPGRADE GET /api/remote.mux')
if (afterMuxCount > beforeMuxCount) {
  Ok(`Host HTTP 已就绪（本轮有新的 websocket 接入：${beforeMuxCount} → ${afterMuxCount}）`)
} else {
  // 非判据：界面没连上来时本来就没有 websocket —— 旧写法 `grep -c … -gt 0` 对**跨 boot
  // 追加**的日志是**恒真**的，等于每次都替这一步背书。
  Info(`本轮未见新的 websocket 接入（${beforeMuxCount} → ${afterMuxCount}；非判据）`)
}

// 【插件市场重启 ≠ 装机失败（2026-10-09 加）】装完 1~2 分钟内，插件市场页面（`ua=… ArkWeb …`）会
// `POST /dsh-market/restart` 让宿主冷启动：Host 先写 `host-exit-mode=app-restart` 再退出，ArkTS 侧的
// 冷启动通道随后把它拉起来。现场看到的就是「App 自己退出了」—— 它**不是**本轮装机出问题，但极容易被
// 读成「新包把 App 搞崩了」，所以在结论前如实体检一次（这也是那次现场真正绕人的地方）。
const afterMarketCount = LogCount('POST /dsh-market/restart')
if (afterMarketCount > beforeMarketCount) {
  Info(`本轮有 ${afterMarketCount - beforeMarketCount} 次插件市场重启请求（POST /dsh-market/restart，来自 ArkWeb 页面）—— 那是插件市场的「重启后生效」，不是装机失败`)
} else {
  Info(`本轮未见插件市场重启请求（${beforeMarketCount} → ${afterMarketCount}；非判据）`)
}

// ── 9) 结论 ──────────────────────────────────────────────────────────────
console.log('')
if (dataOk && execOk) {
  if (dataChecked) {
    console.log(`${C.green ?? ''}更新完成：代码已换、用户数据已确认保留、端侧就绪。${C.reset ?? ''}`)
  } else {
    console.log(`${C.green ?? ''}更新完成（部分验证）：代码已换、端侧就绪。${C.reset ?? ''}`)
    console.log(`${C.yellow ?? ''}  注意：本次**未能验证**「用户数据被保留」—— 安装前 home 为空。${C.reset ?? ''}`)
  }
} else {
  console.log(`${C.red ?? ''}更新未完全通过 —— 见上面的 FAIL 项，不要据此宣布成功。${C.reset ?? ''}`)
  process.exit(1)
}

console.log('')
console.log(`${C.gray ?? ''}提示：如需按功能逐项验收，跑 python3 tools/func_test_final.py${C.reset ?? ''}`)
