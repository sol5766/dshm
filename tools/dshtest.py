"""
DSHM 端侧功能测试支撑库。

【设计原则】
  1. **坐标来自 uitest dumpLayout，不猜**（本项目的历史教训：
     "图形歪四轮"的根因就是在截图里找像素）。
  2. **断言用产物/状态，不用"看起来正常"**。可用的硬证据通道：
       · ArkUI 树（uitest dumpLayout）—— 界面元素及其文字/坐标
       · 应用写出的 diag 文件 —— 桥自己留下的原始证据
       · 宿主日志 dshm-host.log —— 启动/探测/请求
       · 端口 13120 转发后的 HTTP —— 后端存活
  3. 每个测试**独立可重跑**，失败给出可复现的现场（dump 落盘）。
"""
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 【2026-09-28 清理】原先是写死的占位符
#   HDC = r'%USERPROFILE%\AppData\Local\OpenHarmony\Sdk\<版本>\toolchains\hdc.exe'
#   ART = Path(r'<仓库绝对路径>\dist\_func_test')
# 前者在任何机器上都不可用（subprocess 不做 %VAR% 展开），后者把仓库路径写死。
# 改为按 DSHM_HDC → PATH → DevEco 工具链目录 依次解析；产物目录相对仓库根。


def _find_hdc():
    """按 DSHM_HDC → PATH → DevEco Studio 自带工具链 找 hdc。找不到返回原占位串（跑起来自然报错）。"""
    env = os.environ.get('DSHM_HDC')
    if env and Path(env).exists():
        return env
    onpath = shutil.which('hdc') or shutil.which('hdc.exe')
    if onpath:
        return onpath
    roots = [
        os.environ.get('DEVECO_SDK_HOME'),
        os.environ.get('OHOS_SDK_HOME'),
        r'C:\Program Files\Huawei\DevEco Studio\sdk',
        '/home/node/deveco-clt/command-line-tools/sdk',
    ]
    names = ('hdc.exe', 'hdc')
    for root in roots:
        if not root or not Path(root).is_dir():
            continue
        for name in names:
            for hit in sorted(Path(root).rglob('toolchains/' + name)):
                return str(hit)
    return '<hdc 未找到：设 DSHM_HDC 或把它放进 PATH>'


HDC = _find_hdc()
APP = 'com.dshm.dshclient'
FILES = f'/data/app/el2/100/base/{APP}/haps/entry/files'
ART = ROOT / 'dist' / '_func_test'
ART.mkdir(parents=True, exist_ok=True)


def sh(cmd, timeout=120):
    """跑一条 hdc shell 命令，返回 stdout（已去尾空行）。"""
    r = subprocess.run([HDC, 'shell', cmd], capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=timeout)
    return (r.stdout or '').strip()


def sh_bytes(cmd, timeout=120):
    r = subprocess.run([HDC, 'shell', cmd], capture_output=True, timeout=timeout)
    return r.stdout or b''


def hdc(*args, timeout=60):
    """跑一条**宿主侧** hdc 命令（不带 `shell`），返回 stdout。

    【为什么必须有这个函数】`fport` / `list targets` / `install` 是 **hdc 自己的**子命令，
    不是设备上的可执行文件。写成 `sh('fport tcp:13120 tcp:3120')` 时会变成
    `hdc shell "fport …"` ⇒ 设备上 `/bin/sh: fport: inaccessible or not found`，
    而 hdc 把设备侧 127 也当成功返回（exit 0）⇒ **端口转发从未建立，断言却看起来只是"HTTP ERR"**。
    2026-09-30 实测踩到：`dist/_func_test_run.log` 里 T0.4 报 `HTTP ERR`，真因是这个。
    """
    r = subprocess.run([HDC, *args], capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=timeout)
    return (r.stdout or '').strip()


def _fport_line(ls_out, node):
    """在 `fport ls` 输出里找出含该节点的那一行。

    行格式：`86E0226429000417    tcp:13120 tcp:3120    [Forward]`（列宽可能变）。
    """
    for line in (ls_out or '').splitlines():
        if node in line:
            return line.strip()
    return ''


