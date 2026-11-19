/**
 * `python` 工具：Agent 侧稳定的进程内 Python 结构化入口。
 *
 * 【为什么需要（2026-10-16，r47 自检报告的缺口）】宿主侧内嵌 CPython 早已就绪
 * （`/dshm-python/status` → `ready:true / stdlib:true`，`print(6*7)` 实测回 `42`），
 * 但 `/dshm-python/*` 是 loopback 端点，而 `web_fetch` 按 SSRF 策略拒回环；
 * `run_code`（PTC）在上游 alpha.4 是停用状态。本插件把 `python` 工具直接接到
 * **主进程内**的桥（与随包 `python3` 垫片同一条通道、同一份鉴权），让模型不依赖
 * shell 也能稳定运行真实 Python；PC 原生 shell 仍是另一条独立可用路径。
 *
 * 【通道选型：为什么走 HTTP 环回，而不是 require 宿主模块】
 * 桥的实现住在宿主入口 `hostcore/app/*.js`（**不在核心树里**），而插件加载器只解析核心树
 * 内的包 ⇒ 插件够不到那些模块；桥本来就是 HTTP 端点（`python3` 垫片走同一条路），
 * 因此这里也走 `http://127.0.0.1:<port>/dshm-python/*`：
 *   · 端口 / token / baseUrl 取 `$DSHM_HOME/host-ready.json`（**当前进程**写出的权威值，
 *     与垫片"主通道"逐字同源；`env.DSHM_PYTHON_TOKEN` 只作垫片侧快路径，这里不依赖它）；
 *   · 鉴权用常数时间风格的 token 比对（宿主侧实现），插件只负责带上。
 *
 * 【契约（与宿主端点逐条对齐，见 hostcore/app/main.js 的「Python HTTP 桥端点」一节）】
 *   · `code` 模式：`GET /dshm-python/run-get?token&code&timeout` → `{ok, stdout, errStderr, rc}`
 *   · `file` 模式：`GET /dshm-python/exec?token&argv&timeout` → `argv` 以 \x1f 分隔，
 *     `sys.argv` 对齐真 python3（`['python3', <脚本路径>, ...args]`）；脚本路径必须落在
 *     应用沙箱 / `$DSHM_HOME` 树内（**宿主自己会校验**，插件不重复实现路径闸门）。
 *   · 超时 1..300 秒（默认 120）：宿主侧注入 SIGALRM，超时以 `rc="124"` 返回（不炸进程）。
 *
 * 【边界（如实写进工具描述，不承诺没有的东西）】
 *   · 工具本身不创建 shell 或子进程；需要 shell 时显式使用 PC 原生 `bash` 工具。
 *   · 内嵌解释器是**进程内**的：长任务会卡住宿主事件循环（桥用 SIGALRM 限时，默认 120 s）。
 *   · 标准库来自随包解包（`stdlib=true` 才放行）；未就绪 / 桥不可用时工具**如实报错**，
 *     绝不返回空输出冒充成功。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** 插件名（与 package.json / pack-core 的清单同值）。 */
const name = 'dshm-tool-python';

/**
 * Cordis 注入声明：`apply()` 里第一句就是 `ctx.tools.register(...)`，而 Cordis 的服务是
 * **按注入放行**的 —— 不声明就直接取会抛 `cannot get property "tools" without inject`
 * （2026-10-16 真机实测：`.53` 上 `include:tool-python` 就是 `enabled=True phase=failed`）。
 * 与 `dshm-tool-fs-remove`（`inject = ["tools", "fs", "systemPrompt"]`）同一口径。
 */
const inject = ['tools'];

/** 超时口径与宿主 `pyBridgeTimeoutSec()` 的 clamp 保持同值（1..300，默认 120）。 */
const DEFAULT_TIMEOUT_SEC = 120;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 300;

