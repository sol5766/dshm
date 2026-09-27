# electron-runtime —— 阶段一的运行时载体（Electron-on-鸿蒙）

> 这一目录处理的是 D6 §4.1「阶段一」：复用 Electron-on-鸿蒙 运行时，**只把它当 Node 用**，
> 快速把「端侧起 Host + 现有 ArkUI 页面接上」这条链路打通。
> 上架形态仍是阶段二（自建 `libnode.so`，见 `tools/node-runtime/`），因为本运行时自带 Chromium
> 与带 JIT 的 V8，与「不申请特殊权限、各端统一 jitless」（D6 §4.4）不一致。

## 这个产物从哪来（**无法自动下载，必须人工获取**）

Huawei DevCloud CodeHub，**需要华为账号登录、没有公开 URL**。本仓库根目录下的
`v37.2.3-20260825.1-release.zip` 就是它（353.3 MB）。相关工程：
`gitcode.com/CPF-Electron/Electron`（分支 `v37.2.0-openharmony` / `v34.0.2-openharmony` / `v40.1.0-openharmony`）。

## 用法

```powershell
# 解包（产物落在 dist/electron/，已在 .gitignore 中）
& tools\electron-runtime\extract.ps1
# 指定 zip：& tools\electron-runtime\extract.ps1 -ZipPath 'D:\path\to\v37.2.3-...-release.zip'

# 校验原生库的 ELF 类型与签名状态
& tools\electron-runtime\verify.ps1
```

## 已实测的结构与结果（2026-09-13）

release zip 里只有 **一个** 条目：`libelectron_138.tar.gz`（373.9 MB）。解开后 296 条目，关键路径：

| 路径 | 大小 | 说明 |
|---|---|---|
| `libelectron/ohos_hap/electron/libs/arm64-v8a/libelectron.so` | **172.7 MB** | 运行时主体（Chromium + Node） |
| `libelectron/ohos_hap/electron/libs/arm64-v8a/libadapter.so` | 7.33 MB | ArkTS 桥接层 |
| `libelectron/ohos_hap/electron/libs/arm64-v8a/libffmpeg.so` | 2.10 MB | 媒体 |
| `libelectron/ohos_hap/electron/libs/arm64-v8a/libc++_shared.so` | 1.20 MB | 从 OHOS SDK 的 `native/llvm/lib/aarch64-linux-ohos/` 复制而来（包里没有） |
| `libelectron/ohos_hap/{electron,web_engine,hvigor,AppScope}` | — | 可直接作为模块引入的两个模块 + 工程配置 |
| `libelectron/lib.unstripped/*` | 1.19 GB | 未 strip 的符号版本，**解包时已排除** |

### 签名状态（重要，别误读）

`llvm-readelf -S` 实测：`libelectron.so` / `libadapter.so` / `libffmpeg.so` / `libc++_shared.so`
**四个都只有 `.note.ohos.ident`，没有 `.codesign`**——即**未签名**。

为什么仍然可用（这是有依据的判断，不是乐观）：
- 鸿蒙的 XPM 拦截的是**执行**未签名二进制（社区方案里被拒绝的正是 `resources/resfile/electron` 这个**可执行路径**）；
- 而这四个 `.so` 是**随 HAP 打包、由 `dlopen` 加载**的，签名的覆盖面来自 **HAP 自身的签名**；
- 同一批产物已被社区工程在真机（HarmonyOS 6.1.0.135 / API 24）上跑通。

**但这仍是风险项**：若平台对 in-HAP 的 `.so` 也强制要求代码签名，就需要用
`binary-sign-tool` 或 `ohos-bst-light` 的 `self-sign.py` 补签之后再打包。

## 踩过的三个坑（都已在脚本里固化为注释，别重复踩）

1. **`.ps1` 必须保持纯 ASCII**。Windows PowerShell 5.1 按 ANSI(GBK) 读 `.ps1`，
   UTF-8 的中文注释会被解成乱码，且**尾部字节会吞掉下一行**（实测表现为
   `Test-Path : ... 'Path' because it is null`，而赋值语句整行消失）。
2. **用 Windows 自带 bsdtar，不要用 PATH 上的 tar**。PATH 上是 Git 的 GNU tar，
   它把 `D:\...` 当远程主机（`Cannot connect to D: resolve failed`）；
   `C:\Windows\System32\tar.exe` 原生支持盘符。
3. **写成员列表必须无 BOM**。PS 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
   bsdtar 于是把首个成员读成 `\ufefflibelectron` → `Not found in archive`。
   另外包里有两个中文名 PDF，会让 bsdtar 整包解压失败（`Invalid empty pathname`），
   所以脚本改成**先生成成员列表、排除 docs/ 与 lib.unstripped/、再用 `-T` 选择性解包**。
