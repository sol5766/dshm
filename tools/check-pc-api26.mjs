#!/usr/bin/env node
/**
 * 多 HAP 工程 API 门禁：最低兼容 API 23，target 与 compile 面保持 API 26。
 *
 * `compatibleSdkVersion` 是 product 级字段。当前 `.app` 把 desktop/tablet 双形态
 * entry、phone entry 与一个共享 HSP 放在同一 product，因此只能共享同一个最低值。
 * 2026-10-24 用户校正：移动端要兼容 API 23，故最低面统一为 6.1.0(23)，
 * target 继续锁 26.0.0。文件名保留 check-pc-api26 只为兼容既有 CI 命令。
 *
 * 【2026-11-06 复核】`build-profile.portable.json5` 实际仍存在，但已标注为**历史迁移模板、不参与正式构建**；
 * API 口径由「本机配置 build-profile.json5 + 三份 module.json5」钉住，本门禁的 FILES 不含该模板。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const FILES = {
  localProfile: 'build-profile.json5',
  templateProfile: 'tools/build-profile.template.json5',
  moduleEntry: 'entry/src/main/module.json5',
  modulePhone: 'phone/src/main/module.json5',
  moduleShared: 'hostruntime/src/main/module.json5',
  webAppEntry: 'entry/src/main/ets/pages/WebApp.ets',
}

const LEGACY_VERSIONS = [
  '"targetSdkVersion": "6.1.1(24)"',
  '"targetSdkVersion": "6.1.0(23)"',
  '"compatibleSdkVersion": "6.1.1(24)"',
  '"compatibleSdkVersion": "26.0.0"'
]

function read(relativePath) {
  const absolutePath = join(ROOT, relativePath)
  if (!existsSync(absolutePath) && relativePath === FILES.localProfile) return ''
  return readFileSync(absolutePath, 'utf8')
}

function parseJson5(text) {
  return JSON.parse(text
    .replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1'))
}

/** 返回空数组才表示 PC 工程只保留 API 26。 */
export function collectProblems(sources = Object.fromEntries(
  Object.entries(FILES).map(([key, path]) => [key, read(path)])
)) {
  const problems = []
  const requireText = (key, label, text) => {
    if (!sources[key].includes(text)) problems.push(`${label}：缺少 ${JSON.stringify(text)}`)
  }
  const rejectText = (key, label, text) => {
    if (sources[key].includes(text)) problems.push(`${label}：不应再出现 ${JSON.stringify(text)}`)
  }

  for (const key of ['localProfile', 'templateProfile']) {
    if (key === 'localProfile' && sources[key].trim() === '') continue
    requireText(key, FILES[key], '"targetSdkVersion": "26.0.0"')
    requireText(key, FILES[key], '"compatibleSdkVersion": "6.1.0(23)"')
    for (const legacy of LEGACY_VERSIONS) rejectText(key, FILES[key], legacy)
  }

  const expectedDevices = new Map([
    /* 【2026-11-08】entry 同时声明 tablet + 2in1（Edge/Pro Max 按 PC 应用分发）；
       hostruntime 仍三面齐全。原独立 pc 壳已并入 entry。 */
    ['moduleEntry', ['tablet', '2in1']],
    ['modulePhone', ['phone']],
    ['moduleShared', ['phone', 'tablet', '2in1']],
  ])
  for (const [key, expected] of expectedDevices) {
    let actual = []
    try {
      actual = parseJson5(sources[key])?.module?.deviceTypes ?? []
    } catch (e) {
      problems.push(`${FILES[key]}：JSON5 解析失败（${String(e)}）`)
      continue
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${FILES[key]}：deviceTypes=${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
    }
  }

  /*
   * API 23 上不存在的声明式属性不能直接挂到组件链上。上架自检设备
   * MatePad Pro / API 23 的 release 崩溃证明 `.enableDefaultContextMenu(true)`
   * （since 24）会被 ArkUI 以 `undefined is not callable` 调用。
   * 兼容写法必须是 AttributeModifier + API/方法双重探测。
   */
  const web = sources.webAppEntry
  if (/^\s*\.enableDefaultContextMenu\s*\(/m.test(web)) {
    problems.push('entry WebApp：不得直接链式调用 since 24 的 enableDefaultContextMenu')
  }
  if (!web.includes('deviceInfo.sdkApiVersion >= 24')
    || !web.includes("typeof instance.enableDefaultContextMenu === 'function'")) {
    problems.push('entry WebApp：enableDefaultContextMenu 缺少 API 24 + 方法存在性双重门禁')
  }
  return problems
}

function mutate(sources, key, search, replace) {
  if (!sources[key].includes(search)) {
    throw new Error(`对照臂失效：${FILES[key]} 找不到 ${JSON.stringify(search)}`)
  }
  return { ...sources, [key]: sources[key].replace(search, replace) }
}

const sources = Object.fromEntries(
  Object.entries(FILES).map(([key, path]) => [key, read(path)])
)

if (process.argv.includes('--self-test')) {
  const arms = [
    {
      name: '本机配置把 compatible 误升到 API 26',
      sources: mutate(sources, 'localProfile',
        '"compatibleSdkVersion": "6.1.0(23)"',
        '"compatibleSdkVersion": "26.0.0"')
    },
    {
      name: '模板块把 compatible 改成 API 24',
      sources: mutate(sources, 'templateProfile',
        '"compatibleSdkVersion": "6.1.0(23)"',
        '"compatibleSdkVersion": "6.1.1(24)"')
    },
    {
      name: '模板把 target 退回 API 24',
      sources: mutate(sources, 'templateProfile',
        '"targetSdkVersion": "26.0.0"',
        '"targetSdkVersion": "6.1.1(24)"')
    },
    {
      name: '双形态 entry 丢掉 tablet deviceType',
      sources: {
        ...sources,
        moduleEntry: sources.moduleEntry.replace('"tablet"', '"2in1"')
      }
    },
    {
      name: 'WebApp 恢复直接调用 API 24 的 enableDefaultContextMenu',
      sources: {
        ...sources,
        webAppEntry: sources.webAppEntry.replace(
          '.attributeModifier(WEB_CONTEXT_MENU_COMPAT)',
          '.enableDefaultContextMenu(true)')
      }
    }
  ]
  let failures = 0
  for (const arm of arms) {
    const problems = collectProblems(arm.sources)
    if (problems.length === 0) {
      failures += 1
      console.log(`  ✗ 对照臂没判红：${arm.name}`)
    } else {
      console.log(`  ✓ 对照臂判红：${arm.name}（${problems.length} 条）`)
    }
  }
  console.log(`# 对照臂 ${arms.length - failures}/${arms.length} 通过`)
  process.exit(failures === 0 ? 0 : 1)
}

console.log('# 多 HAP 工程最低 API 23 / 目标 API 26 门禁')
const problems = collectProblems(sources)
if (problems.length === 0) {
  console.log('✅ 最低兼容 API 为 23、target 为 26.0.0；双形态 entry、phone 与公共 HSP 设备面符合基线。')
  process.exit(0)
}
for (const problem of problems) console.log(`  ✗ ${problem}`)
process.exit(1)
