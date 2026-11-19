/**
 * python_runner —— 内嵌 Python 运行时 NAPI addon。
 *
 * 移植自 DSHM（com.brewdsh.app）同源实现（entry/src/main/cpp/python_runner.cpp，
 * 2026-09 同设备真机实证 ready:true / captureRun 可用），env 前缀由 DSHM_ 改为
 * DSHM_，其余逻辑（GIL 纪律、字符串转义、stdout/stderr 捕获垫片）逐行保留——
 * 那三个坑（裸换行进单引号字面量、NAPI 回调线程不带 GIL 访问 CPython、先
 * GILRelease 再取结果）都是真机上排障过的，注释里的教训不要删。
 *
 * 架构（与本项目 koffi/libsystem 同构）：
 *   - NAPI_MODULE(python_runner, Init) 导出 napi 函数；由宿主 main.js 的
 *     `process.dlopen({exports:{}}, <el1>/libpython_runner.so)` 加载；
 *   - napi_* 符号经 DT_NEEDED libnode.so.137 在链接期解析（E43 教训：libnode
 *     即便 RTLD_GLOBAL 首载也不进后加载模块的可见集，必须写进依赖闭包）；
 *   - 内部 dlopen libpython3.12.so.1.0（el1 bundle libs，随 HAP 打包——resfile/
 *     el2 files/ 实测不可 dlopen，E16/E17b），用 dlsym 取 CPython embedding API，
 *     **不链接 libpython**（musl 构建的 libpython 与 hvigor llvm 链接的 addon 跨
 *     libc，且 el1 路径链接期不可见）；
 *   - CPython 一次初始化（Py_IsInitialized 守卫），Py_SetPythonHome 指向解包到
 *     沙箱的 stdlib；所有 Python 调用受 std::mutex + GIL 保护。
 *
 * 环境变量（由 main.js 的 ensurePythonBridge 在调用导出函数前设置）：
 *   DSHM_PYTHON_LIB  - libpython3.12.so.1.0 的绝对路径（el1 libs）
 *   DSHM_PYTHON_HOME - stdlib 安装根（<sandbox>/toolchain/python，其下
 *                      lib/python3.12/ 为标准库；bin/python3.12 永远 exec 不了
 *                      ——execve 白名单见 main.js E1-E19——但解释器已在本进程内）
 *
 * 导出 API（同步）：
 *   runString(code) / runFile(path) / evalExpr(expr)
 *   captureRun(code): { ok, stdout, errStderr, rc }  —— 主通道
 *   isReady(): { ready, lib, home, initialized }      —— 不触发初始化
 *   version(): { ok, version }
 *
 * 错误处理：所有 Python 异常经 PyErr_Print/Clear 清除，返回 JS 结构化对象，
 * 绝不崩进程（宿主是同进程多线程的 Node，崩了整个应用就没了）。
 */
#define _GNU_SOURCE
#include <node_api.h>
#include <dlfcn.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <mutex>

