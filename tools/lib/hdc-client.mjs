/**
 * hdc 客户端共享库 —— 本仓 node 侧工具调用 hdc 的**唯一入口**。
 *
 * 【新建背景】DSHM beta 工作区从 Windows 迁到鸿蒙 PC（2026-10-21），装机链
 * （update-device.mjs）、端侧验收（device-acceptance.mjs）、代码指纹
 * （device-code-fingerprint.mjs）三个移植工具都要调 hdc；同一套「多设备 -t 契约 /
 * [Empty] 判定 / 输出捕获」不该抄三遍 —— 三份副本各自漂移正是本仓
 * denial-hints.js / fs-fence.js「两份判据副本逐字节一致」门禁存在的原因。
 * 共享库是仓库已验证的反模式解法（与 tools/lib/deveco-home.mjs 同层）。
 *
 * 【三个真机读数的坑（出处：AGENTS.md「真机读数的三个坑」，逐条写进实现）】
 *  ① 多设备在线时裸 `hdc shell` 被拒（实测原文：
 *     `[Fail]ExecuteCommand need connect-key? please confirm a device by help info`），
 *     且环境变量 HDC_TARGET 实测**不被 hdc 识别**，只有命令行 `-t <key>` 有效
 *     ⇒ runHdc() 的 `target` 参数非空时自动前插 `-t <target>`（2026-10-13 教训）。
 *  ② `bm dump` 的 stdout **不能在设备侧重定向**：`bm dump -n X > f` 得到 0 字节、
 *     stderr 空、退出码 0（必须在宿主侧捕获）⇒ 本库一律 spawnSync 在宿主侧拿
 *     Buffer 再解码，绝不在设备侧 `> 文件`（2026-10-05 实测）。
 *  ③ 含 NUL 的日志行在设备侧 `grep` 里「看起来被截断」、`grep -c` 还会静默少算
 *     （`/proc/self/attr/current` 尾带 `\0`）⇒ 需要按字节看日志时走 `hdc file recv`
 *     回宿主侧；本库的 utf8 解码只面向**命令输出**，不承诺保留 NUL 语义。
 *
 * 【hdc 解析优先级（FR-002）】`DSHM_HDC` 环境变量 → DevEco 根下
 * `sdk/default/openharmony/toolchains/hdc(.exe)`（经 deveco-home.mjs 解析，路径不写死）
 * → PATH 里的 `hdc`。平台差异（Windows 的 `.exe` 后缀）由本库处理。
 * 找不到返回 `null`：调用方自己决定 exit 几（不返回假路径，与 deveco-home 同契约）。
 *
 * 【零副作用】本库全部函数不写文件、不联网、不改环境变量。
 */
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { devecoPath } from './deveco-home.mjs'

const IS_WIN = process.platform === 'win32'

/** hdc 可执行文件名候选：本平台优先（POSIX 无后缀 / Windows 带 .exe），另一个垫底。 */
function hdcNames() {
  return IS_WIN ? ['hdc.exe', 'hdc'] : ['hdc', 'hdc.exe']
}

/**
 * 解析 hdc 可执行文件路径；找不到返回 `null`。
 * 优先级：`DSHM_HDC` → DevEco toolchains → PATH。
 */
export function resolveHdc() {
  // 1) 环境变量显式指定（绝对/相对路径均可，交给 existsSync 判）
  const env = process.env.DSHM_HDC
  if (typeof env === 'string' && env.length > 0 && existsSync(env)) return env
  // 2) DevEco 根下的 toolchains（路径经 deveco-home.mjs 解析口，不写死安装根）
  for (const name of hdcNames()) {
    const p = devecoPath(join('sdk', 'default', 'openharmony', 'toolchains', name))
    if (p !== null) return p
  }
  // 3) PATH 里找（逐段 existsSync，不 spawn `which`——保持零副作用且跨平台一致）
  const pathEnv = process.env.PATH
  if (typeof pathEnv === 'string' && pathEnv.length > 0) {
    for (const dir of pathEnv.split(delimiter)) {
      if (dir.length === 0) continue
      for (const name of hdcNames()) {
        const p = join(dir, name)
        try {
          if (existsSync(p)) return p
        } catch { /* 不可读段跳过 */ }
      }
    }
  }
  return null
}

