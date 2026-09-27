---
name: ohos-plugin-install
description: DSHM 端侧插件安装通道（pnpm/npm 假壳 + 文件队列 + Host 进程内安装器）。需要为 DSHM 安装 dsh 插件时阅读。
whenToUse: 用户要求安装插件（"装个插件" / dsh plugin add / pnpm add / npm install 等任何安装意图）时。
---

# DSHM 插件安装：直接 pnpm add（假壳会接住）

## 首选姿势：直接跑 pnpm/npm 命令

本机（DSHM 端侧）的 PATH 里有一个 **pnpm/npm 假壳**（Host 布置）：真包管理器不存在，
但 `pnpm add <spec>` / `npm install <spec>` 会被假壳改写为安装队列投递，**同步等待
Host 进程内安装器（dshm-installer.js）完成并返回 JSON 结果**。

```bash
pnpm add ms                  # npm 包
pnpm add @scope/pkg@^1.2.0   # 带 scope 与版本范围
pnpm add github.com/owner/repo   # GitHub 仓库（可加 #branch）
```

- 成功：打印 `.done` 的 JSON（`ok:true, installed:[…]`），退出码 0
- 失败：stderr 打印 `.fail` 的 JSON（`ok:false, error:…`），退出码 1
- 超过 90s 未完成：提示仍在后台安装，结果文件稍后出现在队列目录
- 不要用 `pnpm install`（无参）——端侧没有可解析的 package.json 场景；不要用
  `pnpm remove`——卸载请在 DSHM 设置→插件 切换停用

## 为什么是假壳（背景）

端侧没有真 pnpm/npm/git，也没有独立 node 可执行文件；上游 `dsh plugin add` 是
`spawnSync("pnpm", …)` 直接 ENOENT。假壳把这个事实封装掉：你按肌肉记忆写 pnpm，
队列协议在后面跑。

## 后备姿势：手动写队列（假壳不可用时）

假壳的本质是往 `$HOME/dsh/home/install-queue/` 写 `.req` 文件（一行 spec）。
如果 `pnpm -v` 都失败了（老版本 Host），手动走同样协议：

```bash
SPEC='要装的包名或仓库地址'
Q="$HOME/dsh/home/install-queue"
B="model-$(date +%s)"
printf '%s' "$SPEC" > "$Q/$B.req"
for i in $(seq 1 90); do
  sleep 2
  [ -f "$Q/$B.done" ] && { cat "$Q/$B.done"; rm -f "$Q/$B.done" "$Q/$B.fail"; exit 0; }
  [ -f "$Q/$B.fail" ] && { cat "$Q/$B.fail"; rm -f "$Q/$B.done" "$Q/$B.fail"; exit 1; }
done
echo "超时：Host 未回报结果（180s）"
```

## spec 支持范围

- npm 包名：`pkg` / `pkg@1.2.3` / `pkg@^1.2.0` / `@scope/pkg`
- GitHub：`github.com/owner/repo` / `https://github.com/owner/repo`（可加 `#branch`）
- 依赖会递归安装（深度 ≤3，同名已装跳过）；registry 默认 npmmirror，
  可用 `$HOME/dsh/home/installer.json` 的 `{"registry": "https://…"}` 覆盖

## 边界（如实告知用户，不给会失败的承诺）

- 含原生模块（.node）的插件装不了：沙箱禁 symlink/hardlink，tar 里的链接条目会被跳过并写进结果
- 声明 `dsh.bundle` 的插件：主包会装上，但 bundle 里的子插件组需按其 README 逐个安装/启用
- 安装成功后插件行已写入 profile，但**必须重启 DSHM 应用才挂载生效**——
  重启前 `pluginInventory` 里看不到它，这不是失败
- UI 侧同一通道：设置 → 插件 页有「安装插件」输入框，效果相同（.req 前缀是 `ui-`）
