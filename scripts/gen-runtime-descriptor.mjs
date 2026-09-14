/**
 * 生成运行时完整性描述符（runtime-descriptor.json）。
 *
 * 借鉴 dsh 官方 desktop 的 runtime-tree.ts：构建前遍历 rawfile/dsh 全目录，
 * 计算每个文件的 path + bytes + sha256，生成结构化描述符打包进 HAP。
 * 启动时 DshBootstrap.ensureDshDir 解压后读描述符做完整性校验。
 *
 * 用法：node scripts/gen-runtime-descriptor.mjs [--env-version <version>] [--platform <platform>] [--arch <arch>]
 * 默认：--env-version 从 DshBootstrap.ets 的 ENV_VERSION 读取
 *       --platform ohos
 *       --arch arm64
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const RAWFILE_DSH = 'entry/src/main/resources/rawfile/dsh';
const DESCRIPTOR_NAME = 'runtime-descriptor.json';
const SCHEMA_VERSION = 1;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { envVersion: '', platform: 'ohos', arch: 'arm64' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env-version' && args[i + 1]) opts.envVersion = args[++i];
    else if (args[i] === '--platform' && args[i + 1]) opts.platform = args[++i];
    else if (args[i] === '--arch' && args[i + 1]) opts.arch = args[++i];
  }
  return opts;
}

function readEnvVersion() {
  const content = readFileSync('entry/src/main/ets/dshm/bootstrap/DshBootstrap.ets', 'utf8');
  const match = content.match(/ENV_VERSION:\s*string\s*=\s*'([^']+)'/);
  if (!match) throw new Error('无法从 DshBootstrap.ets 提取 ENV_VERSION');
  return match[1];
}

function collectFiles(root, dir, results) {
  if (dir === undefined) dir = root;
  if (results === undefined) results = [];
  for (const name of readdirSync(dir)) {
    if (name === DESCRIPTOR_NAME) continue;
    // hvigor 打包 rawfile 时会过滤掉隐藏文件（任意路径段以 '.' 开头，如
    // .github/.history/.eslintrc/.editorconfig/.bin 的 Windows 包装等）。
    // 描述符必须与「实际会打包进 HAP 的文件集合」一致，否则启动 L0 完整性校验
    // 会用描述符里的隐藏文件去 stat 设备上不存在（被打包过滤）的路径 → 报缺文件。
    if (name.startsWith('.')) continue;
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      collectFiles(root, fullPath, results);
    } else if (stat.isFile()) {
      const rel = relative(root, fullPath).split(sep).join('/');
      results.push({ path: rel, fullPath });
    }
  }
  return results;
}

function main() {
  const opts = parseArgs();
  const envVersion = opts.envVersion || readEnvVersion();

  if (!existsSync(RAWFILE_DSH)) {
    console.error('rawfile/dsh 目录不存在: ' + RAWFILE_DSH);
    console.error('请先运行 prepare-dsh 环境准备脚本');
    process.exit(1);
  }

  console.log('遍历 ' + RAWFILE_DSH + ' ...');
  const files = collectFiles(RAWFILE_DSH);
  console.log('找到 ' + files.length + ' 个文件');

  console.log('计算 SHA256 ...');
  const entries = files.map(({ path, fullPath }) => {
    const data = readFileSync(fullPath);
    const sha256 = createHash('sha256').update(data).digest('hex');
    return { path, bytes: data.length, sha256 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const descriptor = {
    schemaVersion: SCHEMA_VERSION,
    envVersion,
    platform: opts.platform,
    arch: opts.arch,
    fileCount: entries.length,
    files: entries,
  };

  const outputPath = join(RAWFILE_DSH, DESCRIPTOR_NAME);
  writeFileSync(outputPath, JSON.stringify(descriptor, undefined, 2) + '\n');
  console.log('描述符已写入: ' + outputPath);
  console.log('  envVersion: ' + envVersion);
  console.log('  platform:   ' + opts.platform);
  console.log('  arch:       ' + opts.arch);
  console.log('  fileCount:  ' + entries.length);
  console.log('  size:       ' + statSync(outputPath).size + ' bytes');
}

main();
