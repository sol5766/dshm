// 临时断言：内嵌 Python 桥（python_runner addon + el1 libpython + main.js 自检）
// 用法：node tools/assert-python-bridge.mjs
import { readFileSync, existsSync } from 'node:fs';
import { verifyStartupWork } from './check-startup-work.mjs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const cpp = read('../entry/src/main/cpp/python_runner.cpp');
const cmake = read('../entry/src/main/cpp/CMakeLists.txt');
const place = read('../tools/place-toolchain.mjs');
const main = read('../hostcore/app/main.js');
let n = 0;
function ok(cond, msg) { n++; if (!cond) { console.error(`FAIL ${n}: ${msg}`); process.exit(1); } }

// ── python_runner.cpp（DSHM 移植，教训全保留）──
ok(existsSync(new URL('../entry/src/main/cpp/python_runner.cpp', import.meta.url)), 'python_runner.cpp 存在');
ok(cpp.includes('NAPI_MODULE(python_runner, Init)'), 'NAPI_MODULE 注册');
ok(cpp.includes('DSHM_PYTHON_LIB'), 'lib 路径 env：DSHM_PYTHON_LIB');
ok(cpp.includes('DSHM_PYTHON_HOME'), 'stdlib 根 env：DSHM_PYTHON_HOME');
ok(cpp.includes('RTLD_NOW | RTLD_GLOBAL'), 'dlopen RTLD_NOW|RTLD_GLOBAL');
ok(cpp.includes('static void AppendPyStringLiteral'), '统一字符串转义（禁止手写循环）');
ok(cpp.includes('PyEval_SaveThread'), 'Py_Initialize 后释放 GIL（EvalSaveThread）');
ok((cpp.match(/PyGILState_Ensure_t/g) || []).length >= 1 && cpp.includes('PyGILState_Release_t'), 'GIL Ensure/Release 对');
ok(cpp.includes('_dshm_redirect_stdout') && cpp.includes('_dshm_get_captured_err'), 'stdout/stderr 捕获垫片注入');
ok(cpp.includes('except SystemExit as _e') && cpp.includes('traceback.print_exc()'), 'captureRun 异常不逃逸（SystemExit/BaseException 分支）');
ok(cpp.includes('g_loadAttempted'), 'dlopen 单次尝试守卫');
ok(!/target_link_libraries[^\n]*python_runner[^\n]*libpython/.test(cmake), 'libpython 不进 DT_NEEDED（运行时 dlopen）');

// ── CMakeLists.txt：SHARED 目标 + koffi 同款链接口径 ──
ok(/add_library\(python_runner SHARED python_runner\.cpp\)/.test(cmake), 'add_library(python_runner SHARED)');
ok(/target_link_libraries\(python_runner PRIVATE \$\{PYRUN_LIBNODE\} dl\)/.test(cmake), 'DT_NEEDED libnode + dl（E43 口径）');
ok(/LIBRARY_OUTPUT_DIRECTORY \$\{CMAKE_LIBRARY_OUTPUT_DIRECTORY\}/.test(cmake), '产物输出到 hvigor 指定目录');
ok(/python_runner 编入 HAP/.test(cmake), '构建状态消息');

// ── place-toolchain.mjs：libpython 只随共享 HSP 一份（2026-11-02 口径）──
// 【方向翻转 2026-11-05】旧断言要求"写进 entry/libs/arm64-v8a"，但那正是 581MB 包的成因：
// place-toolchain 每次跑都往 entry HAP 复制一份 22MB，而端侧 dlopen 用的是共享 HSP 那份，
// entry 侧从来没有消费者（place-toolchain.mjs:466-472 的移除说明 + 产物侧判据
// tools/check-mobile-upgrade-migration.mjs:266「libpython 只随共享 HSP 一份」）。
// 旧断言在 LIBS_ABI 常量被删除后恒红，属门禁欠账，不是产品缺陷。
ok(!place.includes("join(LIBS_ABI, 'libpython3.12.so.1.0')"), 'place-toolchain 不再把 libpython 写进 entry/libs');
ok(place.includes('不再把 libpython 写进 entry/libs'), '移除原因的注释在位（防止照旧实现加回来）');
ok(existsSync(new URL('../hostruntime/libs/arm64-v8a/libpython3.12.so.1.0', import.meta.url)),
  '共享 HSP 里 libpython3.12.so.1.0 在位');
ok(!existsSync(new URL('../entry/libs/arm64-v8a/libpython3.12.so.1.0', import.meta.url)),
  'entry HAP 的 libs 下没有重复的 libpython');

