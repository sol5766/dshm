#!/usr/bin/env node
// 历史用途：APMS 崩溃数据查询，默认版本 1.1.3 为历史分析口径，非当前发布版本。

import { existsSync, readFileSync } from 'node:fs'
import {
  formatMarkdown,
  parseApiClientJson,
  parseCliArgs,
  parseEnvText,
  queryCrashIssues,
  requestAccessToken,
} from './lib/apms-openapi.mjs'

const HELP = `Usage:
  node tools/apms-query.mjs --agc-env-file D:\\DSHM_AGC\\.env --from 2026-10-11 --to 2026-10-17
  node tools/apms-query.mjs --agc-client-file D:\\DSHM_AGC\\agc-apiclient-*.json --from 2026-10-11 --to 2026-10-17

Options:
  --agc-env-file <path>   AGC client credential file (AGC_CLIENT_ID / AGC_CLIENT_SECRET)
  --agc-client-file <path> AGC API client credential JSON
  --package <name>        Application package name (default: com.dshm.dshclient)
  --version <value>       Application version (default: 1.1.3)
  --app-id <id>           AGC application ID; falls back to AGC_APP_ID
  --project-id <id>       AGC project ID; falls back to AGC_PROJECT_ID
  --from <YYYY-MM-DD>     Inclusive start date in Asia/Shanghai
  --to <YYYY-MM-DD>       Inclusive end date in Asia/Shanghai
  --format <markdown|json>
  -h, --help
`

function shanghaiDate(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

function shiftDate(dateText, days) {
  const date = new Date(`${dateText}T00:00:00+08:00`)
  date.setUTCDate(date.getUTCDate() + days)
  return shanghaiDate(date)
}

function startOfShanghaiDay(dateText) {
  return new Date(`${dateText}T00:00:00+08:00`).getTime()
}

function loadEnvironment(envFile) {
  if (envFile.length > 0 && !existsSync(envFile)) {
    throw new Error(`credential file not found: ${envFile}`)
  }
  const fileValues = envFile.length > 0
    ? parseEnvText(readFileSync(envFile, 'utf8'))
    : {}
  return { ...fileValues, ...process.env }
}

function requireValue(values, key, label) {
  const value = String(values[key] ?? '').trim()
  if (value.length === 0) throw new Error(`missing ${label} (${key})`)
  return value
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }

  const env = loadEnvironment(args.envFile)
  let clientId
  let clientSecret
  if (args.clientFile.length > 0) {
    if (!existsSync(args.clientFile)) {
      throw new Error(`API client file not found: ${args.clientFile}`)
    }
    const client = parseApiClientJson(readFileSync(args.clientFile, 'utf8'))
    clientId = client.clientId
    clientSecret = client.clientSecret
  } else {
    clientId = requireValue(env, 'AGC_CLIENT_ID', 'API client ID')
    clientSecret = requireValue(env, 'AGC_CLIENT_SECRET', 'API client secret')
  }
  const appId = args.appId || String(env.AGC_APP_ID ?? '').trim()
  const projectId = args.projectId || String(env.AGC_PROJECT_ID ?? '').trim()
  if (appId.length === 0) throw new Error('missing AGC application ID (--app-id or AGC_APP_ID)')

  const to = args.to || shanghaiDate()
  const from = args.from || shiftDate(to, -6)
  const startTime = startOfShanghaiDay(from)
  const endTime = startOfShanghaiDay(shiftDate(to, 1))

  const accessToken = await requestAccessToken({ clientId, clientSecret })
  const report = await queryCrashIssues({
    accessToken,
    clientId,
    appId,
    projectId,
    packageName: args.packageName,
    version: args.version,
    startTime,
    endTime,
  })

  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify({
      packageName: args.packageName,
      version: args.version,
      from,
      to,
      report,
    }, null, 2)}\n`)
    return
  }

  process.stdout.write(formatMarkdown({
    packageName: args.packageName,
    version: args.version,
    startTime,
    endTime,
    report,
  }))
}

main().catch((error) => {
  process.stderr.write(`APMS query failed: ${error.message}\n`)
  process.exitCode = 1
})
