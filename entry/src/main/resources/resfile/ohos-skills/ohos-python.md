---
name: ohos-python
description: HarmonyOS 内嵌 Python 3.12（CPython，node 进程内 embedding）。本设备**有** Python，且已提供 `python3`/`pip3` 命令（~/bin 垫片在 PATH 上）。即使 `which python3`/`command -v python3` 返回失败也不代表不支持（沙箱无 python3 二进制，实际由垫片转发到内嵌运行时）。需要运行 Python 代码、判断本机是否支持 Python、处理数据/文件时使用。
whenToUse: 需要运行 Python 代码、判断/确认设备是否支持 Python、pip 包、数据分析、文件批处理，或使用依赖 Python 的技能时；也覆盖「探测 python 是否可用」这类环境检查场景。
---

# HarmonyOS 内嵌 Python 运行时（DSHM 内置）

## ⚠️ 先读：不要用 `which python3` 判断支持性

沙箱里没有 python3 二进制，所以 `which python3`、`command -v python3` 会失败
（返回 1）。**这不代表本机不支持 Python。** 本机有 CPython 3.12，且已提供
`python3`/`pip3` 命令（垫片在 PATH 上），像平常一样用即可：

```bash
python3 --version                    # → Python 3.12.14 (DSHM embedded CPython, in-process bridge)
python3 -c "print(1+1)"              # → 2
python3 script.py arg1 arg2          # 运行脚本，参数进 sys.argv
python3 -m json.tool                 # 模块模式（runpy 语义）
pip3 list                            # 等价 python3 -m pip list
```

支持：`-c "<code>"`、脚本文件（+ 参数，相对路径相对当前目录）、
`-m <module> [args...]`、`-V/--version`、`-h/--help`。
不支持：交互式 REPL、stdin 管道模式（`python3 - < x.py`，请传脚本路径）。

本设备没有系统 python3，沙箱也不能 execve 外部 ELF，但 DSHM 在 node 进程内
内置了 CPython 3.12（NAPI addon dlopen libpython + embedding API）。
垫片与下列 HTTP 端点都走同一运行时；能 exec 真身的设备垫片会自动直连
（行为不变），被 execve 策略拒绝时自动切桥模式。

## 鉴权（HTTP 端点必须）

执行端点要求 query token（与 dsh web 进程 token 同源）。token 优先取 shell
环境变量 `DSHM_PYTHON_TOKEN`；没有时垫片会自己从 host-ready.json 读——
普通用户无需关心，直接用 `python3` 命令即可。手调端点时：

```bash
T="${DSHM_PYTHON_TOKEN:-$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' ~/host-ready.json)}"
wget -O - "http://127.0.0.1:3120/dshm-python/run-get?token=$T&code=<urlencoded code>"
```

无 token / 错 token 返回 401。`/dshm-python/status` 是只读探测，无需 token。

## 调用方式

### 推荐：直接用 python3/pip3 命令（垫片全自动）

```bash
cat > ~/task.py << "EOF"
import sys
data = [1, 2, 3, 4, 5]
print("sum:", sum(data), "mean:", sum(data)/len(data))
print("python:", sys.version.split()[0])
EOF
python3 ~/task.py        # -> sum: 15 mean: 3.0 ...
```

脚本路径须在沙箱 home 树内（`$HOME` 或 workspace 下）。

### 短代码：run-get（URL 传 code，需 URL 编码）

```bash
wget -O - "http://127.0.0.1:3120/dshm-python/run-get?token=$T&code=print(%22hi%22)" 2>/dev/null
```

code 需 URL 编码（`%22`=`"`、`%2B`=`+`、`%20`=空格、`%3D`=`=`、`%0A`=换行）。
超过 64KB 返回 413——长代码写 .py 文件用脚本模式。

### argv 级语义：exec（垫片内部通道）

`/dshm-python/exec?token=<T>&argv=<urlencoded argv 以 %1f 分隔>`，
支持 `-c` / 脚本路径 / `-m`，sys.argv 与真 python3 对齐。垫片（~/bin/python3、
~/bin/pip3）就是走这个端点；一般不手调。

### 查询 Python 状态（无 token）

```bash
wget -O - 'http://127.0.0.1:3120/dshm-python/status' 2>/dev/null
# -> {"ok":true,"bridge":true,"stdlib":true,"ready":true,"initialized":true,"home":"..."}
```

## 响应结构（所有执行端点一致）

```json
{"ok": true, "stdout": "...", "errStderr": "...", "rc": "None"}
```

- `stdout`：print 输出（StringIO 捕获）
- `errStderr`：未捕获异常的完整 traceback（Python 侧 print_exc）
- `rc`：退出码 repr——正常完成 `"None"`；`sys.exit(N)` 或未捕获异常是 `"N"`
  （字符串形式的数字；`sys.exit("msg")` 是 `"'msg'"`）。判断脚本成败看 rc。
- `ok:false` 只在桥接层故障（stdlib 未就位、addon 不可用等）出现；脚本异常走
  `errStderr`+`rc`。

## 关键事实

- **不 spawn 子进程**：Python 在宿主 node 进程内运行，`libpython_runner.so`
  NAPI addon dlopen libpython3.12.so.1.0（el1 bundle libs，与 koffi/sharp
  同通道）调 CPython embedding API。
- **不 execve**：debug 签名域禁 exec（真机 E1-E19 实证）。
- **GIL 管理**：`PyGILState_Ensure/Release` + `PyEval_SaveThread`，多线程安全。
- **stdlib 就位**：toolchain/python/lib/python3.12（首次启动从 resfile 解包）。
- **跨请求共享同一解释器**：全局变量、已 import 的模块在后续请求中仍在；
  需要干净环境时先 `importlib.reload` 或重置全局。

## 边界

- **执行是同步阻塞的**：Python 在宿主 node 进程内同步运行——脚本跑多久，
  dsh web（UI/terminal）就无响应多久。执行端点带 SIGALRM 超时保护
  （默认 120s，`&timeout=<秒>` 可调 1..300，超时 `rc:"124"`）。**长任务
  请拆小步**或用 `time.sleep` 分段；卡在单次超长 C 层阻塞调用（如无超时
  DNS）alarm 打不断，属残余风险。
- **第三方 C 扩展模块不可用**：el1 bundle 库目录之外的 .so（site-packages 的
  lxml/PIL/numpy 等）被 musl-LDSO namespace 检查拒绝。替代品：
  - `xml.etree.ElementTree`（内置）替代 lxml.etree
  - `html.parser`（内置）替代 lxml.html
  - 图像处理（PIL）暂不可用
- 内置 C 扩展全部可用：`_ssl/_socket/_ctypes/zlib/_elementtree/_sqlite3/
  _hashlib/_io`；标准库 10/10（json/math/re/xml.etree/urllib/http.server/
  sqlite3/hashlib/base64 等）。
- pip3 只能装纯 Python 包（C 扩展装上也加载不了，见上条）；`pip3 install`
  需要网络可达 PyPI。**pip 首次调用（冷 import）在 jitless ARM 上明显偏慢，
  且期间 web 会阻塞——预期内，等它返回即可**。
- 不能跑 GUI 程序（无 display）。