namespace {

// ── CPython embedding API 函数指针类型 ────────────────────────────────
// 签名取自 CPython 3.12 stable ABI（Include/cpython/init.h / run.h / pythonrun.h）。
typedef void (*Py_Initialize_t)(void);
typedef int  (*Py_IsInitialized_t)(void);
typedef void (*Py_Finalize_t)(void);
typedef int  (*PyRun_SimpleString_t)(const char*);
typedef int  (*PyRun_SimpleFile_t)(FILE*, const char*);
typedef void (*Py_SetPythonHome_t)(const wchar_t*);
typedef void (*Py_SetProgramName_t)(const wchar_t*);
typedef void (*PySys_SetArgv_t)(int, wchar_t**);
typedef void (*Py_Exit_t)(int);
typedef void (*PyErr_Print_t)(void);
typedef void (*PyErr_Clear_t)(void);
// GIL 管理（CPython 多线程访问必需）
typedef unsigned long (*PyGILState_Ensure_t)(void);  // 返回 PyGILState_STATE
typedef void (*PyGILState_Release_t)(unsigned long);
typedef void* (*PyEval_SaveThread_t)(void);  // 返回 PyThreadState*
typedef void (*PyEval_RestoreThread_t)(void*);
typedef void (*PyEval_InitThreads_t)(void);
// PyObject 相关（用于 evalExpr / captureRun）
typedef void* (*PyImport_ImportModule_t)(const char*);
typedef void* (*PyObject_GetAttrString_t)(void*, const char*);
typedef void* (*PyObject_CallObject_t)(void*, void*);
typedef void* (*PyObject_Str_t)(void*);
typedef void* (*PyObject_Repr_t)(void*);
typedef void  (*Py_DecRef_t)(void*);
typedef void* (*PyUnicode_AsUTF8_t)(void*);
typedef void* (*PyDict_GetItemString_t)(void*, const char*);
typedef void* (*PyModule_GetDict_t)(void*);
typedef void  (*PyObject_Print_t)(void*, void*, int);

// 捕获的函数指针（dlopen 后填充）
struct PyAPI {
    void* handle = nullptr;
    Py_Initialize_t          Initialize = nullptr;
    Py_IsInitialized_t       IsInitialized = nullptr;
    Py_Finalize_t            Finalize = nullptr;
    PyRun_SimpleString_t     RunSimpleString = nullptr;
    PyRun_SimpleFile_t       RunSimpleFile = nullptr;
    Py_SetPythonHome_t       SetPythonHome = nullptr;
    Py_SetProgramName_t      SetProgramName = nullptr;
    PySys_SetArgv_t          SysSetArgv = nullptr;
    Py_Exit_t                Exit = nullptr;
    PyErr_Print_t            ErrPrint = nullptr;
    PyErr_Clear_t            ErrClear = nullptr;
    PyGILState_Ensure_t      GILEnsure = nullptr;
    PyGILState_Release_t     GILRelease = nullptr;
    PyEval_SaveThread_t      EvalSaveThread = nullptr;
    PyEval_RestoreThread_t   EvalRestoreThread = nullptr;
    PyEval_InitThreads_t     EvalInitThreads = nullptr;
    PyImport_ImportModule_t  ImportModule = nullptr;
    PyObject_GetAttrString_t GetAttrString = nullptr;
    PyObject_CallObject_t    CallObject = nullptr;
    PyObject_Str_t           Str = nullptr;
    PyObject_Repr_t          Repr = nullptr;
    Py_DecRef_t              DecRef = nullptr;
    PyUnicode_AsUTF8_t       UnicodeAsUTF8 = nullptr;
    PyDict_GetItemString_t   DictGetItemString = nullptr;
    PyModule_GetDict_t       ModuleGetDict = nullptr;
    PyObject_Print_t         ObjectPrint = nullptr;
};

PyAPI g_py;
std::mutex g_mu;
bool g_loadAttempted = false;
bool g_loaded = false;
bool g_initialized = false;

// ── dlopen libpython + dlsym 取 API ──────────────────────────────────
// 返回空字符串表示成功；失败返回原因。
std::string LoadPython() {
    if (g_loadAttempted) {
        return g_loaded ? "" : "python lib load already failed";
    }
    g_loadAttempted = true;

    const char* libPath = std::getenv("DSHM_PYTHON_LIB");
    if (libPath == nullptr || libPath[0] == '\0') {
        return "DSHM_PYTHON_LIB 未设置";
    }
    // RTLD_GLOBAL: 让 Python 的 C 扩展模块（若 dlopen）能解析 libpython 符号。
    // RTLD_NOW: 立即解析所有符号，避免运行时随机 symbol-not-found。
    void* h = dlopen(libPath, RTLD_NOW | RTLD_GLOBAL);
    if (h == nullptr) {
        const char* err = dlerror();
        return std::string("dlopen libpython 失败: ") + (err ? err : libPath);
    }
    g_py.handle = h;

    // 显式 dlsym 取每个 API（不用宏：typedef 名与字段名前缀不一致，宏的 token-paste
    // 会拼错类型名）。reinterpret_cast 从 void* 到函数指针是 POSIX dlsym 的标准用法。
    dlerror(); // 清空错误
    auto loadSym = [h](const char* sym) -> void* {
        void* p = dlsym(h, sym);
        if (p == nullptr) {
            const char* e = dlerror();
            fprintf(stderr, "[python_runner] dlsym %s 失败: %s\n", sym, e ? e : "(null)");
        }
        return p;
    };

    g_py.Initialize        = reinterpret_cast<Py_Initialize_t>(loadSym("Py_Initialize"));
    g_py.IsInitialized     = reinterpret_cast<Py_IsInitialized_t>(loadSym("Py_IsInitialized"));
    g_py.Finalize          = reinterpret_cast<Py_Finalize_t>(loadSym("Py_Finalize"));
    g_py.RunSimpleString   = reinterpret_cast<PyRun_SimpleString_t>(loadSym("PyRun_SimpleString"));
    g_py.RunSimpleFile     = reinterpret_cast<PyRun_SimpleFile_t>(loadSym("PyRun_SimpleFile"));
    g_py.SetPythonHome     = reinterpret_cast<Py_SetPythonHome_t>(loadSym("Py_SetPythonHome"));
    g_py.SetProgramName    = reinterpret_cast<Py_SetProgramName_t>(loadSym("Py_SetProgramName"));
    g_py.SysSetArgv        = reinterpret_cast<PySys_SetArgv_t>(loadSym("PySys_SetArgv"));
    g_py.Exit              = reinterpret_cast<Py_Exit_t>(loadSym("Py_Exit"));
    g_py.ErrPrint          = reinterpret_cast<PyErr_Print_t>(loadSym("PyErr_Print"));
    g_py.ErrClear          = reinterpret_cast<PyErr_Clear_t>(loadSym("PyErr_Clear"));
    g_py.GILEnsure         = reinterpret_cast<PyGILState_Ensure_t>(loadSym("PyGILState_Ensure"));
    g_py.GILRelease        = reinterpret_cast<PyGILState_Release_t>(loadSym("PyGILState_Release"));
    g_py.EvalSaveThread    = reinterpret_cast<PyEval_SaveThread_t>(loadSym("PyEval_SaveThread"));
    g_py.EvalRestoreThread = reinterpret_cast<PyEval_RestoreThread_t>(loadSym("PyEval_RestoreThread"));
    g_py.EvalInitThreads   = reinterpret_cast<PyEval_InitThreads_t>(loadSym("PyEval_InitThreads"));
    g_py.ImportModule      = reinterpret_cast<PyImport_ImportModule_t>(loadSym("PyImport_ImportModule"));
    g_py.GetAttrString     = reinterpret_cast<PyObject_GetAttrString_t>(loadSym("PyObject_GetAttrString"));
    g_py.CallObject        = reinterpret_cast<PyObject_CallObject_t>(loadSym("PyObject_CallObject"));
    g_py.Str               = reinterpret_cast<PyObject_Str_t>(loadSym("PyObject_Str"));
    g_py.Repr              = reinterpret_cast<PyObject_Repr_t>(loadSym("PyObject_Repr"));
    g_py.DecRef            = reinterpret_cast<Py_DecRef_t>(loadSym("Py_DecRef"));
    g_py.UnicodeAsUTF8     = reinterpret_cast<PyUnicode_AsUTF8_t>(loadSym("PyUnicode_AsUTF8"));
    g_py.DictGetItemString = reinterpret_cast<PyDict_GetItemString_t>(loadSym("PyDict_GetItemString"));
    g_py.ModuleGetDict     = reinterpret_cast<PyModule_GetDict_t>(loadSym("PyModule_GetDict"));
    g_py.ObjectPrint       = reinterpret_cast<PyObject_Print_t>(loadSym("PyObject_Print"));

    // 校验：初始化与运行所必需的符号必须全部命中（其余可选）。
    if (g_py.Initialize == nullptr || g_py.IsInitialized == nullptr ||
        g_py.RunSimpleString == nullptr || g_py.SetPythonHome == nullptr) {
        return "libpython 缺少必需 embedding API 符号";
    }

    g_loaded = true;
    return "";
}

// ── 初始化 Python（幂等）──────────────────────────────────────────────
// 成功返回空串；失败返回原因。持有 g_mu。
std::string EnsurePythonInit() {
    if (!g_loaded) {
        std::string e = LoadPython();
        if (!e.empty()) {
            fprintf(stderr, "[python_runner] LoadPython failed: %s\n", e.c_str()); fflush(stderr);
            return e;
        }
    }
    if (g_initialized) return "";

    // Py_SetPythonHome 必须在 Py_Initialize 之前调用。
    // home 是 stdlib 安装根（<sandbox>/toolchain/python），Python 据此找
    // lib/python3.12；不设的话 Py_Initialize 找不到标准库直接 fatal。
    const char* home = std::getenv("DSHM_PYTHON_HOME");
    if (home != nullptr && home[0] != '\0' && g_py.SetPythonHome != nullptr) {
        // Py_SetPythonHome 接受 wchar_t*；musl locale 下 wchar_t = 4 字节。
        // 对纯 ASCII 路径，直接扩展为 wchar_t 等价于 UTF-32 ASCII。
        std::wstring whome(home, home + std::strlen(home));
        g_py.SetPythonHome(whome.c_str());
    }
    // 设置程序名（避免 Python 在 argv[0] 里看到 "node"）
    if (g_py.SetProgramName != nullptr) {
        const wchar_t* prog = L"python3";
        g_py.SetProgramName(prog);
    }

    g_py.Initialize();
    // 标记初始化完成；即使后续报错也认为已初始化过（CPython 只能 init 一次）。
    g_initialized = (g_py.IsInitialized && g_py.IsInitialized() != 0);

    if (!g_initialized) {
        return "Py_Initialize 后 IsInitialized 仍为 0";
    }
    // 初始化后立即导出全局 print 重定向垫片，供 captureRun 使用。
    const char* bootstrap =
        "import io, sys\n"
        "class _DshmCap(io.StringIO):\n"
        "    pass\n"
        "_dshm_cap_buf = None\n"
        "def _dshm_redirect_stdout():\n"
        "    global _dshm_cap_buf\n"
        "    _dshm_cap_buf = _DshmCap()\n"
        "    sys.stdout = _dshm_cap_buf\n"
        "def _dshm_restore_stdout():\n"
        "    global _dshm_cap_buf\n"
        "    if _dshm_cap_buf is not None:\n"
        "        sys.stdout = sys.__stdout__\n"
        "def _dshm_get_captured():\n"
        "    global _dshm_cap_buf\n"
        "    v = _dshm_cap_buf.getvalue() if _dshm_cap_buf is not None else ''\n"
        "    return v\n";
    if (g_py.RunSimpleString) {
        g_py.RunSimpleString(bootstrap);
    }
    // stderr 重定向垫片：捕获 traceback 等错误输出
    const char* bootstrapStderr =
        "class _DshmCapErr(io.StringIO):\n"
        "    pass\n"
        "_dshm_cap_err_buf = None\n"
        "def _dshm_redirect_stderr():\n"
        "    global _dshm_cap_err_buf\n"
        "    _dshm_cap_err_buf = _DshmCapErr()\n"
        "    sys.stderr = _dshm_cap_err_buf\n"
        "def _dshm_restore_stderr():\n"
        "    global _dshm_cap_err_buf\n"
        "    if _dshm_cap_err_buf is not None:\n"
        "        sys.stderr = sys.__stderr__\n"
        "def _dshm_get_captured_err():\n"
        "    global _dshm_cap_err_buf\n"
        "    v = _dshm_cap_err_buf.getvalue() if _dshm_cap_err_buf is not None else ''\n"
        "    return v\n";
    if (g_py.RunSimpleString) {
        g_py.RunSimpleString(bootstrapStderr);
    }
    // 释放 GIL：Py_Initialize 后主线程持有 GIL。NAPI 的后续调用可能来自
    // node 的 libuv 工作线程，不持有 GIL 直接调 CPython 会崩（无 GIL 守护
    // 下访问解释器状态是未定义行为）。PyEval_SaveThread 释放 GIL 并保存
    // 线程状态；后续每个 NAPI 函数用 PyGILState_Ensure/Release 获取释放。
    if (g_py.EvalSaveThread) {
        g_py.EvalSaveThread();
    }
    return "";
}

// ── NAPI helper：构造返回对象 ─────────────────────────────────────────
static napi_value MakeObj(napi_env env, bool ok, const std::string& err = "",
                          const std::string& valKey = "", const std::string& val = "") {
    napi_value obj;
    napi_create_object(env, &obj);
    napi_value okv;
    napi_get_boolean(env, ok, &okv);
    napi_set_named_property(env, obj, "ok", okv);
    if (!err.empty()) {
        napi_value ev;
        napi_create_string_utf8(env, err.c_str(), NAPI_AUTO_LENGTH, &ev);
        napi_set_named_property(env, obj, "error", ev);
    }
    if (!valKey.empty() && !val.empty()) {
        napi_value vv;
        napi_create_string_utf8(env, val.c_str(), NAPI_AUTO_LENGTH, &vv);
        napi_set_named_property(env, obj, valKey.c_str(), vv);
    }
    return obj;
}

/**
 * 把任意字节串转成 Python 单引号字符串字面量的**内容**（不含首尾引号）。
 * 所有「拼 Python 源码 + 嵌入用户数据」的路径必须经此函数，禁止手写循环转义。
 *
 * 历史教训（DSHM 两个同源 bug）：EvalExpr 与 CaptureRun 曾各自手写"只转义
 * \\ 和 '"的循环，均漏掉真实换行符 —— Python 单引号字符串不允许跨行，用户
 * 代码含 \n 即产生 `SyntaxError: unterminated string literal`，症状被误判为
 * "lxml C 扩展 dlopen 失败"排障了一整轮。规则：新代码不得再手写转义。
 */
static void AppendPyStringLiteral(std::string& out, const char* data, size_t len) {
    for (size_t i = 0; i < len; ++i) {
        char c = data[i];
        if (c == '\\') out += "\\\\";
        else if (c == '\'') out += "\\'";
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else if ((unsigned char)c < 0x20) {
            char buf[8];
            snprintf(buf, sizeof(buf), "\\x%02x", (unsigned char)c);
            out += buf;
        } else {
            out += c;
        }
    }
}

// ── 导出函数实现 ─────────────────────────────────────────────────────

/** runString(code) —— 运行任意 Python 代码（PyRun_SimpleString），无返回值。 */
static napi_value RunString(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) {
        return MakeObj(env, false, "runString(code) 需要 code 参数");
    }
    size_t len = 0;
    napi_get_value_string_utf8(env, argv[0], nullptr, 0, &len);
    if (len == 0) {
        return MakeObj(env, false, "code 不能为空");
    }
    std::vector<char> code(len + 1);
    napi_get_value_string_utf8(env, argv[0], code.data(), len + 1, &len);

