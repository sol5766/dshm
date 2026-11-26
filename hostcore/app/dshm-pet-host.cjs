'use strict';
/**
 * dsh-pet 桌面宿主伴生层：把插件自己的 Electron 渲染页放到宿主同源下。
 *
 * 只做三件事：
 *   1. 标记 DSH_PET_IN_PROCESS=1，让 dsh-pet 不 spawn/下载 Electron；
 *   2. 注册 /dsh-pet-native/*：serving <dsh-pet>/runtime/electron-helper，并在 index.html
 *      前注入同源 pet-bridge-shim.js（CSP script-src 'self' 不允许内联）；
 *   3. 不参与宠物 UI/配置/动画——全部由 dsh-pet 自己负责。
 *
 * 找不到 dsh-pet（未安装）时静默跳过，不影响宿主启动。
 */

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webm': 'video/webm',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasPackage(dir) {
  return isDir(dir) && fs.existsSync(path.join(dir, 'package.json'));
}

/** 在 home 下有限深度找 dsh-pet 包根：插件安装目录在不同 profile 下层级不同。 */
function findPetRoot(home) {
  const direct = [
    path.join(home, 'plugins', 'node_modules', 'dsh-pet'),
    path.join(home, 'plugin', 'node_modules', 'dsh-pet'),
    path.join(home, 'node_modules', 'dsh-pet'),
  ];
  for (const p of direct) {
    if (hasPackage(p)) return p;
  }
  try {
    const resolved = require.resolve('dsh-pet/package.json', {
      paths: [home, process.cwd(), path.join(home, 'plugins'), path.join(home, 'plugin')],
    });
    return path.dirname(resolved);
  } catch {
    /* fallthrough */
  }
  const queue = [{ dir: home, depth: 0 }];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur.depth > 4) continue;
    let names = [];
    try {
      names = fs.readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of names) {
      if (!ent.isDirectory()) continue;
      if (ent.name === 'node_modules' || ent.name === 'dsh-pet') {
        const cand = path.join(cur.dir, ent.name, 'dsh-pet');
        if (hasPackage(cand)) return cand;
      }
      if (ent.name.startsWith('.')) continue;
      queue.push({ dir: path.join(cur.dir, ent.name), depth: cur.depth + 1 });
    }
  }
  return '';
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * 注册 /dsh-pet-native 前缀路由。
 * @param ctx 宿主上下文（ctx.webServer）
 * @param homeDir $DSH_HOME
 * @param log 日志函数
 * @returns 是否注册成功
 */
function registerPetHost(ctx, homeDir, log) {
  const info = typeof log === 'function' ? log : () => {};
  try {
    process.env.DSH_PET_IN_PROCESS = '1';
    process.env.DSH_PET_OPEN_TARGET = process.env.DSH_PET_OPEN_TARGET || 'web';
    // 配置变化时 dsh-pet 会调它；宿主侧无需重建进程，ArkTS 轮询 /dsh-pet-7340/config 即可。
    if (typeof globalThis.__dshPetRebuildUi !== 'function') {
      globalThis.__dshPetRebuildUi = async () => {};
    }
  } catch {
    /* 环境设置失败不阻断 */
  }

  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    info('[dsh-pet-host] webServer 不可用，跳过静态路由');
    return false;
  }

  const petRoot = findPetRoot(homeDir);
  if (!petRoot) {
    info('[dsh-pet-host] 未安装 dsh-pet，跳过静态路由');
    return false;
  }
  const helperDir = path.join(petRoot, 'runtime', 'electron-helper');
  if (!isDir(helperDir)) {
    info('[dsh-pet-host] dsh-pet 缺少 runtime/electron-helper，跳过');
    return false;
  }
  const shimPath = path.join(__dirname, 'dshm-pet-shim.js');

  try {
    ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-pet-native',
      auth: 'anonymous',
      handler: (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const name = url.pathname.slice('/dsh-pet-native/'.length);
        if (name === '' || name === 'probe.html') {
          try {
            const html = fs.readFileSync(path.join(helperDir, 'index.html'), 'utf8');
            const injected = html.replace(
              '<script src=',
              '<script src="/dsh-pet-native/pet-bridge-shim.js"></script>\n<script src=',
            );
            send(res, 200, MIME['.html'], injected);
          } catch (e) {
            send(res, 500, 'text/plain; charset=utf-8', 'index.html 不可读');
          }
          return;
        }
        if (name === 'pet-bridge-shim.js') {
          try {
            send(res, 200, MIME['.js'], fs.readFileSync(shimPath));
          } catch (e) {
            send(res, 500, 'text/plain; charset=utf-8', 'shim 不可读');
          }
          return;
        }
        // 防目录穿越
        const file = path.resolve(helperDir, name);
        if (!file.startsWith(path.resolve(helperDir) + path.sep)) {
          send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
          return;
        }
        try {
          const body = fs.readFileSync(file);
          send(res, 200, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', body);
        } catch {
          send(res, 404, 'text/plain; charset=utf-8', 'not found');
        }
      },
    });
    info('[dsh-pet-host] /dsh-pet-native 已注册，pluginRoot=' + petRoot);
    return true;
  } catch (e) {
    info('[dsh-pet-host] 路由注册失败：' + (e && e.message ? e.message : String(e)));
    return false;
  }
}

module.exports = { registerPetHost, findPetRoot };
