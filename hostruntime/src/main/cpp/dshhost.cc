// dshhost —— 端侧 Node 运行时的 NAPI 引导模块（阶段二）
//
// 角色：把 libnode.so 里的 Node 在同一进程内起起来，供 ArkTS 侧调用。
// 它**只做引导**，不做协议、不碰 dsh：dsh 的 Host 由 Node 侧脚本
// （hostcore/app/main.js）在 loopback 上起，ArkTS 仍按既有 HTTP/WS 协议说话。
// 这样"运行时载体"换了，上面的客户端一行都不用改。
//
// 为什么同进程而不是 fork/exec：
//   鸿蒙手机**禁止三方应用 fork/创建进程**（D6 E15，childProcessManager 仅平板/PC-2in1）。
//   同进程加载 libnode.so 是四条形态唯一共同可行的路径。
//
// 已知边界（不要以为已经解决）：
//   1. **无法从外部线程安全停止进程内 Node**。node::Start 是阻塞的，唯一的正路是在
//      Node 线程内部持一个 uv_async 句柄并调用 node::Stop(env)。那需要先拿到 env，
//      属于下一步；现在 stopHost() 如实返回"做不到"，不假装成功。
//   2. node::Start 会走 uv_setup_args 并尝试确定 process.execPath。鸿蒙沙箱下
//      /proc/self/exe 未必可用，process.execPath 可能为空——**必须上设备验证**。
//   3. libnode.so 必须随 HAP 打包且已签名（D6 E14），热更新的 .so 会被系统拦截。
//   4. 本项目统一 jitless（不申请 ALLOW_WRITABLE_CODE_MEMORY），因此 argv 里必须带
//      --jitless；否则 V8 会在初始化时申请可写可执行内存而被拦。
//
// 编译验证：`bash tools/node-runtime/build-dshhost.sh --compile-only`
//   （只编译不链接，因此不需要 libnode.so 存在）

#include <node_api.h>
// 【为什么**不** include <node.h>】（2026-09-20 实测）
//   `node.h` 会拉进 v8 全套头文件；Node 26.x 的 `v8.h` 依赖 C++20 库头 <source_location>，
//   而 OHOS SDK 的 libc++ 不提供它 ⇒ `fatal error: 'source_location' file not found`。
//   本文件**只**通过 dlsym 取 `node::Start`（mangled `_ZN4node5StartEiPPc`），
//   不引用任何 `node::` / `v8::` 类型或符号，因此不需要 node.h 的类型声明。
//   需要的宏（NODE_VERSION_STRING）由 <node_version.h> 提供，它不依赖 v8。
#include <node_version.h>
#include <hilog/log.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

/*
 * 【诊断/候选修复】由本 .so 提供 `napi_fatal_error` 的定义。
 *
 * 背景（真机读数）：koffi 的 .node 加载时报
 *     Error relocating …/libs/arm64/libkoffi.so: napi_fatal_error: symbol not found
 * 而 libkoffi.so 需要 84 个 `napi_*`，**只有这一个**解析不到 ⇒ 进程全局作用域里确实有一个
 * `napi_*` 提供者（其余 83 个都来自它），但它缺这一个符号。
 *
 * 本定义同时充当**探针**：构造函数里的 diag1 会 `dlsym(RTLD_DEFAULT, "napi_fatal_error")`
 * 并用 `dladdr` 打印提供者路径。据此可一次判别三种可能：
 *   · 提供者 = libdshhost.so → 本 .so 的符号在全局作用域 ⇒ 在这里补齐缺失符号即可修好 koffi；
 *   · 提供者 = libnode.so.127 → libnode 已全局可见，失败另有原因（需再查加载标志）；
 *   · 返回 null            → 本 .so 与 libnode 都不在全局作用域，只能靠依赖闭包（DT_NEEDED）解决。
 * 语义与 Node 一致：打印后 abort（`napi_fatal_error` 本就是不可恢复错误）。
 */
extern "C" __attribute__((visibility("default"))) void napi_fatal_error(
    const char* location, size_t location_len, const char* message, size_t message_len) {
  (void)location_len;
  (void)message_len;
  OH_LOG_Print(LOG_APP, LOG_FATAL, 0x0000, "DSHM-SHIM",
               "napi_fatal_error: %{public}s | %{public}s",
               location != nullptr ? location : "(null)",
               message != nullptr ? message : "(null)");
  ::abort();
}