/**
 * 内联源码走 GET query ⇒ 受 HTTP 头体积限制（Node 默认约 16 KiB）。
 * 宿主端点自己允许 64 KiB，这里取 8 KiB 作**工具侧**上限，超了就让调用方改用 `file` 模式。
 */
const MAX_INLINE_CODE_CHARS = 8192;
const MAX_REQUEST_TARGET_BYTES = 8192;

/** argv 分隔符：与宿主 `exec` 端点约定一致（\x1f = unit separator）。 */
const ARGV_SEPARATOR = '\u001f';

/** 从 host-ready.json 取桥的 baseUrl 与 token；读不到就抛出可行动的错误。 */
async function bridgeEndpoint() {
  const home = String(process.env.DSHM_HOME ?? '').trim();
  if (home.length === 0) {
    throw new Error('python 桥不可用：DSHM_HOME 未设置（宿主未按预期拉起？）');
  }
  let info;
  try {
    info = JSON.parse(await readFile(join(home, 'host-ready.json'), 'utf8'));
  } catch (error) {
    throw new Error(`python 桥不可用：读不到 host-ready.json（${error instanceof Error ? error.message : String(error)}）`);
  }
  const baseUrl = typeof info.baseUrl === 'string' ? info.baseUrl : '';
  const token = typeof info.token === 'string' ? info.token : '';
  if (baseUrl.length === 0 || token.length === 0) {
    throw new Error('python 桥不可用：host-ready.json 里没有 baseUrl/token（宿主尚在启动？稍后重试）');
  }
  return { baseUrl, token };
}

/** 超时归一到 [1,300]；缺省 / 非法一律回默认值（与宿主 clamp 同口径，不抛错）。 */
function clampTimeoutSec(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_TIMEOUT_SEC;
  }
  const rounded = Math.round(seconds);
  if (rounded < MIN_TIMEOUT_SEC) {
    return MIN_TIMEOUT_SEC;
  }
  if (rounded > MAX_TIMEOUT_SEC) {
    return MAX_TIMEOUT_SEC;
  }
  return rounded;
}

/** GET 一个 JSON 端点；只在**传输层**失败 / 状态码非 2xx / 响应不是 JSON 时抛错。 */
function getJson(urlString, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let request = null;
    const done = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };
    /*
     * 【2026-11-10 总时限】`request.setTimeout` 只管 socket 空闲：对端回完 header 后
     * 一个字节一个字节地拖、或直接半截断链时，它不会触发，Promise 就永久 pending。
     * 这里再加一道**整次请求**的硬截止，到点先 settle 再销毁连接。
     */
    const deadline = setTimeout(() => {
      done(rejectPromise, new Error('请求总时限已到（宿主桥无响应）'));
      try {
        if (request !== null) {
          request.destroy();
        }
      } catch {
        // 已结束：忽略
      }
    }, timeoutMs);
    request = http.get(urlString, (response) => {
      if (settled) {
        response.resume();
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== undefined && (response.statusCode < 200 || response.statusCode > 299)) {
          done(rejectPromise, new Error(`${response.statusCode} ${text.slice(0, 300)}`));
          return;
        }
        try {
          done(resolvePromise, JSON.parse(text));
        } catch {
          done(rejectPromise, new Error(`桥返回的不是 JSON：${text.slice(0, 300)}`));
        }
      });
      response.on('error', (error) => done(rejectPromise, error));
      response.on('aborted', () => done(rejectPromise, new Error('桥连接被中断')));
      response.on('close', () => {
        if (response.complete !== true) {
          done(rejectPromise, new Error('桥连接提前关闭'));
        }
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('请求超时（宿主桥无响应）'));
    });
    request.on('error', (error) => done(rejectPromise, error));
  });
}

