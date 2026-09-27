cmake_minimum_required(VERSION 3.5.0)
project(dshmnative)

# Node 26.x 的头文件（`v8-internal.h` 等）用了 C++20 的 concepts/`requires`，
# 以 C++17 编会报 "unknown type name 'requires'" 并连锁出上百条错。
# 原值是 17（对应 Node 24.x 头文件）；换到 26.7.0 的头文件后必须提到 20。
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── 为什么这里有 CMake（D6 E30 的结论）────────────────────────────────────────
#
# 实测（同进程、相隔几毫秒的并列对照）：
#   DSHM-PROBE  cmake 构建的原生模块可绑定，返回值=dshm-probe-ok   ← 走 hvigor 的 CMake 路径
#   DSHM-RUNTIME runtimeVersion is undefined                       ← 手工拷进 entry/libs/
# ⇒ **本项目里"手工放预编译 .so"不会生成 ArkTS↔原生模块的映射**：运行时会 dlopen 它、
#   构造器会执行，但 `napi_module_register` 注册的模块**永远不会被实例化**（`Init` 不被调用）。
#   所以 `libdshhost.so` 必须由 hvigor 自己编译链接，而不是我们编好再拷进去。
#
# 代价：CMake 需要 Node 的头文件，由 `tools/node-runtime/sync-node-headers.sh` 同步到
# `node-headers/`（**已 gitignore**：几十 MB 的三方头文件，字节不进库、方法进库）。

set(NATIVE_ROOT ${CMAKE_CURRENT_SOURCE_DIR})
# cpp → main → src → entry → 仓库根；`entry/libs` 是上溯三级
set(REPO_ROOT ${NATIVE_ROOT}/../../../..)
set(ENTRY_LIBS ${NATIVE_ROOT}/../../../libs)

# 1) 最小探针模块：回答"CMake 路径能否绑定"（见 probe.cpp 与 E30），保留它作为回归证据。
add_library(entryprobe SHARED probe.cpp)
target_link_libraries(entryprobe PUBLIC libace_napi.z.so)

# 2) 真正的引导模块：dshhost（源码在 hostruntime 里，那一层才是它的归属）。
add_library(dshhost SHARED
    ${NATIVE_ROOT}/../../../../hostruntime/src/main/cpp/dshhost.cc)

target_include_directories(dshhost PRIVATE
    ${NATIVE_ROOT}/node-headers/src
    ${NATIVE_ROOT}/node-headers/v8include
    ${NATIVE_ROOT}/node-headers/uvinclude)

# -fno-emulated-tls / -D__MUSL__：与交叉编译 libnode.so.127 时用的口径保持一致。
# TLS 模型不一致时，与 libnode 的交互会出现难以定位的问题，所以两端必须同口径。
target_compile_options(dshhost PRIVATE -fno-emulated-tls -D__MUSL__)
set_target_properties(dshhost PROPERTIES LINK_FLAGS "-fno-emulated-tls")

target_link_libraries(dshhost PUBLIC libace_napi.z.so)

# 诊断日志用 OH_LOG_Print（应用进程的 stdout 在设备上看不见，见 D6 E23）。
# 独立编译时用 -lhilog_ndk.z，CMake 里要显式列出来，否则 --no-undefined 会直接报 undefined symbol。
target_link_libraries(dshhost PUBLIC hilog_ndk.z)

# libnode.so.127 是**预编译**产物（自建 Node，见 tools/node-runtime/）。
#
# 【为什么**不**链接它，而是运行期 dlopen】见 dshhost.cc 构造函数里的说明：
# 若写进 DT_NEEDED，动态加载器会先以**局部作用域**把它载入，之后原生模块（koffi/node-pty/sharp）
# 就解析不到 `napi_*` 符号——musl 不支持事后把已载入的库提升为全局（实测：dlopen 带 RTLD_GLOBAL
# 返回 ok，符号依然 not found）。所以改为在构造函数里**首次** dlopen 并带 RTLD_GLOBAL，
# 并用 dlsym 取 `node::Start`（mangled 名 `_ZN4node5StartEiPPc`）。
# 代价：链接期不再校验 libnode —— 这是**有意的**取舍，换来 `.node` 能加载。

