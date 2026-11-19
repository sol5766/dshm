/*
 * QEMU Guest Agent (QGA) 客户端。
 *
 * 【为什么用 QGA 而不是别的通道】它是**唯一**已验证能在这个 guest 上执行命令的通道
 * （上一轮 PoC 实测：命令端到端 81~219 ms、RPC 16~52 ms），且它落在**文件系统的
 * unix socket** 上 —— 宿主 Node 用 `net.connect()` 直接连，不需要 FFI、不需要 TCP、
 * 不需要 guest 里再跑任何监听器。VM 由谁启动（Node/koffi 还是别的）与客户端无关，
 * 这条解耦是刻意的。
 *
 * 【上一轮踩过的三个坑，这里逐条落实】────────────────────────────────────
 *   ① `guest-sync-delimited` 的 `\xff` **只对它自己发**：别对 `guest-exec` 之类的
 *      普通命令也发 `\xff`（发了对方会把它当数据的一部分，回包错位）。
 *      回包方向同理：只有 sync 的应答带 `\xff` 前缀，所以要**剥掉**再解析。
 *   ② 退出码字段是 `exitcode`（**不是** `exit-code`）。proto 里 `guest-exec-status`
 *      返回的是 `exitcode`；按 `exit-code` 取值会永远读到 undefined，把"命令失败"
 *      静默读成"成功但无输出"。
 *   ③ `guest-exec` 必须带 `capture-output: true`，否则 `out-data` / `err-data` 根本
 *      不出现；两者都是 **base64**。
 *
 * 【2026-10-08 真机 P0：所谓"QGA 150 s 不就绪"，错的其实是**这一层**】────────
 * 现场：guest 早就起来了（串口 `Starting QEMU Guest Agent ... [ ok ]`、`hish:~#`），
 * QEMU 侧一切正常（`query-status=running`、QGA chardev 上确有 client、guest 内存里
 * 有应答），可插件整整 150 s 一次都没 sync 上，**日志里连一行 QGA 错误都没有**。
 * 用内嵌 Python 桥在**外面新连一条**连接，立刻拿到 guest 的应答 ⇒ 通道没问题，
 * 问题在本文件。事后定位到两条互相叠加的设计错误：
 *   ① **一次问答挂一次监听器**（原 `exchange()`），读完第一行就 `off("data")`。
 *      Node 的 `net.Socket` 一旦进过 flowing 模式，**摘掉最后一个 `data` 监听器不会
 *      自动 pause** ⇒ 两次问答之间到达的字节被**静默读掉并丢弃**。
 *   ② **只认第一行**。真机上 `\xff` 前缀会让 qemu-ga 先回一行
 *      `JSON parse error, stray "\uFFFD"`（sentinel 造成的杂音，实测**每一条带 \xff
 *      的请求都必然先带一行**），真正的 `\xff{"return": 424242}` 紧随其后。原实现
 *      把那行错误当最终答案直接 reject ⇒ 永远 sync 不成功；而 ① 的丢弃又让
 *      "下一次重试捡回那条真应答"彻底失效 ⇒ **两个错合起来是一个死循环**，
 *      再叠上调用点的 `catch {}` 静默，现场一行证据都不留（这才是最贵的部分）。
 * 现在这版：**一条连接上只挂一次监听器**（`LineStream`），行进了队列就不会丢；
 * `sync()` 在超时内**跳过杂音行直到看见自己的 `id`**（与 PoC 的判定逐条一致）；
 * **只有"一个字节都没收到"才丢弃连接重连**（真机实测：开机就连、一辈子不换的那条
 * 旧连接会永远收不到任何东西，而每一条**新**连接立刻就收到）；每次问答都留一行读数
 * （发出/收到/跳过/耗时），下一次真机排障不必再靠外部探针反推。
 *
 * 【串行化】一个连接上所有请求走同一条 promise 链：QGA 的应答不带宽窄标识，全靠
 * "一问一答"的顺序对齐，并发发两条就会错位。命令之间本来就是串行的（模型一次一条），
 * 代价可以忽略。
 */
import net from 'node:net';

/** sync 的魔数 id：任意非零值即可，选一个显眼的。 */
const SYNC_ID = 424242;

/** 单次读一行（`\n` 结尾）的超时上限。QGA 在本机实测 RPC 16~52 ms。 */
const LINE_TIMEOUT_MS = 20000;

/** 连接超时：VM 刚起来时 socket 文件可能已存在但还没 accept。 */
const CONNECT_TIMEOUT_MS = 5000;

