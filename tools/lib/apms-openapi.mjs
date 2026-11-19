#!/usr/bin/env node

/**
 * APMS Connect API helpers.
 *
 * APMS exposes crash/freeze/leak metrics through AGC Reports API. The APMS
 * endpoints currently document API-client authentication; Service Account
 * credentials are not interchangeable here.
 */

export function buildCrashRequest({ version, startTime, endTime }) {
  return {
    startTime,
    endTime,
    filters: {
      appVersions: [version],
    },
  }
}

export function parseEnvText(text) {
  const values = {}
  for (const rawLine of String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

export function parseApiClientJson(text) {
  let payload
  try {
    payload = JSON.parse(String(text ?? '').replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('API client credential must be valid JSON')
  }
  const clientId = String(payload?.client_id ?? '').trim()
  const clientSecret = String(payload?.client_secret ?? '').trim()
  if (clientId.length === 0 || clientSecret.length === 0) {
    throw new Error('API client credential is missing client_id or client_secret')
  }
  return {
    clientId,
    clientSecret,
    developerId: String(payload?.developer_id ?? '').trim(),
  }
}

export function parseCliArgs(argv) {
  const result = {
    envFile: process.env.APMS_ENV_FILE ?? '',
    clientFile: process.env.APMS_CLIENT_FILE ?? '',
    packageName: 'com.dshm.dshclient',
    version: '1.1.3',
    appId: '',
    projectId: '',
    from: '',
    to: '',
    format: 'markdown',
    help: false,
  }
  const valueOptions = new Map([
    ['--agc-env-file', 'envFile'],
    ['--agc-client-file', 'clientFile'],
    ['--package', 'packageName'],
    ['--version', 'version'],
    ['--app-id', 'appId'],
    ['--project-id', 'projectId'],
    ['--from', 'from'],
    ['--to', 'to'],
    ['--format', 'format'],
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      result.help = true
      continue
    }
    const key = valueOptions.get(argument)
    if (key === undefined) throw new Error(`unknown option: ${argument}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${argument}`)
    }
    result[key] = value
    index += 1
  }

  if (result.format !== 'markdown' && result.format !== 'json') {
    throw new Error('--format must be markdown or json')
  }
  return result
}

async function httpError(response, label) {
  let detail = ''
  try {
    detail = typeof response.text === 'function' ? await response.text() : ''
  } catch {
    detail = ''
  }
  const suffix = detail.trim().length > 0 ? `: ${detail.trim()}` : ''
  return new Error(`${label} failed (HTTP ${response.status})${suffix}`)
}

export async function requestAccessToken({
  clientId,
  clientSecret,
  domain = 'connect-api.cloud.huawei.com',
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`https://${domain}/api/oauth2/v1/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })
  if (!response.ok) throw await httpError(response, 'APMS access token')
  const payload = await response.json()
  if (typeof payload?.access_token !== 'string' || payload.access_token.length === 0) {
    throw new Error('APMS access token response is missing access_token')
  }
  return payload.access_token
}

export async function queryCrashIssues({
  accessToken,
  clientId,
  appId,
  projectId,
  packageName,
  version,
  startTime,
  endTime,
  domain = 'connect-api.cloud.huawei.com',
  fetchImpl = fetch,
}) {
  void projectId
  const response = await fetchImpl(
    `https://${domain}/api/apm/api/v1/hap/query/crash/metric`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        client_id: clientId,
        packageName,
        appId,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildCrashRequest({ version, startTime, endTime })),
    },
  )
  if (!response.ok) throw await httpError(response, 'APMS crash query')
  return normalizeCrashResponse(await response.json())
}

function numberOrZero(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function normalizeCrashResponse(response) {
  const resultSets = Array.isArray(response?.data?.resultSet)
    ? response.data.resultSet
    : []

  const byType = resultSets.map((item) => ({
    crashType: String(item?.crashType ?? ''),
    crashCount: numberOrZero(item?.crashCount),
    startCount: numberOrZero(item?.startCount),
    crashDeviceCount: numberOrZero(item?.crashDeviceCount),
    deviceCount: numberOrZero(item?.deviceCount),
  }))

  const issues = resultSets
    .flatMap((item) => {
      const crashType = String(item?.crashType ?? '')
      const summaries = Array.isArray(item?.summaries) ? item.summaries : []
      return summaries.map((summary) => ({
        crashType,
        fingerprint: String(summary?.fingerprint ?? ''),
        crashCount: numberOrZero(summary?.crashCount),
        crashDeviceCount: numberOrZero(summary?.crashDeviceCount),
        summary: String(summary?.summary ?? ''),
        firstTime: numberOrZero(summary?.firstTime),
        lastTime: numberOrZero(summary?.lastTime),
        startVersion: String(summary?.startVersion ?? ''),
        endVersion: String(summary?.endVersion ?? ''),
      }))
    })
    .sort((a, b) => b.crashCount - a.crashCount)

  const crashCount = byType.reduce((sum, item) => sum + item.crashCount, 0)
  const startCount = byType.reduce((max, item) => Math.max(max, item.startCount), 0)
  const crashDeviceCount = byType.reduce((sum, item) => sum + item.crashDeviceCount, 0)
  const deviceCount = byType.reduce((max, item) => Math.max(max, item.deviceCount), 0)

  return {
    requestId: String(response?.requestId ?? ''),
    reason: String(response?.reason ?? ''),
    message: String(response?.message ?? ''),
    total: {
      crashCount,
      startCount,
      crashDeviceCount,
      deviceCount,
      crashRate: startCount > 0 ? crashCount / startCount : 0,
    },
    byType,
    issues,
  }
}

function shanghaiDate(timestamp) {
  return new Date(timestamp).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Shanghai',
  })
}

function percent(rate) {
  return `${(rate * 100).toFixed(2)}%`
}

export function formatMarkdown({
  packageName,
  version,
  startTime,
  endTime,
  report,
}) {
  const lines = [
    `# APMS ${version} 崩溃报告`,
    '',
    `- 包名：\`${packageName}\``,
    `- 时间范围：${shanghaiDate(startTime)} 至 ${shanghaiDate(endTime - 1)}`,
    `- 崩溃次数：${report.total.crashCount}`,
    `- 崩溃设备数：${report.total.crashDeviceCount}`,
    `- 启动设备数：${report.total.deviceCount}`,
    `- 崩溃率：${percent(report.total.crashRate)}`,
    '',
    '## TOP 问题',
    '',
  ]

  if (report.issues.length === 0) {
    lines.push('无匹配问题。')
  } else {
    for (const [index, issue] of report.issues.slice(0, 10).entries()) {
      const summary = issue.summary.replaceAll('|', '\\|')
      lines.push(
        `${index + 1}. \`${issue.crashType}\` ${summary}`,
        `   - ${issue.crashCount} 次，影响 ${issue.crashDeviceCount} 台设备`,
        `   - Fingerprint：\`${issue.fingerprint}\``,
      )
    }
  }

  return `${lines.join('\n')}\n`
}
