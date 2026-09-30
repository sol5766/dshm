"""
DSHM 端侧功能测试（定稿版）。

【三级分类，按证据可得性】
  A 级｜硬证据，自动断言：宿主日志 / diag 文件 / HTTP / 文件系统 / ArkUI 可访问性节点
  B 级｜真实交互路径，自动断言：先点开路径再断言（路径已实测确认）
  C 级｜测不到就标 MANUAL，不写 PASS/FAIL、不伪装

【本轮排查得到的两条重要教训（已写进断言设计）】
  1) 必须先确认在测谁：一次 keyEvent Back 把应用退到桌面后，后续 dump 全在桌面上，
     导致"插件市场找不到"的**错误结论**。现在每次 dump 前校验前台是应用。
  2) 断言不能假设"元素在首屏"：插件市场/皮肤市场在**插件列表页**里，不在侧栏首屏。

【实测确认的导航路径】
  侧栏「插件」 → 插件列表页（含「添加和管理插件」「添加插件」「已安装」「刷新」）
  插件详情页    → 「返回插件列表」可回
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import dshtest as T

ROOT = Path(__file__).resolve().parent.parent


def want_core():
    """期望的端侧核心版本：读 hostcore/core-recipe.json（唯一事实来源）。

    原先这里写死 '0.1.7-rc.2'：升级核心后 T0.3 会 FAIL，而现场看起来像
    "核心没升上去"；同形态的坑在 docs/90 §8.1 有登记。
    """
    try:
        return json.loads((ROOT / 'hostcore' / 'core-recipe.json').read_text('utf-8'))['coreVersion']
    except Exception as e:
        return f'<读配方失败：{e}>'


R = T.Result()
MANUAL = []

APP_MARK = ['新建会话', '添加工作区', '发送消息']
DESK_MARK = ['WPS Office', '天气', '我的华为', '文件管理']


def pause(s=2.5):
    time.sleep(s)


def manual(tid, name, why):
    MANUAL.append((tid, name, why))
    print(f'  [MANUAL] {tid} {name}  — {why}')


def front(check=True):
    """取 ArkUI 树；check=True 时确保前台是应用（教训 1）。"""
    for _ in range(3):
        lay = T.dump_layout('front')
        nodes = T.walk(lay) if lay else []
        blob = ''.join(n['text'] for n in nodes)
        if not check or any(k in blob for k in APP_MARK):
            return nodes
        print('     （不在应用前台，拉回）')
        T.sh(f'aa start -a EntryAbility -b {T.APP}')
        time.sleep(9)
    return []


def txts(nodes):
    return [n['text'].strip() for n in nodes if n['text'].strip()]


def click(nodes, label, wait=4, nth=0):
    hits = [h for h in T.find(nodes, label) if T.center(h['bounds'])]
    if len(hits) <= nth:
        return False
    T.tap(*T.center(hits[nth]['bounds']))
    time.sleep(wait)
    return True


# ══ T0 启动健康 ══════════════════════════════════════════════════════════
def t0():
    print('\n=== T0 启动健康 ===')
    import re
    log = T.host_log_tail(150)
    R.check('T0.1', '宿主写入启动段', 'boot pid=' in log)
    m = re.search(r'exec 探测：(.*)', log)
    detail = m.group(1) if m else ''
    # 【2026-09-28 清理】原先写死 `detail.count('=ok') >= 7`（7 = exec 探测项数）。
    # 写死总数会在新增探测目标后失效：8 项里只 ok 了 7 项（新的那项失败）依然算过。
    # 改为逐项判定，项数由 hostcore/app/main.js 的 execProbeTargets() 决定。
    items = [x.strip() for x in re.split(r'[，,]', detail) if x.strip()]
    bad = [x for x in items if not x.endswith('=ok')]
    R.check('T0.2', f'exec 探测全通（{len(items)}/{len(items)}）', bool(items) and not bad,
            '，'.join(bad)[:100] if bad else detail[:100])
    want = want_core()
    R.check('T0.3', f'运行核心 {want}', want in T.sh(f'ls {T.FILES}/dsh/cores/'))
    # 【2026-09-30 修正】原写作 T.sh('fport tcp:13120 tcp:3120') —— `fport` 是**宿主侧**
    # hdc 子命令，经 sh() 变成 `hdc shell "fport …"`，设备上 `/bin/sh: fport: inaccessible
    # or not found`，而 hdc 把设备侧 127 当成功返回（exit 0）⇒ **转发从未建立**。
    # 改用 T.fport()（真在宿主侧建映射，并以 `fport ls` 为唯一判据）。
    # 另：T0.4 必须把 fok 计入断言 —— 首轮曾出现"fport 报未建立、HTTP 却拿到 401"
    # （蹭到上一轮遗留映射）而 PASS 的假阴性，故 fok 为假时直接判失败。
    fok, fout = T.fport(13120, 3120)
    import urllib.request
    import urllib.error
    try:
        urllib.request.urlopen('http://127.0.0.1:13120/', timeout=8)
        code = 200
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception:
        code = 'ERR'
    R.check('T0.4', 'Host HTTP 有响应', fok and code in (200, 401),
            f'HTTP {code}｜{fout[:70]}')


# ══ T1 目录选择链路（本次修复项，端到端硬证据）═══════════════════════════
def t1():
    print('\n=== T1 目录选择链路（修复项）===')
    for f in ['diag-pick-called', 'diag-select-returned',
              'diag-resolve-dispatched', 'diag-persist-done']:
        T.clear(f)

    nodes = front()
    btn = [h for h in T.find(nodes, '添加工作区') if T.center(h['bounds'])]
    R.check('T1.1', '存在「添加工作区」入口', bool(btn))
    if not btn:
        return

    t_click = time.time()
    T.tap(*T.center(btn[0]['bounds']))
    pause(6)

    import datetime as dt
    import re
    called = T.read_file('diag-pick-called')
    m = re.search(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})', called)
    fresh = False
    if m:
        ts = dt.datetime.strptime(m.group(1), '%Y-%m-%dT%H:%M:%S').replace(
            tzinfo=dt.timezone.utc).timestamp()
        fresh = abs(ts - t_click) < 90
    R.check('T1.2', '点击触发同步桥（新记录）', fresh, m.group(1) if m else '无记录')

    nodes2 = front(check=False)
    # 【2026-09-30 修正】原断言用 `len(nodes2) != len(nodes)`（节点数变了即通过）——
    # ArkUI dump 的节点数本身会小幅抖动，故"变了"不足以证明选择器弹出（假阳性）。
    # 改为结构性判据：出现选择器特有的「取消」，或出现真实用户目录名。
    b2 = ''.join(txts(nodes2))
    picker_new = bool(T.find(nodes2, '取消'))
    dir_marks = [k for k in ['内部存储', '我的手机', '文件夹', '下载'] if k in b2]
    R.check('T1.3', '弹出系统目录选择器', picker_new or bool(dir_marks),
            f'{len(nodes)} → {len(nodes2)} 节点｜取消={picker_new}｜目录标记={dir_marks}')
    R.check('T1.3b', '选择器列出真实用户目录',
            any(k in b2 for k in ['内部存储', '我的手机', '文件夹']))

    hits = [h for h in T.find(nodes2, '取消') if T.center(h['bounds'])]
    if hits:
        T.tap(*T.center(hits[0]['bounds']))
    else:
        T.sh('uitest uiInput keyEvent Back')
    pause(3)
    # 【2026-09-30 修正】原断言用 `len(nodes3) == len(nodes)`（节点数精确相等）——
    # 实测回退后是 824 → 394 而"未弹出时"的基线是 397：**节点数本来就会有小幅抖动**
    # （ArkUI dump 的 id/包裹层数量不稳定），拿精确相等当判据必然误报。
    # 改为结构性判据：主界面标记回来了，且选择器独有的「取消」已消失。
    nodes3 = front(check=False)
    b3 = ''.join(txts(nodes3))
    back_marks = [k for k in APP_MARK if k in b3]
    R.check('T1.4', '取消后回到主界面',
            not T.find(nodes3, '取消') and len(back_marks) >= 2,
            f'{len(nodes2)} → {len(nodes3)} 节点｜主界面标记 {len(back_marks)}/{len(APP_MARK)}'
            f'｜残留「取消」={bool(T.find(nodes3, "取消"))}')


# ══ T2 工作区与会话（ArkUI 层）══════════════════════════════════════════
def t2():
    print('\n=== T2 工作区与会话 ===')
    nodes = front()
    blob = ''.join(txts(nodes))
    R.check('T2.1', '侧栏渲染工作区', '工作区' in blob)
    R.check('T2.2', '工作区列表有条目', 'harness' in blob or 'test' in blob)
    R.check('T2.3', '存在「新建会话」', bool(T.find(nodes, '新建会话')))
    # 【2026-09-30 修正】原断言写死四个会话名（'Simple Math' / 'Run echo' / 'Bash echo' /
    # '列出当前目录'）—— 那是早期测试轮次的残留，设备上早已不存在，于是**列表明明渲染了**
    # 也恒 FAIL（真机实测：会话区里有 `harness` 工作区下的 5 条历史会话）。
    # 与 want_core() 是同一类坑：把"当时的事实"写死进断言 ⇒ 断言随事实腐坏。
    # 改为**结构性判据**：在「会话」面板区域内数真实条目，不依赖任何具体会话名。
    import re as _re
    panel = None
    for n in nodes:
        if (n['text'] or '').strip() == '会话':
            panel = T.bounds_of(n['bounds'])
            break
    entries = []
    if panel:
        px1, py1, px2, py2 = panel
        for n in nodes:
            t = (n['text'] or '').strip()
            if not t or t == '会话':
                continue
            bb = T.bounds_of(n['bounds'])
            if not bb:
                continue
            x1, y1, x2, y2 = bb
            # 落在面板纵向范围内、且**不在**面板顶边（排除表头自身）
            if y1 > py1 and y2 <= py2 and x1 >= px1 and x2 <= px2:
                entries.append(t)
    R.check('T2.4', '会话列表渲染历史会话', len(entries) >= 1,
            f'{len(entries)} 条：' + ' / '.join(entries[:3]))
    R.check('T2.5', '会话分组结构可见', '未分组' in blob or '会话' in blob)

    import re
    log = T.host_log_tail(500)
    sess = set(re.findall(r'sessionId=(session-[0-9a-f-]+)', log))
    R.check('T2.6', '前端建立会话 websocket', len(sess) > 0, f'{len(sess)} 个会话')


# ══ T3 插件面板（真实路径：侧栏「插件」→ 列表页）═════════════════════════
def t3():
    print('\n=== T3 插件面板 ===')
    nodes = front()
    R.check('T3.1', '侧栏存在「插件」入口', bool(T.find(nodes, '插件')))
    if not click(nodes, '插件', wait=5):
        R.check('T3.2', '进入插件面板', False, '点击失败')
        return

    n2 = front()
    b2 = ''.join(txts(n2))
    R.check('T3.2', '进入插件面板（列表页）',
            '添加和管理插件' in b2 or '添加插件' in b2)
    R.check('T3.3', '存在「已安装」列表', '已安装' in b2)
    R.check('T3.4', '存在「添加插件」入口', '添加插件' in b2)
    R.check('T3.5', '存在「刷新」', '刷新' in b2)
    R.check('T3.6', '插件面板渲染内置插件条目',
            '终端' in b2 or '子智能体' in b2 or '语音输入' in b2,
            '终端/子智能体/语音输入 之一在')

    # 返回主界面（避免污染后续）
    for label in ['返回插件列表', '关闭']:
        if click(front(), label, wait=3):
            break
    pause(2)


# ══ T4 工具链（硬证据）═══════════════════════════════════════════════════
def t4():
    print('\n=== T4 工具链与文件系统 ===')
    import re
    log = T.host_log_tail(500)
    m = re.search(r'exec 探测：(.*)', log)
    detail = m.group(1) if m else ''
    for name in ['python3.12', 'git', 'git-core/git', 'git-remote-http',
                 'rg', 'bash', 'git-ls-remote']:
        R.check(f'T4.{name}', f'{name} 可执行', f'{name}=ok' in detail)
    R.check('T4.ws', '工作区目录存在',
            T.sh(f'ls -d {T.FILES}/workspace 2>/dev/null') != '')
    n_bin = T.sh(f'ls {T.FILES}/bin 2>/dev/null | wc -l').strip()
    R.check('T4.bin', f'工具链 wrapper 已布置（{n_bin} 个）',
            n_bin.isdigit() and int(n_bin) > 0)


# ══ T5 运行期关键机制（硬证据）═══════════════════════════════════════════
def t5():
    print('\n=== T5 运行期关键机制 ===')
    log = T.host_log_tail(500)
    R.check('T5.1', 'jitless fetch 垫片已安装', 'jitless fetch 垫片已安装' in log)
    R.check('T5.2', 'undici 解析钩子已注册', 'undici 解析钩子已注册' in log)
    R.check('T5.3', '原生库重定向启用', '原生库重定向已启用' in log)
    R.check('T5.4', 'execPath spawn 兜底启用', 'execPath spawn 兜底已安装' in log)
    R.check('T5.5', '平台标识已设 DSHM_PLATFORM=ohos', 'DSHM_PLATFORM=ohos' in log)
    R.check('T5.6', 'CLI 假壳通道布置', 'CLI 假壳' in log)
    R.check('T5.7', 'bash 垫片布置', 'bash 垫片' in log)
    R.check('T5.8', 'python 桥已加载', 'python 桥' in log)


# ══ C 级：如实标记需人工确认 ═════════════════════════════════════════════
def t6_manual():
    print('\n=== T6 需人工确认 ===')
    manual('M1', '插件市场 / 皮肤市场内容（列表页深层）',
           '需点开「添加插件」后的市场页，其内容为动态加载列表')
    manual('M2', '主题跟随实际观感（浅/深色切换）', '需人眼或截图比对')
    manual('M3', '状态栏配色随外观变化', '需人眼观察')
    manual('M4', '右侧工作台 Tab（文件变动/任务/终端）',
           '需先打开右侧边栏；本轮未找到该入口')
    manual('M5', '皮肤渲染效果（kimino-theme 等）', '需人眼确认视觉')
    manual('M6', '模型对话端到端（需真实 API Key）', '涉及外部服务与密钥')


if __name__ == '__main__':
    t0()
    t1()
    t2()
    t3()
    t4()
    t5()
    t6_manual()

    p, f, fails = R.report()
    print('\n' + '=' * 72)
    print(f'A/B 级自动化断言：通过 {p} / 失败 {f} / 共 {p + f}')
    if fails:
        print('\n失败项：')
        for tid, name, _, d in fails:
            print(f'  {tid} {name}  {d}')
    print(f'\nC 级需人工确认：{len(MANUAL)} 项')
    for tid, name, why in MANUAL:
        print(f'  {tid} {name}')
        print(f'       原因：{why}')
    print(f'\n现场落盘：{T.ART}')
