#!/usr/bin/env node
/**
 * 门禁：宿主 webServer 路由必须显式声明 `auth: 'anonymous'`。
 *
 * 【事故】2026-11-25 两端实测（r51 P0 / PC v3 R1-R2）：核心 0.2.3 的
 * `@deepseek-ai/dsh-host-webserver` 把缺省授权策略改成 `auth ?? "required"`
 * （lib/index.js authPolicy），而 `hostcore/app/main.js` 的 10 处
 * `ctx.webServer.register({ kind, path, handler })` 全都没写 `auth` 字段
 * ⇒ 传输层 admission 落进 "required" ⇒ `dsh-client-connection` 的
 * `webserver/authorize` 钩子走会话 Cookie 鉴权 ⇒ 只带桥 token 的
 * python / browser 工具全部 401。0.2.2 没有这套 admission，所以是核心升级引出的回归。
 *
 * 【口径】这些路由的真实鉴权在 handler 内部（`pyBridgeTokenOk` 等 token 检查）
 * 与 `isTrustedRequest` 主机白名单 403 栅栏，传输层必须放行为 anonymous。
 * `register()` 原样保存 route 对象，多出的 `auth` 字段对 0.2.2 无害。
 *
 * 判据：
 *   ① main.js 里 10 条 /dshm-* 路由与 dshm-pet-host.cjs 里 1 条 /dsh-pet-native
 *      前缀路由必须齐全（防整段删除后门禁空转）；
 *   ② 每个 `ctx.webServer.register({...})` 从开括号到 handler 之间必须显式含
 *      `auth: 'anonymous'`（防缺省回落 required 再次 401）；
 *   ③ 未来新增路由同样必须显式声明；若要故意挂会话鉴权路由，先改本门禁再改代码。
 *
 * 用法：node tools/check-webserver-route-auth.mjs [--self-test]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = [
  {
    file: 'hostcore/app/main.js',
    requiredPaths: [
      '/dshm-python/status', '/dshm-python/run-get', '/dshm-python/exec',
      '/dshm-browser/start', '/dshm-browser/status', '/dshm-browser/invoke',
      '/dshm-open-link', '/dshm-registry/view', '/dshm-packages/list', '/dshm-shot',
    ],
  },
  {
    file: 'hostcore/app/dshm-pet-host.cjs',
    requiredPaths: ['/dsh-pet-native'],
  },
]

/** 从 register 开括号扫到 handler 属性为止的一段里抽 path / auth。 */
export function extractSites(text) {
  const sites = []
  const re = /ctx\.webServer\.register\(\{/g
  let m
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length
    const handlerAt = text.indexOf('handler', start)
    const segEnd = handlerAt < 0 ? Math.min(start + 400, text.length)
      : Math.min(handlerAt, start + 400)
    const seg = text.slice(start, segEnd)
    sites.push({
      path: /path:\s*'([^']+)'/.exec(seg)?.[1] ?? '(path?)',
      auth: /auth:\s*'([^']+)'/.exec(seg)?.[1] ?? null,
    })
  }
  return sites
}

export function judgeText(mainText, petText) {
  const fails = []
  const seen = []
  const texts = [mainText, petText]
  for (let f = 0; f < FILES.length; f++) {
    const sites = extractSites(texts[f])
    for (const s of sites) {
      seen.push(s.path)
      if (s.auth !== 'anonymous') {
        fails.push(`${FILES[f].file}：路由 ${s.path} 的 auth 必须显式为 'anonymous'`
          + `（实际：${s.auth ?? '未声明'}）——缺省即 required，会话 Cookie 鉴权会把 token 客户端挡成 401`)
      }
    }
    for (const need of FILES[f].requiredPaths) {
      if (!sites.some((s) => s.path === need)) {
        fails.push(`${FILES[f].file}：缺少路由 ${need}（注册被整段删除或路径被改）`)
      }
    }
    if (sites.length === 0) {
      fails.push(`${FILES[f].file}：没有找到任何 ctx.webServer.register 站点（解析器失效或注册被移走）`)
    }
  }
  return { fails, seen }
}

function selfTest(mainText, petText) {
  const arms = [
    ['删掉一处 auth 声明（缺省回落 required）', () => judgeText(
      mainText.replace("      path: '/dshm-python/status',\n      auth: 'anonymous',\n",
        "      path: '/dshm-python/status',\n"),
      petText)],
    ['auth 改成 required（会话鉴权 401 回归）', () => judgeText(
      mainText.replace("      path: '/dshm-browser/invoke',\n      auth: 'anonymous',\n",
        "      path: '/dshm-browser/invoke',\n      auth: 'required',\n"),
      petText)],
    ['auth 值打错（anonymousX）', () => judgeText(
      mainText.replace("      path: '/dshm-shot',\n      auth: 'anonymous',\n",
        "      path: '/dshm-shot',\n      auth: 'anonymousX',\n"),
      petText)],
    ['还原旧形态：全部 auth 行移除', () => judgeText(
      mainText.replaceAll("      auth: 'anonymous',\n", ''),
      petText.replaceAll("      auth: 'anonymous',\n", ''))],
    ['新增一条未声明 auth 的路由', () => judgeText(
      mainText.replace('function pyBridgePathInsideSandbox(abs) {',
        "function pyBridgePathInsideSandbox(abs) {\n  ctx.webServer.register({ kind: 'exact', path: '/dshm-new-thing', handler: () => {} });"),
      petText)],
    ['整段删除 python 注册（路由缺失）', () => judgeText(
      mainText.replace("      path: '/dshm-python/exec',\n      auth: 'anonymous',\n", ''),
      petText)],
  ]
  let bad = 0
  for (const [name, run] of arms) {
    const fails = run().fails
    console.log(`  ${fails.length ? '通过' : '失败'}：${name}（命中 ${fails.length} 条）`)
    if (!fails.length) bad++
  }
  return bad
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mainText = readFileSync(join(ROOT, FILES[0].file), 'utf8')
  const petText = readFileSync(join(ROOT, FILES[1].file), 'utf8')
  const { fails, seen } = judgeText(mainText, petText)
  console.log('== 宿主 webServer 路由 auth 声明（共 ' + seen.length + ' 条）==')
  for (const p of seen) console.log('  · ' + p)
  for (const f of fails) console.error('失败：' + f)
  const bad = process.argv.includes('--self-test') ? selfTest(mainText, petText) : 0
  if (bad) console.error(`自检失败：${bad} 条变异未被识破`)
  if (fails.length || bad) process.exit(1)
  console.log('通过：11 条路由全部显式 auth=anonymous（真实鉴权在 handler 内 token 检查 + 主机白名单 403 栅栏）。')
}