/** 把宿主 `{ok, stdout, errStderr, rc}` 归一成工具输出（rc "None" ⇒ 0）。 */
function normalizeRun(raw) {
  const stdout = typeof raw.stdout === 'string' ? raw.stdout : '';
  const stderr = typeof raw.errStderr === 'string' ? raw.errStderr : '';
  const rcRaw = raw.rc;
  const rcNumber = Number(rcRaw);
  /*
   * 【为什么 exitCode 必须是**整数**】输出 schema 交给 `dsh-tools` 编译时，字段必须声明
   * 明确类型（2026-10-16 真机 `.54` 的现场：`unsupported JSON schema:
   * schema.properties.exitCode.type must be …` ⇒ 整行 `phase=failed`）。
   * 桥那边 rc 只可能是 `"None"`（成功）或整数（含超时的 124），但为稳妥仍把
   * 非数字 rc 归成 1 并把原值写进 stderr —— 既不违反 schema，也不吞掉现场。
   */
  const numeric = rcRaw === undefined || rcRaw === null || rcRaw === 'None'
    ? 0
    : (Number.isFinite(rcNumber) ? Math.trunc(rcNumber) : 1);
  const note = rcRaw === undefined || rcRaw === null || rcRaw === 'None' || Number.isFinite(rcNumber)
    ? ''
    : `[dshm] 桥返回了非数字 rc：${String(rcRaw)}\n`;
  return { stdout, stderr: note + stderr, exitCode: numeric };
}

/** 工具执行主体：解析参数 → 打桥 → 归一结果。 */
async function runPython(args) {
  const code = typeof args.code === 'string' ? args.code : '';
  const file = typeof args.file === 'string' ? args.file
    : (typeof args.path === 'string' ? args.path : '');
  if (code.length > 0 && file.length > 0) {
    throw new Error('python：`code` 与 `file`/`path` 只能给一个（内联源码走 run-get，脚本文件走 exec）');
  }
  if (code.length === 0 && file.length === 0) {
    const got = Object.keys(args ?? {}).filter((key) => key !== 'timeoutSec' && key !== 'args');
    throw new Error('python：必须给 `code`（内联源码）或 `file`/`path`（.py 路径）之一'
      + `；收到的参数键=${got.length > 0 ? got.join(',') : '(空)'}`);
  }
  if (code.length > MAX_INLINE_CODE_CHARS) {
    throw new Error(`python：内联源码上限 ${MAX_INLINE_CODE_CHARS} 字符（HTTP 头体积）`
      + '；长脚本请先 write 成 .py 文件再用 `file` 模式执行');
  }
  const timeoutSec = clampTimeoutSec(args.timeoutSec);
  const { baseUrl, token } = await bridgeEndpoint();
  let path;
  let mode;
  if (code.length > 0) {
    mode = 'code';
    path = `/dshm-python/run-get?token=${encodeURIComponent(token)}`
      + `&timeout=${encodeURIComponent(String(timeoutSec))}`
      + `&code=${encodeURIComponent(code)}`;
  } else {
    mode = 'file';
    const extra = Array.isArray(args.args) ? args.args.filter((one) => typeof one === 'string') : [];
    const argv = [file, ...extra];
    path = `/dshm-python/exec?token=${encodeURIComponent(token)}`
      + `&timeout=${encodeURIComponent(String(timeoutSec))}`
      + `&argv=${encodeURIComponent(argv.join(ARGV_SEPARATOR))}`;
  }
  const url = new URL(`${baseUrl}${path}`);
  if (Buffer.byteLength(url.pathname + url.search, 'utf8') > MAX_REQUEST_TARGET_BYTES) {
    throw new Error(`python：编码后请求目标超过 ${MAX_REQUEST_TARGET_BYTES} 字节上限`
      + '；请先将脚本写成 .py 文件再用 `file` 模式执行；file/path 模式请缩短路径和参数，将大段参数写入文件读取');
  }
  /* 客户端超时必须**大于**桥侧的执行超时，否则会先把自己的连接掐掉、把结果丢掉。 */
  const raw = await getJson(url.href, (timeoutSec + 15) * 1000);
  if (raw.ok !== true) {
    const reason = typeof raw.error === 'string' ? raw.error : JSON.stringify(raw);
    throw new Error(`python 桥拒绝执行：${reason}`);
  }
  const normalized = normalizeRun(raw);
  return { mode, timeoutSec, ...normalized };
}