    std::lock_guard<std::mutex> lk(g_mu);
    std::string e = EnsurePythonInit();
    if (!e.empty()) return MakeObj(env, false, e);

    // 获取 GIL（NAPI 调用可能来自 libuv 线程，不持有 GIL）
    unsigned long gilState = 0;
    if (g_py.GILEnsure) gilState = g_py.GILEnsure();
    int rc = g_py.RunSimpleString(code.data());
    // ErrPrint 必须在 GILRelease 之前：释放后调 CPython API = fatal
    // （真机 2026-09-23 实证：清 itimer 的 runString 遇 NameError → ErrPrint 在
    //  GILRelease 之后 → "_Py_GetConfig: GIL is released" fatal 整个进程）。
    if (rc != 0 && g_py.ErrPrint) g_py.ErrPrint();
    if (g_py.GILRelease) g_py.GILRelease(gilState);
    if (rc != 0) {
        return MakeObj(env, false, "PyRun_SimpleString 返回非零（Python 异常）");
    }
    return MakeObj(env, true);
}

/** runFile(path) —— 运行一个 .py 文件（PyRun_SimpleFile）。 */
static napi_value RunFile(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) {
        return MakeObj(env, false, "runFile(path) 需要 path 参数");
    }
    size_t len = 0;
    napi_get_value_string_utf8(env, argv[0], nullptr, 0, &len);
    if (len == 0) {
        return MakeObj(env, false, "path 不能为空");
    }
    std::vector<char> path(len + 1);
    napi_get_value_string_utf8(env, argv[0], path.data(), len + 1, &len);

    std::lock_guard<std::mutex> lk(g_mu);
    std::string e = EnsurePythonInit();
    if (!e.empty()) return MakeObj(env, false, e);

    FILE* fp = fopen(path.data(), "rb");
    if (fp == nullptr) {
        return MakeObj(env, false, std::string("无法打开文件: ") + path.data());
    }
    unsigned long gilState = 0;
    if (g_py.GILEnsure) gilState = g_py.GILEnsure();
    int rc = g_py.RunSimpleFile(fp, path.data());
    if (g_py.GILRelease) g_py.GILRelease(gilState);
    fclose(fp);
    if (rc != 0) {
        if (g_py.ErrPrint) g_py.ErrPrint();
        return MakeObj(env, false, "PyRun_SimpleFile 返回非零（Python 异常）");
    }
    return MakeObj(env, true);
}

