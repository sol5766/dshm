// dshm-boot-rescue — host side.
//
// DSHM（鸿蒙端 DeepSeek Harness）的 Web UI 启动门要求「profile 里所有 loader 条目
// 都激活」。只要有一个 client 条目 pending（常见于某插件在等一个不存在的服务），
// 整个页面就只剩 “Failed to load plugins”，而插件管理页本身也在这张页面里 ——
// 用户没有任何恢复入口。
//
// 本插件不依赖正常的客户端插件加载链：宿主把一段很小的救援脚本通过
// webServer.tapIndex 注入 index.html，脚本在失败页上挂出「启动恢复中心」，
// 把肇事插件的行 id 写入 DSHM 的持久启停文件 `.dshm-plugin-rows.yml`
// （profile 每次启动按「种子 + 用户行」重拼 cordis.patch.yml，所以只有这个文件
// 能跨重启生效），用户划掉后台重开应用即可恢复。
//
// 平台约束（DSHM 真机，务必保持）：
//   · 纯宿主插件、零依赖、只用 Node 内置模块；
//   · 禁止子进程模块、WASM、后台线程（端侧 --jitless，且平台不允许创建进程）；
//   · 禁止静态 inject 声明（会因缺服务进入 pending）：webServer/loader 一律
//     ctx.get 并判空，
//     拿不到只写日志降级，绝不进入 pending（那正是本插件要救的故障模式）；
//   · 所有文件读写只能在 $DSH_HOME / $DSHM_HOME 内。

import { readFile, writeFile, rename, unlink, copyFile, stat } from "node:fs/promises";
import { readFileSync, existsSync, statSync, readdirSync, appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ── 常量 ────────────────────────────────────────────────────────────────
const PACKAGE_NAME = "dshm-boot-rescue";
/*
 * 【2026-11-12，docs/410】entry id 与包名解耦：内置行改用 `dshm-boot-rescue-builtin`，
 * 免得与外部同名插件（行 id = 包名 `dshm-boot-rescue`）在 loader 里撞成同一个实体
 * —— 那样后写的内置会把外部新版顶掉（安全中心消失、启停切不动版本）。
 * `PACKAGE_NAME` 仍是包名（node_modules 路径、日志前缀、显示名用它）；
 * 两者都在 forbidden 名单里，救援中心永远不能停用任何一个救援实现。
 */
const SELF_ENTRY_ID = "dshm-boot-rescue-builtin";
const ROUTE_PATH = "/dshm-boot-rescue";
const ROWS_FILENAME = ".dshm-plugin-rows.yml";
const ROW_MARKER_PREFIX = "# [dshm-boot-rescue] disabled ";
const PATCH_MARKER_PREFIX = "# [dshm-boot-rescue] fallback-disabled ";
const FALLBACK_WARNING = "本次停用重启应用后失效，请进入系统后立即卸载肇事插件";
const RESCUE_MARKER = "dshm-boot-rescue-client";
const LOG_FILENAME = "dshm-boot-rescue.log";
const BACKUP_SUFFIX = ".dshm-boot-rescue.bak";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_IDS = 32;
const MAX_ID_LENGTH = 200;
const MAX_ENTRIES = 400;
const MAX_ALIASES = 12;
const MAX_MUTATION_ATTEMPTS = 4;
const SERVICE_WAIT_MS = 1000;
const SERVICE_WAIT_TRIES = 30;

export const name = "dshm-boot-rescue";
export const version = readVersion();
export const ROUTE = ROUTE_PATH;
export const ROWS_FILE_NAME = ROWS_FILENAME;
export const DISABLE_MARKER = ROW_MARKER_PREFIX;
export const FALLBACK_MARKER = PATCH_MARKER_PREFIX;
export const FALLBACK_MESSAGE = FALLBACK_WARNING;

const fileMutationQueues = new Map();
const installedScanCache = new Map();

function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : "0.0.0";
  } catch (_) {
    return "0.0.0";
  }
}

// ── 通用小工具 ──────────────────────────────────────────────────────────
function errText(error) {
  if (error === null || error === undefined) {
    return "unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  try {
    return String(error);
  } catch (_) {
    return "unknown error";
  }
}

function errorWithStatus(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) {
    error.code = code;
  }
  return error;
}

function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function json(res, statusCode, value) {
  if (!res || res.writableEnded) {
    return;
  }
  if (typeof res.writeHead === "function") {
    res.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
  }
  if (typeof res.end === "function") {
    res.end(JSON.stringify(value));
  }
}

function methodAllowed(req, res, expected) {
  if (req && req.method === expected) {
    return true;
  }
  if (res && typeof res.writeHead === "function") {
    res.writeHead(405, { allow: expected, "cache-control": "no-store" });
  }
  if (res && typeof res.end === "function") {
    res.end();
  }
  return false;
}

function isInside(parent, child) {
  try {
    const parentPath = resolve(String(parent || ""));
    const childPath = resolve(String(child || ""));
    const rel = relative(parentPath, childPath);
    if (rel === "") {
      return true;
    }
    return !rel.startsWith("..") && !isAbsolute(rel);
  } catch (_) {
    return false;
  }
}

function isProfileDirectory(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return !!(manifest && typeof manifest === "object" && manifest.dsh
      && typeof manifest.dsh === "object" && manifest.dsh.profile
      && typeof manifest.dsh.profile === "object");
  } catch (_) {
    return false;
  }
}

function readJsonSync(filename) {
  try {
    return JSON.parse(readFileSync(filename, "utf8"));
  } catch (_) {
    return null;
  }
}

