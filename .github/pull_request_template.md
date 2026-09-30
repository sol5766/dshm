## 改了什么

<!-- 一句话说清这个 PR 做了什么 -->

## 为什么

<!-- 关联的 Issue：Closes #___ -->

## 怎么验证的

- [ ] 基础门禁全绿：`assert-cli-shim` · `assert-resfile-sync` · `check-parity` · `compat-drift` · `assert-exec-fix` · `assert-python-bridge` · `assert-fs-search-fallback`
- [ ] 改动涉及的专项门禁已跑（设计令牌 / 文档引用 / 布局断言 / 上架红线 / 协议往返 / 原生闭包 …）
- [ ] 真机验证（如涉及端侧行为）：设备型号 / 核心版本 / 观察到的结果
- [ ] 未使用 `hdc uninstall` 或任何会删除 `el2` 的命令

## 影响面

<!-- 改了哪些目录；是否触及上游协议面（dshcompat/）、门禁判据、profile 参数 -->

## 备注

<!-- 有没有需要 review 时特别留意的取舍或已知限制 -->
