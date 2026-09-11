#!/usr/bin/env node
/**
 * ⛔ 已停用（2026-09-11）：客户端侧的「在线环境包」能力已按用户决定移除
 *   （菜单项 + EnvAssetClient.ets + DshBootstrap 的备份/待验收/回滚机制均已删除）。
 * 本脚本保留作为日后恢复该路线的构建侧工具，当前没有任何代码会调用它。
 * 现状与恢复要点见 docs/dsh-version-upgrade.md §3.2。
 *
 * 打包「在线环境预设」（env asset）+ 生成 manifest。
 *
 * 背景与目标见 docs/plan-lite-env-online.md：把「pnpm 原地升级」换成「分发已适配好的
 * 环境包」，绕开「pnpm 只换依赖树、不重放构建期鸿蒙适配」这个结构性矛盾
 * （实测后果：装上去 boot 时主线程死循环，见 .agent-rules/bug-log.md 2026-09-11）。
 *
 * 输入：entry/src/main/resources/rawfile 下已由 prepare-dsh-env.sh + apply-dsh-ohos-adapt.sh
 *       适配好的环境树（dsh / busybox / ohos-skills）。
 * 输出：<out>/dsh-env-<version>.zip + manifest.json + SHA256SUMS
 *
 * 为什么是 zip 而不是 plan 里写的 tar.gz：**解压发生在 ArkTS 侧**（此时设备上还没有
 * node，环境本身就是待部署物），只能用 OHOS 自带 API。`@ohos.zlib.decompressFile`
 * 原生支持 zip 解压到目录；tar 没有任何系统支持，需要在 ArkTS 里手写 tar 解析。
 * 故选择 zip —— 这是对 plan §5.2「解压用 node zlib/tar 内建」的修订（当时假定有 node 可用）。
 *
 * zip 写入器为纯 Node 实现（deflateRaw + 自算 CRC32），不依赖 bsdtar / Compress-Archive，
 * 避免 Windows 版 tar 的长路径与非 ASCII 行为差异。12k 文件量级下未使用 zip64。
 *
 * 用法：
 *   node scripts/build-env-asset.mjs                 # 版本号自动取 DshBootstrap.ENV_VERSION
 *   node scripts/build-env-asset.mjs --out dist/env
 *   node scripts/build-env-asset.mjs --sources scripts/env-asset-sources.json
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const RAWFILE_DIR = path.join(REPO_ROOT, 'entry/src/main/resources/rawfile');
const ENV_INCLUDE = ['dsh', 'busybox', 'ohos-skills'];

// ── 工具 ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const out = { out: path.join(REPO_ROOT, 'dist/env'), sources: null, version: 'auto' };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') out.out = argv[++i];
        else if (a === '--sources') out.sources = argv[++i];
        else if (a === '--version') out.version = argv[++i];
        else throw new Error('未知参数: ' + a);
    }
    return out;
}

/** 从 DshBootstrap.ets 读 ENV_VERSION，保证资产版本与壳期望的一致。 */
function readEnvVersion() {
    const file = path.join(REPO_ROOT, 'entry/src/main/ets/dshm/bootstrap/DshBootstrap.ets');
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/const ENV_VERSION:\s*string\s*=\s*'([^']+)'/);
    if (!m) throw new Error('未能从 DshBootstrap.ets 解析 ENV_VERSION');
    return m[1];
}

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0 ^ -1;
    for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
    return (c ^ -1) >>> 0;
}

/** 递归收集文件，返回相对 rawfile 的 posix 风格路径（保持 dsh/... 前缀）。 */
function collectFiles() {
    const files = [];
    const walk = (absDir, relDir) => {
        for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
            const abs = path.join(absDir, entry.name);
            const rel = relDir.length > 0 ? relDir + '/' + entry.name : entry.name;
            if (entry.isDirectory()) walk(abs, rel);
            else if (entry.isFile()) files.push({ abs, rel });
        }
    };
    for (const top of ENV_INCLUDE) {
        const abs = path.join(RAWFILE_DIR, top);
        if (fs.existsSync(abs)) walk(abs, top);
    }
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return files;
}

// ── 最小 zip 写入器（deflate，无 zip64）──────────────────────────────────────