// ── YAML 文本 / 标量 ────────────────────────────────────────────────────
function parseYamlScalar(source) {
  const raw = String(source === null || source === undefined ? "" : source).trim();
  if (!raw) {
    return null;
  }
  const commentOffset = raw.search(/\s+#/);
  const value = (commentOffset === -1 ? raw : raw.slice(0, commentOffset)).trim();
  if (!value) {
    return null;
  }
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function yamlQuoteId(value) {
  const id = String(value === null || value === undefined ? "" : value);
  if (!id) {
    return id;
  }
  const needs = /^[@`*&!%#~|]/.test(id)
    || /[#]:\s/.test(id)
    || id !== id.trim()
    || /[@#]/.test(id);
  if (needs) {
    return "'" + id.replace(/'/g, "''") + "'";
  }
  return id;
}

function textFormat(text) {
  const source = String(text === null || text === undefined ? "" : text);
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? source.slice(1) : source;
  const newline = body.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
  return {
    bom,
    newline,
    body: body.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
  };
}

function encodeText(body, format) {
  return format.bom + String(body).replace(/\n/g, format.newline);
}

function isValidRowId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/\s/.test(value);
}

// ── 用户行文件（.dshm-plugin-rows.yml）解析 ─────────────────────────────
// 格式只有两种行：`- id: <行id>` 与缩进的 `disabled: true|false`；
// 注释/空行允许。任何其它内容都视为「结构无法安全解析」→ 降级模式。
export function parseUserRows(text) {
  const format = textFormat(text);
  const lines = format.body.split("\n");
  const rows = [];
  let current = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idMatch = /^-\s+id:\s*(.*)$/.exec(line);
    if (idMatch) {
      const id = parseYamlScalar(idMatch[1]);
      if (!isValidRowId(id)) {
        return { ok: false, rows: [], format, issue: "line " + String(index + 1) + ": invalid row id" };
      }
      current = { id, disabled: false, line: index, disabledLine: -1 };
      rows.push(current);
      continue;
    }
    const disabledMatch = /^\s+disabled:\s*(.*?)\s*$/.exec(line);
    if (disabledMatch && current) {
      const raw = parseYamlScalar(disabledMatch[1]);
      current.disabled = !(raw !== null && String(raw).toLowerCase() === "false");
      current.disabledLine = index;
      continue;
    }
    return { ok: false, rows: [], format, issue: "line " + String(index + 1) + ": unsupported content" };
  }
  return { ok: true, rows, format, issue: "" };
}

function collectMarkers(body, markerPrefix) {
  const found = [];
  const lines = String(body || "").split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].indexOf(markerPrefix) === 0) {
      const id = lines[index].slice(markerPrefix.length).trim();
      if (id && found.indexOf(id) === -1) {
        found.push(id);
      }
    }
  }
  return found;
}

function buildDisableBlock(markerPrefix, id) {
  return markerPrefix + id + "\n- id: " + yamlQuoteId(id) + "\n  disabled: true";
}

// 把 ids 追加成带标记的禁用行；已由用户禁用或已有本插件标记的 id 不重复写。
export function renderDisableRows(text, ids) {
  const source = String(text === null || text === undefined ? "" : text);
  const parsed = parseUserRows(source);
  if (!parsed.ok) {
    throw errorWithStatus(422, "用户行文件结构无法安全解析：" + parsed.issue, "rows-invalid");
  }
  const format = parsed.format;
  const already = [];
  const added = [];
  const blocks = [];
  const markers = collectMarkers(format.body, ROW_MARKER_PREFIX);
  for (const rawId of ids || []) {
    const id = String(rawId);
    const existing = parsed.rows.filter(function (row) { return row.id === id; })[0];
    if (markers.indexOf(id) !== -1 || (existing && existing.disabled)) {
      if (already.indexOf(id) === -1) {
        already.push(id);
      }
      continue;
    }
    blocks.push(buildDisableBlock(ROW_MARKER_PREFIX, id));
    added.push(id);
  }
  if (!blocks.length) {
    return { text: source, result: { added, already } };
  }
  let body = format.body;
  if (body.length > 0 && !body.endsWith("\n")) {
    body += "\n";
  }
  body += blocks.join("\n") + "\n";
  return { text: encodeText(body, format), result: { added, already } };
}

// 只删除「本插件标记 + 精确 3 行块」；用户改过的块、其它行一律原样保留。
export function removeRescueRows(text, ids, options) {
  const source = String(text === null || text === undefined ? "" : text);
  const opts = options && typeof options === "object" ? options : {};
  const markerPrefix = typeof opts.markerPrefix === "string" && opts.markerPrefix.length > 0
    ? opts.markerPrefix
    : ROW_MARKER_PREFIX;
  const wanted = Object.prototype.toString.call(ids) === "[object Set]"
    ? new Set(Array.from(ids).map(String))
    : (Array.isArray(ids) && ids.length > 0
      ? new Set(ids.map(String))
      : (typeof ids === "string" && ids.length > 0 ? new Set([ids]) : null));
  const format = textFormat(source);
  const lines = format.body.split("\n");
  const output = [];
  const restored = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indexOf(markerPrefix) === 0) {
      const id = line.slice(markerPrefix.length).trim();
      const selected = wanted === null || wanted.has(id);
      const idLine = lines[index + 1] !== undefined ? lines[index + 1] : "";
      const disabledLine = lines[index + 2] !== undefined ? lines[index + 2] : "";
      const nextLine = lines[index + 3] !== undefined ? lines[index + 3] : "";
      const idMatch = /^-\s+id:\s*(.*?)\s*$/.exec(idLine);
      const parsedId = idMatch ? parseYamlScalar(idMatch[1]) : null;
      // 即使有人手工伪造了本插件标记，也绝不删除 @deepseek-ai 内置行或插件自身。
      const forbidden = id.indexOf("@deepseek-ai/") === 0 || id === SELF_ENTRY_ID || id === PACKAGE_NAME;
      const exact = selected
        && !forbidden
        && id.length > 0
        && parsedId === id
        && /^\s{2}disabled:\s*true\s*$/.test(disabledLine)
        && !/^\s+\S/.test(nextLine);
      if (exact) {
        restored.push(id);
        index += 3;
        continue;
      }
    }
    output.push(line);
    index += 1;
  }
  if (!restored.length) {
    return { text: source, result: { restored } };
  }
  return { text: encodeText(output.join("\n"), format), result: { restored } };
}

// ── cordis.patch.yml 解析（降级模式 + name→row id 映射） ────────────────
// 解析 `- id: X` 行及其块内（缩进 +2）的 name / disabled。
export function parsePatchRows(text) {
  const format = textFormat(text);
  const lines = format.body.split("\n");
  const rows = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = /^(\s*)-\s+id:\s*(.*?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const indent = match[1].length;
    const id = parseYamlScalar(match[2]);
    if (!isValidRowId(id)) {
      continue;
    }
    const row = { id, name: "", disabled: false, insert: isInsertRow(lines, index, indent), indent, line: index };
    for (let next = index + 1; next < lines.length; next++) {
      const candidate = lines[next];
      if (!candidate.trim() || candidate.trim().startsWith("#")) {
        continue;
      }
      const indentMatch = /^(\s*)/.exec(candidate);
      const candidateIndent = indentMatch ? indentMatch[1].length : 0;
      if (candidateIndent <= indent) {
        break;
      }
      if (candidateIndent === indent + 2) {
        const nameMatch = /^\s+name:\s*(.*?)\s*$/.exec(candidate);
        if (nameMatch && !row.name) {
          row.name = parseYamlScalar(nameMatch[1]) || "";
        }
        if (/^\s+disabled:\s*true\b/.test(candidate)) {
          row.disabled = true;
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

// 判断一条 `- id:` 行是否位于某个 `- insert:` 块内（新的 loader 条目），
// 而不是对已有条目的 patch 覆盖行。Bundle patch 里只有 insert 行才是可停用的真实新行。
function isInsertRow(lines, rowIndex, indent) {
  for (let index = rowIndex - 1; index >= 0; index--) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const indentMatch = /^(\s*)/.exec(line);
    const lineIndent = indentMatch ? indentMatch[1].length : 0;
    if (lineIndent >= indent) {
      continue;
    }
    return /^-\s+insert:\s*$/.test(line) || /^\s+insert:\s*$/.test(line);
  }
  return false;
}

function significantPatchLines(body) {
  return String(body || "").split("\n").filter(function (line) {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#") && trimmed !== "---";
  });
}

// 降级写 cordis.patch.yml 前确认它是可追加的顶层 YAML 数组。
export function checkPatchAppendable(text) {
  const format = textFormat(text);
  const significant = significantPatchLines(format.body);
  if (!significant.length) {
    return { ok: true, reason: "" };
  }
  if (/^\[\]\s*(?:#.*)?$/.test(significant[0]) && significant.length === 1) {
    return { ok: true, reason: "" };
  }
  if (!/^-($|\s)/.test(significant[0])) {
    return { ok: false, reason: "cordis.patch.yml 不是顶层 YAML 数组" };
  }
  for (const line of significant) {
    if (!/^\s/.test(line) && !/^-($|\s)/.test(line)) {
      return { ok: false, reason: "cordis.patch.yml 含不支持的顶层内容" };
    }
  }
  return { ok: true, reason: "" };
}

function normalizePatchBody(body) {
  const lines = String(body || "").split("\n");
  const significant = significantPatchLines(body);
  if (significant.length === 1 && /^\[\]\s*(?:#.*)?$/.test(significant[0])) {
    for (let index = 0; index < lines.length; index++) {
      if (/^\s*\[\]\s*(?:#.*)?$/.test(lines[index])) {
        lines.splice(index, 1);
        break;
      }
    }
  }
  return lines.join("\n").replace(/[ \t\n]+$/g, "");
}

// 降级模式：把 ids 追加成带标记的禁用行。只用于用户行文件无法解析时。
export function renderPatchDisableRows(text, ids) {
  const source = String(text === null || text === undefined ? "" : text);
  const format = textFormat(source);
  const appendable = checkPatchAppendable(source);
  if (!appendable.ok) {
    throw errorWithStatus(422, appendable.reason, "patch-invalid");
  }
  const parsedRows = parsePatchRows(source);
  const disabledIds = parsedRows.filter(function (row) { return row.disabled; }).map(function (row) { return row.id; });
  const markers = collectMarkers(format.body, PATCH_MARKER_PREFIX);
  const added = [];
  const already = [];
  const blocks = [];
  for (const rawId of ids || []) {
    const id = String(rawId);
    if (markers.indexOf(id) !== -1 || disabledIds.indexOf(id) !== -1) {
      if (already.indexOf(id) === -1) {
        already.push(id);
      }
      continue;
    }
    blocks.push(buildDisableBlock(PATCH_MARKER_PREFIX, id));
    added.push(id);
  }
  if (!blocks.length) {
    return { text: source, result: { added, already } };
  }
  let body = normalizePatchBody(format.body);
  if (body.length > 0) {
    body += "\n";
  }
  body += blocks.join("\n") + "\n";
  return { text: encodeText(body, format), result: { added, already } };
}

// ── 原子文件修改（备份 + tmp + rename + 快照校验 + 串行队列） ───────────
function statSignature(value) {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}

async function captureSnapshot(filename) {
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt++) {
    let before = null;
    try {
      before = await stat(filename, { bigint: true });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { exists: false, text: "", signature: "missing", hash: "" };
      }
      throw error;
    }
    const text = await readFile(filename, "utf8");
    let after = null;
    try {
      after = await stat(filename, { bigint: true });
    } catch (_) {
      continue;
    }
    const signature = statSignature(after);
    if (statSignature(before) === signature) {
      return { exists: true, text, signature, hash: sha256(text) };
    }
  }
  throw errorWithStatus(409, "文件在读取过程中被修改，请重试", "file-busy");
}

async function mutateTextFileUnlocked(filename, render) {
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt++) {
    const snapshot = await captureSnapshot(filename);
    const rendered = render(snapshot.text);
    if (rendered.text === snapshot.text) {
      return rendered.result;
    }
    const temporary = filename + ".dshm-boot-rescue-" + String(process.pid) + "-" + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, rendered.text, { encoding: "utf8", flag: "wx" });
      const current = await captureSnapshot(filename);
      if (current.exists !== snapshot.exists || current.signature !== snapshot.signature || current.hash !== snapshot.hash) {
        try {
          await unlink(temporary);
        } catch (_) {
          // ignore
        }
        continue;
      }
      if (snapshot.exists) {
        try {
          await copyFile(filename, filename + BACKUP_SUFFIX);
        } catch (error) {
          try {
            await unlink(temporary);
          } catch (_) {
            // ignore
          }
          throw errorWithStatus(500, "写前备份失败，已拒绝写入：" + errText(error), "backup-failed");
        }
      }
      await rename(temporary, filename);
      return rendered.result;
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (_) {
        // ignore
      }
      throw error;
    }
  }
  throw errorWithStatus(409, "文件持续变化，未写入任何修改", "file-busy");
}

export function mutateTextFile(filename, render) {
  const previous = fileMutationQueues.get(filename) || Promise.resolve();
  const run = previous.then(
    function () { return mutateTextFileUnlocked(filename, render); },
    function () { return mutateTextFileUnlocked(filename, render); }
  );
  const tail = run.then(function () {}, function () {});
  fileMutationQueues.set(filename, tail);
  tail.then(function () {
    if (fileMutationQueues.get(filename) === tail) {
      fileMutationQueues.delete(filename);
    }
  });
  return run;
}

// ── 数据目录 / profile 定位 ─────────────────────────────────────────────
export function resolveHomeDir(env) {
  const source = env && typeof env === "object" ? env : process.env;
  for (const key of ["DSH_HOME", "DSHM_HOME"]) {
    try {
      const raw = String(source[key] === undefined ? "" : source[key]).trim();
      if (!raw || !isAbsolute(raw)) {
        continue;
      }
      const dir = resolve(raw);
      if (statSync(dir).isDirectory()) {
        return { dir, source: key };
      }
    } catch (_) {
      // try next source
    }
  }
  return { dir: "", source: "" };
}

export function readHostReadyProfile(homeDir) {
  if (!homeDir) {
    return "";
  }
  const manifest = readJsonSync(join(homeDir, "host-ready.json"));
  if (manifest && typeof manifest.profile === "string" && manifest.profile.length > 0) {
    return manifest.profile;
  }
  return "";
}

export function findProfileDir(startDir, homeDir) {
  try {
    let current = resolve(String(startDir || ""));
    for (let depth = 0; depth < 12; depth++) {
      // 先判边界再读 package.json：任何读取都必须留在 DSH_HOME 内。
      if ((!homeDir || isInside(homeDir, current)) && isProfileDirectory(current)) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  } catch (_) {
    // ignore
  }
  return "";
}

function resolveProfileDir(homeDir, startDir) {
  // 1) 插件自身安装路径向上找（profile/node_modules/dshm-boot-rescue/lib → profile）
  const fromPlugin = findProfileDir(startDir, homeDir);
  if (fromPlugin) {
    return { dir: fromPlugin, source: "plugin-path" };
  }
  // 2) DSHM_PROFILE 环境变量
  const envProfile = String(process.env.DSHM_PROFILE === undefined ? "" : process.env.DSHM_PROFILE).trim();
  if (envProfile) {
    const candidate = join(homeDir, "profiles", envProfile);
    if (isInside(homeDir, candidate) && isProfileDirectory(candidate)) {
      return { dir: candidate, source: "DSHM_PROFILE" };
    }
  }
  // 3) host-ready.json（DSHM 入口脚本必写，含当前 profile 名）
  const readyProfile = readHostReadyProfile(homeDir);
  if (readyProfile) {
    const candidate = join(homeDir, "profiles", readyProfile);
    if (isInside(homeDir, candidate) && isProfileDirectory(candidate)) {
      return { dir: candidate, source: "host-ready" };
    }
  }
  // 4) 默认 profile 名
  const fallback = join(homeDir, "profiles", "ondevice");
  if (isInside(homeDir, fallback) && isProfileDirectory(fallback)) {
    return { dir: fallback, source: "default-ondevice" };
  }
  // 5) 扫描 profiles/*：只有一个时采用；多个时优先包含本插件的目录
  try {
    const profilesRoot = join(homeDir, "profiles");
    const dirents = readdirSync(profilesRoot, { withFileTypes: true });
    const found = [];
    for (const dirent of dirents) {
      if (!dirent || !dirent.isDirectory || !dirent.isDirectory()) {
        continue;
      }
      const candidate = join(profilesRoot, dirent.name);
      if (isInside(homeDir, candidate) && isProfileDirectory(candidate)) {
        found.push(candidate);
      }
    }
    if (found.length === 1) {
      return { dir: found[0], source: "profiles-scan" };
    }
    for (const candidate of found) {
      if (existsSync(join(candidate, "node_modules", PACKAGE_NAME, "package.json"))) {
        return { dir: candidate, source: "profiles-scan-plugin" };
      }
    }
  } catch (_) {
    // ignore
  }
  return { dir: "", source: "" };
}

function readRowsFile(filename) {
  return readFile(filename, "utf8").then(function (text) {
    const parsed = parseUserRows(text);
    return { state: "found", exists: true, text, parse: parsed };
  }, function (error) {
    if (error && error.code === "ENOENT") {
      return { state: "missing", exists: false, text: "", parse: { ok: true, rows: [] } };
    }
    return { state: "unreadable", exists: false, text: "", parse: { ok: false, rows: [] }, error: errText(error) };
  });
}

async function readPatchInfo(profileDir) {
  const patchPath = join(profileDir, "cordis.patch.yml");
  try {
    const text = await readFile(patchPath, "utf8");
    return { ok: true, text, rows: parsePatchRows(text) };
  } catch (error) {
    return { ok: false, text: "", rows: [], error: errText(error) };
  }
}

// ── 已安装插件（bundle patch 的 entry id ↔ name 映射） ──────────────────
function pushUnique(list, seen, item) {
  if (!item || typeof item.id !== "string" || !item.id || !isValidRowId(item.id)) {
    return;
  }
  const key = item.id + "\u0000" + String(item.packageName || "");
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  list.push(item);
}

async function readInstalledPluginEntries(profileDir) {
  const cached = installedScanCache.get(profileDir);
  if (cached && Date.now() - cached.at < 8000) {
    return cached.value;
  }
  const value = await scanInstalledPluginEntries(profileDir);
  installedScanCache.set(profileDir, { at: Date.now(), value });
  return value;
}

async function scanInstalledPluginEntries(profileDir) {
  const output = [];
  const seen = new Set();
  let profileManifest = null;
  try {
    profileManifest = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
  } catch (_) {
    profileManifest = null;
  }
  const dependencyNames = new Set(Object.keys((profileManifest && profileManifest.dependencies) || {}));
  const candidates = new Set();
  dependencyNames.forEach(function (item) { candidates.add(item); });
  try {
    const dirents = await readdirSync(join(profileDir, "node_modules"), { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent || !dirent.isDirectory || !dirent.isDirectory()) {
        continue;
      }
      if (dirent.name.startsWith(".")) {
        continue;
      }
      if (dirent.name.startsWith("@")) {
        try {
          const scoped = await readdirSync(join(profileDir, "node_modules", dirent.name), { withFileTypes: true });
          for (const child of scoped) {
            if (child && child.isDirectory && child.isDirectory()) {
              candidates.add(dirent.name + "/" + child.name);
            }
          }
        } catch (_) {
          // ignore
        }
        continue;
      }
      candidates.add(dirent.name);
    }
  } catch (_) {
    // node_modules 不存在：只用 package.json dependencies
  }
  let inspected = 0;
  for (const name of candidates) {
    if (inspected >= 160) {
      break;
    }
    inspected += 1;
    if (name === PACKAGE_NAME || name === SELF_ENTRY_ID) {
      continue;
    }
    // 包名来自 profile package.json / 目录扫描：拒绝任何可逃逸 node_modules 的写法，
    // 保证所有读取都留在 DSH_HOME 内（依赖名不允许 `..` / 绝对路径）。
    if (!name || isAbsolute(name) || name.indexOf("..") !== -1 || name.indexOf("\\") !== -1
      || /[\u0000-\u001f\u007f]/.test(name) || /\s/.test(name)) {
      continue;
    }
    const packageDir = join(profileDir, "node_modules", name);
    if (!isInside(join(profileDir, "node_modules"), packageDir)) {
      continue;
    }
    let packageManifest = null;
    try {
      packageManifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    } catch (_) {
      continue;
    }
    const packageName = typeof packageManifest.name === "string" && packageManifest.name
      ? packageManifest.name
      : name;
    if (packageName === PACKAGE_NAME || packageName === SELF_ENTRY_ID) {
      continue;
    }
    let dsh = null;
    if (packageManifest.dsh && typeof packageManifest.dsh === "object") {
      dsh = packageManifest.dsh;
    }
    const hasBundle = !!(dsh && (dsh.bundle !== undefined || dsh.bundles !== undefined));
    if (!hasBundle && !dependencyNames.has(name)) {
      continue;
    }
    let patchRelative = "cordis.patch.yml";
    if (dsh && dsh.bundle && typeof dsh.bundle === "object" && typeof dsh.bundle.patch === "string" && dsh.bundle.patch) {
      patchRelative = dsh.bundle.patch;
    }
    let patchPath = "";
    try {
      patchPath = resolve(packageDir, patchRelative);
    } catch (_) {
      patchPath = "";
    }
    let bundleRows = [];
    if (patchPath && isInside(packageDir, patchPath)) {
      try {
        const bundleText = await readFile(patchPath, "utf8");
        bundleRows = parsePatchRows(bundleText);
      } catch (_) {
        bundleRows = [];
      }
    }
    if (bundleRows.length > 0) {
      let insertedCount = 0;
      for (const row of bundleRows) {
        // 只认 bundle patch 顶层 `- insert:` 块里的行（标准缩进 2~4）；
        // 更深的 `- id:` 可能是 config 里的普通数组项，不能当插件行。
        if (!row.insert || row.indent > 4) {
          continue;
        }
        insertedCount += 1;
        pushUnique(output, seen, {
          id: row.id,
          name: row.name || packageName,
          packageName,
          disabled: !!row.disabled,
          source: "installed",
        });
      }
      if (insertedCount > 0) {
        continue;
      }
    }
    if (hasBundle) {
      pushUnique(output, seen, {
        id: packageName,
        name: packageName,
        packageName,
        disabled: false,
        source: "installed-fallback",
      });
    } else {
      pushUnique(output, seen, {
        id: packageName,
        name: packageName,
        packageName,
        disabled: false,
        source: "dependency",
      });
    }
  }
  return output;
}

// ── 宿主 loader（可选：只做映射补全与状态显示） ─────────────────────────
function readLoaderEntries(ctx) {
  try {
    const loader = ctx && typeof ctx.get === "function" ? ctx.get("loader") : undefined;
    if (!loader || typeof loader.entries !== "function") {
      return { ok: false, reason: "unavailable", entries: [] };
    }
    const output = [];
    for (const entry of loader.entries()) {
      const options = entry && entry.options ? entry.options : {};
      const id = options.id;
      if (typeof id !== "string" || !id) {
        continue;
      }
      output.push({
        id,
        name: typeof options.name === "string" ? options.name : "",
        disabled: !!entry.disabled,
      });
    }
    return { ok: true, reason: "ok", entries: output };
  } catch (error) {
    return { ok: false, reason: "error: " + errText(error), entries: [] };
  }
}

// ── catalog：候选行 + name→row id 映射（纯函数，便于测试） ──────────────
export function buildCatalog(input) {
  const opts = input && typeof input === "object" ? input : {};
  const selfId = typeof opts.selfId === "string" && opts.selfId ? opts.selfId : SELF_ENTRY_ID;
  const selfName = typeof opts.selfName === "string" && opts.selfName ? opts.selfName : PACKAGE_NAME;
  const writable = opts.writable !== false;
  const rescueRows = new Set((opts.rescueRows || []).map(String));
  const known = new Map();

  function ensure(id) {
    let item = known.get(id);
    if (!item) {
      item = {
        id,
        name: "",
        packageName: "",
        aliases: [],
        installed: false,
        hasUserRow: false,
        disabled: false,
        knownRow: false,
      };
      known.set(id, item);
    }
    return item;
  }

  function addAlias(item, value) {
    if (typeof value !== "string") {
      return;
    }
    const alias = value.trim();
    if (!alias || alias.length > MAX_ID_LENGTH) {
      return;
    }
    if (item.aliases.indexOf(alias) === -1 && item.aliases.length < MAX_ALIASES) {
      item.aliases.push(alias);
    }
  }

  function mergeRow(row, flags) {
    if (!row || typeof row.id !== "string" || !isValidRowId(row.id)) {
      return;
    }
    const item = ensure(row.id);
    const options = flags || {};
    item.knownRow = item.knownRow || options.known !== false;
    if (typeof row.name === "string" && row.name && !item.name) {
      item.name = row.name;
    }
    if (options.installed) {
      item.installed = true;
      if (typeof row.packageName === "string" && row.packageName && !item.packageName) {
        item.packageName = row.packageName;
      }
    }
    if (options.userRow) {
      item.hasUserRow = true;
    }
    if (row.disabled) {
      item.disabled = true;
    }
    addAlias(item, row.id);
    addAlias(item, row.name);
    addAlias(item, row.packageName);
  }

  const loaderById = new Map();
  (opts.loaderEntries || []).forEach(function (row) {
    if (row && typeof row.id === "string" && row.id) {
      loaderById.set(row.id, row);
    }
  });
  (opts.patchEntries || []).forEach(function (row) {
    // 核心 seed / 覆盖行只用于 name→row id 映射，不作为候选。
    // 没有 name 的行（如 `- id: web-runtime` / `- id: subprocess` 这类核心覆盖行）
    // 无法证明是用户插件，连 knownRow 都不给：宁可拒绝写入，也不能误停 webServer 行。
    const hasName = !!(row && typeof row.name === "string" && row.name.length > 0);
    mergeRow(row, { known: hasName });
  });
  (opts.installedEntries || []).forEach(function (row) {
    // 只有「bundle patch 里真实 insert 出来的行」才算已验证存在；
    // 单纯依赖兜底出来的包名只作为映射候选，是否真实存在由宿主 loader 佐证。
    const verified = !!row && row.source === "installed";
    mergeRow(row, { known: verified || (row && loaderById.has(row.id)), installed: true });
  });
  (opts.userRows || []).forEach(function (row) { mergeRow(row, { known: false, userRow: true }); });
  // loader 只做补全（name/disabled），绝不凭空新增候选行。
  loaderById.forEach(function (row, id) {
    if (!known.has(id)) {
      return;
    }
    mergeRow({ id, name: row.name, disabled: row.disabled }, { known: true });
  });

  const output = [];
  known.forEach(function (item) {
    const aliases = [];
    function addFinal(value) {
      if (typeof value === "string" && value && aliases.indexOf(value) === -1 && aliases.length < MAX_ALIASES) {
        aliases.push(value);
      }
    }
    addFinal(item.id);
    addFinal(item.name);
    addFinal(item.packageName);
    item.aliases.forEach(addFinal);

    let builtin = false;
    for (const alias of aliases) {
      if (alias.indexOf("@deepseek-ai/") === 0) {
        builtin = true;
        break;
      }
    }
    const self = item.id === selfId
      || item.name === selfName
      || item.packageName === selfName
      || aliases.indexOf(selfId) !== -1
      || aliases.indexOf(selfName) !== -1;
    if (builtin && !item.hasUserRow && !item.installed) {
      return;
    }
    // 候选只来自：用户行文件里真实存在的行，或已安装 bundle patch 里验证过的 insert 行。
    // 核心 seed / 覆盖行即使出现在 profile patch 里也不默认列出（只做映射）。
    if (!item.hasUserRow && !item.installed) {
      return;
    }
    const unmapped = !item.knownRow;
    let protectedReason = "";
    if (self) {
      protectedReason = "self";
    } else if (builtin) {
      protectedReason = "builtin";
    }
    let reason = "";
    if (protectedReason === "self") {
      reason = "救援插件自身，禁止停用";
    } else if (protectedReason === "builtin") {
      reason = "内置 @deepseek-ai 行受保护，救援插件不会修改";
    } else if (unmapped) {
      reason = "未映射到真实插件行，禁止直接写入";
    }
    const actionable = writable && !protectedReason && !unmapped && !item.disabled && !rescueRows.has(item.id);
    output.push({
      id: item.id,
      groupId: item.packageName || item.name || item.id,
      name: item.name || item.id,
      packageName: item.packageName || "",
      aliases,
      builtin,
      protected: !!protectedReason,
      protectedReason,
      installed: !!item.installed,
      hasUserRow: !!item.hasUserRow,
      disabled: !!item.disabled,
      disabledByRescue: rescueRows.has(item.id),
      actionable,
      reason,
    });
  });

  output.sort(function (left, right) {
    if (left.actionable !== right.actionable) {
      return left.actionable ? -1 : 1;
    }
    const leftName = String(left.name || left.id).toLowerCase();
    const rightName = String(right.name || right.id).toLowerCase();
    if (leftName < rightName) {
      return -1;
    }
    if (leftName > rightName) {
      return 1;
    }
    return 0;
  });
  return output.slice(0, MAX_ENTRIES);
}

// ── 请求校验 ────────────────────────────────────────────────────────────
export function isLoopbackAddress(address) {
  const value = String(address === null || address === undefined ? "" : address).toLowerCase().split("%")[0];
  if (!value) {
    return false;
  }
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (value.indexOf("127.") === 0) {
    return true;
  }
  if (value.indexOf("::ffff:127.") === 0) {
    return true;
  }
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(value)) {
    return true;
  }
  return false;
}

function hostHeaderIsLoopback(value) {
  const raw = String(value === null || value === undefined ? "" : value).trim().toLowerCase();
  if (!raw) {
    return false;
  }
  let host = raw;
  if (host.charAt(0) === "[") {
    const end = host.indexOf("]");
    if (end === -1) {
      return false;
    }
    host = host.slice(1, end);
  } else {
    const colons = host.split(":");
    if (colons.length === 2) {
      host = colons[0];
    }
  }
  if (host === "localhost") {
    return true;
  }
  return isLoopbackAddress(host);
}

export function assertMutationRequest(req) {
  const remoteAddress = req && req.socket ? req.socket.remoteAddress : "";
  if (!isLoopbackAddress(remoteAddress)) {
    throw errorWithStatus(403, "remote mutation is disabled; use the DSHM Web UI on this device", "remote-mutation-disabled");
  }
  const headers = (req && req.headers) || {};
  // 防 DNS rebinding：攻击页可以把 Origin/Host 都写成自己的域名并解析到 127.0.0.1，
  // 因此写操作还要求 Host 头本身是回环字面量（127.* / [::1] / localhost）。
  if (!hostHeaderIsLoopback(headers.host)) {
    throw errorWithStatus(403, "host must be a loopback address", "non-loopback-host");
  }
  const contentType = String(headers["content-type"] === undefined ? "" : headers["content-type"]).toLowerCase();
  if (contentType.indexOf("application/json") !== 0) {
    throw errorWithStatus(415, "content-type must be application/json", "content-type");
  }
  const fetchSite = String(headers["sec-fetch-site"] === undefined ? "" : headers["sec-fetch-site"]).toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw errorWithStatus(403, "cross-origin mutation denied", "cross-origin");
  }
  const origin = headers.origin;
  if (origin) {
    let parsed = null;
    try {
      parsed = new URL(origin);
    } catch (_) {
      throw errorWithStatus(403, "invalid origin", "invalid-origin");
    }
    if (!headers.host || parsed.host !== headers.host) {
      throw errorWithStatus(403, "origin does not match host", "origin-mismatch");
    }
  }
}

export function normalizeIds(body, options) {
  const opts = options && typeof options === "object" ? options : {};
  let values = [];
  if (body && Array.isArray(body.ids)) {
    values = body.ids;
  } else if (body && typeof body.ids === "string" && body.ids.length > 0) {
    // 兼容标量形式 `{"ids":"dsh-market"}`（SPEC 5.1 数组或单值）。
    values = [body.ids];
  } else if (body && body.id !== undefined && body.id !== null && body.id !== "") {
    values = [body.id];
  }
  if (values.length === 0) {
    if (opts.allowEmpty) {
      return [];
    }
    throw errorWithStatus(400, "missing ids", "empty-ids");
  }
  if (values.length > MAX_IDS) {
    throw errorWithStatus(400, "too many ids", "too-many-ids");
  }
  const ids = [];
  for (const value of values) {
    let id = "";
    try {
      id = String(value).trim();
    } catch (_) {
      id = "";
    }
    if (!id || id.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(id) || /\s/.test(id)) {
      throw errorWithStatus(400, "invalid id", "invalid-id");
    }
    if (ids.indexOf(id) === -1) {
      ids.push(id);
    }
  }
  return ids;
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw errorWithStatus(413, "request body too large", "body-too-large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw errorWithStatus(400, "invalid JSON body", "invalid-json");
  }
}

// ── 诊断日志 ────────────────────────────────────────────────────────────
function writeDiagnostic(runtime, message) {
  const line = "[" + new Date().toISOString() + "] [" + PACKAGE_NAME + "@" + version + "] " + message;
  try {
    console.log(line);
  } catch (_) {
    // console 不可用时忽略
  }
  try {
    const logger = runtime && runtime.ctx ? runtime.ctx.logger : undefined;
    if (logger && typeof logger.info === "function") {
      logger.info(line);
    }
  } catch (_) {
    // ignore
  }
  try {
    if (runtime && runtime.logFile) {
      appendFileSync(runtime.logFile, line + "\n", "utf8");
    }
  } catch (_) {
    // 日志文件写不进不能影响插件
  }
}

// ── 运行时 ──────────────────────────────────────────────────────────────
function createRuntime(ctx) {
  return {
    ctx,
    homeDir: "",
    homeSource: "",
    profileDir: "",
    profileSource: "",
    rowsPath: "",
    patchPath: "",
    logFile: "",
    readOnly: true,
    readOnlyReason: "",
    readOnlyReasonCode: "",
    injections: 0,
    diag: {
      homeDir: "",
      profileDir: "",
      webServer: "pending",
      loader: "pending",
      route: "pending",
      tapIndex: "pending",
      rowsFile: "unknown",
      logFile: "",
    },
  };
}

function resolveRuntimePaths(runtime) {
  try {
    const home = resolveHomeDir(process.env);
    runtime.homeDir = home.dir;
    runtime.homeSource = home.source;
    writeDiagnostic(runtime, "启动：版本 " + version + "（宿主插件，" + PACKAGE_NAME + "）");
    if (!home.dir) {
      runtime.readOnly = true;
      runtime.readOnlyReason = "未找到可用的 DSH_HOME / DSHM_HOME 数据目录，救援写入已禁用（只读）。";
      runtime.readOnlyReasonCode = "home-unresolved";
      writeDiagnostic(runtime, "数据目录：未设置 DSH_HOME / DSHM_HOME → 只读降级");
      return;
    }
    runtime.diag.homeDir = home.source;
    runtime.logFile = join(home.dir, LOG_FILENAME);
    runtime.diag.logFile = runtime.logFile;
    writeDiagnostic(runtime, "数据目录：由 " + home.source + " 定位 = " + home.dir);

    const profile = resolveProfileDir(home.dir, dirname(fileURLToPath(import.meta.url)));
    runtime.profileDir = profile.dir;
    runtime.profileSource = profile.source;
    if (!profile.dir) {
      runtime.readOnly = true;
      runtime.readOnlyReason = "无法安全定位声明了 dsh.profile 的 DSHM profile 目录，救援写入已禁用（只读）。";
      runtime.readOnlyReasonCode = "profile-unresolved";
      writeDiagnostic(runtime, "profile：未定位到声明 dsh.profile 的目录 → 只读降级");
      return;
    }
    runtime.diag.profileDir = profile.source;
    runtime.rowsPath = join(profile.dir, ROWS_FILENAME);
    runtime.patchPath = join(profile.dir, "cordis.patch.yml");
    runtime.readOnly = false;
    writeDiagnostic(runtime, "profile：" + profile.dir + "（来源：" + profile.source + "）");
    writeDiagnostic(runtime, "用户行文件：" + runtime.rowsPath + "（" + (existsSync(runtime.rowsPath) ? "存在" : "尚未创建") + "）");
    writeDiagnostic(runtime, "诊断日志：" + runtime.logFile);
  } catch (error) {
    runtime.readOnly = true;
    runtime.readOnlyReason = "救援插件定位数据目录时出错，已降级为只读：" + errText(error);
    runtime.readOnlyReasonCode = "path-error";
    writeDiagnostic(runtime, "路径定位异常：" + errText(error));
  }
}

// ── state / 目标解析 ────────────────────────────────────────────────────
function emptyState(runtime) {
  return {
    ok: true,
    version,
    generatedAt: new Date().toISOString(),
    mode: "readonly",
    writable: false,
    readOnlyReason: "",
    readOnlyReasonCode: "",
    warning: "",
    rowsPath: runtime.rowsPath || "",
    profileDir: runtime.profileDir || "",
    homeDir: runtime.homeDir || "",
    entries: [],
    rescueRows: [],
    counts: { entries: 0, actionable: 0, rescue: 0 },
    diagnostics: Object.assign({}, runtime.diag),
  };
}

async function resolveTarget(runtime) {
  const target = { mode: "readonly", reason: "", code: "", warning: "", rowsPath: runtime.rowsPath || "", patchPath: runtime.patchPath || "", rowsFile: null, patchText: "" };
  if (runtime.readOnly || !runtime.profileDir) {
    target.reason = runtime.readOnlyReason || "救援服务处于只读模式。";
    target.code = runtime.readOnlyReasonCode || "read-only";
    return target;
  }
  const rowsFile = await readRowsFile(runtime.rowsPath);
  target.rowsFile = rowsFile;
  runtime.diag.rowsFile = rowsFile.state;
  if (rowsFile.state === "unreadable") {
    target.reason = "用户行文件无法读取（" + String(rowsFile.error || "unknown") + "），已进入只读模式。";
    target.code = "rows-unreadable";
    return target;
  }
  if (rowsFile.state === "found" && !rowsFile.parse.ok) {
    // 用户行文件结构解析失败 → 降级写 cordis.patch.yml（本次停用重启后失效）
    let patchText = "";
    try {
      patchText = await readFile(runtime.patchPath, "utf8");
    } catch (error) {
      if (!(error && error.code === "ENOENT")) {
        target.reason = "用户行文件结构解析失败，且 cordis.patch.yml 无法读取，已进入只读模式。";
        target.code = "patch-unreadable";
        return target;
      }
      patchText = "";
    }
    const appendable = checkPatchAppendable(patchText);
    if (!appendable.ok) {
      target.reason = "用户行文件结构解析失败，且 cordis.patch.yml 无法安全追加（" + appendable.reason + "），已进入只读模式。";
      target.code = "patch-unappendable";
      return target;
    }
    target.mode = "patch-fallback";
    target.warning = FALLBACK_WARNING;
    target.patchText = patchText;
    return target;
  }
  target.mode = "rows";
  return target;
}

async function buildState(runtime) {
  const state = emptyState(runtime);
  let target = null;
  try {
    target = await resolveTarget(runtime);
  } catch (error) {
    state.readOnlyReason = "读取救援状态失败：" + errText(error);
    state.readOnlyReasonCode = "state-error";
    return state;
  }
  state.mode = target.mode;
  state.writable = target.mode !== "readonly";
  state.readOnlyReason = target.reason;
  state.readOnlyReasonCode = target.code;
  state.warning = target.warning;
  if (target.rowsPath) {
    state.rowsPath = target.rowsPath;
  }
  state.diagnostics = Object.assign({}, runtime.diag);
  if (target.mode === "readonly") {
    return state;
  }

  const rows = target.mode === "rows" && target.rowsFile && target.rowsFile.parse && target.rowsFile.parse.ok
    ? target.rowsFile.parse.rows
    : [];
  const patchInfo = await readPatchInfo(runtime.profileDir);
  const installed = await readInstalledPluginEntries(runtime.profileDir);
  const loader = readLoaderEntries(runtime.ctx);
  runtime.diag.loader = loader.ok ? "ok" : "unavailable";
  state.diagnostics = Object.assign({}, runtime.diag);

  const markerPrefix = target.mode === "patch-fallback" ? PATCH_MARKER_PREFIX : ROW_MARKER_PREFIX;
  const markerText = target.mode === "patch-fallback" ? target.patchText : (target.rowsFile ? target.rowsFile.text : "");
  const rescueRows = collectMarkers(textFormat(markerText).body, markerPrefix);
  const entries = buildCatalog({
    userRows: rows,
    patchEntries: patchInfo.rows,
    installedEntries: installed,
    loaderEntries: loader.entries,
    rescueRows,
    selfId: SELF_ENTRY_ID,
    selfName: PACKAGE_NAME,
    writable: true,
  });
  state.entries = entries;
  state.rescueRows = rescueRows;
  state.counts = {
    entries: entries.length,
    actionable: entries.filter(function (entry) { return entry.actionable; }).length,
    rescue: rescueRows.length,
  };
  return state;
}

// ── 写接口 ──────────────────────────────────────────────────────────────
async function stateHandler(runtime, req, res) {
  try {
    if (!methodAllowed(req, res, "GET")) {
      return;
    }
    const state = await buildState(runtime);
    if (!isLoopbackAddress(req && req.socket ? req.socket.remoteAddress : "")) {
      state.writable = false;
      state.readOnlyReason = "当前连接不是本机回环地址；救援配置变更默认禁用。";
      state.readOnlyReasonCode = "remote-mutation-disabled";
      for (const entry of state.entries) {
        entry.actionable = false;
      }
      state.counts = {
        entries: state.entries.length,
        actionable: 0,
        rescue: state.rescueRows.length,
      };
    }
    json(res, 200, state);
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "state-error" });
  }
}

async function disableHandler(runtime, req, res) {
  try {
    if (!methodAllowed(req, res, "POST")) {
      return;
    }
    assertMutationRequest(req);
    const body = await readJsonBody(req);
    const ids = normalizeIds(body);
    const state = await buildState(runtime);
    if (!state.writable) {
      throw errorWithStatus(503, state.readOnlyReason || "rescue is read-only", state.readOnlyReasonCode || "read-only");
    }
    const byId = new Map();
    for (const entry of state.entries) {
      byId.set(entry.id, entry);
    }
    for (const id of ids) {
      if (id === SELF_ENTRY_ID || id === PACKAGE_NAME) {
        throw errorWithStatus(409, PACKAGE_NAME + " cannot disable itself", "self-protected");
      }
      const entry = byId.get(id);
      if (!entry) {
        throw errorWithStatus(404, "unknown plugin row: " + id, "unknown-id");
      }
      if (entry.protected && entry.protectedReason === "self") {
        throw errorWithStatus(409, PACKAGE_NAME + " cannot disable itself", "self-protected");
      }
      if (entry.protected) {
        throw errorWithStatus(409, "protected row: " + id, "protected-id");
      }
      if (!entry.actionable) {
        throw errorWithStatus(409, "row is not actionable: " + id, "not-actionable");
      }
    }

    const target = await resolveTarget(runtime);
    if (target.mode === "readonly") {
      throw errorWithStatus(503, target.reason || "rescue is read-only", target.code || "read-only");
    }
    let outcome = null;
    if (target.mode === "rows") {
      outcome = await mutateTextFile(target.rowsPath, function (text) {
        return renderDisableRows(text, ids);
      });
      outcome.mode = "rows";
    } else {
      outcome = await mutateTextFile(target.patchPath, function (text) {
        return renderPatchDisableRows(text, ids);
      });
      outcome.mode = "patch-fallback";
    }
    writeDiagnostic(runtime, "停用：mode=" + outcome.mode + " added=" + JSON.stringify(outcome.added) + " already=" + JSON.stringify(outcome.already) + " ids=" + JSON.stringify(ids));
    const after = await buildState(runtime);
    json(res, 200, {
      ok: true,
      mode: outcome.mode,
      disabled: outcome.added,
      already: outcome.already,
      rescueRows: after.rescueRows,
      warning: after.warning,
    });
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "disable-failed" });
  }
}

async function restoreHandler(runtime, req, res) {
  try {
    if (!methodAllowed(req, res, "POST")) {
      return;
    }
    assertMutationRequest(req);
    const body = await readJsonBody(req);
    const ids = normalizeIds(body, { allowEmpty: true });
    const state = await buildState(runtime);
    if (!state.writable) {
      throw errorWithStatus(503, state.readOnlyReason || "rescue is read-only", state.readOnlyReasonCode || "read-only");
    }
    const target = await resolveTarget(runtime);
    if (target.mode === "readonly") {
      throw errorWithStatus(503, target.reason || "rescue is read-only", target.code || "read-only");
    }
    const requested = ids.length > 0 ? ids : null;
    let result = null;
    if (target.mode === "rows") {
      result = await mutateTextFile(target.rowsPath, function (text) {
        return removeRescueRows(text, requested, { markerPrefix: ROW_MARKER_PREFIX });
      });
    } else {
      result = await mutateTextFile(target.patchPath, function (text) {
        return removeRescueRows(text, requested, { markerPrefix: PATCH_MARKER_PREFIX });
      });
    }
    writeDiagnostic(runtime, "恢复：mode=" + target.mode + " restored=" + JSON.stringify(result.restored));
    json(res, 200, { ok: true, mode: target.mode, restored: result.restored });
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "restore-failed" });
  }
}

// ── 页面注入 ────────────────────────────────────────────────────────────
function injectRescue(runtime, html) {
  try {
    if (typeof html !== "string") {
      return html;
    }
    const source = html;
    if (source.indexOf(RESCUE_MARKER) !== -1) {
      return source;
    }
    const offset = source.lastIndexOf("</head>");
    if (offset === -1) {
      return source;
    }
    const meta = '<meta name="' + RESCUE_MARKER + '" content="' + RESCUE_MARKER + '">';
    const script = '<script defer src="' + ROUTE_PATH + '/client.js"></script>';
    const injected = source.slice(0, offset) + meta + "\n" + script + "\n" + source.slice(offset);
    runtime.injections += 1;
    if (runtime.injections === 1) {
      writeDiagnostic(runtime, "tapIndex：已向 index.html 注入救援脚本（" + ROUTE_PATH + "/client.js）");
    }
    return injected;
  } catch (error) {
    writeDiagnostic(runtime, "tapIndex：注入时异常（已返回原页面）：" + errText(error));
    return html;
  }
}

function previewHtml() {
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<title>DSHM Boot Rescue 自检</title>"
    + "<style>html,body{margin:0;height:100%}body{font-family:system-ui,sans-serif}"
    + "#root{height:100%;display:grid;place-items:center;background:#f5f6f8;color:#1d232b}"
    + ".preview-card{border:1px solid rgba(0,0,0,.12);border-radius:14px;padding:24px 28px;background:#fff;max-width:560px}"
    + ".preview-wordmark{font-size:12px;font-weight:700;letter-spacing:.16em;margin-bottom:12px}"
    + ".preview-failed{font-weight:600;margin-bottom:8px}"
    + ".preview-item{font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#5b6570;white-space:pre-wrap}"
    + "</style></head><body data-dshm-boot-rescue-preview=\"1\"><div id=\"root\">"
    + "<div data-dsh-boot=\"\" class=\"preview-card\"><div class=\"preview-wordmark\">HARNESS</div>"
    + "<div class=\"preview-failed\">Failed to load plugins</div>"
    + "<div class=\"preview-item\">web boot: 1 entry did not activate</div>"
    + "<div class=\"preview-item\">dsh-market: pending (waiting for service: demo-service)</div>"
    + "</div></div>"
    + "<script defer src=\"" + ROUTE_PATH + "/client.js\"></script></body></html>";
}

// ── 路由 ────────────────────────────────────────────────────────────────
async function routeHandler(runtime, req, res) {
  try {
    const url = new URL(req && req.url ? req.url : "/", "http://localhost");
    let subpath = url.pathname;
    if (subpath.indexOf(ROUTE_PATH) === 0) {
      subpath = subpath.slice(ROUTE_PATH.length);
    }
    if (subpath === "" || subpath === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("dshm-boot-rescue " + version + "\n");
      return;
    }
    if (subpath === "/client.js") {
      if (!methodAllowed(req, res, "GET")) {
        return;
      }
      const body = await readFile(new URL("./rescue-client.js", import.meta.url));
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(body);
      return;
    }
    if (subpath === "/health") {
      if (!methodAllowed(req, res, "GET")) {
        return;
      }
      json(res, 200, {
        ok: true,
        version,
        webServer: runtime.diag.webServer,
        loader: runtime.diag.loader,
        route: runtime.diag.route,
        tapIndex: runtime.diag.tapIndex,
        injections: runtime.injections,
        mode: runtime.readOnly ? "readonly" : "ready",
      });
      return;
    }
    if (subpath === "/preview") {
      if (!methodAllowed(req, res, "GET")) {
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      });
      res.end(previewHtml());
      return;
    }
    if (subpath === "/state") {
      await stateHandler(runtime, req, res);
      return;
    }
    if (subpath === "/disable") {
      await disableHandler(runtime, req, res);
      return;
    }
    if (subpath === "/restore") {
      await restoreHandler(runtime, req, res);
      return;
    }
    res.writeHead(404, { "cache-control": "no-store" });
    res.end();
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "route-error" });
  }
}

// ── 服务获取（绝不进入 pending） ────────────────────────────────────────
function attachWebServer(runtime, cleanups) {
  let webServer = null;
  try {
    webServer = runtime.ctx && typeof runtime.ctx.get === "function"
      ? runtime.ctx.get("webServer")
      : undefined;
  } catch (error) {
    runtime.diag.webServer = "error: " + errText(error);
  }
  if (!webServer || typeof webServer.register !== "function") {
    return false;
  }
  runtime.diag.webServer = "ok";
  writeDiagnostic(runtime, "webServer：已获取");
  try {
    const dispose = webServer.register({
      kind: "prefix",
      path: ROUTE_PATH,
      handler: function (req, res) { return routeHandler(runtime, req, res); },
    });
    if (typeof dispose === "function") {
      cleanups.push(dispose);
    }
    runtime.diag.route = "ok";
    writeDiagnostic(runtime, "路由注册：ok（" + ROUTE_PATH + "）");
  } catch (error) {
    runtime.diag.route = "failed: " + errText(error);
    writeDiagnostic(runtime, "路由注册：失败（已降级，不影响宿主）：" + errText(error));
  }
  try {
    if (typeof webServer.tapIndex !== "function") {
      throw new Error("webServer.tapIndex 不可用");
    }
    const dispose = webServer.tapIndex(function (html) {
      return injectRescue(runtime, html);
    });
    if (typeof dispose === "function") {
      cleanups.push(dispose);
    }
    runtime.diag.tapIndex = "ok";
    writeDiagnostic(runtime, "tapIndex：注册成功（等待 index.html 渲染时注入）");
  } catch (error) {
    runtime.diag.tapIndex = "failed: " + errText(error);
    writeDiagnostic(runtime, "tapIndex：失败（已降级，不影响宿主）：" + errText(error));
  }
  return true;
}

export function apply(ctx) {
  try {
    if (!ctx || typeof ctx.effect !== "function") {
      try {
        console.error("[" + PACKAGE_NAME + "] apply：ctx.effect 不可用，跳过（不影响宿主启动）");
      } catch (_) {
        // ignore
      }
      return;
    }
    const runtime = createRuntime(ctx);
    ctx.effect(function () {
      const cleanups = [];
      let stopped = false;
      let attached = false;
      let timer = null;
      let attempts = 0;

      function cleanup() {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        while (cleanups.length > 0) {
          const dispose = cleanups.pop();
          try {
            if (typeof dispose === "function") {
              dispose();
            }
          } catch (_) {
            // ignore
          }
        }
      }

      function tryAttach() {
        if (stopped || attached) {
          return;
        }
        let webServer = null;
        try {
          webServer = typeof ctx.get === "function" ? ctx.get("webServer") : undefined;
        } catch (error) {
          runtime.diag.webServer = "error: " + errText(error);
        }
        if (!webServer || typeof webServer.register !== "function") {
          attempts += 1;
          if (runtime.diag.webServer !== "unavailable") {
            runtime.diag.webServer = "unavailable";
            writeDiagnostic(runtime, "webServer：暂不可用（等待 internal/service 事件并重试；插件自身不会进入 pending）");
          }
          if (attempts < SERVICE_WAIT_TRIES) {
            timer = setTimeout(tryAttach, SERVICE_WAIT_MS);
            try {
              if (timer && typeof timer.unref === "function") {
                timer.unref();
              }
            } catch (_) {
              // ignore
            }
          } else {
            runtime.diag.webServer = "unavailable(timeout)";
            writeDiagnostic(runtime, "webServer：等待超时，已降级为无路由 / 无注入模式（不影响宿主启动）");
          }
          return;
        }
        attached = true;
        attachWebServer(runtime, cleanups);
      }

      try {
        resolveRuntimePaths(runtime);
      } catch (error) {
        runtime.readOnly = true;
        runtime.readOnlyReason = "救援插件初始化异常，已降级为只读：" + errText(error);
        runtime.readOnlyReasonCode = "init-error";
        writeDiagnostic(runtime, "初始化异常：" + errText(error));
      }

      try {
        const loader = typeof ctx.get === "function" ? ctx.get("loader") : undefined;
        runtime.diag.loader = loader && typeof loader.entries === "function" ? "ok" : "unavailable";
      } catch (error) {
        runtime.diag.loader = "error: " + errText(error);
      }
      writeDiagnostic(runtime, "loader：" + runtime.diag.loader);

      try {
        const dispose = ctx.on("internal/service", function (serviceName, impl) {
          if (!stopped && serviceName === "webServer" && impl) {
            tryAttach();
          }
        });
        if (typeof dispose === "function") {
          cleanups.push(dispose);
        }
      } catch (error) {
        writeDiagnostic(runtime, "internal/service 监听注册失败（改用定时重试）：" + errText(error));
      }

      tryAttach();
      return cleanup;
    }, PACKAGE_NAME + ": rescue routes and script");
  } catch (error) {
    try {
      console.error("[" + PACKAGE_NAME + "] apply 失败（已忽略，不影响宿主启动）：" + errText(error));
    } catch (_) {
      // ignore
    }
  }
}