# ── koffi 3.x（自建；见 D6 E47 / E50）────────────────────────────────────────
#
# 【为什么自建】dsh 全线声明 `koffi ^3.1.0`，而鸿蒙侧只有 `@ohos-ports/koffi@2.16.2-beta.0`：
# 2.x 的 `koffi.struct(...).size` 是 undefined ⇒ `dsh-win32-process` 的**模块顶层**断言抛错
# ⇒ `subprocess-local` / `sandbox-local` 加载失败（整棵树 fail-loud）。上游 3.x 的分平台包
# 没有 openharmony 变体，其 musl 预编译的 DT_NEEDED 是 libstdc++.so.6 / libc.musl-aarch64.so.1
# ——鸿蒙都不提供。所以只能自己编。
#
# 【为什么编在这里】hvigor 已经有可用的 OHOS CMake/ninja 工具链，并且天然按 ABI（arm64-v8a /
# x86_64）各编一份、按 `lib<target>.so` 打进 HAP 的 `libs/`。目标名取 `koffi` ⇒ 产出
# `libs/<abi>/libkoffi.so`，正好命中入口脚本的原生库重定向约定（`lib<stem>.so`，D6 E40）。
#
# 源码由 `node tools/fetch-koffi.mjs` 取到 `third_party/koffi/`（**已 gitignore**）。
# 取不到就只 warn 不失败：缺 koffi 只影响 subprocess/sandbox 两行，不该让整个 HAP 编不出来。
enable_language(ASM)

