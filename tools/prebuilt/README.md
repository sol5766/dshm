# tools/prebuilt

本目录存放 koffi 的预编译 OpenHarmony arm64 原生模块。

## ⚠️ `koffi-3.2.1-ohos-arm64.node` 是已知损坏的历史产物，不要使用

这是一个**没有构建配方的黑盒产物**：链接时**漏掉了 koffi 自己的基础库**
`koffi/lib/native/base/base.cc`（上游 `koffi/src/koffi/CMakeLists.txt` 的 `KOFFI_SRC`
明确包含 `../../lib/native/base/base.cc`）。

后果：产物内有 18 个 `K::` 符号为 UND，设备端 dlopen 重定位失败，进而导致 dsh 插件树
加载失败、应用起不来：

```
Error relocating /data/storage/el1/bundle/libs/arm64/libkoffi.so:
    _ZN1K16PrintAssertErrorEPKciS1_: symbol not found
=== SIGNAL 6 (Aborted) ===
```

完整定位过程见 `.agent-rules/bug-log.md` 的 `[2026-09-11]` 条目。

## ✅ 支持的构建方式

```powershell
# 从包内源码完整重建自包含的 entry/libs/arm64-v8a/libkoffi.so
# （含 base.cc；脚本内置自检，产物若仍残留 K:: 未定义符号会直接失败）
& scripts/build-koffi-ohos.ps1
```

- 输入：`entry/src/main/resources/rawfile/dsh/node_modules/koffi`（随 npm 依赖树落盘）
- 输出：`entry/libs/arm64-v8a/libkoffi.so`（hvigor 会把它装到
  `/data/storage/el1/bundle/libs/arm64/`，那里是沙箱唯一允许 dlopen 原生模块的位置）
- 编译器：DevEco Studio 自带 OHOS clang（`sdk/default/openharmony/native/llvm`）

源文件列表严格对齐上游 `KOFFI_SRC` 的 arm64 分支：`ffi/call/interp/parser/type/util/uv/win32.cc`
+ `abi/arm64.cc` + `abi/arm64_asm.S`（内部 `#include "gnu.inc"`，由 `trampolines.cjs` 生成）
+ `lib/native/base/base.cc`。

## 为什么不"单独编一个 base 库再预加载"

**OHOS/musl 链接器对 dlopen 的对象只在该对象自身的 `DT_NEEDED` 闭包内解析符号，
不查全局作用域。** 已实测：即便用 `RTLD_GLOBAL` 预加载一个导出全部 K:: 符号的 `.so`，
koffi 的重定位依然报 `symbol not found`（`dlsym(RTLD_DEFAULT, …)` 明明能找到该符号）。

这同时解释了为什么同目录的 `libpty_host.so` 能正常加载 —— 它的 `DT_NEEDED` 里有
`libnode.so.137`，而 N-API 符号正是从那里解析的。

**结论：缺失符号必须编进 `libkoffi.so` 本身。**

## ⚠️ 删除本目录文件的连带影响

`scripts/apply-dsh-ohos-adapt.sh` 用 `[ -f "$KOFFI_PREBUILT" ]` 判断走
「真 koffi + koffi 加载器补丁」还是「写入 koffi stub 回退」。**直接删掉
`koffi-3.2.1-ohos-arm64.node` 会让环境刷新时把 koffi 换成 stub（FFI 不可用）。**
若要移除该文件，必须同步修改那段判断的条件。
