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
import re
import subprocess
import time
from pathlib import Path

HDC = r'%USERPROFILE%\AppData\Local\OpenHarmony\Sdk\<版本>\toolchains\hdc.exe'
APP = 'com.dshm.dshclient'
FILES = f'/data/app/el2/100/base/{APP}/haps/entry/files'
ART = Path(r'D:\desktop\temp\desktop.ohos.arm64\dist\_func_test')
ART.mkdir(parents=True, exist_ok=True)


def sh(cmd, timeout=120):
    """跑一条 hdc shell 命令，返回 stdout（已去尾空行）。"""
    r = subprocess.run([HDC, 'shell', cmd], capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=timeout)
    return (r.stdout or '').strip()


def sh_bytes(cmd, timeout=120):
    r = subprocess.run([HDC, 'shell', cmd], capture_output=True, timeout=timeout)
    return r.stdout or b''


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


def center(bounds):
    """'[x1,y1][x2,y2]' → 中心点 (x,y)。"""
    m = _BOUND.search(bounds or '')
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
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
