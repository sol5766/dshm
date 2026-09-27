# hostcore —— 端侧 dsh 核心的构建期事实来源

> 这个目录**不是** ArkTS 模块（没有 `oh-package.json5`），它是**打包期**的数据与配方。
> 运行期的 ArkTS 代码在 `hostruntime/`（见 D6 §2）；本目录只被 `tools/pack-core.mjs` 读取。

## 内容

| 文件 | 作用 |
|---|---|
| `core-recipe.json` | **唯一事实来源**：核心版本、平台（openharmony/arm64）、把硬原生依赖别名到鸿蒙移植版的 overrides、裁剪规则、必需原生产物清单 |
| `profile/ondevice/package.json` | 端侧 profile 的组合（`dsh.profile.bundles` = base + web-app，`patchReload: startup`） |
| `profile/ondevice/cordis.patch.yml` | 端侧 profile 的**用户 patch 层**。阶段一故意为空（不覆盖任何 dsh 行），以便先回答"三个鸿蒙移植件能不能加载"；某行被实测证伪后才在此加 `{id, disabled: true}` 并附证据 |

## 用法

```sh
# 物化 + 裁剪 + 校验签名 + 打包（约 5 分钟，主要花在 npm install）
node tools/pack-core.mjs

# 只重打包（复用已有 node_modules，秒级）
node tools/pack-core.mjs --skip-install

# 产物
# 产物（放 dist/ 而不是根 build/：根 build/ 属于 HarmonyOS 构建，devecocli build 会清掉它）
#   dist/core/dsh-core-<ver>-openharmony-arm64.zip     ← 随应用分发的容器（zip，见 D6 §4.2 R5）
#   dist/core/dsh-core-<ver>.manifest.json             ← 版本/体积/条目数/sha256/原生签名清单
#
# 加 --place-in-app 会把 zip 复制到 entry/src/main/resources/resfile/（随 HAP 分发；该文件不入库）
node tools/pack-core.mjs --place-in-app
```

`build/` 已被 `.gitignore` 忽略：**分发产物不进版本库**，进版本库的是"如何生产它"。

## 为什么是这些选择（都有实测依据）

| 选择 | 依据 |
|---|---|
| `npm install --os=openharmony --cpu=arm64` | 让 npm 按鸿蒙平台解析依赖，宿主（Windows）也能物化出端侧形态 |
| `overrides` 别名到 `@ohos-ports/*` | dsh 的 `node-pty` / `koffi` / `sharp` 是**硬**原生依赖，缺失会让 dsh 的 `boot()` 直接 `exit(1)`（fail-loud，见 D6 §5） |
| 裁剪非鸿蒙二进制 | `koffi` 一个包自带 19 个平台的 `.node`；裁剪后解包体积 292.8 MB → 207.3 MB |
| 校验 `.codesign` | 鸿蒙商用版拦截未签名 ELF；**只有 `.note.ohos.ident` 不算已签名**（实测对照见 D6 §4.2 R4） |
| 容器用 zip | 鸿蒙侧只有 `@ohos.zlib.decompressFile`（zip），没有 tar/gzip 等价 API |
| 自带最小 zip 写入器 | 避免依赖外部 `zip` 工具；固定时间戳 ⇒ 同输入产出逐字节相同的包。已用独立的 .NET `ZipFile` 读取器交叉验证（28982 条目一致、内容往返正确） |

## 已知的、尚未处理的事（不要当成已完成）

- **`--ignore-scripts`**：目标平台的原生模块 postinstall 在宿主上跑不了，所以跳过。若某个包依赖 postinstall 产物，需要在配方里显式补。
- **`koffi` 是 2.x 而 dsh 0.1.5-rc.2 声明 `^3.1.4`**：overrides 强制降级，API 是否兼容**尚未验证**。这是 D6 §5.1 里要逐个验证的第一项。
- **裁剪可能过度**：`node-pty/scripts`、`node-pty/third_party` 已删；目前只做了静态判断，**没有在设备上跑过**。
- **签名只验了"段存在"**，没有验证签名与 HAP 的签名链是否匹配（要等真机加载才算数）。