set(KOFFI_DIR ${REPO_ROOT}/third_party/koffi)
if(EXISTS ${KOFFI_DIR}/package/src/koffi/CMakeLists.txt)
  set(KOFFI_SRC ${KOFFI_DIR}/package/src/koffi)
  set(KOFFI_CXX
      ${KOFFI_SRC}/src/ffi.cc
      ${KOFFI_SRC}/src/call.cc
      ${KOFFI_SRC}/src/interp.cc
      ${KOFFI_SRC}/src/parser.cc
      ${KOFFI_SRC}/src/type.cc
      ${KOFFI_SRC}/src/util.cc
      ${KOFFI_SRC}/src/uv.cc
      ${KOFFI_SRC}/src/win32.cc
      ${KOFFI_DIR}/package/lib/native/base/base.cc)

  # 默认当 arm64（出货目标）；只有明确是 x86 才走 x64sysv，避免 CMAKE_SYSTEM_PROCESSOR
  # 在 OHOS 工具链里为空时**静默编错架构**（这种错误要到运行时才暴露）
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|amd64|AMD64|X86_64" OR OHOS_ARCH MATCHES "x86")
    set(KOFFI_TARGET x86_64)
    set(DSHM_LIBNODE_ABI x86_64)
    list(APPEND KOFFI_CXX ${KOFFI_SRC}/src/abi/x64sysv.cc)
    set(KOFFI_ASM ${KOFFI_SRC}/src/abi/x64sysv_asm.S)
  else()
    set(KOFFI_TARGET arm64)
    set(DSHM_LIBNODE_ABI arm64-v8a)
    list(APPEND KOFFI_CXX ${KOFFI_SRC}/src/abi/arm64.cc)
    set(KOFFI_ASM ${KOFFI_SRC}/src/abi/arm64_asm.S)
  endif()

  # 取该 ABI 下**实际存在**的 libnode（soname 随 Node 版本走：26.x=.137、24.x=.127）。
  # 不写死名字，换 Node 版本时不必改这里。
  set(DSHM_LIBNODE_ARCH_DIR ${ENTRY_LIBS}/${DSHM_LIBNODE_ABI})
  unset(DSHM_LIBNODE CACHE)
  foreach(cand libnode.so.137 libnode.so.127 libnode.so)
    if(NOT DSHM_LIBNODE AND EXISTS ${DSHM_LIBNODE_ARCH_DIR}/${cand})
      set(DSHM_LIBNODE ${DSHM_LIBNODE_ARCH_DIR}/${cand})
    endif()
  endforeach()
  if(NOT DSHM_LIBNODE)
    set(DSHM_LIBNODE ${DSHM_LIBNODE_ARCH_DIR}/libnode.so.137)
  endif()
  message(STATUS "libnode（预编译，${DSHM_LIBNODE_ABI}）= ${DSHM_LIBNODE}")

  # 【为什么"没有 libnode 就不编 koffi"】koffi 的 napi_*/uv_* 必须靠 DT_NEEDED 放进
  # 它自己的依赖闭包（E43：libnode 即便 RTLD_GLOBAL 首载也不进它的可见集）。
  # 而 OHOS 工具链默认带 `-Wl,--no-undefined` ⇒ 拿不到 libnode 时链接必然失败。
  # 与其放宽成"允许未定义符号"（那会产出运行时必崩的 .node），不如**这个 ABI 先不产**：
  # x86_64 的 libnode 一进 entry/libs/x86_64/，这里就会自动开始编。
  if(NOT EXISTS ${DSHM_LIBNODE})
    message(WARNING "koffi(${KOFFI_TARGET}) 跳过：缺 ${DSHM_LIBNODE}（DT_NEEDED 必须有它）。"
                    "先出该架构的 libnode.so.127，或到模拟器上临时禁用 subprocess/sandbox 两行")
  else()
    add_library(koffi MODULE ${KOFFI_CXX} ${KOFFI_ASM})
    set_target_properties(koffi PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)
    target_include_directories(koffi PRIVATE
        ${KOFFI_SRC}
        ${KOFFI_DIR}/package
        ${KOFFI_DIR}/package/vendor/node-addon-api
        ${KOFFI_DIR}/package/vendor/node-api-headers/include
        ${KOFFI_DIR}/trampolines
        ${NATIVE_ROOT}/node-headers/src)
    # 宏与选项逐条照抄上游 src/koffi/CMakeLists.txt（NAPI 实验版是 koffi 的硬要求）
    target_compile_definitions(koffi PRIVATE
        FELIX_TARGET=koffi
        NAPI_VERSION=NAPI_VERSION_EXPERIMENTAL
        NODE_ADDON_API_DISABLE_CPP_EXCEPTIONS
        NODE_ADDON_API_REQUIRE_BASIC_FINALIZERS)
    set_source_files_properties(${KOFFI_SRC}/src/ffi.cc PROPERTIES COMPILE_DEFINITIONS VERSION=3.2.1)
    target_compile_options(koffi PRIVATE
        -fno-exceptions -fno-rtti -fwrapv
        -fno-semantic-interposition -fvisibility=hidden -fdata-sections -ffunction-sections)
    target_link_options(koffi PRIVATE -Wl,--gc-sections)
    target_link_libraries(koffi PRIVATE ${DSHM_LIBNODE})
    message(STATUS "koffi 3.2.1 编入 HAP：target=${KOFFI_TARGET} libnode=${DSHM_LIBNODE}")
  endif()
else()
  message(WARNING "未找到 koffi 源码（${KOFFI_DIR}）⇒ 本架构不带 libkoffi.so；"
                  "先跑 `node tools/fetch-koffi.mjs`")
endif()

# ── node-addon-system 的 flock（自建；E103）──────────────────────────────────
#
# 【用途】`dsh-session-persistence-jsonl` 用它给会话日志加**排他锁**（POSIX flock）——
# 这是会话持久化的一部分，不能绕过（绕过的代价是并发写坏日志）。
#
# 【为什么要自建，而不是用 npm 预编译】
#   1. npm 在 Windows 上装树时**不会**装 `@deepseek-ai/node-addon-system-linux-arm64`
#      （optionalDependencies 只装当前平台），而设备上 `process.platform=linux/arch=arm64`
#      ⇒ 加载器找不到它（真机报错：`Cannot find module '@deepseek-ai/node-addon-system-linux-arm64/package.json'`）；
#   2. 取 npm 的 musl 预编译件也不行：它只 `DT_NEEDED libc.so`，dlopen 后 **napi 符号解析不到**
#      （与 koffi 同一个坑，E43/E44），而 `libc.so` 是必需项、不能被替换掉。
# 自建时可以把 libnode 显式写进链接行 ⇒ 依赖闭包正确。
#
# 产物名取 `system` ⇒ `libs/<abi>/libsystem.so`，正好命中入口脚本的原生库重定向约定
# （`lib<stem>.so`，与 koffi/sharp 同一套，E40）。
# 【为什么按 glob 找而不是写死版本】核心树目录名随 coreVersion 变（0.1.5-rc.2 / 0.1.6-alpha.x …），
# 写死会让"换了版本但没改这里"变成一种**静默降级**：警告看着像源码丢了，实际只是目录名对不上。
# 这里按 dist/core/work/dsh-core-*/ 匹配，取排序后的最后一个（版本有序时即最新）。
file(GLOB DSHM_CORE_SYSTEM_DIRS
     ${REPO_ROOT}/dist/core/work/dsh-core-*/node_modules/@deepseek-ai/node-addon-system/src)
