'use strict';

/**
 * 为养鱼等媒体插件落位随包 ffmpeg / ffprobe。
 *
 * 构建期 tools/place-ffmpeg.mjs 从 Harmonybrew 采集可执行文件、动态库闭包并
 * 自签名。运行期这里把整个目录复制到应用可写沙箱，生成带 LD_LIBRARY_PATH 的
 * wrapper，让插件通过 PATH / FFMPEG 环境变量直接找到。
 *
 * 边界：
 *   - 只在 PC / 2in1 档启用（手机与平板不加载、不落位）；
 *   - 只写 `<SANDBOX_HOME>/toolchain/ffmpeg` 与 `<BIN>/ffmpeg|ffprobe` 生成物；
 *   - 不读取用户工作区，不修改插件文件；
 *   - 更新用临时目录完成后替换，失败保留旧版本。
 */

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_REL = path.join('toolchain', 'ffmpeg');
const MARKER = 'dshm-ffmpeg.json';

function writeIfChanged(file, text, mode = 0o755) {
  try {
    if (fs.readFileSync(file, 'utf8') === text) {
      return false;
    }
  } catch {
    // 文件不存在或不可读：继续写。
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, text, { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    try {
      if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    } catch {
      // 下次启动会覆盖。
    }
  }
  return true;
}

function equalMarker(left, right) {
  try {
    return fs.readFileSync(left, 'utf8') === fs.readFileSync(right, 'utf8');
  } catch {
    return false;
  }
}

function removeGeneratedRuntime(binDir, sandboxHome) {
  let changed = false;
  for (const file of ['ffmpeg', 'ffprobe']) {
    try {
      const target = path.join(binDir, file);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        changed = true;
      }
    } catch {
      // 清理失败不阻断启动；下次仍会尝试。
    }
  }
  try {
    const target = path.join(sandboxHome, 'toolchain', 'ffmpeg');
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      changed = true;
    }
  } catch {
    // 同上。
  }
  return changed;
}

function wrapperScript(binDir, nativeLibs, tool) {
  return [
    '#!/system/bin/sh',
    `# DSHM ${tool} wrapper：使用随包工具链，不依赖用户 Brew 路径。`,
    `BIN=${JSON.stringify(binDir)}`,
    `LIBS=${JSON.stringify(nativeLibs)}`,
    `P="$BIN/../toolchain/ffmpeg"`,
    'if [ ! -x "$P/bin/ffmpeg" ]; then',
    '  echo "ffmpeg：随包工具链尚未就位" >&2',
    '  exit 127',
    'fi',
    'export LD_LIBRARY_PATH="$P/lib:$LIBS:/system/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
    `exec "$P/bin/${tool}" "$@"`,
  ].join('\n') + '\n';
}

/**
 * @returns {{ready:boolean,warning:string,ffmpeg:string,ffprobe:string,changed:boolean,cleaned?:boolean}}
 */
