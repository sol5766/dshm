// [DSHM] OpenHarmony 版 node-pty 兼容层。
//
// 背景：dsh 的插件通过 require("node-pty") 拿伪终端能力，而鸿蒙上没有 node-pty
// 的预编译 binding。DSHM 自己已经有一个等价的原生 addon `libpty_host.so`
// （entry/src/main/cpp/pty_terminal.cpp，posix_openpt + forkpty + socketpair），
// 终端侧边栏就是用它跑起来的。这里把它的同步 fd 接口包成 node-pty 的事件式 API：
//   spawn(file, args, options) -> IPty { pid, onData, onExit, write, resize, kill, ... }
//
// 已知差异（够 dsh 用，但不追求 node-pty 全量 API）：
//   - 不支持自定义 env / cwd（pty_host 的 start() 只接受 shell/args/cols/rows）
//   - 不实现 flow control（pause/resume 映射到 socket）
//   - exitCode 恒为 0；信号退出时通过 signal 字段体现
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Socket } = require("node:net");

let ptyHost = null;

/** 定位并加载 pty 原生 addon（优先 bundle 库目录，回退 vendor/*.node）。 */
function loadPtyHost() {
  if (ptyHost !== null) return ptyHost;
  const candidates = [];
  try {
    // libnode 自身位于 el1 bundle 库目录，用它推出同目录的 libpty_host.so；
    // el2 用户数据区的 .so dlopen 会被沙箱拒绝，故优先 bundle 目录。
    const maps = fs.readFileSync("/proc/self/maps", "utf8");
    const matched = maps.match(/[^\s]+\/libnode\.so[^\s]*/);
    if (matched !== null) {
      candidates.push(path.join(path.dirname(matched[0]), "libpty_host.so"));
    }
  } catch (error) {
    // /proc/self/maps 不可读时继续用 vendor 候选
  }
  candidates.push(path.join(__dirname, "..", "vendor", "pty_host.node"));
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      if (candidate.endsWith(".so")) {
        // require() 只认 .node 扩展名，.so 会被当源码解析 → 直接用 process.dlopen
        const mod = { exports: {} };
        process.dlopen(mod, candidate);
        ptyHost = mod.exports;
      } else {
        try {
          fs.chmodSync(candidate, 0o755);
        } catch (chmodError) {
          // 沙箱内解压出来的 .node 可能没有执行位；chmod 失败也继续尝试加载
        }
        ptyHost = require(candidate);
      }
      if (ptyHost !== null && ptyHost !== undefined) {
        return ptyHost;
      }
    } catch (error) {
      ptyHost = null;
    }
  }
  throw new Error("node-pty(DSHM): 找不到可用的 pty 原生模块（libpty_host.so / vendor/pty_host.node）");
}

/** node-pty 的 IPty 最小实现：socket 事件流 + 原生 resize/kill。 */
class OhosPty {
  constructor(rc, file, cols, rows) {
    this.pid = rc.pid;
    this._fd = rc.fd;
    this._cols = cols;
    this._rows = rows;
    this._closed = false;
    this._dataCbs = [];
    this._exitCbs = [];
    this._socket = new Socket({ fd: rc.fd });
    this._socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      for (const cb of this._dataCbs) {
        try {
          cb(text);
        } catch (error) {
          // 单个回调异常不影响其它订阅者
        }
      }
    });
    this._socket.on("error", () => {
      // 会话关闭由 kill/close 处理
    });
    this._socket.on("close", () => {
      this._emitExit(0, 0);
    });
    this._socket.resume();
  }

  _emitExit(exitCode, signal) {
    if (this._closed) return;
    this._closed = true;
    for (const cb of this._exitCbs) {
      try {
        cb({ exitCode, signal });
      } catch (error) {
        // 忽略退出回调异常
      }
    }
  }

  onData(callback) {
    this._dataCbs.push(callback);
    return { dispose: () => this._remove(this._dataCbs, callback) };
  }

  onExit(callback) {
    this._exitCbs.push(callback);
    return { dispose: () => this._remove(this._exitCbs, callback) };
  }

  _remove(list, callback) {
    const at = list.indexOf(callback);
    if (at >= 0) list.splice(at, 1);
  }

  write(data) {
    if (this._socket.destroyed) return;
    this._socket.write(Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"));
  }

  resize(cols, rows) {
    this._cols = cols || this._cols;
    this._rows = rows || this._rows;
    try {
      loadPtyHost().resize(this._fd, this._cols, this._rows);
    } catch (error) {
      // 会话可能已结束
    }
  }

  kill(signal) {
    try {
      loadPtyHost().kill(this._fd);
    } catch (error) {
      // 忽略重复 kill
    }
    try {
      this._socket.destroy();
    } catch (error) {
      // 忽略销毁异常
    }
    this._emitExit(0, typeof signal === "number" ? signal : 0);
  }

  pause() {
    this._socket.pause();
  }

  resume() {
    this._socket.resume();
  }

  clear() {
    // 无屏幕缓冲语义，占位以兼容 node-pty 调用方
  }

  destroy() {
    this.kill();
  }
}

/** 与 node-pty 同签名：spawn(file, args, options)。 */
function spawn(file, args, options) {
  const host = loadPtyHost();
  const opts = options || {};
  const cols = Number.isFinite(opts.cols) ? Number(opts.cols) : 80;
  const rows = Number.isFinite(opts.rows) ? Number(opts.rows) : 24;
  const rc = host.start({
    shell: typeof file === "string" && file.length > 0 ? file : "/system/bin/sh",
    args: Array.isArray(args) ? args : [],
    cols,
    rows
  });
  return new OhosPty(rc, file, cols, rows);
}

module.exports = {
  spawn,
  open: spawn,
  // node-pty 里少数调用方会检测平台
  platform: "ohos"
};