list(LENGTH DSHM_CORE_SYSTEM_DIRS DSHM_CORE_SYSTEM_N)
if(DSHM_CORE_SYSTEM_N GREATER 0)
  list(SORT DSHM_CORE_SYSTEM_DIRS)
  list(GET DSHM_CORE_SYSTEM_DIRS -1 SYSTEM_ADDON_SRC)
else()
  set(SYSTEM_ADDON_SRC "${REPO_ROOT}/dist/core/work/__missing__/node_modules/@deepseek-ai/node-addon-system/src")
endif()
if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|amd64|AMD64|X86_64" OR OHOS_ARCH MATCHES "x86")
  set(SYSTEM_LIBNODE_ABI x86_64)
else()
  set(SYSTEM_LIBNODE_ABI arm64-v8a)
endif()
set(SYSTEM_LIBNODE_ARCH_DIR ${ENTRY_LIBS}/${SYSTEM_LIBNODE_ABI})
unset(SYSTEM_LIBNODE CACHE)
foreach(cand libnode.so.137 libnode.so.127 libnode.so)
  if(NOT SYSTEM_LIBNODE AND EXISTS ${SYSTEM_LIBNODE_ARCH_DIR}/${cand})
    set(SYSTEM_LIBNODE ${SYSTEM_LIBNODE_ARCH_DIR}/${cand})
  endif()
endforeach()
if(NOT SYSTEM_LIBNODE)
  set(SYSTEM_LIBNODE ${SYSTEM_LIBNODE_ARCH_DIR}/libnode.so.137)
endif()
if(EXISTS ${SYSTEM_ADDON_SRC}/flock.c AND EXISTS ${SYSTEM_LIBNODE})
  add_library(system MODULE ${SYSTEM_ADDON_SRC}/flock.c)
  target_include_directories(system PRIVATE ${NATIVE_ROOT}/node-headers/src)
  target_link_libraries(system PRIVATE ${SYSTEM_LIBNODE})
  message(STATUS "flock（node-addon-system）编入 HAP：libsystem.so ← ${SYSTEM_ADDON_SRC}/flock.c")

