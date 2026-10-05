# vendor 出处与纯度记录

本目录是 `hostcore/plugins/dshm-ptc-runtime-inproc/lib/ts-strip.cjs` 的**唯一**第三方依赖，
以**源码原样搬运**的方式 vendor 进来（不走 `node_modules`、不走包管理器解析）。

## 1. 是什么

| 项 | 值 |
|---|---|
| 包名 | `@babel/standalone` |
| 版本 | `7.28.4` |
| 许可 | MIT（原文见同目录 `LICENSE`） |
| 上游 tarball | `https://registry.npmmirror.com/@babel/standalone/-/standalone-7.28.4.tgz` |
| npm `dist.integrity` | `sha512-Qc1BNCfuJZBKs2SC5lqRmSYOw7Ka0X7urZQ7oVsGIax4eGDUIHX+CDg752N4jDxC2rbBh3li098ReGOtjT0x4g==` |
| 上游文件 | `<pkg>/babel.min.js`（原样改名而来） |
| 落地文件名 | `babel.min.cjs` |

### 为什么改名成 `.cjs`（这是**硬要求**，已经 A/B 实测）

本插件包的 `package.json` 里是 `"type": "module"`，因此同一目录树下的 `.js` 会被当成 ESM。

实测（Node v24.19.0，`--jitless`，把同一个 vendor 文件分别命名成两个后缀，其余逐字节不动）：

| 臂 | vendor 文件名 | 结果 |
|---|---|---|
| A | `babel.min.js` | **FAIL** —— `TypeStripError: api.transform is not a function` |
| B | `babel.min.cjs` | **OK** —— `"const a = 1;"` |

A 臂的机理：Node 的 `require(esm)`（Node 23+ 默认开启）把这份 **UMD** 文件当 ESM 加载，
UMD 包装里 `typeof exports === 'object' && typeof module !== 'undefined'` 这个分支
在 ESM 下不成立 ⇒ 它不会写 `module.exports` ⇒ `require()` 拿到一个**空命名空间**
⇒ 上层报 `api.transform is not a function`（错得莫名其妙、离根因很远）。

`.cjs` 扩展名强制 CommonJS 解析，正好匹配上游那个 UMD 包装。
门禁的 `XB.4 vendor 与擦除器必须是 .cjs` 一条会读插件 `package.json` 的 `type`，
在 `"type":"module"` 时断言两个文件都是 `.cjs` —— 防止有人"顺手"改回 `.js`。

### 为什么 vendor 这个包（而不是 sucrase / typescript）

见 `../ts-strip.cjs` 文件头的"vendor 选型"一节。一句话：sucrase 更小但实测
**把所有 `namespace` 形式静默擦成空串**（静默产出坏代码，淘汰）；`typescript@5.9.3`
的单文件 `lib/typescript.js` 是 **9 112 572 B**，是本方案 **3 069 546 B** 的 2.97 倍，
且它只给字符 offset、要自己做 offset→行列映射。`@babel/standalone` 是单个自包含文件、
零运行时依赖、直接给 `err.loc`，且在 12 类用例上全部正确。

## 2. 体积与摘要（可复核）

```
babel.min.cjs   3 069 546 B   sha256 = 254d0fe4bd4a17bcceb0623a467de5f69e9938ee07de3bff9851dcb94adeb03d
LICENSE             1 106 B
--------------------------------------------------------------
有效载荷合计    3 070 652 B   (2.93 MiB)   ← 不含本说明文件 PROVENANCE.md
```

这两个数字（字节数 + sha256）**同时**被写进 `ts-strip.cjs` 的 `VENDOR` 常量，
并会被门禁 `tools/check-ptc-ts-strip.mjs` 每次运行核对。也就是说：
注释里写的、树里躺的、门禁验的，必须是同一个文件；谁被悄悄换掉都会红。

## 3. 纯度审计：没有 wasm、没有原生模块

任务要求"vendor 的东西必须是纯 JS——不许有 `.wasm` 文件、不许在加载/执行路径里出现
`WebAssembly`、不许有原生 `.node`"。逐条结论与复核命令：

### 3.1 树里没有任何 wasm / 原生 / 二进制