/** 单行最大字节数：挡住"不换行的垃圾流"把内存吃光。 */
const MAX_LINE_BYTES = 1 << 20;

/** 队列上限：只可能发生在"没人取"的时候，超出的丢并计数（绝不静默）。 */
const MAX_QUEUED_LINES = 256;

/** 杂音行进日志的上限（每条连接只刷这么多，避免刷屏）。 */
const JUNK_LOG_LIMIT = 5;

/**
 * `guest-exec-status` 是**可安全重试**的只读查询：pid 在 guest 里不变，进程状态由
 * qemu-ga 保留。真机在 guest 忙时可能让单次查询 20 s 没有回包，但此时命令仍在跑；
 * 若把整次 bash 直接判死，就会出现“sleep 30 没跑却报 VM 错误，且一进程一 VM 无法重来”。
 * 传输层失联最多重连续查 3 次；`guest-exec` 本身绝不重试（否则可能重复执行命令）。
 */
const STATUS_TRANSPORT_RETRIES = 3;

/** 状态查询重试前的短退避，给 qemu-ga 恢复事件循环的窗口。 */
const STATUS_RETRY_BASE_MS = 180;

/**
 * 连上 QGA 的 unix socket。
 * @param path socket 路径
 * @param timeoutMs 连接超时（VM 刚起来时 socket 文件可能已经存在但还没 accept）
 */
export function connect(path, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('QGA 连接超时（' + path + '）'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      // 【不设 setNoDelay】AF_UNIX 上没有 Nagle，`setNoDelay` 在这里是多余的
      // 系统调用；端侧只在 TCP 上才需要它。
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * 一条连接上的「行队列 + 单个等待者」。
 *
 * 【监听器为什么一次都不摘】见文件头注 ①：`off("data")` 之后 socket 仍是 flowing，
 * 新到的字节会被流层当成"没人要"直接丢掉。所以这里从连上那一刻起只挂一次，之后所有
 * 问答都从队列里取 —— 队列空就等，绝不摘监听器。
 *
 * 【为什么只允许一个等待者】QGA 的应答不带宽窄标识，顺序就是语义（与 #serial 同一条
 * 道理）。并发等两行会让两个人抢同一行 ⇒ 这里直接断言，别让调用方误用。
 */
class LineStream {
  #onLine = null;

  constructor(socket, onLine = null) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.queued = [];
    this.waiter = null;
    this.failure = null;
    this.rx = 0;
    this.overflow = 0;
    this.lost = 0;
    this.#onLine = typeof onLine === 'function' ? onLine : null;
    socket.on('data', (chunk) => this.#feed(chunk));
    socket.on('error', (error) => this.#break(error));
    socket.on('close', () => this.#break(new Error('QGA 连接被关闭')));
  }

  /** 发一行（调用方自己拼好换行）。返回实际交给内核的字节数。 */
  write(buffer) {
    this.socket.write(buffer);
    return buffer.length;
  }

  /**
   * 取下一行。超时返回 `null`（**不是**异常：超时是"还没到"的正常状态，调用方要据此
   * 决定是继续等还是换连接）。连接已断则抛错 —— 那种情况重试也读不到东西。
   * @param timeoutMs 等待上限
   * @returns `{line, bytes}` 或 `null`
   */
  next(timeoutMs) {
    if (this.queued.length > 0) {
      const entry = this.queued.shift();
      return Promise.resolve(entry);
    }
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.waiter !== null) return Promise.reject(new Error('LineStream 不支持并发等待'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = {
        resolve: (entry) => {
          clearTimeout(timer);
          this.waiter = null;
          resolve(entry);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.waiter = null;
          reject(error);
        },
      };
    });
  }

  /** 把新到的字节切成行：完整性判断只用 `\n`，与 qemu-ga 的输出口径一致。 */
  #feed(chunk) {
    this.rx += chunk.length;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf(0x0a);
      if (end < 0) break;
      const raw = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      this.#push({ line: raw, bytes: raw.length + 1 });
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      // 没有换行的超长垃圾：留着只会吃内存，还会让后面所有行都错位 ⇒ 丢掉并计数。
      this.lost += this.buffer.length;
      this.buffer = Buffer.alloc(0);
    }
  }

  #push(entry) {
    if (this.waiter !== null) {
      this.waiter.resolve(entry);
      return;
    }
    if (this.queued.length >= MAX_QUEUED_LINES) {
      this.queued.shift();
      this.overflow += 1;
    }
    this.queued.push(entry);
    try {
      if (this.#onLine !== null) this.#onLine(entry);
    } catch {
      /* 观测钩子自身的失败不许影响协议 */
    }
  }

  #break(error) {
    if (this.failure === null) this.failure = error;
    if (this.waiter !== null) this.waiter.reject(error);
  }
}