/** 渲染：与 bash 类工具同风格的结构化文本（stdout / stderr / exit code 分开）。 */
function renderRun(args, value) {
  const head = value.mode === 'file'
    ? `Ran ${args.file} with the embedded CPython (timeout ${value.timeoutSec}s, in-process)`
    : `Ran the snippet with the embedded CPython (timeout ${value.timeoutSec}s, in-process)`;
  return [{
    type: 'text',
    text: `${head}\n<exit-code>${String(value.exitCode)}</exit-code>\n`
      + `<stdout>\n${value.stdout}</stdout>\n<stderr>\n${value.stderr}</stderr>`,
  }];
}

/**
 * 注册 `python` 工具（作用域与 ctx 一致，与 `dshm-tool-fs-remove` 的 publish/remove 同法）。
 * @param ctx - the plugin context; registration is scoped to it.
 */
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'python',
    description: 'Run Python 3.12 in this app\'s embedded interpreter, inside the host process — '
      + 'without a shell or subprocess. Use it for parsing, calculation, and transforming files '
      + 'in the workspace when a shell is unavailable or too heavy. Give either `code` (a short inline '
      + `snippet, <= ${MAX_INLINE_CODE_CHARS} characters) or \`file\` (a .py path inside this app's sandbox / home tree) `
      + `plus optional \`args\`. The encoded GET request target (including token, path, timeout and code/argv) is limited to ${MAX_REQUEST_TARGET_BYTES} bytes. `
      + 'Write longer scripts to a .py file and use `file`; keep paths/args short and read bulk input from files. '
      + 'The interpreter starts already initialized; output (stdout/stderr) and the exit code are captured and returned. '
      + 'There is no subprocess inside Python (fork/exec is denied by '
      + 'the tool boundary), network access follows the device policy, and a long-running program blocks the '
      + 'host event loop until the timeout fires (default 120s, max 300s, rc 124 on timeout). '
      // 【2026-10-18 内测闪退】ctypes 手工调用 native 库（例如 libzstd 流式解压）一旦崩在 native 层，
      // 会把整个 Host 进程带走（Python 层来不及抛异常，日志也可能只剩心跳断档）。工具描述里必须
      // 把这条边界说清：能用内置工具读的东西不要用 ctypes 硬解。
      + 'IMPORTANT: this interpreter shares the host process — a crash inside a native library you load '
      + 'through `ctypes` kills the whole host (no Python traceback). Do NOT use `ctypes` to hand-decompress '
      + 'DSHM session files (`.jsonl.zstd`) or to load arbitrary `.so` libraries; use the built-in session '
      + 'tools (`session_search` / `session_event_read`) or a supported parser instead. If `ctypes` is '
      + 'unavoidable, always declare `argtypes`/`restype` for every function you call.',
    parameters: {
      code: {
        type: 'string',
        description: 'Inline Python source to run (mutually exclusive with `file`).',
      },
      file: {
        type: 'string',
        description: 'Path of a .py file to run, relative to the session cwd or absolute inside the sandbox/home tree '
          + '(mutually exclusive with `code`).',
      },
      path: {
        type: 'string',
        description: 'Alias of `file`; useful for callers that name the path parameter `path`.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command-line arguments for `file` mode (sys.argv[1:]); ignored with `code`.',
      },
      timeoutSec: {
        type: 'number',
        description: `Execution timeout in seconds (default ${DEFAULT_TIMEOUT_SEC}, clamped to ${MIN_TIMEOUT_SEC}..${MAX_TIMEOUT_SEC}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true, enum: ['code', 'file'] },
          timeoutSec: { type: 'integer', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
        },
      },
      render: renderRun,
    },
    async execute(args) {
      return runPython(args);
    },
  }));
}

export { apply, inject, name };
