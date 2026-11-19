#!/usr/bin/env node
/**
 * 门禁：文件预览里的「文件管理」入口必须走 HarmonyOS 公开 API。
 *
 * 事实边界（SDK `@ohos.file.picker.d.ts`）：
 *   - `DocumentSelectOptions.defaultFilePathUri` 自 API 10 起表示
 *     “从指定文件或目录位置打开”，空值才回到“最近打开”；
 *   - `DocumentSelectMode.FILE` 自 API 11 起可用；
 *   - HarmonyOS 没有公开的“文件管理器定位到任意绝对路径”Want 契约。
 *
 * 因此本门禁同时守住三件事：
 *   ① 两个交付 entry 的 WebView 桥都注册了 `openFileLocation`，且平台导出了实现；
 *   ② 实现确实设置 `defaultFilePathUri`，不得退回 `viewData`/私有深链伪装定位；
 *   ③ 插件只对 `/storage/Users/currentUser/` 下、且不含 `..` 的用户可见路径显示入口。
 *
 * 用法：node tools/check-file-location.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

function count(text, needle) {
  return text.split(needle).length - 1
}

/** 纯判据：返回错误清单（空数组 = 通过）。变异体也走同一份判据。 */
export function analyze(sources) {
  const errors = []
  const picker = sources.picker || ''
  const platformIndex = sources.platformIndex || ''
  const client = sources.client || ''

  if (!picker.includes('options.defaultFilePathUri = uri')) {
    errors.push('FilePreview 未设置 defaultFilePathUri')
  }
  if (!picker.includes('options.selectMode = picker.DocumentSelectMode.FILE')) {
    errors.push('FilePreview 未使用公开的 DocumentSelectMode.FILE')
  }
  const locationStart = picker.indexOf('export function openFileLocation')
  const locationBody = locationStart < 0 ? '' : picker.slice(locationStart)
  if (locationStart < 0) {
    errors.push('缺少 openFileLocation 实现')
  }
  if (/\b(?:viewData|filemanager|fileManager|file-manager)\b/i.test(locationBody)) {
    errors.push('openFileLocation 混入了未承诺可定位的文件管理器深链')
  }
  if (!platformIndex.includes('openFileLocation')) {
    errors.push('platform Index 未导出 openFileLocation')
  }

  if (!client.includes('bridges.openFileLocation')) {
    errors.push('预览插件未调用 openFileLocation 桥')
  }
  if (!client.includes('const root = "/storage/Users/currentUser/"')
    || !client.includes('target.startsWith(root)')) {
    errors.push('预览插件未限制为用户可见目录')
  }
  if (!client.includes('segment === ".."') || !client.includes('segment === "."')) {
    errors.push('用户可见路径判据未拒绝点段')
  }

  const webApps = sources.webApps || []
  if (webApps.length !== 2) {
    errors.push(`应检查桌面/平板 entry 与 phone 两个 WebApp，实得 ${webApps.length}`)
  }
  for (const app of webApps) {
    const name = app.name || '(unknown)'
    if (!app.source.includes('openFileLocation as openFileLocationPicker')) {
      errors.push(`${name}: 未从 platform 导入 openFileLocation`)
    }
    if (!app.source.includes("'openFileLocation': (path: string): string => this.openFileLocation(path)")) {
      errors.push(`${name}: bridges 未注册 openFileLocation`)
    }
    if (count(app.source, "'openFileLocation'") < 2) {
      errors.push(`${name}: bridges 与 methodList 未同时接线`)
    }
    if (!app.source.includes("diag-file-location")) {
      errors.push(`${name}: 未写 diag-file-location 诊断`)
    }
  }
  return errors
}

function loadSources() {
  return {
    picker: read('platform/src/main/ets/system/FilePreview.ets'),
    platformIndex: read('platform/src/main/ets/Index.ets'),
    client: read('hostcore/plugins/dshm-office-system-preview/lib/client.js'),
    webApps: [
      { name: 'entry', source: read('entry/src/main/ets/pages/WebApp.ets') },
      { name: 'phone', source: read('phone/src/main/ets/pages/WebApp.ets') },
    ],
  }
}

function runMutationTests(base) {
  const cases = [
    {
      name: '去掉 defaultFilePathUri（必须判红）',
      mutate: (s) => {
        s.picker = s.picker.replace('options.defaultFilePathUri = uri;', '')
      },
    },
    {
      name: '用户可见路径改宽（必须判红）',
      mutate: (s) => {
        s.client = s.client.replace('target.startsWith(root)', 'target.length > 0')
      },
    },
    {
      name: 'methodList 漏掉新桥（必须判红）',
      mutate: (s) => {
        const app = s.webApps[0]
        app.source = app.source.replace(
          "'openFilePreview', 'openFileLocation',",
          "'openFilePreview',",
        )
      },
    },
  ]
  let failed = 0
  for (const item of cases) {
    const copy = structuredClone(base)
    item.mutate(copy)
    const ok = analyze(copy).length > 0
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${item.name}`)
    if (!ok) failed += 1
  }
  return failed
}

const sources = loadSources()
console.log('# 文件管理直达门禁\n')
const mutationFailures = runMutationTests(sources)
console.log('\n# 主体检查')
const errors = analyze(sources)
if (errors.length === 0) {
  console.log('PASS  defaultFilePathUri / 两个交付 entry 桥接 / 用户可见路径限制均一致')
} else {
  for (const error of errors) console.error(`FAIL  ${error}`)
}

if (mutationFailures > 0 || errors.length > 0) {
  console.error(`\nRESULT: FAIL（变异体失败 ${mutationFailures}，主体错误 ${errors.length}）`)
  process.exit(1)
}
console.log('\nRESULT: PASS')
