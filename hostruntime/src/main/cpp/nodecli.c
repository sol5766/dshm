/*
 * nodecli —— 用随包 libnode 提供独立 `node` CLI。
 *
 * DSHM 的 Host 运行在内嵌 libnode.so.137 中，process.execPath 是 appspawn；
 * 第三方插件（例如 dsh-bili-whale）却会 spawn 一个真正的 `node` 来运行自己的
 * .mjs 工具。再随包带一份约 130 MB 的完整 node 可执行文件会重复整套 V8/ICU。
 *
 * 这个程序只负责把参数交给同一份 libnode 的 node::Start：
 *   - DSHM_NODE_LIBNODE 指定 libnode 的绝对路径（运行时 wrapper 注入）；
 *   - 未指定时依次尝试同目录与常见的 libs 相对路径；
 *   - dlopen 使用 RTLD_GLOBAL，保证插件脚本加载 native addon 时能看到 napi_*；
 *   - 不链接 libnode，也不依赖 libc++，构建产物保持很小。
 *
 * 注意：这是**独立进程**入口，不要与 libdshhost.so 的进程内 Node 启动混用。
 */

#include <dirent.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef int (*node_start_fn)(int, char*[]);

static int dir_name(const char* argv0, char* out, size_t out_size) {
  char resolved[4096];
  ssize_t n = readlink("/proc/self/exe", resolved, sizeof(resolved) - 1);
  const char* path = argv0;
  if (n > 0) {
    resolved[n] = '\0';
    path = resolved;
  }
  if (path == NULL || path[0] == '\0') {
    return -1;
  }
  int written = snprintf(out, out_size, "%s", path);
  if (written < 0 || (size_t)written >= out_size) {
    return -1;
  }
  char* slash = strrchr(out, '/');
  if (slash == NULL) {
    return snprintf(out, out_size, ".") >= 0 ? 0 : -1;
  }
  if (slash == out) {
    slash[1] = '\0';
  } else {
    *slash = '\0';
  }
  return 0;
}

static int try_dlopen(const char* configured, const char* dir, const char* suffix,
                      void** handle, char* loaded, size_t loaded_size) {
  char candidate[4096];
  if (configured != NULL && configured[0] != '\0') {
    (void)snprintf(candidate, sizeof(candidate), "%s", configured);
    *handle = dlopen(candidate, RTLD_NOW | RTLD_GLOBAL);
    if (*handle != NULL) {
      (void)snprintf(loaded, loaded_size, "%s", candidate);
      return 0;
    }
  }
  if (suffix[0] == '/') {
    (void)snprintf(candidate, sizeof(candidate), "%s", suffix);
  } else {
    (void)snprintf(candidate, sizeof(candidate), "%s/%s", dir, suffix);
  }
  *handle = dlopen(candidate, RTLD_NOW | RTLD_GLOBAL);
  if (*handle != NULL) {
    (void)snprintf(loaded, loaded_size, "%s", candidate);
    return 0;
  }
  return -1;
}


/*
 * ── 按"自身文件名"改写 argv（2026-11-04，手机端 ELF 化）──────────────────────
 *
 * 【解决什么】手机档没有可 exec 的 shell：`/system/bin/sh` 被拒、`toybox` 也没有 sh applet。
 * 于是 `bin/node`、`bin/pnpm`、`bin/dsh` 这些 **shell 脚本形态的启动器在手机上一行都跑不了**
 * （内核在 execve 阶段就失败）—— 用户看到的 `libc++_shared.so not found` / `command not found`
 * 都是这条死路的表象。
 *
 * 做法：把它们做成**本程序的副本**（同一份已签名 ELF），由这里按"自己叫什么名字"决定跑什么：
 *   node  → 原样交给 node::Start
 *   pnpm/npm/npx → 前面插入 <sandbox>/toolchain/{pnpmroot,npmroot}/bin/*.js
 *   dsh   → 扫描 <sandbox>/dsh/cores/<ver>/node_modules/@deepseek-ai/dsh/lib/bin.js，
 *           取版本最大的那个（与 shell 壳的自推导口径一致）
 * 这样**不需要任何解释器、不需要环境变量**，手机与 PC 同一套入口。
 */
static const char* base_name(const char* path) {
  if (path == NULL || path[0] == '\0') {
    return "";
  }
  const char* slash = strrchr(path, '/');
  return slash == NULL ? path : slash + 1;
}

static int file_exists(const char* path) {
  return access(path, R_OK) == 0;
}

