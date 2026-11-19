#!/usr/bin/env node
/**
 * API 23–25 手持端的工作区选择门禁。
 *
 * 背景：系统能力表里 `FolderSelection` 对 phone / tablet 从 API 26 才提供。
 * 旧兜底在能力缺失时静默改用 `Download/<package>`，用户看不到选择动作，
 * 主观上就是“点了添加工作区但无法手动选择”。
 *
 * 现在能力缺失必须进入应用内工作区浏览器：
 *   1. Web pick() 的 Promise 保持 pending，直到用户确认或取消；
 *   2. 浏览器只暴露应用真正可读写的两个根：
 *        应用专属 Download/<package> 与沙箱 files/workspace；
 *   3. 支持下钻、上一级、新建目录、明确取消和确认；
 *   4. 两个实际交付壳（桌面/平板 entry、phone）接线一致。
 *
 * 这是源码结构门禁，不需要核心树或设备。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SHELLS = [
  'entry/src/main/ets/pages/WebApp.ets',
  'phone/src/main/ets/pages/WebApp.ets'
]

function invariant(ok, message) {
  if (!ok) throw new Error(message)
}

function checkShell(path, source) {
  const required = [
    ['浏览器结果类型', 'interface WorkspaceBrowserPickResult'],
    ['打开浏览器回调', 'openWorkspaceBrowser: (ctx: common.Context)'],
    ['等待用户选择', 'await this.openWorkspaceBrowser(ctx)'],
    ['API 23–25 强制内置浏览器', 'isHandheldForm() && deviceInfo.sdkApiVersion < 26'],
    ['旧手持端进入内置分支', 'legacyHandheld || !folderSelectionAvailable()'],
    ['浏览器打开状态', '@State workspaceBrowserOpen: boolean'],
    ['等待 Promise 回调', 'new Promise<WorkspaceBrowserPickResult>'],
    ['应用下载根', "label: '应用下载目录'"],
    ['沙箱根', '`${ctx.filesDir}/workspace`'],
    ['目录列表', 'fileIo.listFileSync(this.workspaceBrowserPath)'],
    ['进入子目录', 'workspaceBrowserEnter(name)'],
    ['上一级', 'workspaceBrowserUp()'],
    ['新建目录', 'workspaceBrowserCreate()'],
    ['用户确认', "path: this.workspaceBrowserPath, error: ''"],
    ['用户取消', "path: null, error: ''"],
    ['浮层挂载', 'this.WorkspaceBrowserOverlay()'],
    ['打开诊断', 'diag-workspace-browser-open'],
    ['确认诊断', 'diag-workspace-browser-choice']
  ]
  for (const [label, needle] of required) {
    invariant(source.includes(needle), `${path}: 缺少${label}（${needle}）`)
  }

  const branchAt = source.indexOf('if (legacyHandheld || !folderSelectionAvailable())')
  invariant(branchAt >= 0, `${path}: 缺少 FolderSelection 能力预检`)
  const branch = source.slice(branchAt, branchAt + 1000)
  invariant(branch.includes('await this.openWorkspaceBrowser(ctx)'),
    `${path}: 能力缺失分支没有等待应用内工作区浏览器`)
  invariant(!branch.includes('resolvePublicWorkspace(ctx, id'),
    `${path}: 能力缺失时又退回静默默认目录，用户无法手动选择`)
}

function verify(sources) {
  for (const path of SHELLS) {
    invariant(typeof sources[path] === 'string', `缺少源文件：${path}`)
    checkShell(path, sources[path])
  }
}

function loadSources() {
  const out = new Map()
  for (const path of SHELLS) out.set(path, readFileSync(resolve(ROOT, path), 'utf8'))
  return out
}

const sources = loadSources()
const asObject = Object.fromEntries(sources)
verify(asObject)
console.log(`OK 工作区内置浏览器：${SHELLS.length}/2 个交付 entry 接线完整`)

if (process.argv.includes('--self-test')) {
  const mutants = [
    {
      name: '能力缺失退回静默默认目录',
      path: SHELLS[0],
      from: 'const picked: WorkspaceBrowserPickResult = await this.openWorkspaceBrowser(ctx);',
      to: "await this.resolvePublicWorkspace(ctx, id, 'capability-unavailable');"
    },
    {
      name: '遗漏应用下载根',
      path: SHELLS[0],
      from: "roots.push({ label: '应用下载目录', path: pub.path });",
      to: '// root omitted'
    },
    {
      name: '遗漏用户确认',
      path: SHELLS[1],
      from: "this.closeWorkspaceBrowser({ path: this.workspaceBrowserPath, error: '' });",
      to: '// no explicit confirmation'
    },
    {
      name: '只信 canIUse，API 23–25 仍可能走系统 picker',
      path: SHELLS[1],
      from: 'if (legacyHandheld || !folderSelectionAvailable())',
      to: 'if (!folderSelectionAvailable())'
    }
  ]
  for (const mutant of mutants) {
    const copy = new Map(sources)
    const text = copy.get(mutant.path)
    invariant(text.includes(mutant.from), `自检夹具失效：${mutant.name}`)
    copy.set(mutant.path, text.replace(mutant.from, mutant.to))
    let red = false
    try {
      verify(Object.fromEntries(copy))
    } catch {
      red = true
    }
    invariant(red, `对照臂必须判红：${mutant.name}`)
  }
  console.log(`OK 工作区内置浏览器自检：${mutants.length}/${mutants.length} 个对照臂已判红`)
}