namespace {

// Node 线程与它的 argv。argv 必须活到线程结束，所以放静态存储。
std::thread g_nodeThread;
std::atomic<bool> g_running{false};
std::atomic<bool> g_started{false};
std::vector<std::string> g_argStore;
std::vector<char*> g_argv;

/*
 * libnode 的句柄与 `node::Start` 的函数指针。
 *
 * 【为什么要 dlsym 而不是直接调 `node::Start`】见构造函数里的说明：为了让 libnode 的符号
 * 从一开始就进**全局作用域**（后续 dlopen 的 `.node` 模块要解析 `napi_*`），libdshhost
 * **不能**在 `DT_NEEDED` 里带 libnode —— 一旦带了，它就会被动态加载器以**局部作用域**先载入，
 * 之后再 dlopen 提升为 RTLD_GLOBAL 在 musl 上无效（实测：返回 ok 但符号依然解析不到）。
 */
void* g_libnode = nullptr;
using NodeStartFn = int (*)(int, char*[]);
NodeStartFn g_nodeStart = nullptr;

void SetString(napi_env env, napi_value obj, const char* key, const std::string& value) {
  napi_value v = nullptr;
  napi_create_string_utf8(env, value.c_str(), value.length(), &v);
  napi_set_named_property(env, obj, key, v);
}

void SetBool(napi_env env, napi_value obj, const char* key, bool value) {
  napi_value v = nullptr;
  napi_get_boolean(env, value, &v);
  napi_set_named_property(env, obj, key, v);
}

/**
 * runtimeVersion(): 返回编译进 libnode.so 的 Node 版本。
 * 只要这个函数返回了非空字符串，就证明"模块加载成功且与 libnode 链接在一起了"——
 * 这是端侧"运行时是否真的可用"的第一条可观测证据（第二条是 Host 真的起来）。
 */
napi_value RuntimeVersion(napi_env env, napi_callback_info info) {
  napi_value out = nullptr;
  napi_create_string_utf8(env, NODE_VERSION_STRING, NAPI_AUTO_LENGTH, &out);
  return out;
}

/**
 * startHost(argv: string[], envPairs: string[]): { started: boolean, note: string }
 *
 * 在独立线程里跑 node::Start（阻塞）。**同一个进程只能起一次**：第二次调用返回
 * started=false 并说明原因，而不是偷偷再起一个（那样会有两个 Host 抢同一个端口）。
 *
 * 【为什么需要 envPairs】端侧 Host 的配置通道**是环境变量，不是 argv**：
 * hostcore/app/main.js 读的是 DSHM_CORE_DIR / DSHM_HOME / DSHM_SANDBOX_HOME /
 * DSHM_PORT / DSHM_PROFILE，而 ArkTS 侧**没有任何办法设置原生进程的环境变量**。
 * 所以必须由这里在 node::Start 之前 setenv()。
 * 取"KEY=VALUE"字符串数组而不是两个平行数组：无需在两端各自维护下标对应关系，
 * 少一类"键值错位"的错法（键值错位会静默把 Host 指向错误的目录）。
 */
std::thread g_tailThread;
std::atomic<bool> g_tailStop{false};

/**
 * 把 Node 抓取文件里**新增**的内容实时转发到 hilog。
 *
 * 【为什么必须有它】原先只在 `node::Start` **返回**时才把捕获内容转 hilog，于是当 Node
 * 一直跑着（这正是现在的状态：started=true 且 node::Start 不返回）时我们**完全瞎**——
 * 不知道 Web 服务起没起来、卡在哪一步。有了 tail 线程，Node 活着也能看见它的输出。
 */
void TailNodeOutput(std::string path) {
  long offset = 0;
  while (!g_tailStop.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    FILE* f = ::fopen(path.c_str(), "r");
    if (f == nullptr) continue;
    if (::fseek(f, offset, SEEK_SET) != 0) { ::fclose(f); continue; }
    char buf[3000];
    size_t n = ::fread(buf, 1, sizeof(buf) - 1, f);
    ::fclose(f);
    if (n == 0) continue;
    offset += static_cast<long>(n);
    buf[n] = '\0';
    // 逐行打：单条 hilog 过长会被截断，行首的定位信息（例如 "dsh web:"）就没了
    std::string all(buf);
    size_t pos = 0;
    while (pos < all.size()) {
      size_t nl = all.find('\n', pos);
      std::string line = all.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
      if (!line.empty()) {
        OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-NODELIVE", "%{public}s", line.c_str());
      }
      if (nl == std::string::npos) break;
      pos = nl + 1;
    }
  }
}

napi_value StartHost(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  napi_value out = nullptr;
  napi_create_object(env, &out);

  if (g_started.load()) {
    SetBool(env, out, "started", false);
    SetString(env, out, "note", "运行时已经启动过；同一进程只允许一个 Node 实例");
    return out;
  }

  // argv：第 0 位是程序名（node::Start 要求），其余由 ArkTS 侧给出。
  g_argStore.clear();
  g_argStore.emplace_back("node");
  uint32_t len = 0;
  if (argc >= 1 && napi_get_array_length(env, args[0], &len) == napi_ok) {
    for (uint32_t i = 0; i < len; i++) {
      napi_value el = nullptr;
      if (napi_get_element(env, args[0], i, &el) != napi_ok) {
        continue;
      }
      size_t n = 0;
      if (napi_get_value_string_utf8(env, el, nullptr, 0, &n) != napi_ok) {
        continue;  // 非字符串项直接跳过，不猜
      }
      std::string s(n, '\0');
      napi_get_value_string_utf8(env, el, &s[0], n + 1, &n);
      g_argStore.push_back(s);
    }
  }

  // 环境变量：必须在 node::Start 之前生效——Node 启动时就会读 process.env 初始化，
  // 之后再 setenv 对已启动的 Host 没有任何作用。
  uint32_t envCount = 0;
  int envBad = 0;
  if (argc >= 2 && napi_get_array_length(env, args[1], &envCount) == napi_ok) {
    for (uint32_t i = 0; i < envCount; i++) {
      napi_value el = nullptr;
      if (napi_get_element(env, args[1], i, &el) != napi_ok) {
        continue;
      }
      size_t n = 0;
      if (napi_get_value_string_utf8(env, el, nullptr, 0, &n) != napi_ok) {
        continue;
      }
      std::string pair(n, '\0');
      napi_get_value_string_utf8(env, el, &pair[0], n + 1, &n);
      const size_t eq = pair.find('=');
      if (eq == std::string::npos || eq == 0) {
        envBad++;  // 没有 "=" 或键为空：不猜，计数后如实报告
        continue;
      }
      setenv(pair.substr(0, eq).c_str(), pair.substr(eq + 1).c_str(), 1);
    }
  }

  g_argv.clear();
  for (std::string& s : g_argStore) {
    g_argv.push_back(&s[0]);
  }

  g_started.store(true);
  g_running.store(true);
  // 抓取路径在**线程外**算好：Node 线程与 tail 线程都要用它
  std::string logPath;
  const char* homeEnv = ::getenv("DSHM_SANDBOX_HOME");
  if (homeEnv != nullptr && homeEnv[0] != '\0') {
    logPath = std::string(homeEnv) + "/node-output.log";
  }
  g_nodeThread = std::thread([logPath]() {
    /*
     * 把 Node 的 stdout/stderr 抓进一个文件。
     *
     * 【为什么必须这么做】应用进程的 stdout 在设备上**看不见**（D6 E23：hilog 里没有，
     * 也没人去读它），而 `node::Start` 返回时把失败原因（例如入口脚本抛错、配置缺失）
     * 全打在 stdout/stderr 上。实测症状就是"Node 线程起来又退出、端口从未应答"，
     * 而**原因完全不可见**——这正是当前卡住的地方。
     * 目录用调用方传进来的 DSHM_SANDBOX_HOME（buildHostEnv 会设），那是应用自己的可写目录。
     */
    std::string logPath;
    const char* home = ::getenv("DSHM_SANDBOX_HOME");
    if (home != nullptr && home[0] != '\0') {
      logPath = std::string(home) + "/node-output.log";
    }
    if (!logPath.empty()) {
      if (FILE* f = ::freopen(logPath.c_str(), "w", stdout)) {
        ::setvbuf(f, nullptr, _IOLBF, 0);
        ::dup2(::fileno(f), 2);  // stderr 也指向同一个文件
      }
    }

    if (g_nodeStart == nullptr) {
      OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "DSHM-SHIM",
                   "node::Start 未解析到（libnode 未首载成功），无法启动 Node");
      g_running.store(false);
      // 【E119】启动失败也要把"已启动"标记复位，否则这一次失败会把此后所有启动永久拒掉
      g_started.store(false);
      return;
    }
    int rc = g_nodeStart(static_cast<int>(g_argv.size()), g_argv.data());
    g_running.store(false);
    /*
     * 【E119：切换/重启失败的根因就在这里】`g_started` 是 `startHost` 的守卫
     * （"同一进程只允许一个 Node 实例"），但此前**置真之后从未复位**：
     * 第一次启动成功后，任何后续 `startHost` 都会被拒，报
     * 「运行时已经启动过；同一进程只允许一个 Node 实例」——真机上表现为
     * **核心版本切换、重启核心全部失败**（而旧核心明明已经退出了：
     * `isHostRunning()` 读的是 `g_running`，它是准的）。
     * 语义应当是"当前**有**一个 Node 线程在跑"，因此线程一退出就复位；
     * 这样它仍然拦住真正的并发启动，而不拦住"停掉之后再起"。
     */
    g_started.store(false);

    // Node 退出后，把抓到的输出**转成 hilog**——这是设备上唯一能读到的通道。
    ::fflush(stdout);
    if (!logPath.empty()) {
      FILE* f = ::fopen(logPath.c_str(), "r");
      if (f != nullptr) {
        // 【必须读全量】先前只读了前 2999 字节，而 Host 打印的 `dsh web: <带 token 的 URL>`
        // 与"最后一条错误"都在**输出末尾**——被截掉后我们无法判断服务到底有没有绑定端口。
        // static：64 KB 放在栈上不合适。
        static char buf[262144];
        size_t n = ::fread(buf, 1, sizeof(buf) - 1, f);
        buf[n] = '\0';
        ::fclose(f);
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "DSHM-SHIM",
                     "node::Start returned rc=%{public}d, captured output (%{public}zu bytes):",
                     rc, n);
        // 逐行打，避免 hilog 单条过长被截断丢掉关键信息
        std::string all(buf);
        size_t pos = 0;
        while (pos < all.size()) {
          size_t nl = all.find('\n', pos);
          std::string line = all.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
          if (!line.empty()) {
            OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "DSHM-NODEOUT", "%{public}s", line.c_str());
          }
          if (nl == std::string::npos) {
            break;
          }
          pos = nl + 1;
        }
      } else {
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "DSHM-SHIM",
                     "node::Start returned rc=%{public}d, but could not reopen %{public}s",
                     rc, logPath.c_str());
      }
    } else {
      OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "DSHM-SHIM",
                   "node::Start returned rc=%{public}d (no DSHM_SANDBOX_HOME, output not captured)", rc);
    }
  });
  // **必须 detach**：全局 std::thread 若在进程退出时仍是 joinable，它的析构函数会调用
  // std::terminate —— 表现为"退出时崩溃"。而 node::Start 是永不返回的阻塞调用
  // （Host 正常运行时它就是一直跑），所以这个线程在退出时**一定**是 joinable 的。
  // 不 join 的理由：join 会阻塞调用方直到 Host 结束，而 Host 按设计是要一直跑的。
  g_nodeThread.detach();
  // 同时开一个 tail 线程：Node 活着的时候也能看见它的输出（见 TailNodeOutput 的说明）
  if (!logPath.empty()) {
    g_tailStop.store(false);
    g_tailThread = std::thread(TailNodeOutput, logPath);
    g_tailThread.detach();
  }

  SetBool(env, out, "started", true);
  napi_value applied = nullptr;
  napi_create_uint32(env, envCount - static_cast<uint32_t>(envBad), &applied);
  napi_set_named_property(env, out, "envApplied", applied);
  // 环境变量格式不对必须说出来：静默忽略会让 Host 用上默认目录，
  // 表面上"起来了"，实际指向了错的 $DSH_HOME。
  SetString(env, out, "note",
            envBad > 0
                ? ("Node 线程已启动，但有 " + std::to_string(envBad) +
                   " 条环境变量格式不合法（缺少 KEY=）已被忽略")
                : "Node 线程已启动（node::Start 阻塞运行）");
  return out;
}

