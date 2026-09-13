cmake_minimum_required(VERSION 3.5.0)
project(dsh_host)

set(NATIVERENDER_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR})

include_directories(${NATIVERENDER_ROOT_PATH}/include/node)

# 工具链给共享库注入 -Wl,--no-undefined，会拒绝 pty_host_napi 里 N-API 的未定义符号
# （napi_* 由宿主 node 在 dlopen 时解析，这是 N-API 的标准用法）。lld 没有对应的
# 「放行」开关（只有 --no-undefined），因此把该标志从本目录的链接参数里摘掉。
# 对其它目标只是少一道链接期检查——它们本就链接 libnode.so.137，没有未定义符号。
string(REPLACE "-Wl,--no-undefined" "" CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS}")

add_library(dsh_host SHARED dsh_host.cpp)

# 输出到 hvigor 指定的库输出目录（obj/arm64-v8a），否则产物留在 .cxx 构建树
set_target_properties(dsh_host PROPERTIES
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_RELEASE ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_DEBUG ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
)

# 注：dsh_host.cpp 不使用日志 API；SDK 26 native sysroot 无 liblog.so（仅 libhilog_ndk.z.so），
# 若后续需要日志请链接 hilog_ndk 并 include <hilog/log.h>。
# target_link_libraries(dsh_host PUBLIC hilog_ndk)

# libnode.so.137 链接进 dsh_host 的 DT_NEEDED：让 ld.so 在进程启动时装载并完成
# thread_local 初始化（而非纯 dlopen 路径，否则 V8 的
# AllowHeapAllocationInRelease TLS 断言读到的初始值不正确），
# 运行时仍以 dlopen 取得同一份 node::Start 符号。
# M1 瘦身：entry/libs 下 .so 与 .so.137 为同一文件（md5 相同）的双副本，
# 库内 SONAME 是 .so.137，统一链接保留下来的 .so.137 实体，HAP 少打一份 126MB。
target_link_libraries(dsh_host PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/arm64-v8a/libnode.so.137)

# pty_host —— dshm-terminal 的真 pty addon（node 侧以 .node 方式加载）。
# 产物复制到 rawfile 依赖树，随 HAP 打包；node 运行 tree 解压后可见，
# dshm-terminal 通过 require(".../vendor/pty_host.node") 使用。
set(PTY_NODE_DEST ${CMAKE_CURRENT_SOURCE_DIR}/../resources/rawfile/dsh/node_modules/dshm-terminal/vendor)
add_library(pty_host SHARED pty_terminal.cpp)
target_include_directories(pty_host PRIVATE ${NATIVERENDER_ROOT_PATH}/include/node)
# N-API 符号由 node 运行时导出：与 dsh_host 同样链接 libnode.so.137，
# 避免 NAPI 函数引用在链接期成为未定义符号（启动时宿主已 dlopen 同一库）。
target_link_libraries(pty_host PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/arm64-v8a/libnode.so.137)
set_target_properties(pty_host PROPERTIES
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_RELEASE ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_DEBUG ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
)
add_custom_command(TARGET pty_host POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory ${PTY_NODE_DEST}
  COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:pty_host> ${PTY_NODE_DEST}/pty_host.node
)

# pty_host_napi —— 同上，但**不链接 libnode.so.137**（宿主模式专用）。
#
# 为什么需要第二个变体：上面的 pty_host 把 libnode.so.137 写进了 DT_NEEDED
# （工具链默认 -Wl,--no-undefined，N-API 的 15 个未定义符号必须先满足）。
# 内嵌模式没问题——进程里本来就 dlopen 了同一份 libnode；但宿主模式跑的是
# brew 的原生 node（v26），进程里没有 libnode.so.137，dlopen 直接报
# 「Error loading shared library libnode.so.137」，宿主终端于是永远退化成管道会话
# （无 Tab 补全 / 无行编辑）。往 brew node 进程里塞内嵌 libnode 更不可取（两份 V8）。
#
# N-API 是跨版本 ABI 稳定的：把 napi_* 留作未定义符号，交给**加载它的那个 node**
# 在 dlopen 时解析即可（内嵌 libnode 与 brew node 都导出这些符号）。
add_library(pty_host_napi SHARED pty_terminal.cpp)
target_include_directories(pty_host_napi PRIVATE ${NATIVERENDER_ROOT_PATH}/include/node)
set_target_properties(pty_host_napi PROPERTIES
  OUTPUT_NAME pty_host_napi
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_RELEASE ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_DEBUG ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
)

# node_shim —— 内嵌 node 的可执行 shim（供 pnpm spawn 插件）。
# 运行时链接 libnode.so.137 为 DT_NEEDED，让 ld.so 在进程启动时装载并完成
# thread_local 初始化（同 dsh_host 的链接策略，而非纯 dlopen 路径，
# 否则 musl 下 V8 的 errno_location TLS 断言 `12 == (*__errno_location())`
# 会失败，导致 spawn 出的 node 进程立即 SIGNAL 5/6 崩溃）。
# dlopen 保留为 fallback 路径（部分特殊设备使用）。
# 注意：禁止指定 INSTALL_RPATH 或 RUNPATH——开发机路径会写入 ELF 的 RUNPATH，
# 设备上找不到该路径，linker 拒绝加载 libnode.so.137（Permission denied）。
# 运行时由 dsh_host.cpp 的 fork+exec 子进程设置 LD_LIBRARY_PATH 指向
# el1/bundle/libs/arm64（运行时的实际 libnode 位置）。
set(NODE_BIN_DEST ${CMAKE_CURRENT_SOURCE_DIR}/../resources/rawfile/dsh/node/bin)
add_executable(node_shim node_shim.cpp)
target_link_libraries(node_shim PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/arm64-v8a/libnode.so.137)
# OHOS NDK 下 add_executable 默认产 PIE ELF，不需要额外 -fPIE -pie
set_target_properties(node_shim PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/node_shim_bin
  # 不让 CMake 写入 RUNPATH（开发机路径）
  SKIP_BUILD_RPATH TRUE
  BUILD_WITH_INSTALL_RPATH FALSE
  INSTALL_RPATH ""
)
add_custom_command(TARGET node_shim POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory ${NODE_BIN_DEST}
  COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:node_shim> ${NODE_BIN_DEST}/node
)
