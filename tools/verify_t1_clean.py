"""
单独、干净地验证 T1（目录选择链路）—— 排除测试间的状态污染。

【怀疑】T1 的失败是测试顺序造成的：
  · 测试开始时 clear 了 diag-pick-called
  · 点击前取的元素列表可能来自上一个测试遗留的面板
  · 导致点到的不是「添加工作区」而是别的东西
本脚本：先回主界面 → 明确点「添加工作区」→ 立刻查 diag 文件。
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import dshtest as T

APP_MARK = ['新建会话', '添加工作区']
DESK_MARK = ['WPS Office', '天气', '我的华为']


def back_to_main(max_try=5):
    """退到主界面：主界面特征在、且无插件详情特征。"""
    for i in range(max_try):
        lay = T.dump_layout(f'b2m{i}')
        nodes = T.walk(lay) if lay else []
        blob = ''.join(n['text'] for n in nodes)
        if any(k in blob for k in DESK_MARK):
            T.sh(f'aa start -a EntryAbility -b {T.APP}')
            time.sleep(9)
            continue
        # 插件详情/列表特征 → 点返回
        if '返回插件列表' in blob:
            for h in T.find(nodes, '返回插件列表'):
                if T.center(h['bounds']):
                    T.tap(*T.center(h['bounds']))
                    time.sleep(3)
                    break
            continue
        if '添加和管理插件' in blob and '新建会话' in blob:
            # 在插件列表页：点左侧「新建会话」回主界面
            hits = [h for h in T.find(nodes, '新建会话') if T.center(h['bounds'])]
            # 取最左侧那个（侧栏顶部）
            hits.sort(key=lambda h: T.center(h['bounds'])[0])
            if hits:
                T.tap(*T.center(hits[0]['bounds']))
                time.sleep(3)
            continue
        if any(k in blob for k in APP_MARK) and '返回插件列表' not in blob:
            return nodes
        time.sleep(1)
    return []


print('=== 1) 回主界面 ===')
nodes = back_to_main()
blob = ''.join(n['text'] for n in nodes if n['text'].strip())
print(f'   节点 {len(nodes)}；含"添加工作区"={"添加工作区" in blob}')

print('\n=== 2) 清掉旧 diag，点「添加工作区」 ===')
T.clear('diag-pick-called')
T.clear('diag-select-returned')
T.clear('diag-resolve-dispatched')

btn = [h for h in T.find(nodes, '添加工作区') if T.center(h['bounds'])]
if not btn:
    print('   ✗ 找不到按钮')
    raise SystemExit(1)
c = T.center(btn[0]['bounds'])
print(f'   点击 @ {c}')
t_click = time.time()
T.tap(*c)
time.sleep(7)

print('\n=== 3) 立刻查证据 ===')
called = T.read_file('diag-pick-called')
print(f'   diag-pick-called: {called!r}')
print(f'   文件列表: {T.ls_files("diag-*")[:300]}')

print('\n=== 4) 当前界面 ===')
lay = T.dump_layout('after_pick')
nodes2 = T.walk(lay) if lay else []
t2 = [n['text'].strip() for n in nodes2 if n['text'].strip()]
b2 = ''.join(t2)
print(f'   节点 {len(nodes2)}')
print(f'   选择器特征: {[k for k in ["文件管理","内部存储","我的手机","取消","选择"] if k in b2]}')
print(f'   主界面特征: {[k for k in ["添加工作区","新建会话"] if k in b2]}')
print(f'   插件特征: {[k for k in ["添加和管理插件","返回插件列表","实验性"] if k in b2]}')
print(f'   样本: {[x[:24] for x in t2][:20]}')