/**
 * evalExpr(expr) —— 求值表达式并返回 repr 字符串。
 * 经 PyRun_SimpleString 桥接：__dshm_ret = eval(...); repr(__dshm_ret)，
 * 再从 __main__ 取 __dshm_repr。不走 PyObject_Call*，减少符号依赖。
 * （DSHM 历史实现曾 ImportModule("builtins")+GetAttrString 取 eval/repr
 *   引用却从未使用且漏 DecRef —— 每次调用泄漏两个引用计数，已删。）
 */
static napi_value EvalExpr(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) {
        return MakeObj(env, false, "evalExpr(expr) 需要 expr 参数");
    }
    size_t len = 0;
    napi_get_value_string_utf8(env, argv[0], nullptr, 0, &len);
    if (len == 0) {
        return MakeObj(env, false, "expr 不能为空");
    }
    std::vector<char> expr(len + 1);
    napi_get_value_string_utf8(env, argv[0], expr.data(), len + 1, &len);

    std::lock_guard<std::mutex> lk(g_mu);
    std::string e = EnsurePythonInit();
    if (!e.empty()) return MakeObj(env, false, e);

    unsigned long gilState = 0;
    if (g_py.GILEnsure) gilState = g_py.GILEnsure();

    // 拼接：import builtins; __dshm_ret = eval('<escaped>'); __dshm_repr = repr(ret)
    // 转义必须走 AppendPyStringLiteral（见其注释里的历史教训）。
    std::string script = "import builtins\n__dshm_ret = builtins.eval('";
    script.reserve(expr.size() * 2 + 32);
    AppendPyStringLiteral(script, expr.data(), len);
    script += "')\n"
              "__dshm_repr = builtins.repr(__dshm_ret)\n";
    int rc = g_py.RunSimpleString(script.c_str());
    if (rc != 0) {
        if (g_py.ErrClear) g_py.ErrClear();
        if (g_py.GILRelease) g_py.GILRelease(gilState);
        return MakeObj(env, false, "eval 执行失败（Python 异常）");
    }
    // 从 __main__ 取 __dshm_repr（字符串）。所有 CPython 访问在 GIL 内完成。
    std::string out;
    void* mainmod = g_py.ImportModule("__main__");
    if (mainmod != nullptr) {
        void* mdict = g_py.ModuleGetDict(mainmod);
        void* reprObj = g_py.DictGetItemString(mdict, "__dshm_repr");
        const char* s = reprObj ? reinterpret_cast<const char*>(g_py.UnicodeAsUTF8(reprObj)) : nullptr;
        out = s ? s : "";
        if (g_py.DecRef) g_py.DecRef(mainmod);
    }
    if (g_py.GILRelease) g_py.GILRelease(gilState);
    if (out.empty()) {
        return MakeObj(env, false, "取 __dshm_repr 失败");
    }
    return MakeObj(env, true, "", "value", out);
}