/** 在 <sandbox>/dsh/cores 下找版本最大且含 bin.js 的核心树；找不到返回 0。 */
static int find_latest_dsh_bin(const char* sandbox, char* out, size_t out_size) {
  char cores[4096];
  (void)snprintf(cores, sizeof(cores), "%s/dsh/cores", sandbox);
  DIR* dir = opendir(cores);
  if (dir == NULL) {
    return 0;
  }
  char best_name[256] = "";
  struct dirent* entry = NULL;
  while ((entry = readdir(dir)) != NULL) {
    if (entry->d_name[0] == '.') {
      continue;
    }
    char candidate[4096];
    (void)snprintf(candidate, sizeof(candidate),
                   "%s/%s/node_modules/@deepseek-ai/dsh/lib/bin.js", cores, entry->d_name);
    if (!file_exists(candidate)) {
      continue;
    }
    /* 目录名自带版本号（形如 0.2.1-rc.5+dshm.110）；按字典序取最大即最新。 */
    if (best_name[0] == '\0' || strcmp(entry->d_name, best_name) > 0) {
      (void)snprintf(best_name, sizeof(best_name), "%s", entry->d_name);
      (void)snprintf(out, out_size, "%s", candidate);
    }
  }
  closedir(dir);
  return best_name[0] != '\0';
}

int main(int argc, char* argv[]) {
  char dir[4096];
  char loaded[4096] = "";
  if (dir_name(argc > 0 ? argv[0] : NULL, dir, sizeof(dir)) != 0) {
    (void)fprintf(stderr, "nodecli: 无法定位自身目录\n");
    return 127;
  }

  const char* configured = getenv("DSHM_NODE_LIBNODE");
  void* handle = NULL;
  const char* relative[] = {
    "libnode.so.137",
    /* 【设备上真实的随包库目录（2026-11-03，docs/358 §node）】手持档无 shell ⇒
     * 包装器里的 LD_LIBRARY_PATH 与 DSHM_NODE_LIBNODE 都来不及设置，
     * 只能在这里按绝对路径找。el1/bundle/libs/<abi> 是每个应用自己的随包库位。 */
    "/data/storage/el1/bundle/libs/arm64/libnode.so.137",
    "/data/storage/el1/bundle/libs/arm64-v8a/libnode.so.137",
    "../../libs/arm64/libnode.so.137",
    "../../libs/arm64-v8a/libnode.so.137",
    "../../../libs/arm64/libnode.so.137",
    "../../../libs/arm64-v8a/libnode.so.137",
  };
  for (size_t i = 0; i < sizeof(relative) / sizeof(relative[0]); ++i) {
    if (try_dlopen(configured, dir, relative[i], &handle, loaded, sizeof(loaded)) == 0) {
      break;
    }
  }
  if (handle == NULL) {
    const char* error = dlerror();
    (void)fprintf(stderr, "nodecli: 无法加载 libnode.so.137%s%s\n",
                  error != NULL ? ": " : "", error != NULL ? error : "");
    return 127;
  }

  node_start_fn start = (node_start_fn)dlsym(handle, "_ZN4node5StartEiPPc");
  if (start == NULL) {
    (void)fprintf(stderr, "nodecli: %s 未导出 node::Start\n", loaded);
    return 127;
  }
  /*
   * ── 按自身文件名决定跑什么（手机端 ELF 化的核心）──────────────────────────
   * dir = <sandbox>/bin ⇒ sandbox = dir/..
   */
  const char* self = base_name(argc > 0 ? argv[0] : "");
  char sandbox[4096];
  (void)snprintf(sandbox, sizeof(sandbox), "%s/..", dir);

  char script[4096] = "";
  int inject = 0;
  if (strcmp(self, "pnpm") == 0) {
    (void)snprintf(script, sizeof(script), "%s/../toolchain/pnpmroot/bin/pnpm.cjs", dir);
    inject = 1;
  } else if (strcmp(self, "npm") == 0) {
    (void)snprintf(script, sizeof(script), "%s/../toolchain/npmroot/bin/npm-cli.js", dir);
    inject = 1;
  } else if (strcmp(self, "npx") == 0) {
    (void)snprintf(script, sizeof(script), "%s/../toolchain/npmroot/bin/npx-cli.js", dir);
    inject = 1;
  } else if (strcmp(self, "dsh") == 0) {
    if (!find_latest_dsh_bin(sandbox, script, sizeof(script))) {
      (void)fprintf(stderr, "dsh：核心 CLI 未就位（%s/dsh/cores 下没有 bin.js）\n", sandbox);
      return 127;
    }
    inject = 1;
  }

  if (!inject) {
    return start(argc, argv);
  }
  if (!file_exists(script)) {
    (void)fprintf(stderr, "%s：尚未就位（缺 %s）\n", self, script);
    return 127;
  }
  /* argv = [self, script, 原参数…] */
  char** argv2 = (char**)calloc((size_t)argc + 2, sizeof(char*));
  if (argv2 == NULL) {
    (void)fprintf(stderr, "%s：内存不足\n", self);
    return 127;
  }
  argv2[0] = argv[0];
  argv2[1] = script;
  for (int i = 1; i < argc; ++i) {
    argv2[i + 1] = argv[i];
  }
  return start(argc + 1, argv2);
}