/**
 * 解析一行：`{text, value}`。`value === null` = 不是 JSON（杂音）。
 * 【为什么剥 `\xff`/NUL】坑 ①：只有 sync 的应答带 `\xff`；NUL 是设备侧日志的
 * 老问题（`docs/106` §7.3），串口/内核早期输出带 NUL 是常态，一并剔掉。
 */
function parseLine(raw) {
  let line = raw;
  while (line.length > 0 && (line[0] === 0xff || line[0] === 0x00)) line = line.subarray(1);
  const text = line.toString('utf8').trim();
  if (text.length === 0) return { text: '', value: null };
  try {
    return { text, value: JSON.parse(text) };
  } catch {
    return { text, value: null };
  }
}

/**
 * 这一行是不是「`\xff` sentinel 造成的杂音」？
 * 真机实测：**每一条**带 `\xff` 前缀的请求，qemu-ga 都会先回一行
 * `{"error":{"class":"GenericError","desc":"JSON parse error, stray "\uFFFD""}}`，
 * 紧跟其后才是真正的应答。它不是命令的失败，而是流解析器的报怨 ⇒ 只有这一种
 * 形态（class=GenericError 且 desc 含 JSON parse error）按杂音跳过，其余 error 一律
 * 如实抛给调用方（命令真的失败时不能吞）。
 */
function isSentinelNoise(value) {
  if (value === null || typeof value !== 'object') return false;
  const error = value.error;
  if (error === null || typeof error !== 'object') return false;
  return error.class === 'GenericError' && /JSON parse error/i.test(String(error.desc || ''));
}

/**
 * 把 qemu-ga 的 `error` 对象变成 Error（保留 class 供调用方分档）。
 */
function qgaError(error) {
  const klass = (error && error.class) || 'GenericError';
  const desc = (error && error.desc) || '';
  const err = new Error('QGA ' + klass + ': ' + desc);
  err.qgaClass = klass;
  return err;
}

/** 任意错误 → 一行文本（日志用）。 */
function messageOf(error) {
  return String((error && error.message) || error);
}

/**
 * QGA 会话：一条连接 + 串行队列 + 三个语义化调用。
 *
 * 存活性判据用 `guest-sync-delimited`：它是**纯探针**（不改 guest 状态、不执行任何
 * 东西），因此"能不能 sync 通"就是"VM 是不是真的活了"。启动等待、健康检查、
 * 每次执行前的确认都复用这一个判据，避免出现"两套健康判定不一致"。
 */
export class QgaSession {
  #socket = null;

  #stream = null;

  #chain = Promise.resolve();

  #log = null;

  #connects = 0;

  #junkLogged = 0;

  #junkSkipped = 0;

  #synced = false;

  #requests = 0;

  #drops = 0;

  constructor(path, log = null) {
    this.path = path;
    this.#log = typeof log === 'function' ? log : null;
  }

  /** 接上（或换掉）日志通道：端侧写进 node-output.log，离线门禁可读回调。 */
  setLog(log) {
    this.#log = typeof log === 'function' ? log : null;
  }

  /** 机器可读读数（进宿主自检，回答"换过几次连接、跳过多少杂音"）。 */
  stats() {
    const stream = this.#stream;
    return {
      path: this.path,
      connects: this.#connects,
      connected: stream !== null && this.#socket !== null && this.#socket.destroyed === false,
      junkSkipped: this.#junkSkipped,
      rx: stream === null ? 0 : stream.rx,
      queued: stream === null ? 0 : stream.queued.length,
      overflow: stream === null ? 0 : stream.overflow,
      lost: stream === null ? 0 : stream.lost,
      synced: this.#synced,
      requests: this.#requests,
      drops: this.#drops,
    };
  }

  #say(message) {
    try {
      if (this.#log !== null) this.#log(message);
    } catch {
      /* 日志通道异常不许影响功能 */
    }
  }