/** `hdc list targets` 输出 → 连接键数组（无设备返回 []）。 */
function parseTargets(out) {
  const text = String(out ?? '').trim()
  if (text === '' || /Empty/.test(text)) return []
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * 本机回环的 hdc 监听端口（`param get persist.hdc.port`）。
 *
 * 【为什么需要】鸿蒙 PC 上裸 `hdc list targets` 恒为 `[Empty]`，正确顺序是
 * 先读这个系统参数、再 `hdc tconn 127.0.0.1:<port>`（`docs/260` 实测口径）。
 * 桌面平台没有 `param` 命令 ⇒ spawn 失败即返回空串，回环这一路自动不参与。
 */
function readLocalHdcPort() {
  try {
    const r = spawnSync('param', ['get', 'persist.hdc.port'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 })
    const out = (r.stdout ?? Buffer.alloc(0)).toString('utf8').trim()
    return /^\d+$/.test(out) ? out : ''
  } catch {
    return ''
  }
}

function rawOnce(hdc) {
  const r = spawnSync(hdc, ['list', 'targets'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })
  return {
    stdout: (r.stdout ?? Buffer.alloc(0)).toString('utf8'),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString('utf8'),
    status: r.status ?? null,
  }
}

/**
 * 探测设备，并**区分两种"空"**（2026-10-28 修）：
 *
 *   · **真·没有设备**：hdc 明确回 `[Empty]`；
 *   · **hdc 自己不可用**：**完全无输出**（rc=0、stderr 也空）。
 *     实测在 DSHM 应用域里 hdc 连不上自己的服务端就是这一形（`/data/local/tmp` 不可访问、
 *     服务端进程不可见）⇒ 旧实现把它当 `[Empty]` 上报，装机/验收工具于是显示
 *     「没有设备（`hdc list targets = [Empty]`）。接上设备后重跑」——
 *     把"这台机器的应用域调不动 hdc"说成了"你没插设备"，是**误报**。
 *
 * 顺带把本机回环那一跳封进来：`[Empty]`/沉默时先试 `param get persist.hdc.port` + `tconn`
 * 再列一次（`docs/260`）。
 *
 * @returns {{available:boolean, targets:string[], port:string, raw:string, stderr:string,
 *            silent:boolean, note:string}}
 */
export function probeHdc(hdc) {
  const first = rawOnce(hdc)
  const t1 = parseTargets(first.stdout)
  if (t1.length > 0) {
    return { available: true, targets: t1, port: '', raw: first.stdout.trim(),
      stderr: first.stderr.trim(), silent: false, note: '' }
  }
  const port = readLocalHdcPort()
  if (port.length > 0) {
    try {
      spawnSync(hdc, ['tconn', `127.0.0.1:${port}`], { encoding: 'buffer', maxBuffer: 1024 * 1024 })
    } catch { /* 连不上就继续按"没有设备"上报 */ }
    const second = rawOnce(hdc)
    const t2 = parseTargets(second.stdout)
    if (t2.length > 0) {
      return { available: true, targets: t2, port, raw: second.stdout.trim(),
        stderr: second.stderr.trim(), silent: false, note: `本机回环 127.0.0.1:${port}` }
    }
  }
  const silent = first.stdout.trim().length === 0
    && first.stderr.trim().length === 0 && first.status === 0
  let note = ''
  if (silent) {
    note = 'hdc 无任何输出（rc=0、stderr 也空）⇒ hdc 自身不可用（服务端不可达），**不是**"没有设备"；'
      + '本机应用域常见此形，请在桌面终端 / DevEco 侧运行本工具';
  } else if (/Empty/.test(first.stdout)) {
    note = 'hdc 明确回 [Empty] ⇒ 当前确实没有设备在线'
  } else {
    note = `hdc 输出异常：${first.stdout.trim() || first.stderr.trim()}`
  }
  return { available: false, targets: [], port, raw: first.stdout.trim(),
    stderr: first.stderr.trim(), silent, note }
}

/** 列出在线设备连接键（`probeHdc()` 的兼容包装，签名不变）。 */
export function listTargets(hdc) {
  return probeHdc(hdc).targets
}

/**
 * 跑一条 hdc 命令，宿主侧 Buffer 捕获后 utf8 解码。
 *
 * @param {string} hdc   resolveHdc() 的结果
 * @param {string} target 设备连接键；**非空**时自动前插 `-t <target>`（坑 ①），
 *                        空串/null 表示不指定（单设备时保持原行为）
 * @param {string[]} args hdc 子命令与参数（如 `['shell', 'param', 'get', '…']`）
 * @param {object} [opts] 透传 spawnSync 的附加项（如 `cwd`；`encoding` 恒被覆盖为 buffer）
 * @returns {{ stdout: string, stderr: string, status: number|null, error: string|null }}
 *   stdout/stderr：utf8 解码后的完整输出（坑 ②：判定读取一律用这里的宿主侧捕获，
 *   不要在设备侧 `> 文件`）；status：退出码（spawn 本身失败时为 null）；
 *   error：spawn 失败原因（ENOENT/EACCES 等），成功为 null。
 */
export function runHdc(hdc, target, args, opts = {}) {
  const finalArgs = typeof target === 'string' && target.length > 0
    ? ['-t', target, ...args]
    : [...args]
  const r = spawnSync(hdc, finalArgs, { maxBuffer: 64 * 1024 * 1024, ...opts, encoding: 'buffer' })
  return {
    stdout: (r.stdout ?? Buffer.alloc(0)).toString('utf8'),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString('utf8'),
    status: r.status ?? null,
    error: r.error ? String(r.error.message || r.error) : null,
  }
}

/** 仅供断言用：判断路径是否绝对路径（暴露给调用方做参数校验；不派生新契约）。 */
export function isAbsolutePath(p) {
  return typeof p === 'string' && isAbsolute(p)
}