```powershell
# 列出 vendor 全树（应当只有 babel.min.cjs、LICENSE、PROVENANCE.md 三个文件）
Get-ChildItem -Recurse -File hostcore/plugins/dshm-ptc-runtime-inproc/lib/vendor |
  Select-Object FullName, Length

# 扩展名扫描：.wasm / .node / .dll / .so / .dylib / .a / .lib / .exe 一个都不该有
Get-ChildItem -Recurse -File hostcore/plugins/dshm-ptc-runtime-inproc/lib/vendor |
  Where-Object { $_.Extension -in '.wasm','.node','.dll','.so','.dylib','.a','.lib','.exe' }
# （无输出 = 通过）

# 二进制嗅探：这几个文件都不含 NUL 字节（都是文本）
Get-ChildItem -Recurse -File hostcore/plugins/dshm-ptc-runtime-inproc/lib/vendor |
  ForEach-Object {
    $b = [IO.File]::ReadAllBytes($_.FullName)
    $n = [Math]::Min(8192, $b.Length)
    "$($_.Name)  len=$($b.Length)  NULinFirst8K=$(($b[0..($n-1)]) -contains 0)"
  }
```

同一件事也被门禁固化：`vendor 树是纯 JS：无 .wasm / 无原生模块 / 无二进制 / 无符号链接`
一条断言在每次跑门禁时重新扫一遍全树（不是一次性人工检查）。

### 3.2 `WebAssembly` 只以**字符串字面量**形式出现，共 3 处，且都不在 `transform()` 路径上

```powershell
$f='hostcore/plugins/dshm-ptc-runtime-inproc/lib/vendor/babel-standalone/babel.min.cjs'
([regex]::Matches((Get-Content $f -Raw),'WebAssembly')).Count        # → 3
([regex]::Matches((Get-Content $f -Raw),'\.wasm')).Count             # → 0
```

三处的性质（已逐处取出上下文核对）：

1. 一份**浏览器 DOM 全局构造器名清单**里的一个字符串元素
   （`…,"VirtualKeyboard","VisibilityStateEntry",…,"WebAssembly","WebGL2RenderingContext",…`）——
   这是 `@babel/preset-env` 的兼容性数据表，只被"列出全局名"时才读，且读的是**字符串**。
2. / 3. 两份 **core-js `web.*` 模块描述表**里的键
   （`WebAssembly:{CompileError:…,LinkError:…,RuntimeError:…}`）——
   同样是数据，不是对全局 `WebAssembly` 的取值；而且只有启用 `preset-env` + polyfill 注入
   才会去构造它。

本插件**只**注册 `transform-typescript` 插件，`presets` 是空的，压根不走 preset-env。

### 3.3 但"grep 不到"不是证据——门禁用的是**运行时陷阱**

上面 3.2 只说明"字符串层面干净"。真正被断言的结论是运行时事实：门禁在一个
`node --jitless` 子进程里，把 `globalThis.WebAssembly` 换成一个
**读或写都会计数并抛错**的 getter，然后才 `require` 本插件、跑完全部用例。

（能被装上是因为实测 `--jitless` 下 `globalThis` 上**没有** `WebAssembly` 自有属性，
`Object.getOwnPropertyDescriptor(globalThis,'WebAssembly')` 返回 `undefined`。）

跑完断言 `陷阱触发次数 === 0`。这比 grep 强：它连"`typeof WebAssembly` 探一下"这种
读操作都算失败，而且覆盖的是**真实的执行路径**而不是源码文本。

### 3.4 同一进程里的对照臂

门禁还会在**装陷阱之前**调用官方 `node:module.stripTypeScriptTypes`，实测它在同一个
`--jitless` 进程里抛 `ERR_WEBASSEMBLY_NOT_SUPPORTED`。这条对照臂的意义是证明
"门禁确实在测那个真问题"，而不是自己跟自己玩。

> 注：这条对照臂**必须**在装陷阱之前跑。官方实现内部会去读 `WebAssembly` 全局，
> 若在装陷阱之后探测，陷阱会被官方实现触发、把"擦除器碰没碰过 wasm"的计数污染掉。
> 这个顺序在 `tools/check-ptc-ts-strip.mjs` 里有注释说明。

## 4. 怎么升级

1. 在**仓库外**的临时目录 `npm install @babel/standalone@<新版本>`；
2. 用新的 `babel.min.js` 覆盖 `babel.min.cjs`（同时更新 `LICENSE`）；
3. 更新 `ts-strip.cjs` 里 `VENDOR` 的 `version` / `bytes` / `sha256` / `npmIntegrity`；
4. 更新本文件的第 1、2 节；
5. 跑 `node tools/check-ptc-ts-strip.mjs --self-test`，必须 `FAIL 0` 且 `陷阱触发次数 = 0`。

**不要**用 sucrase 顶替：它对 `namespace` 的静默丢失是硬缺陷（门禁用例 12.2 就是为它准备的）。
