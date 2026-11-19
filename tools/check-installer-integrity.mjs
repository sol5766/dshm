#!/usr/bin/env node
/**
 * 门禁：端侧插件安装通道必须**按 registry 声明的完整性**校验 npm tarball。
 *
 * 【为什么要有这条（2026-10-29，docs/291 复核）】
 * npm 客户端装包时会按 `dist.integrity` 校验 tarball；本仓的端侧进程内安装通道
 * 此前只保留 `dist.tarball`，**丢掉 `dist.integrity` / `dist.shasum`**，下载后
 * 直接 `gunzipSync` + 解包 + 落位，落位前只检查"入口文件在"。
 * 这条通道装的是**要进宿主进程执行**的插件 ⇒ registry 镜像 / CDN / 重定向 / 本地缓存
 * 任意一环给出可解包的篡改字节，都会被当成"所选版本"装进来。
 *
 * 【判据（离线，不需要核心树与设备）】
 *   ① 静态接线：`resolveSpec` 带出 `integrity` 与 `shasum` 两个字段；
 *   ② `installSpecInner` 在 `zlib.gunzipSync(` **之前**调用 `verifyTarballIntegrity(`；
 *   ③ 行为：抽出 `verifyTarballIntegrity` 函数原文，真跑一组样例 ——
 *      sha512 正确判绿、错误判红、`shasum` 回退、两者皆无必须判红、
 *      不支持的算法段不得误杀（判绿）。
 *
 * 对照臂（--self-test）：把校验调用删掉 / 让"两者皆无"静默通过，必须判红。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const INSTALLER = 'hostcore/app/dshm-installer.js';

/** 去掉注释（"注释里写着校验、代码已删"是本仓反复踩的坑）。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 截出 `function verifyTarballIntegrity(...) { ... }` 的完整原文。 */
export function extractVerifier(src) {
  const at = src.indexOf('function verifyTarballIntegrity(');
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}

/** 静态判据：返回问题数组（空 = 绿）。 */
export function judgeStatic(raw) {
  const s = stripComments(raw);
  const problems = [];
  if (!/integrity:\s*typeof vMeta\.dist\.integrity === 'string'/.test(s)) {
    problems.push('resolveSpec 没有带出 dist.integrity');
  }
  if (!/shasum:\s*typeof vMeta\.dist\.shasum === 'string'/.test(s)) {
    problems.push('resolveSpec 没有带出 dist.shasum（integrity 缺失时的回退）');
  }
  if (extractVerifier(s).length === 0) {
    problems.push('缺少 verifyTarballIntegrity()（完整性判据本体）');
  }
  const atVerify = s.indexOf('verifyTarballIntegrity(tgz, resolved)');
  const atGunzip = s.indexOf('zlib.gunzipSync(');
  if (atVerify < 0) {
    problems.push('installSpecInner 没有在下载后调用 verifyTarballIntegrity(tgz, resolved)');
  } else if (atGunzip > 0 && atVerify > atGunzip) {
    problems.push('校验被放在解包之后（应先校验、后解包）');
  }
  return problems;
}

/** 行为判据：把校验函数原文编译成函数真跑。 */
function buildVerifier(src) {
  const body = extractVerifier(src);
  if (body.length === 0) return null;
  // 函数体只依赖 crypto（注入）与字符串操作，不含其它闭包 ⇒ 可直接 new Function
  // eslint-disable-next-line no-new-func
  return new Function('crypto', `return (${body.replace(/^function verifyTarballIntegrity/, 'function')})`)({ createHash });
}

export function judgeBehavior(src) {
  const verify = buildVerifier(src);
  if (verify === null) return ['无法编译 verifyTarballIntegrity（函数体缺失）'];
  const payload = Buffer.from('fake-tarball-bytes');
  const sha512 = createHash('sha512').update(payload).digest('base64');
  const sha1 = createHash('sha1').update(payload).digest('hex');
  let failed = 0;
  const check = (label, ok, detail = '') => {
    if (!ok) {
      failed++;
      console.log(`  FAIL  ${label}${detail ? `（${detail}）` : ''}`);
    } else {
      console.log(`  ok    ${label}`);
    }
  };
  const spec = (over) => ({ name: 'pkg', version: '1.0.0', integrity: '', shasum: '', ...over });

  check('sha512 命中 ⇒ 通过', verify(payload, spec({ integrity: `sha512-${sha512}` })) === '');
  check('sha512 不符 ⇒ 判红', verify(payload, spec({ integrity: `sha512-${'A'.repeat(88)}` })) !== '');
  check('sha1 integrity 命中 ⇒ 通过', verify(payload, spec({ integrity: `sha1-${createHash('sha1').update(payload).digest('base64')}` })) === '');
  check('多算法段（其一对）⇒ 通过', verify(payload, spec({ integrity: `sha256-${'B'.repeat(44)} sha512-${sha512}` })) === '');
  check('只有不支持算法段 ⇒ 不得误杀（判绿）', verify(payload, spec({ integrity: 'blake3-AAAA' })) === '');
  check('无 integrity、shasum 命中 ⇒ 通过', verify(payload, spec({ shasum: sha1 })) === '');
  check('无 integrity、shasum 不符 ⇒ 判红', verify(payload, spec({ shasum: 'f'.repeat(40) })) !== '');
  check('两者皆无 ⇒ 必须判红（不许静默放行）', verify(payload, spec({})) !== '');
  return failed === 0 ? [] : [`行为判据红 ${failed} 条`];
}

const selfTest = process.argv.includes('--self-test');
const raw = readFileSync(join(ROOT, INSTALLER), 'utf8');
const problems = [...judgeStatic(raw), ...judgeBehavior(raw)];

if (!selfTest) {
  if (problems.length > 0) {
    console.error(`❌ 插件安装完整性校验不完整（${problems.length} 处）：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：resolveSpec 带出 integrity/shasum，解包前按 SRI 校验，缺元数据拒绝安装。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let ok = problems.length === 0;
console.log(`  基线：${problems.length} 处问题（应为 0）`);
for (const p of problems) console.log(`     · ${p}`);

const arms = [
  ['删掉下载后的校验调用', () => raw.replace("verifyTarballIntegrity(tgz, resolved)", '(() => "")')],
  ['校验挪到解包之后', () => {
    const call = 'const integrityError = verifyTarballIntegrity(tgz, resolved);';
    const without = raw.replace(call, 'const integrityError = "";');
    return without.replace('const tar = zlib.gunzipSync(tgz);', `const tar = zlib.gunzipSync(tgz); ${call}`);
  }],
  ['两者皆无时静默通过', () => raw.replace(
    "return `${label} 的 registry 元数据里没有 integrity/shasum，无法校验 tarball 完整性（已拒绝安装）`;",
    "return '';")],
];
for (const [label, mutate] of arms) {
  const mutated = mutate();
  const changed = mutated !== raw;
  const reds = changed ? [...judgeStatic(mutated), ...judgeBehavior(mutated)] : [];
  const red = changed && reds.length > 0;
  if (!red) ok = false;
  console.log(`  ${red ? '✅' : '❌'} ${label} ⇒ ${changed ? `判红（${reds.length} 处）` : '变异未生效'}`);
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败（门禁没牙）。');
process.exit(ok ? 0 : 3);
