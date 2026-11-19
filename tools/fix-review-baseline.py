#!/usr/bin/env python3
"""Read-only inventory; never prints signing configuration contents."""
import hashlib
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist/acceptance/fix-review-dual-release'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    OUT.mkdir(exist_ok=True)
    status = subprocess.check_output(['git', 'status', '--porcelain=v1', '-z'], cwd=ROOT)
    paths = ['AppScope/app.json5', 'build-profile.json5', 'hostcore/core-recipe.json',
             'entry/src/main/module.json5', 'phone/src/main/module.json5',
             'hostruntime/src/main/module.json5']
    paths += [str(p.relative_to(ROOT)) for p in
              (ROOT / 'hostruntime/src/main/resources/resfile').glob('dsh-core-*.zip')]
    lines = ['# 修改前保全基线', '',
             '应用：com.dshm.dshclient，1.1.8 / 1010016；核心：0.2.2-rc.2+dshm.1。',
             '权限顺序及reason由T002当前实跑判定；下列摘要钉住原始配置，不输出签名配置内容。',
             '现有git status记录数：%d；原始状态字节SHA256：%s。未提交/重置。' %
             (len(status.split(b'\0')) - 1, hashlib.sha256(status).hexdigest()), '',
             '| 文件 | 大小 | SHA256 |', '|---|---:|---|']
    for name in paths:
        p = ROOT / name
        lines.append('| %s | %d | %s |' % (name, p.stat().st_size, digest(p)))
    lines += ['', '## 11项处置表（实施前，均未修复）', '',
              '| ID | 最小处置边界 |', '|---|---|',
              '| DR1 | 唯一拥有探测目录；不损伤预存文件；保守失败 |',
              '| E01 | 完整npm名称、版本、alias及Git意图 |',
              '| B01 | 失败/取消/重试引用配平，保留PC策略 |',
              '| E04 | 代次、runner提交和UI回填隔离，不承诺撤回外部副作用 |',
              '| E02 | 每次自动重扫映射及遗漏反馈，无手动UI |',
              '| D01 | manager真实remove/install/recover保旧，保留官方previous恢复；附属tmp TDZ |',
              '| E03 | 流式摘要、同内容skip、异内容冲突不覆盖、缺sha拒绝 |',
              '| E05 | 完整unit及不可变快照，同源hash/size，登记后不盲删 |',
              '| C01 | worker退出作正常完成，保留8秒/10秒上限 |',
              '| FR1 | 内容stamp；旧缺坏安全重装，保留事务及用户数据 |',
              '| CR2 | 仅修卸载日志作用域；保留Cordis隔离 |', '',
              '边界：这是当前文件保全摘要，不是真机功能、签名有效性或应用包核验。']
    (OUT / 'baseline.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('WROTE dist/acceptance/fix-review-dual-release/baseline.md')


if __name__ == '__main__':
    main()
