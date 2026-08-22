# HarmonyOS 应用进程、沙箱与外部 ELF 执行通用经验

## 一、核心结论

在 HarmonyOS 上，判断一个子进程能否访问文件或执行 ELF，不能只看它是否属于同一个应用，也不能只看应用是否声明了某个权限。

必须同时确认：

1. 进程由谁创建；
2. 进程使用什么沙箱和 mount namespace；
3. 进程实际获得了哪些权限；
4. ELF、解释器和动态库是否都在该进程的可见范围内。

最容易误判的情况是：同一个应用中的不同进程，实际拥有不同的文件系统视图。

## 二、`appspawn` 负责什么

`appspawn` 是 HarmonyOS 的系统服务，不是应用业务代码中的普通子进程。它负责创建应用进程，并在创建时配置：

- UID/GID；
- 权限令牌；
- 应用沙箱；
- mount namespace；
- 动态沙箱规则；
- 进程安全策略。

因此，`appspawn` 决定了一个进程启动时能看到哪些路径，以及哪些类型的程序可以执行。

## 三、几个常见进程角色

### 1. 应用主进程（Main Process）

这是系统启动 HAP 后创建的主要应用进程。它通常负责：

- 加载应用代码；
- 创建窗口；
- 启动应用内部的 native 运行时；
- 创建普通子进程。

### 2. Utility/代理进程

这是通过 `utilityProcess` 或类似系统进程管理机制创建的辅助进程。它可能再次经过 `appspawn` 创建，因此拥有独立的：

- UID；
- mount namespace；
- 沙箱文件视图；
- ELF 执行限制。

它虽然属于同一个应用，但不一定能看到主进程看到的路径。

### 3. 普通 native 子进程

主进程通过普通 `fork/exec`、`spawn` 等方式创建的子进程，通常继承创建者的：

- mount namespace；
- 文件可见性；
- 环境变量；
- 进程权限上下文。

但这不适用于重新由 `appspawn` 或独立进程管理机制创建的进程。

## 四、为什么同一应用中的进程会看到不同文件

典型情况如下：

```text
系统 appspawn
    ├─ 创建应用主进程
    │      └─ 普通 spawn/exec
    │             └─ native 子进程
    │
    └─ 创建 utility/代理进程
           └─ 独立沙箱和 mount namespace
```

主进程通过普通 `spawn/exec` 创建的 native 子进程，通常继承主进程的文件视图。

而 utility/代理进程由 appspawn 独立创建，可能进入另一套 mount namespace。因此会出现：

```text
主进程：可以访问某个系统路径
native 子进程：可以访问该路径
utility 进程：看不到该路径
```

即使三个进程都属于同一个 HAP，也不能据此推断它们共享文件系统。

## 五、权限的准确分工

### `ohos.permission.CUSTOM_SANDBOX`

这是动态沙箱权限，作用不只是“挂载文件”。它可能同时影响：

- 动态沙箱类型；
- 系统路径和用户路径的可见性；
- mount namespace 中的资源配置；
- 外部 native/ELF 程序的运行环境；
- 系统首次执行外部 ELF 时的用户确认流程。

因此，某个系统 ELF 是否可见、是否具备执行条件，通常要先检查动态沙箱是否生效。

### `ohos.permission.READ_WRITE_USER_FILE`

用于访问和修改用户目录下的文件，例如：

- 用户项目；
- 用户配置文件；
- 用户安装的工具；
- 脚本和依赖文件。

它解决的是用户文件的读写授权，不负责创建动态沙箱。

### `ohos.permission.ACCESS_USER_FULL_DISK`

用于在用户授权后访问更广泛的用户公共路径。它解决的是用户目录访问范围问题，不等于系统 ELF 执行权限，也不会自动合并不同进程的 namespace。

### `ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE`

官方名称为：

```text
ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE
```

官方描述是“允许应用使用外部 native 程序”。它是外部 native/ELF 执行相关的权限声明，但不能理解为：

```text
声明后即可执行任意 ELF
```

实际是否生效还可能受到以下因素影响：

- HarmonyOS API 版本；
- 设备类型；
- 应用签名和权限审核；
- 系统安全策略；
- ELF 的签名状态；
- ELF 所在路径；
- 动态加载器和依赖库是否可见；
- 动态沙箱是否正确配置。

因此，在外部 ELF 执行问题中，不能只添加这个权限后就认为问题已经解决。在部分设备或签名环境中，它可能声明成功但实际执行能力仍然无效；应结合设备日志和实际执行结果判断。

