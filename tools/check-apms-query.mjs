#!/usr/bin/env node
// 历史用途：同上，版本 1.1.3 仅作历史崩溃数据查询。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  buildCrashRequest,
  formatMarkdown,
  normalizeCrashResponse,
  parseApiClientJson,
  parseCliArgs,
  parseEnvText,
  queryCrashIssues,
  requestAccessToken,
} from './lib/apms-openapi.mjs'

const request = buildCrashRequest({
  version: '1.1.3',
  startTime: 1760112000000,
  endTime: 1760716800000,
})

assert.deepEqual(request, {
  startTime: 1760112000000,
  endTime: 1760716800000,
  filters: {
    appVersions: ['1.1.3'],
  },
})

const normalized = normalizeCrashResponse({
  requestId: 'req-1',
  reason: 'OK',
  message: 'success',
  data: {
    resultSet: [{
      crashType: 'CPP_CRASH',
      crashCount: 148,
      startCount: 2420,
      crashDeviceCount: 7,
      deviceCount: 385,
      summaries: [{
        fingerprint: 'fp-qemu',
        crashCount: '8',
        crashDeviceCount: '2',
        summary: '/data/libs/libqemu-system-aarch64.so(tcg_region_init+1944)',
        firstTime: 1760601600000,
        lastTime: 1760691200000,
        startVersion: '1.1.3',
        endVersion: '1.1.3',
      }],
    }],
  },
})

assert.equal(normalized.total.crashCount, 148)
assert.equal(normalized.total.startCount, 2420)
assert.equal(normalized.total.crashDeviceCount, 7)
assert.equal(normalized.total.deviceCount, 385)
assert.equal(normalized.total.crashRate, 148 / 2420)
assert.deepEqual(normalized.issues[0], {
  crashType: 'CPP_CRASH',
  fingerprint: 'fp-qemu',
  crashCount: 8,
  crashDeviceCount: 2,
  summary: '/data/libs/libqemu-system-aarch64.so(tcg_region_init+1944)',
  firstTime: 1760601600000,
  lastTime: 1760691200000,
  startVersion: '1.1.3',
  endVersion: '1.1.3',
})

const markdown = formatMarkdown({
  packageName: 'com.dshm.dshclient',
  version: '1.1.3',
  startTime: new Date('2026-10-11T00:00:00+08:00').getTime(),
  endTime: new Date('2026-10-18T00:00:00+08:00').getTime(),
  report: normalized,
})

assert.match(markdown, /APMS 1\.1\.3 崩溃报告/)
assert.match(markdown, /2026-10-11 至 2026-10-17/)
assert.match(markdown, /崩溃次数：148/)
assert.match(markdown, /崩溃率：6\.12%/)
assert.match(markdown, /tcg_region_init\+1944/)
assert.match(markdown, /8 次/)

assert.deepEqual(
  parseEnvText([
    '# local credentials',
    'AGC_CLIENT_ID=client-id',
    'AGC_CLIENT_SECRET="client-secret"',
    'IGNORED',
  ].join('\n')),
  {
    AGC_CLIENT_ID: 'client-id',
    AGC_CLIENT_SECRET: 'client-secret',
  },
)

assert.deepEqual(
  parseApiClientJson(JSON.stringify({
    client_id: 'client-id',
    client_secret: 'client-secret',
    developer_id: 'developer-id',
  })),
  {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    developerId: 'developer-id',
  },
)

const calls = []
const fetchImpl = async (url, init) => {
  calls.push({ url, init })
  if (url.endsWith('/api/oauth2/v1/token')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'access-token', expires_in: 172800 }),
    }
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      requestId: 'req-2',
      reason: 'OK',
      message: 'success',
      data: {
        resultSet: [{
          crashType: 'CPP_CRASH',
          crashCount: 148,
          startCount: 2420,
          crashDeviceCount: 7,
          deviceCount: 385,
          summaries: [],
        }],
      },
    }),
  }
}

const token = await requestAccessToken({
  clientId: 'client-id',
  clientSecret: 'client-secret',
  fetchImpl,
})
assert.equal(token, 'access-token')

const liveReport = await queryCrashIssues({
  accessToken: token,
  clientId: 'client-id',
  appId: 'app-id',
  projectId: 'project-id',
  packageName: 'com.dshm.dshclient',
  version: '1.1.3',
  startTime: 1760112000000,
  endTime: 1760716800000,
  fetchImpl,
})

assert.equal(liveReport.total.crashCount, 148)
assert.equal(calls.length, 2)
assert.equal(
  calls[1].url,
  'https://connect-api.cloud.huawei.com/api/apm/api/v1/hap/query/crash/metric',
)
assert.equal(calls[1].init.headers.Authorization, 'Bearer access-token')
assert.equal(calls[1].init.headers.client_id, 'client-id')
assert.equal(calls[1].init.headers.packageName, 'com.dshm.dshclient')
assert.equal(calls[1].init.headers.appId, 'app-id')
assert.deepEqual(
  JSON.parse(calls[1].init.body).filters.appVersions,
  ['1.1.3'],
)

assert.deepEqual(
  parseCliArgs([
    '--agc-env-file', 'D:\\DSHM_AGC\\.env',
    '--from', '2026-10-11',
    '--to', '2026-10-17',
    '--format', 'markdown',
  ]),
  {
    envFile: 'D:\\DSHM_AGC\\.env',
    clientFile: '',
    packageName: 'com.dshm.dshclient',
    version: '1.1.3',
    appId: '',
    projectId: '',
    from: '2026-10-11',
    to: '2026-10-17',
    format: 'markdown',
    help: false,
  },
)

assert.deepEqual(
  parseCliArgs([
    '--agc-client-file', 'D:\\DSHM_AGC\\client.json',
  ]),
  {
    envFile: '',
    clientFile: 'D:\\DSHM_AGC\\client.json',
    packageName: 'com.dshm.dshclient',
    version: '1.1.3',
    appId: '',
    projectId: '',
    from: '',
    to: '',
    format: 'markdown',
    help: false,
  },
)

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const missingEnv = spawnSync(process.execPath, [
  'tools/apms-query.mjs',
  '--agc-env-file',
  'Z:\\definitely-missing-apms.env',
], {
  cwd: repoRoot,
  encoding: 'utf8',
})
assert.equal(missingEnv.status, 1)
assert.match(missingEnv.stderr, /credential file not found/)

console.log('APMS query contract: PASS')
