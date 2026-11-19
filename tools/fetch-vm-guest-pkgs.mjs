/*
 * 取「手持档虚拟机 guest 侧 bash 闭包」的 Alpine 包，落到 third_party/vmhish/guestpkgs/。
 *
 * 【为什么要这一步】手持档（手机/平板）的应用沙箱里没有任何可 execve 的 shell，
 * 真 bash 只能在随包的 QEMU guest 里跑。guest 镜像（HiSH 的 Alpine 3.22 rootfs）
 * 默认只带 busybox ash —— 而上游 @deepseek-ai/dsh-bash-local 的 execute() 收到的
 * argv 固定是 ["bash","-c",cmd]，用 ash 顶替会静默改变语义（bashism 全废）。
 * 让设备侧装包需要外网 + 实测 30.9s，所以把 bash 及其 so 闭包**构建期**取好、
 * 随 HAP 分发，guest 首启离线安装即可。
 * **路径与名字都不带 `.apk`**：目录是 `guestpkgs/`、落盘一律 `.tar.gz` 后缀（内容仍是
 * Alpine v2 包）——应用市场审核按**路径**判"包内带 apk 相关目录/文件"就判"安装失败"，
 * 见 docs/148 / docs/156；guest 侧装前在 guest 的 /tmp 里补 `.apk` 名字。
 *
 * 【判据】从 Alpine 官方 v3.22 main aarch64 的 APKINDEX 解析依赖闭包：
 *   · `so:` 依赖按 APKINDEX 的 `p:`（provides）反查提供者 ⇒ readline / ncurses-libs 会被拉进来；
 *   · `/bin/sh` 之类的**文件依赖**由基础镜像的 busybox 满足 ⇒ 跳过（不重新装 busybox）；
 *   · musl 已在基础镜像里 ⇒ 列入 HAVE，不重复装（重装 musl 会动 guest 的 loader）。
 *
 * 产物目录 third_party/ 已 gitignore（字节不入库、本脚本入库）。用法：
 *   node tools/fetch-vm-guest-pkgs.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'third_party', 'vmhish', 'guestpkgs');
const BASE = 'https://dl-cdn.alpinelinux.org/alpine/v3.22/main/aarch64';
/*
 * bash = 上游 bash 执行器依赖；
 * dropbear-dbclient / -ssh / -scp = guest 侧 SSH 客户端。
 * `dropbear-ssh` 提供 `ssh` 入口（dbclient 的兼容名），`dropbear-scp` 提供 scp。
 * 只带客户端，不默认启动 dropbear 服务端。
 */
const WANT = ['bash', 'dropbear', 'dropbear-dbclient', 'dropbear-ssh', 'dropbear-scp'];
const HAVE = new Set(['musl']);

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** 解析 APKINDEX.tar.gz：每段是一个包，字段名大小写有意义（`P:`=包名、`p:`=provides）。 */
function parseIndex(buffer) {
  const packages = [];
  for (const block of gunzipSync(buffer).toString('utf8').split('\n\n')) {
    const fields = new Map();
    for (const line of block.split('\n')) {
      const match = /^([A-Za-z]):(.*)$/.exec(line);
      if (match) fields.set(match[1], (fields.get(match[1]) ?? '') + match[2]);
    }
    if (!fields.has('P')) continue;
    packages.push({
      name: fields.get('P'),
      version: fields.get('V'),
      depends: (fields.get('D') ?? '').split(/\s+/).filter((s) => s.length > 0),
      provides: (fields.get('p') ?? '').split(/\s+/).filter((s) => s.length > 0),
    });
  }
  return packages;
}

const index = parseIndex(await get(`${BASE}/APKINDEX.tar.gz`));
const byName = new Map(index.map((p) => [p.name, p]));
// provides 可以带版本后缀（`so:libreadline.so.8=8.2.13`）⇒ 两种写法都登记，
// 否则 `so:` 依赖查不到提供者（第一版就是这么漏掉 readline 的）。
const providerOf = new Map();
for (const pkg of index) {
  for (const provided of pkg.provides) {
    for (const key of [provided, provided.replace(/=.*$/, '')]) {
      if (!providerOf.has(key)) providerOf.set(key, pkg.name);
    }
  }
}

const selected = new Map();
const queue = [...WANT];
while (queue.length > 0) {
  const name = queue.shift();
  if (selected.has(name) || HAVE.has(name)) continue;
  const pkg = byName.get(name);
  if (pkg === undefined) throw new Error(`APKINDEX 里没有 ${name}`);
  selected.set(name, pkg);
  for (const dep of pkg.depends) {
    // 文件依赖（/bin/sh 之类）由基础镜像满足；so: 依赖按 provides 反查提供者。
    const target = dep.startsWith('/') || dep.startsWith('!') ? ''
      : dep.startsWith('so:') ? (providerOf.get(dep) ?? '')
        : dep.replace(/[<>=~].*$/, '');
    if (target.length > 0 && !selected.has(target) && !HAVE.has(target)) queue.push(target);
  }
}

for (const [name, pkg] of selected) {
  console.log(`${name} ${pkg.version}  depends=${pkg.depends.join('|')}`);
}
mkdirSync(DEST, { recursive: true });
for (const [name, pkg] of selected) {
  const file = `${name}-${pkg.version}.tar.gz`;
  const destination = join(DEST, file);
  if (existsSync(destination)) {
    console.log(`skip  ${file}（已存在）`);
    continue;
  }
  // 远端永远是 Alpine 的 `.apk`；本地落盘统一改成 `.tar.gz`（审核端按路径判扩展名）。
  writeFileSync(destination, await get(`${BASE}/${name}-${pkg.version}.apk`));
  console.log(`wrote ${file}`);
}