function ensureBundledFfmpeg(options = {}) {
  const resRoot = String(options.resRoot || '').trim();
  const sandboxHome = String(options.sandboxHome || '').trim();
  const binDir = String(options.binDir || '').trim();
  const nativeLibs = String(options.nativeLibs || '').trim();
  const deviceForm = String(options.deviceForm || '').trim();
  const log = typeof options.log === 'function' ? options.log : () => {};
  const diag = typeof options.diag === 'function' ? options.diag : () => {};
  const empty = { ready: false, warning: '', ffmpeg: '', ffprobe: '', changed: false };
  if (!['desktop', '2in1'].includes(deviceForm)) {
    const cleaned = binDir && sandboxHome ? removeGeneratedRuntime(binDir, sandboxHome) : false;
    if (cleaned) {
      diag(`ffmpeg：设备形态 ${deviceForm || 'unknown'} 不支持，已清理历史落位`);
    }
    return Object.assign(empty, {
      warning: `设备形态 ${deviceForm || 'unknown'} 不加载第三方 ffmpeg ELF`,
      cleaned,
    });
  }
  if (!resRoot || !sandboxHome || !binDir) {
    return Object.assign(empty, { warning: 'resRoot / sandboxHome / binDir 缺失' });
  }

  const source = path.join(resRoot, SOURCE_REL);
  const destRoot = path.join(sandboxHome, 'toolchain', 'ffmpeg');
  const sourceMarker = path.join(source, MARKER);
  if (!fs.existsSync(path.join(source, 'bin', 'ffmpeg')) || !fs.existsSync(sourceMarker)) {
    return Object.assign(empty, { warning: `缺少随包 ffmpeg：${source}` });
  }

  let changed = false;
  let updateWarning = '';
  if (!equalMarker(sourceMarker, path.join(destRoot, MARKER))) {
    /*
     * 【为什么不再"先删旧目录、再 rename 新目录"】那种写法在 rename 失败时旧版本已经
     * 被删掉 —— 用户既没有新版本、也没有旧版本，与文件头"失败保留旧版本"相反。
     * 现在让旧版本先改名让位（改名不删数据）：
     *   stage（新副本） → backup（旧目录改名） → rename(stage → destRoot) → 删 backup。
     * 任何一步失败都把 backup 改名回 destRoot；旧运行时保持可用。
     *
     * `options.fs` 是测试注入口（tools/check-ffmpeg-provision.mjs 用它模拟 rename 失败），
     * 生产调用不传，默认就是 node:fs。
     */
    const io = options.fs || fs;
    const stage = `${destRoot}.tmp-${process.pid}-${Date.now()}`;
    const backup = `${destRoot}.old-${process.pid}-${Date.now()}`;
    try {
      if (io.existsSync(stage)) io.rmSync(stage, { recursive: true, force: true });
      io.cpSync(source, stage, { recursive: true });
      if (io.existsSync(destRoot)) {
        io.renameSync(destRoot, backup);
      }
      try {
        io.renameSync(stage, destRoot);
      } catch (renameError) {
        // 个别文件系统可能把 stage 落成半个 destRoot：先清掉再还原 backup。
        if (io.existsSync(destRoot)) {
          try { io.rmSync(destRoot, { recursive: true, force: true }); } catch { /* 继续还原 */ }
        }
        if (io.existsSync(backup)) {
          io.renameSync(backup, destRoot);
        }
        throw renameError;
      }
      if (io.existsSync(backup)) {
        try { io.rmSync(backup, { recursive: true, force: true }); } catch { /* 旧副本清理失败不影响新版本 */ }
      }
      changed = true;
    } catch (e) {
      /*
       * 失败时先尝试把旧版本放回原位；如果旧版本仍在（改名没发生或还原成功），
       * 继续往下写 wrapper 并如实返回 ready=true + 警告 —— 旧运行时还是可用的，
       * 不能因为"升级没成功"把人话说成"没有 ffmpeg"。
       */
      try { io.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
      if (!io.existsSync(destRoot) && io.existsSync(backup)) {
        try { io.renameSync(backup, destRoot); } catch { /* 下面按"旧版本是否完好"判 */ }
      }
      const oldIntact = io.existsSync(path.join(destRoot, 'bin', 'ffmpeg'))
        && io.existsSync(path.join(destRoot, MARKER));
      if (!oldIntact) {
        return Object.assign(empty, {
          warning: `复制失败：${e && e.code ? e.code : String(e && e.message ? e.message : e)}`,
        });
      }
      updateWarning = `更新失败，继续使用旧版本：${e && e.code ? e.code : String(e && e.message ? e.message : e)}`;
      diag(`ffmpeg：${updateWarning}`);
    }
  }

  try {
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const file = path.join(binDir, tool);
      if (writeIfChanged(file, wrapperScript(binDir, nativeLibs, tool))) changed = true;
    }
  } catch (e) {
    return Object.assign(empty, {
      warning: `wrapper 布置失败：${e && e.code ? e.code : String(e && e.message ? e.message : e)}`,
    });
  }

  const ffmpeg = path.join(binDir, 'ffmpeg');
  const ffprobe = path.join(binDir, 'ffprobe');
  if (changed) {
    diag(`ffmpeg：随包工具链已落位 ${destRoot}`);
  }
  log('养鱼媒体环境：ffmpeg / ffprobe 已就绪');
  return { ready: true, warning: updateWarning, ffmpeg, ffprobe, changed };
}

module.exports = {
  MARKER,
  SOURCE_REL,
  ensureBundledFfmpeg,
  removeGeneratedRuntime,
};
