# DSHM 设备运行时故障修复手册

> 本手册记录 DSHM 设备端（HarmonyOS 沙箱 + 内嵌 libnode）运行时的三个核心故障的**完整定位与修复过程**，
> 供后续遇到同类症状时直接照做。现象与结论索引见 `.agent-rules/bug-log.md`（[2026-09-08][2026-09-09] 三条），
> 本文补充"怎么修好的"：诊断命令、根因推导、改动点、验证方法。

适用平台：arm64-v8a OpenHarmony 真机；嵌入式 node 以 `--jitless` 运行（沙箱 W^X 硬约束）。

---

## 目录

- [0. 排查工具箱（任何问题先跑这几条）](#0-排查工具箱任何问题先跑这几条)
- [1. `--jitless` 下 undici llhttp WebAssembly 使 node 崩溃](#1---jitless-下-undici-llhttp-webassembly-使-node-崩溃)
- [2. libnode 启动 V8 TLS 竞态 / io_uring SIGSYS（native 层）](#2-libnode-启动-v8-tls-竞态--io_uring-sigsysnative-层)
- [3. UI 卡"启动超时"但 3080 其实已就绪（ArkTS http 到 loopback 失效）](#3-ui-卡启动超时但-3080-其实已就绪arkts-http-到-loopback-失效)
- [4. 修完之后如何验证闭环](#4-修完之后如何验证闭环)
- [5. 2026-09-09：WebUI 全 /api 400 + 二次启动崩溃（两条修复）](#5-2026-09-09webui-全-api-400--二次启动崩溃两条修复)

---

## 0. 排查工具箱（必读先跑这几条）

设备 target 记为 `$T`（`hdc list targets` 获取；握手不稳时 hdc 会自动重连，无需插拔）：

```bash
HDC="/c/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe"
# 1) 进程树：应看到 com.dshm.agentic + Native_libdsh_host0 + gpu + render（ArkWeb 渲染栈）
"$HDC" -t $T shell "ps -A -o PID,NAME | grep -E 'dshm|agentic'"
# 2) 端口：3080 应 LISTEN，并有 ESTABLISHED 长连接（前端会话）与 TIME_WAIT（页面/资源拉取）
"$HDC" -t $T shell "netstat -anp | grep 3080"
# 3) node 子进程日志（node stdout/stderr 重定向到应用沙箱，hdc shell 可见）
"$HDC" -t $T shell "tail -20 /data/app/el2/100/base/com.dshm.agentic/haps/entry/files/log/node-*.log"
# 4) HTTP 实测（shell 侧 wget / toybox 是否为真 200）；注意 shell 通 ≠ ArkTS http 通（见 §3）
"$HDC" -t $T shell "toybox wget -O - http://127.0.0.1:3080/ | head -c 200"
# 5) 应用 UI 侧 hilog（A00001 域）
"$HDC" -t $T shell "hilog -x | grep -E 'DshmWebPage|DshBootstrap|ProfileDiag|fetch-shim' | tail -30"
```

诊断时的关键心智：**希尔链路是 `ArkTS → startNativeChildProcess → libdsh_host(C++) → dlopen(libnode) → node::Start → dsh web :3080 → ArkWeb`。每一步都有独立的日志落点**：C++ 侧打 `filesDir/log/node-*.log`（node 的 stdout/stderr 被 freopen 到该文件），ArkTS 侧打 hilog。故障时先确认"哪一段的日志正常、哪一段断了"。

---

## 1. `--jitless` 下 undici llhttp WebAssembly 使 node 崩溃

### 现象

设备上 node 进程首次触碰 Web 全局即退出；`node-*.log` / hilog 报：

```
ReferenceError: WebAssembly is not defined
    at lazylll (node:internal/deps/undici/undici:6337)
unhandledRejection: ReferenceError: WebAssembly is not defined
```

`--jitless` 移除 `WebAssembly` 全局；node 内建 undici 在**模块作用域**执行
`llhttpPromise = lazylight(); llhttpPromise.catch()`，其中的 `await WebAssembly.compile(wasm)`
在模块加载期就解析 `WebAssembly` 标识符，rejection 无人处理 → 进程退出。

### 排查过程（怎么定位的）

1. **最小复现（宿主 Windows node v24.2.0 复现，比设备快）**：
   `node --jitless -e "fetch('http://127.0.0.1:1')"` → 直接 `ReferenceError: WebAssembly is not defined`。
   证实是 undici 模块加载期问题，与网络无关。
2. **挨个安装全局用时序二分**：写探针脚本依次 `Object.defineProperty(globalThis, 'Headers'/'Request'/...)`，
   每次安装后触发 undici 加载，观察是否崩溃。**关键发现**：
   - 在 `WebAssembly` 存根之后装其它全局 → 一切正常；
   - 在 `WebAssembly` 存根之前装任意一个全局（Headers/Request/Response/FormData/MessageEvent/CloseEvent/WebSocket）
     → 即使 `globalThis.WebAssembly` 已经是 object（`typeof === 'object'`），undici 仍然报
     `ReferenceError: WebAssembly is not defined`（unbound identifier，与照 WebAssembly 查找发生在
     模块求值瞬间，Snapshot/作用域链状态有关）。
   - `fetch`/`ErrorEvent`/`EventSource` 安装无害。
3. 尝试过 `process.binding('natives')` 打补丁内建模块（含 `--no-codedots-snapshot`）→ 无效，内建从 snapshot 编译，运行时替换不生效。此路不通，放弃。

### 修复

`entry/src/main/resources/rawfile/dsh/node_modules/@deepseek-ai/dsh/lib/_fetch-shim.cjs`：

- 在**文件顶部**（紧接 zlib import 之后、任何 `installGlobal` 调用之前）安装"永不 resolve 的 FauxWebAssembly"：

```js
if (typeof globalThis.WebAssembly === 'undefined') {
  const neverSettle = () => new Promise(() => {});
  const FauxWebAssembly = {
    compile: neverSettle,
    compileStreaming: neverSettle,
    instantiate: neverSettle,
    instantiateStreaming: neverSettle,
    Module: function Module() { throw new Error('WebAssembly unavailable under --jitless'); },
    Instance: function Instance() { throw new Error('WebAssembly unavailable under --jitless'); },
  };
  Object.defineProperty(globalThis, 'WebAssembly', {
    value: FauxWebAssembly, writable: true, configurable: true, enumerable: true,
  });
  process.stderr.write('[fetch-shim] WebAssembly stub installed early (jitless mode)\n');
}
```

- 后续才做 `installGlobal('fetch', shimFetch)` 等（文件尾部第 ~637 行附近）。`fetch` 用纯 `node:http`
  实现（C++ llhttp，无 WASM）。
- `dsh_host.cpp` 启动 argv 保持：`node --jitless --expose-internals -r <shim> <bin> web`。

### 复用注意（踩过的坑）

- **顺序是命门**：stub 必须在任何全局之前，注释里写明"NEVER install any other global before this block"。
- 改完 shim 后必须把 `DshBootstrap.ets` 的 `ENV_VERSION` 加一（当前 `20260909-55`），
  否则覆盖安装不清应用数据，rawfile 不会重新解压，旧 shim 仍生效。
- 若进程崩溃还要拿到崩溃点上下文，`dsh_host.cpp` 会打印完整 `/proc/self/maps`，保持开启。

### 验证（本手册 §4 的 1/2/4 条）

- 宿主：`node --jitless -r _fetch-shim.cjs -e "fetch('http://127.0.0.1:1').catch(()=>{})"` 不崩溃；
- 设备 node 日志：`[fetch-shim] WebAssembly stub installed early (jitless mode)` →
  `[fetch-shim] installed globals; fetch.name=shimFetch instanceof=true`；
- undici/Worker 均正常（worker preload 亦走 shim，日志见 `Worker wrapped`）。

---

## 2. libnode 启动 V8 TLS 竞态 / io_uring SIGSYS（native 层）

### 现象

- **TLS 竞态**：libnode 由 `dlopen` 纯路径加载时，偶发 `V8 Fatal: AllowHeapAllocationInRelease`，
  启动概率性失败；
- **io_uring SIGSYS**：鸿蒙沙箱 seccomp 禁止 `io_uring_setup`（aarch64 syscall 425），
  libnode 的 `uv__iou_init` 在 `uv__platform_loop_init` 中以 flags=0 调用时**绕过**
  `UV_USE_IO_URING` 环境变量检查、无条件执行 syscall → 进程 SIGSYS 崩溃。
  实测 `setenv UV_USE_IO_URING=0` 无效，不能靠环境变量开关。

### 修复方案

1. **TLS**：`entry/src/main/cpp/CMakeLists.txt` 将 `libs/arm64-v8a/libnode.so` 加入
   `target_link_libraries(dsh_host PRIVATE ...)` → 进入 `DT_NEEDED`，ld.so 进程启动时就装载并
   完成 `thread_local` 初始化；运行时仍由 `dlopen` 取同一份 `node::Start`。改动：

   ```cmake
   # libnode.so 进 dsh_host 的 DT_NEEDED：让 loader 提前初始化 thread_local，
   # 避免 dlopen 路径下 V8 的 TLS 断言读初始值不正确。
   target_link_libraries(dsh_host PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/arm64-v8a/libnode.so)
   ```

2. **io_uring**：`scripts/patch-libnode-io-uring.sh`（幂等，带校验）把
   `uv__iou_init` 中 `bl syscall@plt`（调用 io_uring_setup）替换为 `mov w0, #-1`
   （`movn w0, #0` = `0x12800000`），使 io_uring_setup 返回 -1 → libuv 走失败路径回退 epoll。

```bash
# 每次 fetch-libnode.sh 重新下载后都要重跑：
bash scripts/patch-libnode-io-uring.sh        # 默认入口 libs/arm64-v8a/libnode.so
```

脚本会备份 `libnode.so.orig`，校验通过后打印 ✅；若 libnode 版本变化导致偏移失配会报错并提示更新偏移。

### 稳定性收尾

崩溃后的可诊断性：`dsh_host.cpp` 的崩溃处理打印完整 `/proc/self/maps`（此前定位 TLS 与 io_uring 问题的主要手段），保留不删。

### 验证

- 设备 `ps` 长期可见 `com.dshm.agentic:Native_libdsh_host4`（不随机退出）；
- `node-*.log` 无 V8 Fatal 前缀行经过 `dlopen(libnode.so)` 顺利到 `dsh web:`；
- 主机 `4) toybox.wget :3080` 可取到 HTML。

---

## 3. ArkTS http 到 loopback 失效 → UI 卡"启动超时"（设备）

### 现象

UI 显示"正在启动 DSH 运行时…"约 120 秒后进入失败分支（`hilog -x` 出现 `ProfileDiag` 的 web profile
manifest dump、`DshmWebPage` 打 `DSH server 启动超时`）。但对照诊断：`netstat` 显示 3080 LISTEN；
`toybox wget http://127.0.0.1:3080/` 能取到完整 HTML（`<!doctype html>` + `@deepseek-ai/dsh-client-modules`）；
node 日志已经打印 `dsh web: http://127.0.0.1:3080`。**服务器明明好了，UI 却探不到。**

### 定位过程

- 由于 `hilog` 里没有任何命中 127.0.0.1 的 http 连接（下一次 netstat 全程无 ESTABLISHED/TIME_WAIT 新增），
  说明 ArkTS 侧的 `http.createHttp().request('http://127.0.0.1:3080')` 在**发出前就被系统网络栈收走**——
  是 UI 应用层探测的问题，不是 dsh 服务器的问题。
- 同一条命令 shell 能通 vs ArkTS 不通：区别在 UI 进程的网络权限/loopback 策略/网络命名空间，
  而不是服务器。不要试图让 ArkTS http 打 loopback（不可靠）。

### 修复方案

**就绪判定不再依赖 ArkTS http，改为读 node 子进程日志文件中的 `dsh web:` 标记**（主通路；
http 探测降为兜底，仍在 1 秒超时内快速返回 false 不阻塞）。

`entry/src/main/ets/dshm/bootstrap/DshBootstrap.ets`：

- `waitForServer(context, timeoutMs)`：轮询循环内每次先 `logNodeReady(logDir)`（读
  `<filesDir>/log/node-*.log`，包含 `dsh web:` 即就绪），再 `probeServerHttp()` 兜底，1 秒间隔。
- `probeServerHttp()`：`http.createHttp()` 请求 `SERVER_URL`，`responseCode < 500` 视为成功
  （设备上通常返回 false，不 block）。
- 调用方 `pages/dshm/DshmWebPage.ets` 同步签名：`this.ready = await DshBootstrap.waitForServer(hostCtx, 120000)`。

边界注意：node 日志目录每次启动（`clearNodeLogs`）会被清掉重建，`logNodeReady` 读到空目录返回
false，不会误判；`dsh web:` 是 node stdout 打印且该标记在文件里只出现一次就够。

### 验证

见 §4 闭环清单：`ps` 出现 gpu + 双 render 进程、3080 出现 ESTABLISHED 长连接与成批 TIME_WAIT
（页面与资源拉取）、hilog 出现 `com.dshm.agentic/chromium` 的 `ws://127***` 请求日志。

---

## 4. 修完之后如何验证闭环

单条命令 `smoke` 清单（在设备 shell 上执行）：

```bash
T=$(hdc list targets | head -1 | awk '{print $1}')          # 设备 target
HDC=".../hdc.exe"                                            # 你的 hdc 路径

# 1) 进程：主进程 + Native_libdsh_host + gpu + render
"$HDC" -t $T shell "ps -A -o PID,NAME | grep -E 'com.dshm.agentic'"
# 2) 端口：3080 LISTEN；ESTABLISHED 长连接存在
"$HDC" -t $T shell "netstat -anp | grep 3080"
# 3) node 日志尾部：WebAssembly stub / 全局已装 / dsh web: 一行不缺
"$HDC" -t $T shell "tail -8 .../files/log/node-*.log"
# 4) 服务器真实服务：HTTP 200 + HTML
"$HDC" -t $T shell "toybox wget -O - http://127.0.0.1:3080/ | head -c 120"
# 5) UI 就绪：ArkWeb 已加载 WebUI（render 进程 + ws 请求日志）
"$HDC" -t $T shell "hilog -x | grep -E 'chromium/.*ws://|DshmWebPage.*加载 ArkWeb' | tail -5"
```

全绿 = 设备 → dsh → 3080 → ArkWeb 闭环成立。

### §4.5 RPC 一键探测脚本（/api 是否真的可用）

> 用户报告"某个页面 400"时，先跑这段（在设备 shell 里），能区分“服务没起来”vs“鉴权”vs“RPC 400/500”。
> 原理：Web 服务对未认证请求回 401/303；带 token 交换 cookie 后 POST `/api/<ns>/<method>`，
> body 遵循 `{"type":"client-request","rpcId":"<任意>","method":"<ns>/<method>","payload":{"args":{}}}`。

```bash
# 在设备 shell 内（node 日志路径按实际 bundle 调整）
LOG=/data/app/el2/100/base/com.dshm.agentic/haps/entry/files/log/node-*.log
URL=$(grep -o "dsh web: http://[^ ]*" $LOG | head -1 | sed "s/dsh web: //")
TOKEN=$(echo "$URL" | sed "s/.*token=//")
printf "GET /?token=%s HTTP/1.1\r\nHost: 127.0.0.1:3080\r\nConnection: close\r\n\r\n" "$TOKEN" > /data/local/tmp/_req
COOKIE=$(toybox nc 127.0.0.1 3080 < /data/local/tmp/_req | sed -n "s/^set-cookie: //p" | tr -d "\r")
for EP in settings/describe llm/listProviders llm/listConfigurableProviders \
          agentPresets/list directoryPicker/list pluginInventory/list; do
  NS=${EP%/*}; M=${EP#*/}
  BODY="{\"type\":\"client-request\",\"rpcId\":\"s\",\"method\":\"$NS/$M\",\"payload\":{\"args\":{}}}"
  printf "POST /api/%s HTTP/1.1\r\nHost: 127.0.0.1:3080\r\nCookie: %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" "$EP" "$COOKIE" "${#BODY}" "$BODY" > /data/local/tmp/_rpc
  echo "== $EP => $(toybox nc 127.0.0.1 3080 < /data/local/tmp/_rpc | head -1)"
done

# 编辑配置：GET 读文档 + POST 保存（预期 200；若 POST 显示 405 allow: GET，
# 说明运行的是旧版插件（GET/POST 重复 exact 路由被吞），需 ENV_VERSION 抬版本重装）
printf "GET /dshm-config-editor/document HTTP/1.1\r\nHost: 127.0.0.1:3080\r\nOrigin: http://127.0.0.1:3080\r\nCookie: %s\r\nConnection: close\r\n\r\n" "$COOKIE" > /data/local/tmp/_cfg
toybox nc 127.0.0.1 3080 < /data/local/tmp/_cfg | head -1
REV=$(toybox nc 127.0.0.1 3080 < /data/local/tmp/_cfg | grep -o '"revision":"[0-9a-f]*"' | head -1 | sed 's/.*://;s/"//g')
printf 'POST /dshm-config-editor/document HTTP/1.1\r\nHost: 127.0.0.1:3080\r\nOrigin: http://127.0.0.1:3080\r\nContent-Type: application/json\r\nCookie: %s\r\nContent-Length: 90\r\nConnection: close\r\n\r\n{"content":"# dshm probe\n","revision":"%s"}' "$COOKIE" "$REV" > /data/local/tmp/_cfg2
toybox nc 127.0.0.1 3080 < /data/local/tmp/_cfg2 | head -1
```

预期：全部 `HTTP/1.1 200 OK`。任一非 200 → 看 node 日志 + `_fetch-shim.cjs`（bundle 代码
会在 shim 缺 `json()` 时系统性地把每个 RPC 打成 400，见 §5）。

---

## 5. 2026-09-09：WebUI 全 /api 400 + 二次启动崩溃（两条修复）

这两个问题影响的是“设备上 WebUI 是否可操作、重启是否稳定”，在 §1–§4 的闭环之后出现。

### 5.1 WebUI 全部 /api 400（shim 的 `Request` 缺 body 读取）

- **现象**：`settings/describe`、`llm/listProviders`、`agentPresets/list`、`directoryPicker/list`、`pluginInventory/list` 全部 HTTP 400，页面上是“权限无法读取/无法加载提供方/无法选择工作区目录”等。
- **根因**：`--jitless` 下 `_fetch-shim.cjs` 的全局 `Request`（`ShRequest`）只有 getter，没有 `text()/json()/arrayBuffer()`。RPC bridge（`dsh-client-connection`）用 `new Request(url, { body })` 后 `await request.json()` 读取 body，TypeError 被 `dsh-host-webserver` 的 `next()` catch 并统一包成 400。所有带 body 的 RPC 全中招，因此一修好所有页面一起恢复。
- **修复**：`ShRequest` 增加 `_consumeBody()`（body 已消费抛 TypeError）+ `async text()/json()/arrayBuffer()`，`bodyUsed` 基于 `_bodyUsed`；`ENV_VERSION` → 58。
- **验证**：§4.5 脚本逐条 200；WebUI 各页恢复。

### 5.2 二次启动崩溃（`exists and is not a symlink…`）

- **现象**：首次启动一切正常；`aa force-stop` 后重启必然崩，node 日志 `dsh: …/profiles/node_modules/@deepseek-ai/dsh exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback` ← `ensureSymlink` ← `healProfilesModuleFallbackLocked`。
- **根因**：鸿蒙沙箱禁 symlink → 首次启动 `ensureSymlink` 走 `cpSync` 整目录复制降级，副本是**普通目录**且无 `moduleFallback.targets` 标记；第二次启动 `moduleFallbackEntryCurrent` 不认为它是“当前代”→ 重新 heal → `ensureSymlink` 把“自己的旧副本”当成用户占用目录而抛错。
- **修复**：`dsh-app-boot/lib/index.js` 新增 `isCurrentCopiedModuleDir`（name+version 匹配视为当前代，跳过 heal）和 `isCopiedModuleDir`（name 匹配视为自身副本，允许删除重建）；`ensureSymlink` 的抛错只保留给真正的用户目录。
- **验证**：force-stop → 二次启动 → `dsh web:` 再次出现、无报错（日志无 `exists and is not`）。

### 5.3 通用设置“编辑配置”能读不能保存（dshm-config-editor POST 405）

- **现象**：编辑配置弹窗能打开、内容能加载（GET 200），点“保存”必失败；另有早前观察 `settings/openSettingsDocument` 返回 `ok:false`（”native path opener” 在鸿蒙不可用）。
- **根因**：`dshm-config-editor` 对同一路径 `/dshm-config-editor/document` 注册了**两条** exact 路由（GET 读、POST 写）。`dsh-host-webserver.register()` 对重复 `(kind,path)` 直接 throw（`webserver: duplicate exact route “…”`），第二个注册（写路由）失败被吞；实际生效的是 GET handler，它对 POST 回 `405 allow: GET`。设备直测：`POST /dshm-config-editor/document` → `HTTP/1.1 405 Method Not Allowed, allow: GET`。
- **修复**：`scripts/create-dshm-config-editor.mjs` 合并为单条 exact 路由 + handler 内按 `request.method` 分发（GET 读 / POST 写 / 其它 405 `allow: GET, POST`）；测试 `test-dshm-config-editor.mjs` 断言改为 1 条路由并全部通过。`ENV_VERSION` → 59。
- **验证**：单测全绿；设备端重装后按 §4.5 追加的 POST 探测预期 200。

### 5.4 `ACCESS_USER_FULL_DISK` 等 system_basic 权限安装被拒（grant request failed）

- **现象**：把 demo 里的 `ACCESS_USER_FULL_DISK`/`CUSTOM_SANDBOX`/`READ_WRITE_USER_FILE` 加入 `requestPermissions` 后 `hdc install` 报 `code:9568289 … grant request permissions failed`（逐个各自失败）。
- **根因**：三者均 `grantMode` 之外的 `availableLevel: system_basic`（`ACCESS_USER_FULL_DISK` 还限定 `deviceTypes: [“2in1”]`）；本工程自动签名 profile 的 `acls.allowed-acls` 只有 `FILE_ACCESS_PERSIST`。设备 hilog：`Perm(…) need acl → AclAndEdmCheck: Acl invalid → InitHapToken failed 12100024`。
- **结论（订正）**：安装与否只取决于 provisioning profile 的 `acls.allowed-acls` 是否带对应条目，而 profile 的 acls 由「生成那一刻 manifest 声明的权限 + 账号权限」决定。本机开发者账号**能**配发这些 acls（同机 `dshm` 工程 profile 的 `acls.allowed-acls` 正含这三项）；用户所称“无需单独申请即可使用”成立，前提是重签之后 profile 放行。
- **处理**：按用户意见将三项**留在 manifest**（与 `STORE_PERSISTENT_DATA` 共 4 项新增权限）。旧 profile（2026-09-06，acls 仅 `FILE_ACCESS_PERSIST`）下安装仍会拒装；**待 DevEco 对 DSHM 重新自动签名**（重签 p7b 会携带当前 manifest 对应 acls）后重编 HAP 即可安装。

---

## 附：为什么不是其他方案（记防火）

- **为什么给 node 加 `--trace-exit` 调试？** 不加，设备启动流程不引入调试遗留代码。
- **为什么 JS 依赖不能自动下载？** 依赖树不会自动下载；运行时二进制（libnode/busybox/pnpm）
  由脚本下载或设备/原始目录已有，另一手动步骤。
- **为什么不能去掉 `--jitless`？** W^X 禁可执行内存是沙箱硬约束，JIT 一开 V8 初始化即 FATAL。
- **为什么 http 探测还留着？** 万一某设备 ArkTS loopback 可达（API 或版本差异），http 是更真实的
  服务性验证；当前只作为 logNodeReady 的兜底，不阻塞不充当主通道。

---

*维护：每次替换/升级 libnode 或修改 DSH 环境后，跑一次 §4 清单；UI 卡超时优先看 §3 而非改安装。*