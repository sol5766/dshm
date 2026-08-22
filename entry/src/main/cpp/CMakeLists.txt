cmake_minimum_required(VERSION 3.5.0)
project(dshm_native)

# Common headers
set(COMMON_DIR ${CMAKE_CURRENT_SOURCE_DIR}/common)

# libdsh_host.so — 内嵌 DSH 运行时宿主
add_library(dsh_host SHARED dsh_host.cpp)
target_include_directories(dsh_host PRIVATE ${COMMON_DIR})
set_target_properties(dsh_host PROPERTIES
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_RELEASE ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_DEBUG ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
)

# libbrew_check.so — Brew/DSH 安装检测
add_library(brew_check SHARED brew_check.cpp)
target_include_directories(brew_check PRIVATE ${COMMON_DIR})
set_target_properties(brew_check PROPERTIES
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_RELEASE ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_DEBUG ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
)

# libbrew_installer.so — 应用内 Brew 安装
add_library(brew_installer SHARED brew_installer.cpp)
target_include_directories(brew_installer PRIVATE ${COMMON_DIR})
set_target_properties(brew_installer PROPERTIES
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_RELEASE ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_DEBUG ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
)

# libdsh_launcher.so — 外部 DSH 服务启动器
add_library(dsh_launcher SHARED dsh_launcher.cpp)
target_include_directories(dsh_launcher PRIVATE ${COMMON_DIR})
set_target_properties(dsh_launcher PROPERTIES
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_RELEASE ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
  LIBRARY_OUTPUT_DIRECTORY_DEBUG ${CMAKE_LIBRARY_OUTPUT_DIRECTORY}
)
