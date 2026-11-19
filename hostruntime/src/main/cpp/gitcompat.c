/*
 * gitcompat —— 让 Alpine git 在鸿蒙上能起子进程的最小 LD_PRELOAD 垫片。
 *
 * 【要解决什么】真机上 `git clone / fetch / pull / push / ls-remote` 一律 rc=134
 * （SIGABRT），原文：
 *
 *     BUG: run-command.c:525: disabling cancellation: Operation not permitted
 *
 * 定位（git v2.47.3 `run-command.c` 的 `atfork_prepare()`）：
 *
 *     CHECK_BUG(pthread_sigmask(SIG_SETMASK, &all, &as->old),
 *               "blocking all signals");          // 先这一条
 *     CHECK_BUG(pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &as->cs),
 *               "disabling cancellation");        // 报的是这一条（:525）
 *
 * `CHECK_BUG` 的语义是"这个调用不该失败"——失败即 `BUG()`（abort）。而报错文本说明
 * 平台把 `pthread_setcancelstate` 判成了失败（EPERM）。也就是说：**不是 git 用法错，
 * 是平台 libc 缺/禁了这一块能力**。前一条（sigprocmask）真机上通过了，后一条没过；
 * 但两条都在同一个自检块里，**一起兜**才不会"修好前者又炸在后者"。
 *
 * 【为什么用垫片而不是重编 git】git 是动态链接的 PIE，`DT_NEEDED libc.musl-aarch64.so.1`
 * ——用的是**系统 musl**（我们没随包带 libc）。重编要配一整套 Alpine musl 交叉工具链，
 * 且重编产物还要再过一次签名域；而这里只需要让**两个函数调用**别被判失败。
 *
 * 【垫片的正确性口径：透明优先】
 * 先调 libc 真身，**真身成功就原样成功**；只有真身缺失或返回非 0 时才改写成成功。
 * 于是在真 Linux 上本垫片完全透明（不会掩盖真实错误），只在平台判失败时才介入。
 *
 * 【这两个调用被"当作成功"是否安全】git 拿它们的返回值只为过自检，并没有依赖
 * 取消/屏蔽真的生效：它自己的子进程管理是 fork + exec + waitpid + kill（见
 * `start_command`/`wait_or_whine`），与本垫片无关。
 *
 * 【为什么必须补 oldstate/oldset】`atfork_parent()` 会用 `as.cs` / `as.old` 还原现场：
 *   `pthread_setcancelstate(as->cs, NULL)` / `pthread_sigmask(SIG_SETMASK, &as->old, NULL)`
 * 若我们伪造成功却不写回出参，git 就读到**未初始化**的 `as.cs`。这两处还原调用同样
 * 被本垫片接管（都返回成功），所以即便值不可信也不会真的改状态；但按 POSIX 默认值
 * 填一次（cancel ENABLE）成本为零，且让垫片在"只 preload 一半"的场景下也说得通。
 *
 * 【局限，如实记下】这只是让 git 不再 abort。若某条远端命令还依赖"取消点真被禁用"
 * 才能正确工作，行为可能与预期不同；但 clone/fetch/pull/push 的主路径不依赖它。
 * 一条命令跑通 ≠ 所有远端场景覆盖——以真机实测为准。
 *
 * 【怎么被加载】宿主 git wrapper 对子进程类子命令加
 * `LD_PRELOAD=<bundle>/libs/arm64/libdshm-gitcompat.so`；文件不存在则跳过，退化为
 * "明确不可用提示"（见 hostcore/app/main.js 的 git wrapper 注释）。
 */
#define _GNU_SOURCE
#include <pthread.h>
#include <dlfcn.h>
#include <errno.h>
#include <stddef.h>

typedef int (*setcancelstate_fn)(int, int *);
typedef int (*sigmask_fn)(int, const sigset_t *, sigset_t *);

static setcancelstate_fn real_setcancelstate = NULL;
static sigmask_fn real_sigmask = NULL;
static int resolved = 0;

static void resolve_real(void) {
  if (resolved) {
    return;
  }
  resolved = 1;
  /* RTLD_NEXT：取 libc 里的真身；取不到保持 NULL（下面按"当作成功"处理）。 */
  real_setcancelstate = (setcancelstate_fn)dlsym(RTLD_NEXT, "pthread_setcancelstate");
  real_sigmask = (sigmask_fn)dlsym(RTLD_NEXT, "pthread_sigmask");
}

/* 真身缺失或判失败时，把出参填成 POSIX 默认值（取消默认为 ENABLE）。 */
int pthread_setcancelstate(int state, int *oldstate) {
  resolve_real();
  if (real_setcancelstate != NULL) {
    int rc = real_setcancelstate(state, oldstate);
    if (rc == 0) {
      return 0; /* 真身成功：原样透传，不改任何东西 */
    }
  }
  if (oldstate != NULL) {
    *oldstate = PTHREAD_CANCEL_ENABLE;
  }
  errno = 0; /* 复位：调用方可能用 strerror(errno) 拼串，留着陈旧 errno 会误导 */
  return 0;
}

int pthread_sigmask(int how, const sigset_t *set, sigset_t *oldset) {
  resolve_real();
  if (real_sigmask != NULL) {
    int rc = real_sigmask(how, set, oldset);
    if (rc == 0) {
      return 0;
    }
  }
  if (oldset != NULL) {
    /* 无从得知真实掩码；填空集（= "原来没有屏蔽任何信号"）。
     * 还原点同样被本垫片接管，故这个值只用于让 git 的读取有定义。 */
    static const sigset_t empty = { { 0 } };
    *oldset = empty;
  }
  errno = 0;
  return 0;
}