napi_value IsHostRunning(napi_env env, napi_callback_info info) {
  napi_value out = nullptr;
  napi_get_boolean(env, g_running.load(), &out);
  return out;
}

/**
 * stopHost(): { ok: boolean, note: string }
 *
 * **如实返回做不到**。进程内 Node 无法从外部线程安全停止：node::Start 阻塞，
 * 唯一正路是在 Node 线程内持 uv_async 并调用 node::Stop(env)。在拿到 env 之前，
 * 假装停成功会让上层以为核心已经停了（而它还在监听回环端口）——那比报错更糟。
 */
napi_value StopHost(napi_env env, napi_callback_info info) {
  napi_value out = nullptr;
  napi_create_object(env, &out);
  SetBool(env, out, "ok", false);
  SetString(env, out, "note",
            "进程内 Node 暂不支持从外部线程停止（需在 Node 线程内用 uv_async + node::Stop）。"
            "当前只能随应用退出而结束。");
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  // 这条日志是二分的关键：构造器日志已证明 `.so` 被加载且注册调用返回，
  // 而四种名字口径全试过仍绑不到我们（E25/E26 + 本轮）。
  // 于是只剩两种可能，且修法完全不同：
  //   ① Init 从未被调用 ⇒ 运行时**没有用我们的模块**去实例化（查找/映射问题）；
  //   ② Init 被调用了，但 ArkTS 那边仍拿到别的对象 ⇒ 绑定侧问题。
  OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM", "Init called: creating exports object");
  napi_property_descriptor desc[] = {
      {"runtimeVersion", nullptr, RuntimeVersion, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"startHost", nullptr, StartHost, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"isHostRunning", nullptr, IsHostRunning, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stopHost", nullptr, StopHost, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

napi_module g_dshHostModule = {
    1,          // nm_version
    0,          // nm_flags
    // 【必须非空】Node 的 NODE_MODULE 宏与 DevEco 样例都传 __FILE__，我们原先传 nullptr。
    // 实测症状（E28）：构造器执行、napi_module_register 返回，但 Init **从未被调用**
    // ⇒ 注册很可能没被真正收下。这一栏就是与规范写法唯一的差异，先试它。
    __FILE__,   // nm_filename
    Init,       // nm_register_func
    "dshhost",  // nm_modname：见下方"注册两个名字"的说明
    nullptr,    // nm_priv
    {nullptr},  // reserved
};

/*
 * 同一个模块再注册一次，名字用**完整的导入说明符** `libdshhost.so`。
 *
 * 【为什么两个都要注册】实测（真机 hilog）：
 *     DSHM-RUNTIME 调用原生模块失败：runtimeVersion is not callable, runtimeVersion is undefined
 * 也就是 `.so` 加载成功、`import` 没报错，但**模块注册没被认到**，导出全是 undefined。
 * 而 `nm_modname` 到底该写 `<name>` 还是 `<name>.so` 取决于运行时的匹配口径：
 * 官方样例是 `libentry.so` 配 `nm_modname = "entry"`，但那条规则在不同版本上并不一致，
 * 且**写错不会报错**——只会得到一个空模块（正是我们遇到的症状）。
 * 注册两份的成本是几十字节，换来的是不必靠猜：两者命中其一即可。
 */
napi_module g_dshHostModuleFull = {
    1,
    0,
    __FILE__,
    Init,
    "libdshhost.so",
    nullptr,
    {nullptr},
};

/*
 * 再补两种名字口径：`libdshhost`（带 lib 前缀、不带扩展名）与 `dshhost.so`。
 *
 * 【为什么把四种都注册上】真机实测已确认：`.so` 被 `dlopen`、构造器执行、
 * `napi_module_register` 返回（见构造器里那条 `DSHM-SHIM` 日志），
 * 但 ArkTS 的 `import … from 'libdshhost.so'` 拿到的仍是 ArkUI 的节点模块（E25/E26）
 * ⇒ 只剩"运行时用哪个名字查表"这一个变量，而**查错名字不会报错**，
 * 只会返回一个别的模块。与其一轮一轮猜（每轮一次构建+安装≈3 分钟），
 * 不如把四种合理口径一次全覆盖：命中哪一种，看日志即可反推规则。
 */
napi_module g_dshHostModuleNoExt = {
    1,
    0,
    __FILE__,
    Init,
    "libdshhost",
    nullptr,
    {nullptr},
};

napi_module g_dshHostModuleBareDotSo = {
    1,
    0,
    __FILE__,
    Init,
    "dshhost.so",
    nullptr,
    {nullptr},
};

}  // namespace

// 模块注册：OHOS 的 NAPI 也是靠 constructor 把模块挂上去的（与 Node 原生模块一致）。
//
// 【为什么构造器里要打一条 hilog】这是本轮做的一次**二分**：真机上 ArkTS 侧
// `import dshhost from 'libdshhost.so'` 拿到的是 ArkUI 的节点 API（E25/E26），
// 而 `.so` 本身已被逐项排除（INIT_ARRAY 有我们的构造器、NEEDED 齐全、strip 前后一致）。
// 于是只剩两种可能，且它们需要完全不同的修法：
//   ① `.so` 被 dlopen 了、构造器跑了，但模块名查找没命中 → 改名字/注册方式；
//   ② `.so` **根本没被加载** → 问题在运行时如何决定加载哪个 .so（命名/映射）。
// 一条日志就能区分。用 OH_LOG_Print 而不是 printf：应用进程的 stdout 在设备上看不见（E23）。
extern "C" __attribute__((constructor)) void RegisterDshHostModule() {
  /*
   * 把 libnode 提升到**全局符号作用域**。
   *
   * 【为什么必须做】真机实测：把 koffi 的 .node 放到 HAP 的 libs/ 下加载后（见入口脚本里的
   * "原生库重定向"），`dlopen` 通过了沙箱限制，但接着报
   *     Error relocating …/libs/arm64/libkoffi.so: napi_fatal_error: symbol not found
   * 原因是：Node 在这里是**共享库**（libnode.so.127），它由应用的加载器以 RTLD_LOCAL 载入，
   * 符号不在全局作用域；而原生模块（koffi/node-pty/sharp）要解析 `napi_*` 符号，
   * 靠的正是"Node 的符号全局可见"。可执行文件形式的 node 天然满足这一点，共享库形式不满足。
   * 再 dlopen 一次并带 RTLD_GLOBAL，就把 libnode 的符号提升进全局表，后续的 .node 才能解析。
   * 失败也不致命（只是回到原来的症状），所以只记录、不中止。
   */
  /*
   * 用**绝对路径**首载 libnode。
   *
   * 【为什么不能只写 soname】去掉 DT_NEEDED 之后（见 CMakeLists 的说明），没有任何东西
   * 会把 libnode 拉进来，而 bundle 的 libs 目录未必在加载器的默认搜索路径里 —— 实测症状是
   * 应用连一条自己的日志都打不出来（很可能 libdshhost 因解析失败而加载不了）。
   * 用 `dladdr` 问出**本 .so 自己**的路径，同目录下的 libnode.so.XXX 就是同一个包里的那份，
   * 既不硬编码路径，也不受搜索路径影响。
   *
   * 【候选文件名】本机实际的 Node 是 26.7.0（`libnode.so.137`，真机已跑通于 DSHM），
   * 而早期基线是 24.x（`libnode.so.127`）。soname 随 NODE_MODULE_VERSION 走，
   * 因此这里按候选顺序逐个 dlopen，命中即用，避免换 Node 版本时改代码。
   */
  static const char* kLibnodeCandidates[] = {
      "libnode.so.137",  // Node 26.x（当前资产，真机已验证）
      "libnode.so.127",  // Node 24.x（历史基线）
  };
  std::string libsDir;
  Dl_info selfInfo;
  if (::dladdr(reinterpret_cast<void*>(&RegisterDshHostModule), &selfInfo) != 0 &&
      selfInfo.dli_fname != nullptr) {
    std::string selfPath(selfInfo.dli_fname);
    const size_t slash = selfPath.find_last_of('/');
    if (slash != std::string::npos) {
      libsDir = selfPath.substr(0, slash + 1);
    }
  }
  void* handle = nullptr;
  std::string libnodePath;
  for (const char* candidate : kLibnodeCandidates) {
    const std::string p = libsDir + candidate;
    void* h = ::dlopen(p.c_str(), RTLD_NOW | RTLD_GLOBAL);
    if (h != nullptr) {
      handle = h;
      libnodePath = p;
      break;
    }
  }
  if (handle == nullptr) {
    // 兜底：不写目录，交给加载器按搜索路径解析
    for (const char* candidate : kLibnodeCandidates) {
      void* h = ::dlopen(candidate, RTLD_NOW | RTLD_GLOBAL);
      if (h != nullptr) {
        handle = h;
        libnodePath = candidate;
        break;
      }
    }
  }
  if (handle != nullptr) {
    g_libnode = handle;
    // mangled 名由 `nm -D libdshhost.so` 里那条未定义符号确认过
    g_nodeStart = reinterpret_cast<NodeStartFn>(::dlsym(handle, "_ZN4node5StartEiPPc"));
  }
  OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM",
               "first-load %{public}s (RTLD_GLOBAL): handle=%{public}s node::Start=%{public}s",
               libnodePath.c_str(), handle != nullptr ? "ok" : "failed",
               g_nodeStart != nullptr ? "ok" : "missing");
  /*
   * ── 诊断块（定位 koffi 的 `napi_fatal_error: symbol not found`）─────────────
   * 与本 .so 顶部那个 `napi_fatal_error` 定义配合使用，见那里的说明。
   * 三个读数：
   *   diag1 = 全局作用域里 napi_fatal_error 的提供者（判别本 .so / libnode 是否全局可见）
   *   diag2 = 全局作用域里 napi_get_undefined 的提供者（找出其余 83 个符号来自谁）
   *   diag3 = 我们自己 dlopen 一次 libkoffi.so 的结果（复现 Node 的加载，且可验证修复）
   */
  {
    std::string libsDir = ".";
    Dl_info selfInfo2;
    if (::dladdr(reinterpret_cast<void*>(&RegisterDshHostModule), &selfInfo2) != 0 &&
        selfInfo2.dli_fname != nullptr) {
      std::string selfPath(selfInfo2.dli_fname);
      const size_t slash = selfPath.find_last_of('/');
      if (slash != std::string::npos) {
        libsDir = selfPath.substr(0, slash + 1);
      }
    }
    auto providerOf = [](const char* name) -> std::string {
      void* sym = ::dlsym(RTLD_DEFAULT, name);
      if (sym == nullptr) {
        return std::string("(null)");
      }
      Dl_info info;
      if (::dladdr(sym, &info) != 0 && info.dli_fname != nullptr) {
        return std::string(info.dli_fname);
      }
      return std::string("(unknown)");
    };
    const std::string fatalProvider = providerOf("napi_fatal_error");
    const std::string undefProvider = providerOf("napi_get_undefined");
    OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM",
                 "diag1 RTLD_DEFAULT napi_fatal_error <- %{public}s", fatalProvider.c_str());
    OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM",
                 "diag2 RTLD_DEFAULT napi_get_undefined <- %{public}s", undefProvider.c_str());
    const std::string koffiPath = libsDir + "libkoffi.so";
    ::dlerror();
    void* koffiHandle = ::dlopen(koffiPath.c_str(), RTLD_NOW | RTLD_LOCAL);
    std::string koffiErr = "(no-error)";
    if (koffiHandle == nullptr) {
      const char* raw = ::dlerror();
      koffiErr = raw != nullptr ? std::string(raw) : std::string("(no-dlerror-text)");
    }
    OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM",
                 "diag3 dlopen %{public}s = %{public}s", koffiPath.c_str(),
                 koffiHandle != nullptr ? "ok" : koffiErr.c_str());
  }
  OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM",
               "constructor ran: registering 4 name forms (dshhost / libdshhost.so / libdshhost / dshhost.so)");
  napi_module_register(&g_dshHostModule);
  napi_module_register(&g_dshHostModuleFull);
  napi_module_register(&g_dshHostModuleNoExt);
  napi_module_register(&g_dshHostModuleBareDotSo);
  OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM", "registration calls returned");
}