  /** 串行执行一段对会话的操作。 */
  #serial(task) {
    const next = this.#chain.then(task, task);
    // 队列本身不能被拒绝：失败只回给调用方，链条继续。
    this.#chain = next.then(() => undefined, () => undefined);
    return next;
  }

  async #ensureStream() {
    if (this.#stream !== null && this.#socket !== null && this.#socket.destroyed === false) {
      return this.#stream;
    }
    const socket = await connect(this.path);
    this.#socket = socket;
    this.#connects += 1;
    this.#synced = false;
    // 【line 钩子】只做观测：进来的每一行都在这里过一眼（含后面才被取走的那些）。
    const stream = new LineStream(socket);
    this.#stream = stream;
    return stream;
  }

  /**
   * 丢掉当前连接（下一次问答会重新连）。**只在**"这条连接看着已经死了"时调：
   * 真机实测那种"开机就连、一辈子不换"的连接会永远收不到任何字节，换新的立刻就好。
   */
  #drop(reason) {
    const socket = this.#socket;
    this.#stream = null;
    this.#socket = null;
    this.#synced = false;
    this.#drops += 1;
    if (socket !== null) {
      try {
        socket.destroy();
      } catch {
        /* 关不掉也要让调用方拿到真相 */
      }
    }
    this.#say('丢弃 QGA 连接（' + reason + '）');
  }

  /** 关掉连接（幂等）。会话对象可继续用：下一次调用会重连。 */
  close() {
    const socket = this.#socket;
    this.#stream = null;
    this.#socket = null;
    if (socket !== null) {
      try {
        socket.destroy();
      } catch {
        /* 关连接失败不影响进程退出 */
      }
    }
  }

  /** 杂音行统一出口：计数 + 限量刷日志（既不吞、也不刷屏）。 */
  #noteJunk(text, why) {
    this.#junkSkipped += 1;
    if (this.#junkLogged < JUNK_LOG_LIMIT) {
      this.#junkLogged += 1;
      this.#say('跳过一行杂音（' + why + '）：' + text.slice(0, 120));
    }
  }

  /**
   * 在当前连接上发一次 `guest-sync-delimited` 并等到自己的魔数 id。
   *
   * 这是整条 QGA 通道的**边界标记**：每次重连后、以及任何一次超时/失步之后，
   * 下一次真正发命令前都必须先对齐到这里。它同时把上一条命令的迟到回包全部
   * 归入“sync 之前的杂音”，不会留给下一条 `guest-exec-status` 误认。
   */
  async #syncOnStream(stream, timeoutMs) {
    const body = Buffer.from(JSON.stringify({ execute: 'guest-sync-delimited', arguments: { id: SYNC_ID } }), 'utf8');
    const sent = stream.write(Buffer.concat([Buffer.from([0xff]), body, Buffer.from([0x0a])]));
    const started = Date.now();
    const rxAtSend = stream.rx;
    let skipped = 0;
    for (;;) {
      const left = timeoutMs - (Date.now() - started);
      if (left <= 0) {
        if (stream.rx === rxAtSend) {
          // 一个字节都没回来 ⇒ 这条连接不会再有用了（真机实测）。
          this.#drop('sync ' + timeoutMs + ' ms 内一个字节都没收到（发出 ' + sent + ' B）');
        } else {
          // 收到过字节但边界仍未出现：保留连接，下一次同步可以继续吃队列里的迟到行。
          this.#say('QGA sync 超时（已收 ' + (stream.rx - rxAtSend) + ' B、跳过 ' + skipped + ' 行；连接保留）');
        }
        this.#synced = false;
        return false;
      }
      let entry;
      try {
        entry = await stream.next(left);
      } catch (error) {
        this.#drop('读行失败：' + messageOf(error));
        throw error;
      }
      if (entry === null) continue;
      const parsed = parseLine(entry.line);
      if (parsed.value !== null && parsed.value.return === SYNC_ID) {
        this.#synced = true;
        this.#say('QGA sync 成功（' + (Date.now() - started) + ' ms，跳过 ' + skipped + ' 行杂音）');
        return true;
      }
      skipped += 1;
      this.#noteJunk(parsed.text, parsed.value === null ? '非 JSON' : '与本次 id 不符');
    }
  }

  /**
   * `guest-sync-delimited` 探针。带 `\xff`（坑 ①）。
   * 【为什么必须"跳着读到自己的 id"】见文件头注 ②：带 `\xff` 的请求前面必然跟一行
   * JSON parse error 杂音。只认第一行 ⇒ 永远 sync 不上（这正是真机 150 s 死循环的一半）。
   * @returns 是否同步成功（超时 = false；连接断了则抛错，交给上层决定要不要重连）
   */
  sync(timeoutMs = CONNECT_TIMEOUT_MS) {
    return this.#serial(async () => {
      const stream = await this.#ensureStream();
      return this.#syncOnStream(stream, timeoutMs);
    });
  }

  /**
   * 一条 QGA 命令（`guest-exec` / `guest-exec-status` / `guest-file-*` …）。
   * 【为什么也跳杂音】sync 之后流已对齐，但 `\xff` 杂音与"上一次留下的残行"仍可能
   * 出现在前面；跳掉它们不会误伤：真正的命令失败是 `error` 对象，那一定会抛出去。
   */
  call(execute, args = {}, timeoutMs = LINE_TIMEOUT_MS) {
    return this.#serial(async () => {
      const stream = await this.#ensureStream();
      /*
       * 新连接（或上一次超时后主动断开的连接）必须先同步到已知边界再发命令。
       * 这一步只在 `#synced=false` 时做，正常连续调用的热路径不额外增加 RTT。
       */
      if (!this.#synced) {
        const syncBudget = Math.max(500, Math.min(4000, timeoutMs));
        const synced = await this.#syncOnStream(stream, syncBudget);
        if (!synced) {
          this.#drop(execute + ' 前置 sync 失败（' + syncBudget + ' ms）');
          throw new Error('QGA 通道未对齐：' + execute + ' 在发送前 sync 失败');
        }
      }
      const requestId = ++this.#requests;
      const sent = stream.write(Buffer.from(JSON.stringify({ execute, arguments: args }) + '\n', 'utf8'));
      const started = Date.now();
      const rxAtSend = stream.rx;
      for (;;) {
        const left = timeoutMs - (Date.now() - started);
        if (left <= 0) {
          /*
           * 不能保留这条连接：迟到的应答没有请求 id，会被下一条命令当成自己的回包。
           * 无论这次是否收到过别的字节，超时都直接断链；下一次调用会重连并先 sync。
           */
          this.#drop(execute + ' #' + requestId + ' 在 ' + timeoutMs + ' ms 内没有完成');
          throw new Error('QGA 应答超时：' + execute + ' #' + requestId
            + '（' + timeoutMs + ' ms，发出 ' + sent + ' B，已收 ' + (stream.rx - rxAtSend) + ' B；连接已复位）');
        }
        let entry;
        try {
          entry = await stream.next(left);
        } catch (error) {
          this.#drop('读行失败：' + messageOf(error));
          throw error;
        }
        if (entry === null) continue;
        const parsed = parseLine(entry.line);
        if (parsed.value === null) {
          this.#noteJunk(parsed.text, '非 JSON');
          continue;
        }
        if (isSentinelNoise(parsed.value)) {
          this.#noteJunk(parsed.text, '\\xff sentinel 杂音');
          continue;
        }
        if (parsed.value.error) throw qgaError(parsed.value.error);
        if (!Object.prototype.hasOwnProperty.call(parsed.value, 'return')) {
          this.#drop(execute + ' #' + requestId + ' 返回既无 return 也无 error');
          throw new Error('QGA 协议异常：' + execute + ' #' + requestId + ' 响应缺少 return/error');
        }
        return parsed.value.return;
      }
    });
  }

  /**
   * 在 guest 里起一个命令并等它结束。
   *
   * 【argv 不经 shell】`guest-exec` 直接 execve(path, arg)，所以我们自己决定要不要
   * 经过 shell —— 这里不经过：调用方（handle.js）已经把要跑的东西整理成
   * `["-c", <脚本>]` 交给 bash。这样路径里有空格/引号也不会被二次解释。
   *
   * @param path guest 侧可执行文件绝对路径
   * @param arg argv（不含 argv[0]）
   * @param timeoutMs 总超时（含轮询）
   * @param pollMs 轮询间隔
   * @param hooks `{onPid(pid), aborted(), statusTimeoutMs}` —— 取消要能在**知道 pid 之后**
   *   打进去（pid 只有 `guest-exec` 返回时才有）；`statusTimeoutMs` 只供离线门禁缩短
   *   状态查询超时，生产调用不需要传。
   * @returns `{exitCode, signal, stdout, stderr, polls, pid, ms}`
   */
  async exec(path, arg, timeoutMs, pollMs = 100, hooks = {}) {
    const started = Date.now();
    // 坑 ③：capture-output 必须显式给，否则 out-data/err-data 不出现。
    let spawned;
    try {
      spawned = await this.call('guest-exec', { path, arg, 'capture-output': true });
    } catch (error) {
      this.#drop('guest-exec 失败：' + messageOf(error));
      throw error;
    }
    const pid = spawned && typeof spawned.pid === 'number' ? spawned.pid : undefined;
    if (pid === undefined) {
      this.#drop('guest-exec 响应没有 pid');
      throw new Error('QGA guest-exec 没有返回 pid');
    }
    if (typeof hooks.onPid === 'function') {
      try {
        hooks.onPid(pid);
      } catch {
        /* 取消钩子自身的失败不许影响命令本体 */
      }
    }
    let polls = 0;
    let statusRetries = 0;
    const statusTimeoutMs = Number.isFinite(hooks.statusTimeoutMs) && hooks.statusTimeoutMs > 0
      ? hooks.statusTimeoutMs : LINE_TIMEOUT_MS;
    for (;;) {
      let status;
      try {
        status = await this.call('guest-exec-status', { pid }, statusTimeoutMs);
      } catch (error) {
        if (isStatusTransportFailure(error) && statusRetries < STATUS_TRANSPORT_RETRIES
          && Date.now() - started < timeoutMs) {
          statusRetries += 1;
          this.#say('guest-exec-status 暂时失联 pid=' + pid + '，重连续查 '
            + statusRetries + '/' + STATUS_TRANSPORT_RETRIES + '：' + messageOf(error));
          await new Promise((resolve) => {
            setTimeout(resolve, STATUS_RETRY_BASE_MS * statusRetries);
          });
          continue;
        }
        this.#drop('guest-exec-status 失败 pid=' + pid + '：' + messageOf(error));
        throw error;
      }
      statusRetries = 0;
      polls += 1;
      if (status === null || typeof status !== 'object' || typeof status.exited !== 'boolean') {
        this.#drop('guest-exec-status 响应形状错误 pid=' + pid);
        throw new Error('QGA guest-exec-status 响应缺少 exited（pid=' + pid + '）');
      }
      if (status && status.exited === true) {
        const result = {
          pid,
          polls,
          ms: Date.now() - started,
          // 坑 ②：字段名是 exitcode。
          exitCode: typeof status.exitcode === 'number' ? status.exitcode : null,
          signal: typeof status.signal === 'number' ? status.signal : null,
          stdout: decode(status['out-data']),
          stderr: decode(status['err-data']),
        };
        // 每次命令一行读数：这是"模型看到的结果"与"guest 侧到底跑了什么"之间唯一的对应。
        this.#say('guest 命令结束：pid=' + pid + ' rc=' + result.exitCode + ' 轮询 ' + polls + ' 次、' + result.ms + ' ms');
        return result;
      }
      if (Date.now() - started > timeoutMs) {
        const error = new Error('guest 命令超时（' + timeoutMs + ' ms）');
        error.code = 'DSHM_VM_TIMEOUT';
        error.pid = pid;
        this.#say('guest 命令超时：pid=' + pid + '（' + timeoutMs + ' ms，已轮询 ' + polls + ' 次）');
        // 超时后先丢弃失步连接；kill 会在新连接上重新 sync 后再发。
        this.#drop('guest 命令超时 pid=' + pid);
        // 【超时不杀 = 让它在 guest 里空转】provision 的 `apk add` 曾在超时判死后继续
        // 写盘/烧 CPU（2026-10-13 早期真机：rootfs 从 48.6 MB 涨到 54.1 MB 才停）。
        // best-effort 杀一下；kill 自身失败不许盖掉这条超时报文。
        try {
          await this.kill(pid, 'TERM');
        } catch {
          /* 杀不动就照原样抛超时 */
        }
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(Math.max(pollMs, pollMs * 2 ** Math.min(4, Math.floor(polls / 5))), 1000));
      });
    }
  }

  /** 结束 guest 里的一个进程（best-effort：guest 侧 kill 也要经 guest 自己）。 */
  async kill(pid, signal = 'TERM') {
    await this.call('guest-exec', {
      path: '/bin/busybox',
      arg: ['kill', '-' + signal, String(pid)],
    }, 5000).catch(() => undefined);
  }
}

/** 只把“这一条连接暂时不可用”归为可重试；qemu-ga 的语义错误必须原样失败。 */
function isStatusTransportFailure(error) {
  if (error && typeof error.qgaClass === 'string') return false;
  const text = messageOf(error);
  return /QGA 应答超时|QGA 连接|QGA 通道未对齐|ECONNRESET|ECONNREFUSED|EPIPE|连接已复位/.test(text);
}

/** base64 → utf8 文本；缺字段当空串（`out-data` 只在有输出时出现）。 */
function decode(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return Buffer.from(value, 'base64').toString('utf8');
}