/**
 * captureRun(code) —— 运行代码并捕获 stdout/stderr。
 * 用引导时注入的 _dshm_redirect/restore/get_captured 重定向。
 */
static napi_value CaptureRun(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) {
        return MakeObj(env, false, "captureRun(code) 需要 code 参数");
    }
    size_t len = 0;
    napi_get_value_string_utf8(env, argv[0], nullptr, 0, &len);
    if (len == 0) {
        return MakeObj(env, false, "code 不能为空");
    }
    std::vector<char> code(len + 1);
    napi_get_value_string_utf8(env, argv[0], code.data(), len + 1, &len);

    std::lock_guard<std::mutex> lk(g_mu);
    std::string e = EnsurePythonInit();
    if (!e.empty()) return MakeObj(env, false, e);

    unsigned long gilState = 0;
    if (g_py.GILEnsure) gilState = g_py.GILEnsure();

    // 重定向 -> 跑代码 -> 取捕获 -> 恢复
    // __dshm_rc_repr：把退出码（None 或 int）转成字符串供 C++ 读（避免新增
    // PyLong 符号依赖）；SystemExit(code) 与未捕获异常都落成非 None 值。
    std::string wrap = "_dshm_redirect_stdout()\n"
                       "_dshm_redirect_stderr()\n"
                       "__dshm_rc = None\n"
                       "try:\n"
                       "    exec(__dshm_user_code)\n"
                       "except SystemExit as _e:\n"
                       "    __dshm_rc = _e.code\n"
                       "except BaseException as _e:\n"
                       "    import traceback; traceback.print_exc()\n"
                       "    __dshm_rc = 1\n"
                       "_dshm_restore_stdout()\n"
                       "_dshm_restore_stderr()\n"
                       "__dshm_rc_repr = repr(__dshm_rc)\n";
    // 把用户代码作为 Python 字符串字面量注入到 __dshm_user_code。
    // 转义必须走 AppendPyStringLiteral（历史教训见其函数注释）。
    std::string setup = "__dshm_user_code = '";
    setup.reserve(code.size() * 2 + 16);
    AppendPyStringLiteral(setup, code.data(), len);
    setup += "'\n";
    std::string full = setup + wrap;
    int rc = g_py.RunSimpleString(full.c_str());
    // ── 提取结果（全部 CPython 访问必须在 GIL 内完成）────────────────────
    // 历史教训（DSHM 两轮 GIL bug，勿再犯）：
    //   1) NAPI 回调线程不带 GIL 直接调 CPython = 未定义行为（进程静默崩）；
    //   2) 本函数曾先 GILRelease 再 ImportModule/RunSimpleString —— 同源问题。
    // 规则：先在 GIL 内把 stdout/stderr 取到 std::string，再 GILRelease；
    // napi_* 构造 JS 对象不碰 CPython，放在释放之后。
    if (rc != 0) {
        // 失败也要恢复 stdout/stderr 重定向状态、清异常标志（GIL 内）。
        // 不走 ErrPrint：stderr 已被重定向到 StringIO，print 会污染下次捕获。
        g_py.RunSimpleString("_dshm_restore_stdout()\n_dshm_restore_stderr()\n");
        if (g_py.ErrClear) g_py.ErrClear();
    }
    std::string out, outErr, rcRepr("None");
    void* mm = g_py.ImportModule("__main__");
    if (mm != nullptr) {
        void* md = g_py.ModuleGetDict(mm);
        g_py.RunSimpleString("__dshm_captured = _dshm_get_captured()\n");
        void* cs = g_py.DictGetItemString(md, "__dshm_captured");
        const char* s = cs ? reinterpret_cast<const char*>(g_py.UnicodeAsUTF8(cs)) : nullptr;
        out = s ? s : "";
        g_py.RunSimpleString("__dshm_captured_err = _dshm_get_captured_err()\n");
        void* cse = g_py.DictGetItemString(md, "__dshm_captured_err");
        const char* se = cse ? reinterpret_cast<const char*>(g_py.UnicodeAsUTF8(cse)) : nullptr;
        outErr = se ? se : "";
        void* rcObj = g_py.DictGetItemString(md, "__dshm_rc_repr");
        const char* rs = rcObj ? reinterpret_cast<const char*>(g_py.UnicodeAsUTF8(rcObj)) : nullptr;
        if (rs != nullptr) rcRepr = rs;
        if (g_py.DecRef) g_py.DecRef(mm);
    }
    // GIL 释放点：此后不得再触碰任何 CPython API。
    if (g_py.GILRelease) g_py.GILRelease(gilState);

    napi_value obj = MakeObj(env, rc == 0,
                            rc == 0 ? "" : "captureRun 执行失败（Python 异常）",
                            "stdout", out);
    napi_value ev;
    napi_create_string_utf8(env, outErr.c_str(), NAPI_AUTO_LENGTH, &ev);
    napi_set_named_property(env, obj, "errStderr", ev);
    // 退出码透传：正常完成 "None"，sys.exit(N)/异常 是 N（repr 字符串）。
    napi_value rv;
    napi_create_string_utf8(env, rcRepr.c_str(), NAPI_AUTO_LENGTH, &rv);
    napi_set_named_property(env, obj, "rc", rv);
    return obj;
}

