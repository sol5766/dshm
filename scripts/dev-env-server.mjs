#!/usr/bin/env node
/**
 * ⛔ 已停用（2026-09-11）：客户端侧的「在线环境包」能力已按用户决定移除
 *   （菜单项 + EnvAssetClient.ets + DshBootstrap 的备份/待验收/回滚机制均已删除）。
 * 本脚本保留作为日后恢复该路线的构建侧工具，当前没有任何代码会调用它。
 * 现状与恢复要点见 docs/dsh-version-upgrade.md §3.2。
 *
 * 开发用「伪下载源」静态服务器：托管 dist/env，供真机走完整条
 * 下载 → sha256 → 解压 → 哨兵 → 启动 链路，无需先完成外网发布。
 * （即 docs/plan-lite-env-online.md「附：实施顺序建议」第 2 条的工具化。）
 *
 * 用法：
 *   1) 开发机：node scripts/dev-env-server.mjs            # 默认监听 18080，根目录 dist/env
 *   2) 映射给设备（注意是 rport：设备 → 开发机）：
 *        hdc rport tcp:18080 tcp:18080
 *   3) 设备侧 EnvAssetClient 的 MANIFEST_SOURCES 指向 http://127.0.0.1:18080/manifest.json
 *   4) 用完清理：hdc fport rm tcp:18080 tcp:18080
 *
 * 支持 Range（断点续传验证必需）与 HEAD。故意不做缓存，便于反复改包重测。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '../dist/env');
const PORT = Number(process.env.PORT ?? 18080);

const MIME = {
    '.json': 'application/json; charset=utf-8',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = urlPath === '/' ? '/manifest.json' : urlPath;
    const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));

    if (!file.startsWith(ROOT)) {
        res.writeHead(403).end('forbidden');
        return;
    }
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        console.log('[dev-env] 404 ' + rel);
        res.writeHead(404).end('not found');
        return;
    }

    const headers = {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'no-store'
    };

    // Range 支持：断点续传的关键。返回 206 + content-range。
    const range = req.headers.range;
    if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (m) {
            const start = Number(m[1]);
            const end = m[2].length > 0 ? Number(m[2]) : stat.size - 1;
            if (start >= stat.size || end >= stat.size || start > end) {
                res.writeHead(416, { 'content-range': 'bytes */' + stat.size }).end();
                return;
            }
            headers['content-range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
            headers['content-length'] = String(end - start + 1);
            console.log('[dev-env] 206 ' + rel + ' bytes=' + start + '-' + end);
            res.writeHead(206, headers);
            if (req.method === 'HEAD') { res.end(); return; }
            fs.createReadStream(file, { start, end }).pipe(res);
            return;
        }
    }

    headers['content-length'] = String(stat.size);
    console.log('[dev-env] 200 ' + rel + ' (' + (stat.size / 1048576).toFixed(1) + ' MB)');
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('[dev-env] serving ' + ROOT + ' on http://0.0.0.0:' + PORT);
    console.log('[dev-env] 设备侧记得：hdc rport tcp:' + PORT + ' tcp:' + PORT);
});
