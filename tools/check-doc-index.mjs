#!/usr/bin/env node
/**
 * 门禁：`docs/` 下每个编号文档都必须在 `docs/README.md` 导航里出现一次。
 *
 * 【为什么要有这条】2026-10-26 的复审实测：`docs/` 有 183 篇编号文档，而 `docs/README.md`
 * 只收录到约 47 篇 —— `95–182`、`212–266` 两段整段缺席。后果不是"少几个链接"：
 *   · 接手的人（和自动化助手）**看不到**这些文档存在，等于白写；
 *   · 过期文档（如 `docs/222` 的 8 条权限口径）无人发现被后续口径取代；
 *   · `docs/263` 在导航里仍标"当前权威"而 `HANDOFF.md` 已取代它。
 * 见 `docs/267` §3 P1-4。判据刻意**只看文件名是否出现**（不做内容判等）：导航怎么写、
 * 放在哪一节、一行还是多行，都不限制；这样门禁不会因为"重排导航"而假红。
 *
 * 【判据】
 *   ① `docs/` 下每个 `^\d+-.*\.md$` 的文件名（**空白归一后**）必须出现在 `docs/README.md` 里；
 *   ② `docs/README.md` 必须含全量索引节标题（防"把整节删掉"这种绕过）。
 *
 * 【判据为什么是"空白归一"】本仓文档名含中文与全角字符，导航里常用 `%20` 转义或
 * 直接写原名；两种写法都算命中。归一化只去空白，不改其它字符。
 *
 * 【离线】不碰网络、不碰 SDK、不碰真机、不跑构建。
 *
 * 用法：
 *   node tools/check-doc-index.mjs              # 两条判据
 *   node tools/check-doc-index.mjs --self-test  # 变异体自检（藏一篇 / 删索引节，都必须判红）
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(HERE, '..')
const DOCS = join(REPO, 'docs')
const README = join(DOCS, 'README.md')
const SECTION_TITLE = '## 9. 编号文档全量索引'

const squish = (s) => s.replace(/\s+/g, '')

function numberedDocs() {
  return readdirSync(DOCS)
    .filter((f) => /^\d+-.*\.md$/.test(f))
    .sort((a, b) => Number(/^(\d+)/.exec(a)[1]) - Number(/^(\d+)/.exec(b)[1]))
}

/** 纯判据：给定 README 文本与文档清单，返回问题列表。 */
function judge(readmeText, docs) {
  const problems = []
  const hay = squish(readmeText)
  if (!readmeText.includes(SECTION_TITLE)) {
    problems.push(`缺少全量索引节「${SECTION_TITLE}」（整节被删同样是欠账）`)
  }
  for (const f of docs) {
    if (!hay.includes(squish(f))) {
      problems.push(`未收录：docs/${f}`)
    }
  }
  return problems
}

function run(label, readmeText, docs) {
  const problems = judge(readmeText, docs)
  if (problems.length > 0) {
    console.error(`❌ ${label}：${problems.length} 处问题`)
    for (const p of problems.slice(0, 20)) console.error(`   · ${p}`)
    if (problems.length > 20) console.error(`   …另有 ${problems.length - 20} 处`)
    return false
  }
  console.log(`✅ ${label}：${docs.length} 篇编号文档全部在导航里`)
  return true
}

const selfTest = process.argv.includes('--self-test')
const readmeText = readFileSync(README, 'utf8')
const docs = numberedDocs()

let ok = run('docs 索引覆盖', readmeText, docs)

if (selfTest) {
  console.log('\n--self-test：变异体必须判红 --')
  const arms = [
    { name: '藏一篇（去掉 docs/267 的链接）', text: readmeText.replace(/267-迁移鸿蒙PC自托管开发缺口与修复方案\.md/g, 'MUTATED'), docs },
    { name: '删索引节标题', text: readmeText.replace(SECTION_TITLE, 'MUTATED'), docs },
    { name: '少一篇（清单里多加一个不存在的编号文档）', text: readmeText, docs: [...docs, '999-不存在的文档.md'] },
  ]
  let armsOk = true
  for (const arm of arms) {
    const judged = judge(arm.text, arm.docs)
    const red = judged.length > 0
    console.log(`  ${red ? '✅' : '❌'} ${arm.name} ⇒ ${red ? `判红（${judged.length} 处）` : '未判红（门禁没牙）'}`)
    if (!red) armsOk = false
  }
  if (!armsOk) {
    console.error('\n❌ 自检失败：门禁对变异体不敏感')
    process.exit(1)
  }
  console.log('✅ 自检通过：三条变异体全部判红')
}

if (!ok) {
  console.error(`\n修复：把缺的文档补进 ${relative(REPO, README)} 的「${SECTION_TITLE}」一节（一行一篇即可）。`)
  process.exit(1)
}
if (!selfTest) {
  console.log('✅ 通过：编号文档全收录，且索引节在位。')
}