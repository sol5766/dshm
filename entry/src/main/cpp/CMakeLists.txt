cmake_minimum_required(VERSION 3.5.0)
project(dsh_host)

set(NATIVERENDER_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR})

include_directories(${NATIVERENDER_ROOT_PATH}/include/node)

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