/** isReady() —— 探测环境是否就位（不触发初始化）。 */
static napi_value IsReady(napi_env env, napi_callback_info info) {
    const char* lib = std::getenv("DSHM_PYTHON_LIB");
    const char* home = std::getenv("DSHM_PYTHON_HOME");
    napi_value obj;
    napi_create_object(env, &obj);
    napi_value rv;
    napi_get_boolean(env, lib != nullptr && home != nullptr && lib[0] && home[0], &rv);
    napi_set_named_property(env, obj, "ready", rv);
    if (lib != nullptr) {
        napi_value lv;
        napi_create_string_utf8(env, lib, NAPI_AUTO_LENGTH, &lv);
        napi_set_named_property(env, obj, "lib", lv);
    }
    if (home != nullptr) {
        napi_value hv;
        napi_create_string_utf8(env, home, NAPI_AUTO_LENGTH, &hv);
        napi_set_named_property(env, obj, "home", hv);
    }
    napi_value iv;
    napi_get_boolean(env, g_initialized, &iv);
    napi_set_named_property(env, obj, "initialized", iv);
    return obj;
}

/** version() —— 返回 Python 版本（sys.version）。 */
static napi_value Version(napi_env env, napi_callback_info info) {
    std::lock_guard<std::mutex> lk(g_mu);
    std::string e = EnsurePythonInit();
    if (!e.empty()) return MakeObj(env, false, e);

    unsigned long gilState = 0;
    if (g_py.GILEnsure) gilState = g_py.GILEnsure();

    // 注入到 __main__.__dshm_ver 并取回
    g_py.RunSimpleString(
        "import sys\n"
        "__dshm_ver = sys.version\n");
    void* mainmod = g_py.ImportModule("__main__");
    if (mainmod == nullptr) {
        if (g_py.GILRelease) g_py.GILRelease(gilState);
        return MakeObj(env, false, "import __main__ 失败");
    }
    void* mdict = g_py.ModuleGetDict(mainmod);
    void* verObj = g_py.DictGetItemString(mdict, "__dshm_ver");
    const char* s = verObj ? reinterpret_cast<const char*>(g_py.UnicodeAsUTF8(verObj)) : nullptr;
    std::string out = s ? s : "";
    if (mainmod && g_py.DecRef) g_py.DecRef(mainmod);
    if (g_py.GILRelease) g_py.GILRelease(gilState);
    return MakeObj(env, true, "", "version", out);
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor descs[] = {
        {"runString",   nullptr, RunString,   nullptr, nullptr, nullptr, napi_default, nullptr},
        {"runFile",     nullptr, RunFile,     nullptr, nullptr, nullptr, napi_default, nullptr},
        {"evalExpr",    nullptr, EvalExpr,    nullptr, nullptr, nullptr, napi_default, nullptr},
        {"captureRun",  nullptr, CaptureRun,  nullptr, nullptr, nullptr, napi_default, nullptr},
        {"isReady",     nullptr, IsReady,     nullptr, nullptr, nullptr, napi_default, nullptr},
        {"version",     nullptr, Version,     nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(descs) / sizeof(descs[0]), descs);
    return exports;
}

}  // namespace

NAPI_MODULE(python_runner, Init)
