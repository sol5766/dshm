// 最小原生模块探针：只导出一个返回常量的函数。
//
// 目的不是功能，而是回答一个二选一的问题（见 CMakeLists.txt 的说明）：
//   走 DevEco 的 CMake 路径、由 hvigor 自己构建的 .so，能否被 ArkTS 的
//   `import probe from 'libentryprobe.so'` 正常绑上？
// 若能，则"手工放 .so"就是根因，真实的 libdshhost 只要改成 CMake 构建即可；
// 若不能，则问题在这条导入链本身，与 .so 从哪来无关。
//
// 刻意**不包含 Node 头文件**：把变量压到只剩"工具链映射"这一个。
#include "napi/native_api.h"

#include <string>

namespace {

napi_value Hello(napi_env env, napi_callback_info info) {
  napi_value out = nullptr;
  napi_create_string_utf8(env, "dshm-probe-ok", NAPI_AUTO_LENGTH, &out);
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
      {"hello", nullptr, Hello, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

// 与 DevEco 模板一致：模块名 = 库名去掉 lib 前缀与扩展名。
// 位置初始化而不是指定初始化器：C++17 下后者是扩展（我们的 dshhost.cc 也这么写）。
napi_module g_probeModule = {
    1,             // nm_version
    0,             // nm_flags
    nullptr,       // nm_filename
    Init,          // nm_register_func
    "entryprobe",  // nm_modname
    nullptr,       // nm_priv
    {nullptr},     // reserved
};

}  // namespace

extern "C" __attribute__((constructor)) void RegisterEntryProbeModule() {
  napi_module_register(&g_probeModule);
}
