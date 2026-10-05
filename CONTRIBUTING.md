# 贡献指南

感谢你有兴趣改进 DSHM。本文件说明本仓库接受的贡献方式，以及必须遵守的约定。

## 先开 Issue 还是直接提 PR

| 类型 | 建议 |
|---|---|
| Bug 报告 | 先开 [Issue](https://github.com/sol5766/dshm/issues/new/choose) |
| 新功能 / 架构改动 / 新形态适配 | **先开 Issue 讨论** —— 避免做完才发现方向不一致 |
| 文档修正、明显笔误、局部小修复 | 直接提 PR |
| 安全漏洞 | **不要开公开 Issue**，见 [`SECURITY.md`](SECURITY.md) |

## 开发环境

前置：

- DevEco Command Line Tools（含 hvigor / ohpm / codelinter / SDK）
- JDK 17
- Node.js（仅用于仓库内的构建与检查脚本）
- Python 3（`tools/sign-tar-elf.py` 用它的 `tarfile` 改写工具链归档；Windows 上只有它能在保住归档内 symlink 的前提下改字节）

**本仓库不含**原生库、核心包、工具链归档、入口脚本、Node 头文件与签名材料 —— 它们是构建产物或机器绑定材料。完整清单与获取方式见根 `README.md` 的「不入库的产物」表。

构建与安装：

```bash
devecocli build
hdc install -r entry/build/default/outputs/default/entry-default-signed.hap
```

## 动手前必读：真机数据保全

**禁止**执行 `hdc uninstall` / `bm uninstall`，或任何删除 `/data/app/el2/...` 的命令。

`el2` 下是用户数据（会话 / 插件 / 工作区），**没有任何可用备份通道**（`hdc` 读不到、`smode` 被拒、`run-as` 不存在），删掉不可恢复。本项目已因此丢过一次真实数据，事故复盘见 [`AGENTS.md`](AGENTS.md)。

判断依据只有一条：**这条命令会不会碰 `el2`？会，就是禁止的。**

装机一律用覆盖安装 `hdc install -r <hap>` —— 它只换 `el1`（代码与资源），不动 `el2`。

## 回归纪律

不允许「修好后面、前面又坏」。

1. **改动前**先跑基线并记录结果
2. **改动后**跑同一批，逐项对比；任何 ok → fail 必须当场修，不许延后
3. **临时实验**（例如交换两行顺序做对照）必须在**同一次改动内**还原，验证到的结论写进代码注释，而不是留下实验代码

提 PR 前至少让这批通过：

```bash
node tools/assert-cli-shim.mjs
node tools/assert-resfile-sync.mjs
node tools/check-parity.mjs
node tools/compat-drift.mjs
node tools/assert-exec-fix.mjs
node tools/assert-python-bridge.mjs
node tools/assert-fs-search-fallback.mjs
node tools/check-fetch-mirror.cjs
```

> **权威清单是 `AGENTS.md` 的「必跑的回归门禁」块**（当前 16 项：15 条 node + `device-acceptance.ps1`，另含
> `check-web-fetch-jitless` / `check-worker-jitless` / `check-internal-undici` / `check-skill-sync.cjs` /
> 3 条 PTC 门禁 / `check-core-openharmony-patches.mjs`）。上面这段是**给人类贡献者的最小集**（跑得快、覆盖面广）；两者若不一致，
> **以 `AGENTS.md` 为准**（此处不再复制全清单，避免两处分叉——2026-10-05 审计发现过一次分叉）。

`tools/` 下另有专项门禁（设计令牌棘轮、文档引用、布局断言、上架红线、协议往返、原生闭包等）。改动涉及哪个面就跑哪个；不确定时全跑一遍。

其中 `check-sidebar-tab-id-guard.mjs` 守的是 `pack-core` 对核心树打的行为补丁（侧栏页签 id 守卫）：它把随包发布的源码原文抽出来放进壳里跑。前置是已跑过 `node tools/pack-core.mjs --skip-install`；未跑过时它以退出码 2 明确报「前置条件缺失」，不会伪装成通过。

`check-undici-shim-exports.mjs` 守的是 undici 垫片的**具名导出面**：它从垫片本体 `import()` 取真实导出，再把核心树全部 `from 'undici'` 的具名列表逐个比对。这条故障的症状是**不说话**的 —— ESM 具名导入在解析期校验导出存在性，缺一个名字就让整个模块图 `failed to import`，而 loader 只打一行 `… failed to import`、**不给 reason**（历史上已踩两次：2026-09-24 缺 `EnvHttpProxyAgent`；2026-10-03 缺 `Pool`/`ProxyAgent`）。它同样以退出码 2 报前置条件缺失。

`check-fetch-mirror.cjs` 守的是出网镜像改写（端侧 `raw.githubusercontent.com` 被阻断的兜底）：全离线跑，起本地服务当镜像，断言哪些主机被改写、哪些必须放行。

## 提交信息

采用 [Conventional Commits](https://www.conventionalcommits.org/) 前缀：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`，可带范围，如 `fix(security): ...`。

标题可用中文 —— 本项目的提交历史以中文描述为主。

## PR 约定

- **一个 PR 只做一件事。** 混装改动会让 review 无法逐项判断。
- 描述里写清：**改了什么、为什么、怎么验证的**。
- 涉及界面或端侧行为的改动，附真机截图或录像（含设备型号与核心版本）。
- **不要为了让门禁变绿而放宽门禁阈值。** 调阈值等于改判据，需要单独开 Issue 讨论。
- 改动 `hostcore/**` 后必须跑 `node tools/place-host-app.mjs`，并确认 `assert-resfile-sync` 通过。

## 合并

所有改动经维护者 review 后由维护者合并。`main` 受分支保护：不接受直推，且禁止强推与删除。

## 许可

本仓库代码采用 [MIT](LICENSE)。提交即表示你同意以同一许可分发你的贡献（inbound = outbound）。