// ── main.js：自检双挂载 + 守卫 + 失败不抛 ──
ok(/let pyBridgeSelftestDone = false;/.test(main), '单次自检 flag');
ok(/function ensurePythonBridge\(\)/.test(main), 'ensurePythonBridge 定义');
ok(main.includes("process.env.DSHM_PYTHON_LIB = libPy"), '调用前设 lib env（addon getenv 读）');
ok(main.includes('process.env.DSHM_PYTHON_HOME = PYTHON_PREFIX'), 'stdlib 根指向解包 prefix');
ok(/if \(!pythonReady\(\)\)/.test(main) && /stdlib 尚未解包就位/.test(main), 'stdlib 未就位守卫（防 Py_Initialize fatal）');
await verifyStartupWork(main);
ok((main.match(/startupWork\.request\('python', ensurePythonBridge, pythonReady\)/g) || []).length === 2, 'boot and extraction queue one deferred Python selftest with stdlib guard');
ok(/if \(pyOk\) \{\s*startupWork\.request\('python', ensurePythonBridge, pythonReady\)/.test(main), 'extraction selftest depends on Python only; production timing and lazy user execution verified');
ok(main.includes("bridge.captureRun('print(1+1)')"), '自检用 captureRun（覆盖捕获链路）');
ok(main.includes('python 桥自检通过') && main.includes('python 桥自检失败'), '成功/失败两分支日志');
ok(/NATIVE_LIBS\.length === 0 \|\| !fs\.existsSync\(NATIVE_LIBS\)/.test(main), 'NATIVE_LIBS 不可用早退（PC 离线正常）');

// ── Phase 2：HTTP 桥端点（/dshm-python/*）──
ok(/function readHostToken\(\)/.test(main), 'readHostToken 定义（host-ready.json 主 token 通道）');
ok(/let pyBridge = null;/.test(main) && /let pyBridgeLoadTried = false;/.test(main), 'pyBridge 模块级缓存 + 单次加载 flag');
ok(/function getPyBridge\(\)/.test(main), 'getPyBridge 定义（HTTP 端点共用入口）');
ok(/function registerPythonHttpBridge\(ctx\)/.test(main), 'registerPythonHttpBridge 定义');
ok(/registerPythonHttpBridge\(ctx\);/.test(main), 'start() 里挂载端点注册');
ok(main.includes("path: '/dshm-python/status'"), 'status 端点（只读，无 token）');
ok(main.includes("path: '/dshm-python/run-get'"), 'run-get 端点（GET 传 code）');
ok(main.includes("path: '/dshm-python/exec'"), 'exec 端点（\\x1f 分隔 argv）');
ok(/code\.length > 65536/.test(main), 'run-get 64KB 上限（413）');
ok(/function pyBridgeTokenOk\(url\)/.test(main) && /charCodeAt\(i\) \^ provided\.charCodeAt\(i\)/.test(main), 'token 常数时间比对');
ok(/function pyBridgeRun\(code, timeoutSec\)/.test(main) && /stdlib not ready/.test(main), '执行守卫：stdlib 未就位直接结构化拒绝（防 Py_Initialize fatal）');
ok(/function pyBridgeTimeoutSec\(url\)/.test(main) && /Math\.min\(300, Math\.max\(1/.test(main), 'timeout 参数解析（默认 120，clamp 1..300）');
ok(main.includes('_dshm_sig.setitimer(_dshm_sig.ITIMER_REAL, ${timeoutSec})') ? false : true, 'prelude 不再用 import-as 绑定（真机嵌入环境 NameError 教训）');
ok(/const prelude = 'try:\\n'/.test(main) && main.includes("'    import signal\\n'") && main.includes('signal.setitimer(signal.ITIMER_REAL, ${timeoutSec})'), 'SIGALRM 超时注入（防御式 try + 全限定，同步 NAPI 卡死教训）');
ok(main.includes("'except BaseException as _e:") && main.includes('signal timeout unavailable'), 'prelude import 失败降级为无超时（不挡桥可用）');
ok(/ErrPrint\(\);\s*\r?\n\s*if \(g_py\.GILRelease\) g_py\.GILRelease\(gilState\);\s*\r?\n\s*if \(rc != 0\)/.test(cpp), 'RunString：ErrPrint 在 GIL 释放前（GIL fatal 教训，2026-09-23 真机实证：清 itimer NameError → ErrPrint 在 GILRelease 后 → 进程 fatal）');
ok(main.includes('raise SystemExit(124)'), '超时 handler 抛 SystemExit(124)（captureRun 捕获，不逃逸）');
ok(/ITIMER_REAL, 0\)/.test(main) && /统一清 itimer/.test(main), '请求后统一清 itimer（防 pending alarm 误杀下一请求）');
ok(main.includes('pyBridgeRun(code, pyBridgeTimeoutSec(url))') && main.includes('pyBridgeRun(setArgv + code, pyBridgeTimeoutSec(url))'), 'run-get/exec 端点均传 timeout');
ok(main.includes("argvRaw.split('\\x1f')"), 'exec 按 \\x1f 切分 argv');
ok(main.includes('runpy._run_module_as_main('), 'exec -m 分支走 runpy');
ok(/\['python3'\]\.concat\(argv\.slice\(2\)\)/.test(main), 'exec -m 的 argvHead 不含 MOD 名（runpy 只改 argv[0]）');
ok(/function pyBridgePathInsideSandbox\(abs\)/.test(main), 'exec 脚本路径沙箱树限制');
ok(/sys\.argv = __dshm_argv/.test(main), 'exec sys.argv 对齐真 python3');

// ── Phase 2：python3/pip3 垫片桥模式 ──
ok(/function pythonBridgeShimLines\(label, usage, pipMode\)/.test(main), 'pythonBridgeShimLines 生成器定义');
ok(main.includes('TOKEN="${DSHM_PYTHON_TOKEN:-}"'), '垫片 token env 快路径');
ok(/host-ready\.json" 2>\/dev\/null/.test(main), '垫片 token 文件回退（host-ready.json 现读，修 DSHM 窗口期缺陷）');
ok(main.includes('ARGQ="$ARGQ%1f$(enc "$a")"'), '垫片 argv %1f 组装');
ok(/wget -O - .*\/dshm-python\/exec\?token=/.test(main), '垫片 wget GET 通道（toybox wget 只能 GET）');
ok(main.includes('|None|0|"0") exit 0'), '垫片 rc 透传（None=成功）');
ok(main.includes('ARGQ="-m%1f$(enc pip)"'), 'pip3 垫片固定 -m pip 前缀');
ok(/\.\.\.\(pipMode \? \[\] : \[/.test(main), 'pip3 垫片不拦截 -V/--version（转发 -m pip --version，真机 banner 疑点修复）');
ok(main.includes('if [ -f "$FIRST" ]; then FIRST="$(pwd)/$FIRST"; fi'), '垫片脚本相对路径 resolve（修 DSHM cwd 错位缺陷）');
ok(/stdin 模式不支持（桥模式）/.test(main), '垫片 stdin 模式明确拒绝');
ok(/桥调用失败（端点不可达或 token 失效/.test(main), '垫片桥失败降级文案');
ok(!/unavailable\('python3'\)/.test(main) && !/unavailable\('pip3'\)/.test(main), 'python3/pip3 wrapper 不再是死路 126（桥回退接管）');

// ── Phase 2：ohos-python.md 文档同步 ──
// 【P0-4 / docs/388】技能文档已单源化到 HSP：运行时 `resRoot/ohos-skills` 就是
// hostruntime 的 resfile，entry 侧副本已删除。门禁必须校验**设备真正读到的那一份**。
const skillDoc = read('../hostruntime/src/main/resources/resfile/ohos-skills/ohos-python.md');
ok(skillDoc.includes('/dshm-python/'), 'skill 文档：/dshm-python 端点');
ok(skillDoc.includes('DSHM_PYTHON_TOKEN'), 'skill 文档：token 双源说明');
ok(skillDoc.includes('python3 -m json.tool'), 'skill 文档：-m 支持已更新（DSHM 版曾标注不支持）');
/*
 * 【2026-09-27 方向翻转】原断言是 `!skillDoc.includes('dshm-python')`，
 * 语义是"清除 DSHM 残留"—— 那是**更早一轮命名**（DSHM → HDSH）留下的守卫。
 *
 * 本轮命名改回 DSHM（HDSH → DSHM），该断言与上一行的
 * `includes('/dshm-python/')` **直接自相矛盾**：改名后必然失败。
 * 守卫意图保留（防止残留旧名），方向翻转到旧名 HDSH 上。
 */
ok(!skillDoc.includes('hdsh-python'), 'skill 文档：不再残留旧端点名 hdsh-python');
ok(/124/.test(skillDoc) && /timeout/.test(skillDoc), 'skill 文档：SIGALRM 超时行为标注');
console.log(`OK：${n} 项断言全过`);
