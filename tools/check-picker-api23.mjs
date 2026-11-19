/**
 * HarmonyOS 6.1.0 / API 23 工作区选择兼容门禁。
 *
 * 真机与 SDK 能力表的事实：
 *   · FolderSelection 在 2in1 上从 API 13 可用；
 *   · 在 phone / tablet 上直到 API 26 才进入系统能力表。
 *
 * 因此只把 compatibleSdkVersion 降到 23 不够：API 23 手机/平板仍不能把
 * DocumentSelectMode.FOLDER 当作可用能力。应用必须在调用系统目录选择器前预检，
 * 并在能力缺失时落到本应用真实可读写的 Download/<包名> 专属目录。
 *
 * 这不是“伪造任意目录授权”：API 23 手持档无法获得系统目录选择授权，
 * 兜底目录来自官方 DOWNLOAD 模式，跨启动可用，agent 也能正常读写。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const FILES = {
  localProfile: 'build-profile.json5',
  templateProfile: 'tools/build-profile.template.json5',
  picker: 'platform/src/main/ets/system/FilePicker.ets',
  platformIndex: 'platform/src/main/ets/Index.ets',
  web: 'entry/src/main/ets/pages/WebApp.ets'
}

function read(relativePath) {
  try {
    return readFileSync(join(ROOT, relativePath), 'utf8')
  } catch (error) {
    // build-profile.json5 是机器本地签名配置，干净克隆里不存在；模板始终必须有。
    if (error?.code === 'ENOENT' && relativePath === FILES.localProfile) return ''
    throw error
  }
}

/** 收集兼容性契约；返回空数组才表示可发布。 */
export function collectProblems(sources = Object.fromEntries(
  Object.entries(FILES).map(([key, path]) => [key, read(path)])
)) {
  const problems = []
  const requireText = (key, label, text) => {
    if (!sources[key].includes(text)) {
      problems.push(`${label}：缺少 ${JSON.stringify(text)}`)
    }
  }
  const rejectText = (key, label, text) => {
    if (sources[key].includes(text)) {
      problems.push(`${label}：不应再出现 ${JSON.stringify(text)}`)
    }
  }

  if (sources.localProfile.trim() !== '') {
    requireText('localProfile', FILES.localProfile, '"compatibleSdkVersion": "6.1.0(23)"')
    rejectText('localProfile', FILES.localProfile, '"compatibleSdkVersion": "6.1.1(24)"')
  }
  for (const key of ['templateProfile']) {
    requireText(key, FILES[key], '"compatibleSdkVersion": "6.1.0(23)"')
    rejectText(key, FILES[key], '"compatibleSdkVersion": "6.1.1(24)"')
  }

  requireText('picker', FILES.picker,
    "const FOLDER_SELECTION_SYSCAP: string = 'SystemCapability.FileManagement.UserFileService.FolderSelection';")
  requireText('picker', FILES.picker, 'export function folderSelectionAvailable(): boolean')
  requireText('picker', FILES.picker, 'canIUse(FOLDER_SELECTION_SYSCAP)')
  requireText('picker', FILES.picker,
    'export function shouldAutoFallbackFolderPicker(code: number, handheld: boolean): boolean')
  requireText('picker', FILES.picker,
    'return handheld && !isFolderPickerCancelCode(code);')
  requireText('picker', FILES.picker,
    'shouldAutoFallbackFolderPicker(e.code, isHandheldForm())')
  requireText('picker', FILES.picker,
    "hilog.info(DOMAIN, TAG, '目录选择自动使用默认工作区')")
  requireText('picker', FILES.picker, 'await publicDownloadFolder(context)')
  requireText('platformIndex', FILES.platformIndex, 'folderSelectionAvailable,')
  requireText('platformIndex', FILES.platformIndex, 'shouldAutoFallbackFolderPicker,')

  requireText('web', FILES.web, 'folderSelectionAvailable')
  requireText('web', FILES.web, '!folderSelectionAvailable()')
  requireText('web', FILES.web, 'const pub: PickedFolder = await publicDownloadFolder(ctx);')
  requireText('web', FILES.web, 'shouldAutoFallbackFolderPicker(err.code, isHandheldForm())')
  requireText('web', FILES.web, "this.writeDiagMarker('diag-picker-capability-fallback'")
  requireText('web', FILES.web, 'private async resolvePublicWorkspace(')
  requireText('web', FILES.web, "this.writeDiagMarker('diag-picker-auto-fallback'")

  return problems
}

function mutate(sources, key, search, replace) {
  if (!sources[key].includes(search)) {
    throw new Error(`对照臂失效：${FILES[key]} 找不到 ${JSON.stringify(search)}`)
  }
  return {
    ...sources,
    [key]: sources[key].replace(search, replace)
  }
}

const sources = Object.fromEntries(
  Object.entries(FILES).map(([key, path]) => [key, read(path)])
)

if (process.argv.includes('--self-test')) {
  const arms = [
    {
      name: '兼容面退回 API 24',
      sources: mutate(sources, 'localProfile',
        '"compatibleSdkVersion": "6.1.0(23)"',
        '"compatibleSdkVersion": "6.1.1(24)"')
    },
    {
      name: '移除 FolderSelection 能力预检',
      sources: mutate(sources, 'picker',
        'canIUse(FOLDER_SELECTION_SYSCAP)',
        'true')
    },
    {
      name: '移除 H5 目录桥的 API 23 兜底',
      sources: mutate(sources, 'web',
        '!folderSelectionAvailable()',
        'false')
    },
    {
      name: '移除手持档选择器异常自动兜底判据',
      sources: mutate(sources, 'picker',
        'return handheld && !isFolderPickerCancelCode(code);',
        'return false;')
    },
    {
      name: '移除 ArkTS pickFolder 的异常兜底接线',
      sources: mutate(sources, 'picker',
        'shouldAutoFallbackFolderPicker(e.code, isHandheldForm())',
        'false')
    },
    {
      name: '移除 H5 目录桥的异常兜底接线',
      sources: mutate(sources, 'web',
        'shouldAutoFallbackFolderPicker(err.code, isHandheldForm())',
        'false')
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
      console.log(`      ${problems[0]}`)
    }
  }
  console.log(`# 对照臂 ${arms.length - failures}/${arms.length} 通过`)
  process.exit(failures === 0 ? 0 : 1)
}

const problems = collectProblems(sources)
console.log('# 工作区选择 API 23 兼容门禁')
if (problems.length === 0) {
  console.log('✅ 兼容面、能力预检与手持档兜底均已接线。')
  process.exit(0)
}
for (const problem of problems) {
  console.log(`  ✗ ${problem}`)
}
process.exit(1)