def fport(local, remote):
    """确保宿主→设备的端口转发就绪，返回 (ok, 输出)。

    【为什么判据必须以 `fport ls` 为准，而不是看建映射命令的返回】
    2026-09-30 实测（本机 hdc 6.x）：
      - `fport rm tcp:13120` 回 `[Fail]Remove forward ruler failed, ruler is not exist`，
        而 `fport ls` 里**明明有**这条 ⇒ rm 的匹配键与 ls 展示的不是一回事，删不掉；
      - 旧映射还在时再 `fport tcp:13120 tcp:3120` 回 `[Fail]TCP Port listen failed`，
        **但旧映射照常可用** ⇒ 只看返回值会把"已经能用"误判成"没建立"
        （首轮 T0.4 就是这样：报 `fport 未建立`，HTTP 却拿到 401 而 PASS）；
      - 以上两条的 **exit code 都是 0**，退出码在这条链路上完全不可用。
    故：已有正确映射就直接复用；已映射到别处则 fail loud，绝不静默当成成功。
    """
    want = f'tcp:{local}'
    line = _fport_line(hdc('fport', 'ls'), want)
    if line:
        if f'tcp:{remote}' in line:
            return True, f'已存在：{line}'
        return False, f'{want} 已映射到别处：{line}（本机 hdc 的 fport rm 删不掉，需手工处理）'
    out = hdc('fport', f'tcp:{local}', f'tcp:{remote}')
    line2 = _fport_line(hdc('fport', 'ls'), want)
    if line2 and f'tcp:{remote}' in line2:
        return True, f'新建：{line2}'
    return False, f'{out} | ls 无该映射'


# ── 界面 ─────────────────────────────────────────────────────────────────
def dump_layout(tag='layout'):
    """取 ArkUI 树并落盘（失败返回 None）。"""
    sh('rm -f /data/local/tmp/_ui.json')
    sh('uitest dumpLayout -p /data/local/tmp/_ui.json')
    raw = sh('cat /data/local/tmp/_ui.json')
    if not raw:
        return None
    (ART / f'{tag}.json').write_text(raw, encoding='utf-8')
    try:
        return json.loads(raw)
    except Exception:
        return None


def walk(node, out=None):
    """展平 ArkUI 树为 [{text, desc, bounds, clickable, type}]。"""
    if out is None:
        out = []
    if not isinstance(node, dict):
        return out
    a = node.get('attributes') or {}
    out.append({
        'text': a.get('text') or '',
        'desc': a.get('description') or '',
        'bounds': a.get('bounds') or '',
        'clickable': a.get('clickable'),
        'enabled': a.get('enabled'),
        'type': node.get('type') or '',
        'id': a.get('id') or '',
    })
    for c in (node.get('children') or []):
        walk(c, out)
    return out


def find(nodes, *needles, field=('text', 'desc')):
    """在展平结果里找含任一字样的节点。"""
    hits = []
    for n in nodes:
        s = ''.join(str(n.get(f, '')) for f in field)
        if any(x in s for x in needles):
            hits.append(n)
    return hits


_BOUND = re.compile(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]')


def bounds_of(bounds):
    """'[x1,y1][x2,y2]' → (x1,y1,x2,y2)；解析不了返回 None。

    与 center() 共用同一条正则（_BOUND），避免两套解析在界面上给出不同答案。
    """
    m = _BOUND.search(bounds or '')
    if not m:
        return None
    return tuple(map(int, m.groups()))


def center(bounds):
    """'[x1,y1][x2,y2]' → 中心点 (x,y)。"""
    b = bounds_of(bounds)
    if not b:
        return None
    x1, y1, x2, y2 = b
    return ((x1 + x2) // 2, (y1 + y2) // 2)


def tap(x, y):
    sh(f'uitest uiInput click {x} {y}')


def tap_text(*needles, tag='tap'):
    """按文字找元素并点击；返回是否点到。"""
    lay = dump_layout(tag)
    if not lay:
        return False, 'dumpLayout 失败'
    nodes = walk(lay)
    hits = find(nodes, *needles)
    hits = [h for h in hits if center(h['bounds'])]
    if not hits:
        return False, f'未找到 {needles}'
    c = center(hits[0]['bounds'])
    tap(*c)
    return True, f'点击 {hits[0]["text"] or hits[0]["desc"]} @ {c}'


# ── 应用 ─────────────────────────────────────────────────────────────────
def restart(wait=35):
    sh(f'aa force-stop {APP}')
    time.sleep(2)
    sh(f'aa start -a EntryAbility -b {APP}')
    time.sleep(wait)


def read_file(name):
    return sh(f'cat {FILES}/{name}')


def tail_file(name, n=1):
    return sh(f'tail -n {n} {FILES}/{name}')


def ls_files(pattern='diag-*'):
    return sh(f'ls -la {FILES}/{pattern} 2>/dev/null')


def host_log_tail(n=40):
    return sh(f'tail -n {n} {FILES}/dshm-host.log')


def clear(name):
    sh(f'rm -f {FILES}/{name}')


# ── 断言 ─────────────────────────────────────────────────────────────────
class Result:
    def __init__(self):
        self.rows = []

    def check(self, tid, name, ok, detail=''):
        self.rows.append((tid, name, bool(ok), detail))
        mark = 'PASS' if ok else 'FAIL'
        print(f'  [{mark}] {tid} {name}' + (f'  — {detail}' if detail else ''))

    def report(self):
        p = [r for r in self.rows if r[2]]
        f = [r for r in self.rows if not r[2]]
        return len(p), len(f), f