### `ohos.permission.INHERIT_PARENT_PERMISSION`

该权限用于子进程权限继承，但它不等于：

- 继承父进程的 mount namespace；
- 自动获得父进程可见的文件；
- 自动获得外部 ELF 执行能力。

因此，排查路径不可见或外部 ELF 无法执行时，不应默认把它当成必要权限。

## 六、权限与 namespace 的区别

必须区分：

```text
权限：系统是否允许进程进行某种操作

namespace：进程是否能看到目标路径和资源
```

可能出现这种情况：

```text
权限检查通过
但路径不在当前 namespace 中
```

此时仍可能得到：

```text
ENOENT
inaccessible
not found
```

增加文件读写权限不能自动改变 mount namespace；增加子进程权限继承也不能自动把两个独立 appspawn 进程合并成同一 namespace。

## 七、外部 ELF 执行需要检查的完整条件

执行一个外部 ELF，至少要分别检查：

```text
1. ELF 文件是否存在
2. 当前进程是否能看到该路径
3. 当前进程是否有执行权限
4. CUSTOM_SANDBOX 是否生效
5. ALLOW_EXTERNAL_NATIVE_CODE 是否真正生效
6. ELF 是否有正确签名或代码签名
7. ELF 的解释器是否可见
8. 依赖的 .so 是否可见
9. 进程是否受到 appspawn/seccomp 限制
10. 当前进程是否与目标资源处于同一个 namespace
```

只检查 `fs.existsSync()` 不够。文件存在不代表它可以被当前进程执行。

## 八、namespace 不一致时的正确做法

如果一个进程看不到目标资源，不要只继续增加权限。应当先确定哪个进程拥有正确的运行环境，然后通过 IPC 转发请求：

```text
代理进程
    → IPC
    → 拥有目标 namespace 的主进程或 native 进程
    → 执行 ELF 或命令
    → 返回 stdout、stderr 和退出码
```

IPC 只负责传递请求和结果，不会合并两个进程的 namespace。

## 九、推荐排查顺序

### 第一步：确认启动者

记录目标进程是由以下哪一种方式创建的：

- 系统 `appspawn`；
- utility/代理进程管理机制；
- 普通 `fork/exec` 或 `spawn`；
- HNP 或其他 native 运行时加载器。

### 第二步：比较进程身份和 namespace

分别记录：

```text
pid
ppid
uid/gid
/proc/self/ns/mnt
/proc/self/mountinfo
```

如果两个进程的 `/proc/self/ns/mnt` 不同，就不能假设它们看到相同的文件。

### 第三步：分别检查权限类别

```text
动态沙箱/资源可见性：CUSTOM_SANDBOX
用户目录读写：READ_WRITE_USER_FILE
用户公共路径范围：ACCESS_USER_FULL_DISK
外部 native 执行声明：ALLOW_EXTERNAL_NATIVE_CODE
```

### 第四步：检查 ELF 完整执行链

不能只检查 ELF 本身，还要检查：

- ELF 的解释器；
- 依赖的动态库；
- `PATH` 和 `SHELL`；
- 代码签名；
- 当前进程的 seccomp 和沙箱限制。

## 十、最终经验

> HarmonyOS 上，`appspawn` 负责创建进程并配置其沙箱、权限和 namespace。普通 `fork/exec` 子进程通常继承创建者的运行环境，而由 utility 或其他 appspawn 机制独立创建的进程可能拥有完全不同的文件视图。`CUSTOM_SANDBOX` 不只是挂载权限，还关系到动态沙箱和外部 ELF 执行环境；`READ_WRITE_USER_FILE` 与 `ACCESS_USER_FULL_DISK` 负责用户路径访问；`ALLOW_EXTERNAL_NATIVE_CODE` 是外部 native 执行相关的权限声明，但不能单独保证 ELF 执行成功。遇到路径不可见或 ELF 执行失败时，应先确认启动者、namespace、权限和 ELF 依赖，再决定是补权限还是通过 IPC 转发到正确的进程执行。

## 官方参考

- [HarmonyOS 受限开放权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/restricted-permissions)
- [HarmonyOS 开放权限（系统授权）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/permissions-for-all)
- [应用程序包集成 bin 文件（PC/2in1）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/hap-bin)
- [HarmonyOS ABI 与 ELF 格式](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ohos-abi)