# ── python_runner（内嵌 CPython 桥；execve 被系统白名单拒绝后的替代通道）──
#
# 源码 python_runner.cpp 移植自 DSHM 同源实现（同设备真机实证）。SHARED 库由
# hvigor 打进 HAP libs/<abi>/ ⇒ 端侧路径 <bundle>/libs/arm64/libpython_runner.so，
# 由宿主 main.js 的 ensurePythonBridge 直接 `process.dlopen` 加载。
#
# 【链接口径】与 koffi/flock 相同：napi_* 必须经 DT_NEEDED libnode.so.137 进
# 依赖闭包（E43：RTLD_GLOBAL 首载不进后加载模块的可见集）。dlopen/dlsym 在
# musl 下由 libc 提供，显式列 dl 更稳（DSHM 同款）。libpython **不**链接——
# 运行时从 el1 libs dlopen（跨 libc + 链接期不可见，见 python_runner.cpp 头注）。
if(EXISTS ${NATIVE_ROOT}/python_runner.cpp)
  unset(PYRUN_LIBNODE CACHE)
  set(PYRUN_LIBNODE "")
  foreach(cand libnode.so.137 libnode.so.127 libnode.so)
    if(NOT PYRUN_LIBNODE AND EXISTS ${ENTRY_LIBS}/arm64-v8a/${cand})
      set(PYRUN_LIBNODE ${ENTRY_LIBS}/arm64-v8a/${cand})
    endif()
  endforeach()
  if(NOT PYRUN_LIBNODE)
    message(WARNING "python_runner 跳过：entry/libs/arm64-v8a 缺 libnode（DT_NEEDED 必须有它）")
  else()
    add_library(python_runner SHARED python_runner.cpp)
    target_include_directories(python_runner PRIVATE ${NATIVE_ROOT}/node-headers/src)
    target_link_libraries(python_runner PRIVATE ${PYRUN_LIBNODE} dl)
    set_target_properties(python_runner PROPERTIES
        LIBRARY_OUTPUT_DIRECTORY ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
        LIBRARY_OUTPUT_DIRECTORY_RELEASE ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
        LIBRARY_OUTPUT_DIRECTORY_DEBUG ${CMAKE_LIBRARY_OUTPUT_DIRECTORY})
    message(STATUS "python_runner 编入 HAP：libpython_runner.so（libnode=${PYRUN_LIBNODE}）")
  endif()
else()
  message(WARNING "未找到 python_runner.cpp ⇒ 本包不带内嵌 Python 桥")
endif()
else()
  # 【为什么把两种原因分开报】此前只写"缺 flock.c 或 libnode"，而 x86_64 目标**本来就没有**
  # libnode（koffi 同样跳过），于是每次构建都会打出看着像"源码丢了"的警告。
  if(NOT EXISTS ${SYSTEM_ADDON_SRC}/flock.c)
    message(WARNING "flock 跳过：缺源码 ${SYSTEM_ADDON_SRC}/flock.c（先跑 tools/pack-core.mjs 物化核心树）")
  else()
    message(STATUS "flock(${CMAKE_SYSTEM_PROCESSOR}) 跳过：该架构还没有 libnode（${SYSTEM_LIBNODE}）")
  endif()
endif()

# ── gitcompat（LD_PRELOAD 垫片，报告 5 §2.3）─────────────────────────────
#
# 【用途】Alpine git 在起子进程时（clone/fetch/pull/push/ls-remote）`fork()` 前会调
# `pthread_setcancelstate(PTHREAD_CANCEL_DISABLE)` 并把它放进 `CHECK_BUG()`——即
# "不该失败"的自检。鸿蒙 musl 把这个调用判为失败（真机原文
# `BUG: run-command.c:525: disabling cancellation: Operation not permitted`）⇒ git
# 直接 abort（rc=134）。垫片先调 libc 真身，只在真身缺失/判失败时改判成功（真 Linux
# 上完全透明）。详见 gitcompat.c 头注释。
#
# 【为什么不编进主流程】它是给**别的进程**用的（git），我们自己不加载：宿主 git
# wrapper 以 `LD_PRELOAD=<libs>/libdshm-gitcompat.so` 起 git。所以是独立 MODULE。
# 【为什么不链接 libnode】本垫片只用 libc 的 dlsym/pthread，与 Node 无关；且
# LD_PRELOAD 的库若 DT_NEEDED libnode，会在 git 的进程里多拉一个几十 MB 的依赖。
if(EXISTS ${NATIVE_ROOT}/gitcompat.c)
  add_library(gitcompat SHARED ${NATIVE_ROOT}/gitcompat.c)
  target_link_libraries(gitcompat PRIVATE dl)
  # 产物名 libdshm-gitcompat.so：避开与系统库重名，且自明"这是 DSHM 的兼容垫片"。
  set_target_properties(gitcompat PROPERTIES OUTPUT_NAME "dshm-gitcompat")
  message(STATUS "gitcompat 编入 HAP：libdshm-gitcompat.so（git 子进程类命令的 LD_PRELOAD 垫片）")
else()
  message(WARNING "未找到 gitcompat.c ⇒ git clone/fetch/pull/push 将退化为明确不可用提示")
endif()