function writeZip(outFile, files, onProgress) {
    const fd = fs.openSync(outFile, 'w');
    const central = [];
    let offset = 0;
    const chunk = Buffer.alloc(1 << 20);

    const writeAll = (buf) => { fs.writeSync(fd, buf, 0, buf.length); offset += buf.length; };

    for (let i = 0; i < files.length; i++) {
        const { abs, rel } = files[i];
        const raw = fs.readFileSync(abs);
        const deflated = zlib.deflateRawSync(raw, { level: 9 });
        // 压缩没收益就 store（method 0），避免小文件反而变大
        const useDeflate = deflated.length < raw.length;
        const data = useDeflate ? deflated : raw;
        const method = useDeflate ? 8 : 0;

        const nameBuf = Buffer.from(rel, 'utf8');
        const crc = crc32(raw);
        const localOffset = offset;

        // local file header
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);            // version needed
        lh.writeUInt16LE(0x0800, 6);        // flag: UTF-8 names
        lh.writeUInt16LE(method, 8);
        lh.writeUInt16LE(0, 10);            // time
        lh.writeUInt16LE(0x21, 12);         // date (1996-01-01 占位，保证可复现)
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(data.length, 18);
        lh.writeUInt32LE(raw.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        lh.writeUInt16LE(0, 28);
        writeAll(lh);
        writeAll(nameBuf);
        writeAll(data);

        central.push({ nameBuf, crc, method, compSize: data.length, rawSize: raw.length, localOffset });
        if (onProgress && (i % 500 === 0 || i === files.length - 1)) onProgress(i + 1, files.length);
    }

    const centralStart = offset;
    for (const e of central) {
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(20, 4);            // version made by
        ch.writeUInt16LE(20, 6);            // version needed
        ch.writeUInt16LE(0x0800, 8);
        ch.writeUInt16LE(e.method, 10);
        ch.writeUInt16LE(0, 12);
        ch.writeUInt16LE(0x21, 14);
        ch.writeUInt32LE(e.crc, 16);
        ch.writeUInt32LE(e.compSize, 20);
        ch.writeUInt32LE(e.rawSize, 24);
        ch.writeUInt16LE(e.nameBuf.length, 28);
        ch.writeUInt16LE(0, 30);            // extra
        ch.writeUInt16LE(0, 32);            // comment
        ch.writeUInt16LE(0, 34);            // disk
        ch.writeUInt16LE(0, 36);            // internal attrs
        ch.writeUInt32LE(0, 38);            // external attrs
        ch.writeUInt32LE(e.localOffset, 42);
        writeAll(ch);
        writeAll(e.nameBuf);
    }
    const centralSize = offset - centralStart;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    writeAll(eocd);

    fs.closeSync(fd);
    void chunk;
    return { entries: central.length };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

function main() {
    const args = parseArgs(process.argv);
    const version = args.version === 'auto' ? readEnvVersion() : args.version;
    fs.mkdirSync(args.out, { recursive: true });

    console.log('[env-asset] 版本 ' + version + '（ENV_VERSION）');
    const files = collectFiles();
    const totalRaw = files.reduce((s, f) => s + fs.statSync(f.abs).size, 0);
    console.log('[env-asset] 待打包 ' + files.length + ' 个文件 / ' + (totalRaw / 1048576).toFixed(1) + ' MB');

    const assetName = 'dsh-env-' + version + '.zip';
    const assetPath = path.join(args.out, assetName);
    const t0 = Date.now();
    const { entries } = writeZip(assetPath, files, (done, total) => {
        if (done === total || done % 2500 === 0) {
            console.log('[env-asset]   ' + done + '/' + total);
        }
    });
    const stat = fs.statSync(assetPath);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex');
    console.log('[env-asset] ' + assetName + '  ' + (stat.size / 1048576).toFixed(1) + ' MB  ' +
        ((Date.now() - t0) / 1000).toFixed(1) + 's  entries=' + entries);
    console.log('[env-asset] sha256=' + sha256);

    // 源模板：把 {asset}/{version}/{sha256}/{size} 占位符替换进去
    const sourcesFile = args.sources ?? path.join(SCRIPT_DIR, 'env-asset-sources.json');
    let templates = [];
    if (fs.existsSync(sourcesFile)) {
        templates = JSON.parse(fs.readFileSync(sourcesFile, 'utf8')).sources ?? [];
    } else {
        console.warn('[env-asset] 未找到源模板 ' + sourcesFile + '，manifest.urls 留空');
    }
    const urls = templates
        .map((t) => (t.enabled === false ? '' : String(t.url)
            .replaceAll('{asset}', assetName)
            .replaceAll('{version}', version)
            .replaceAll('{sha256}', sha256)
            .replaceAll('{size}', String(stat.size))))
        .filter((u) => u.length > 0);

    const manifest = {
        schema: 'dsh-env-asset/1',
        version,
        engine: { node: 'v24.2.0', platform: 'openharmony', arch: 'arm64' },
        generatedAt: new Date().toISOString(),
        asset: {
            name: assetName,
            format: 'zip',
            size: stat.size,
            sha256,
            entries,
            // 解压目标相对 filesDir：<filesDir>/dsh 即环境根（含 .dshm-version）
            extractTo: 'dsh',
            // 解压后必须存在的哨兵（与 DshBootstrap.verifyDshSentinel 保持一致）
            sentinels: [
                'dsh/node_modules/@deepseek-ai/dsh/lib/_fetch-shim.cjs',
                'dsh/node_modules/@deepseek-ai/dsh/package.json',
                'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json',
                'dsh/node_modules/dshm-terminal/package.json',
                'dsh/node_modules/dshm-config-editor/package.json'
            ],
            urls
        }
    };
    const manifestPath = path.join(args.out, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(args.out, 'SHA256SUMS'),
        sha256 + '  ' + assetName + '\n', 'utf8');
    console.log('[env-asset] manifest -> ' + manifestPath + '（' + urls.length + ' 个下载源）');
    if (urls.length === 0) {
        console.warn('[env-asset] ⚠️ 没有可用下载源：请填 scripts/env-asset-sources.json 后再发布');
    }
}

main();
