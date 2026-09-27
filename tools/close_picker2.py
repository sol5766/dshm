"""按坐标关掉系统目录选择器 —— 用 dump 出的真实 bounds，不依赖文字匹配。"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import dshtest as T

for attempt in range(3):
    lay = T.dump_layout(f'cls{attempt}')
    if not lay:
        print('dump 失败')
        break
    nodes = T.walk(lay)
    texts = [n['text'].strip() for n in nodes if n['text'].strip()]
    b = ''.join(texts)
    print(f'第{attempt+1}次: 节点 {len(nodes)}；选择器特征='
          f'{[k for k in ["文件管理","内部存储","取消","选择"] if k in b]}')

    # 找「取消」按文字，找不到就找任意含"取"的
    hits = []
    for n in nodes:
        if n['text'].strip() in ('取消', '关闭', '取消选择'):
            c = T.center(n['bounds'])
            if c:
                hits.append((n['text'].strip(), c))
    if not hits:
        print('   无「取消」节点 → 可能已不在选择器')
        break
    for label, c in hits:
        print(f'   点「{label}」@ {c}')
        T.tap(*c)
        time.sleep(2.5)

print()
lay = T.dump_layout('clsfinal')
nodes = T.walk(lay) if lay else []
t = ''.join(n['text'].strip() for n in nodes)
print(f'最终: 节点 {len(nodes)}')
print(f'  主界面特征 {[k for k in ["添加工作区","新建会话","发送消息"] if k in t]}')
print(f'  选择器特征 {[k for k in ["文件管理","内部存储","取消"] if k in t]}')
