/**
 * node_shim.cpp
 *
 * 一个很小的可执行文件，通过 dlopen(runtime libnode.so) + node::Start()
 * 把内嵌的 libnode 运行时暴露为可 exec 的 node 命令，
 * 供 pnpm、子进程 spawn 等场景使用。
 *
 * 构建方式见 CMakeLists.txt（add_executable + target_link_libraries）。
 * 产物通过 POST_BUILD 复制到 rawfile 指定路径，随 HAP 分发；
 * 运行时位于 <envRoot>/node/bin/node（prepare-dsh-env.sh 保持一致）。
 *
 * 注意：与 dsh_host.cpp 不同，此处不注入 busybox PATH 或 --jitless 探测。
 * --jitless 由 DshBootstrap（ArkTS）启动前根据 jit-capability.txt 写入
 * node_flags.txt，shim 在 argv 中读取并追加。
 */
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <unistd.h>

// node::Start(int argc, char **argv) 的签名
using NodeStartFunc = int (*)(int, char **);

// 预设 libnode 文件名（SONAME）
static const char *LIBNODE_SONAME = "libnode.so.137";

// 可选节点标志文件：<exeDir>/../node_flags.txt
// DshBootstrap 在启动前写入（如 "--jitless --expose-internals"）
// 每一行拼接为一个 argv 条目
static void LoadExtraFlags(const char *exePath, int *argc, char ***argv)
{
    // 从 exePath 定位 flags 文件：exe/../node_flags.txt
    char flagsPath[4096];
    size_t len = strlen(exePath);
    if (len == 0 || len >= sizeof(flagsPath) - 20)
        return;
    memcpy(flagsPath, exePath, len + 1);
    // 去掉 exe 文件名
    char *slash = strrchr(flagsPath, '/');
    if (!slash)
        return;
    // exeDir/../
    *slash = '\0';
    char *parent = strrchr(flagsPath, '/');
    if (!parent)
        return;
    size_t parentLen = parent - flagsPath;
    memcpy(flagsPath + parentLen, "/node_flags.txt\0", 16);

    FILE *fp = fopen(flagsPath, "r");
    if (!fp)
        return;

    char line[256];
    // 计数
    int extraCount = 0;
    while (fgets(line, sizeof(line), fp))
    {
        // 去掉首尾空白、空行、注释
        char *p = line;
        while (*p == ' ' || *p == '\t')
            p++;
        if (*p == '\0' || *p == '\n' || *p == '#')
            continue;
        extraCount++;
    }
    if (extraCount == 0)
    {
        fclose(fp);
        return;
    }

    // 分配新 argv
    int newArgc = *argc + extraCount;
    char **newArgv = (char **)malloc((newArgc + 1) * sizeof(char *));
    if (!newArgv)
    {
        fclose(fp);
        return;
    }
    for (int i = 0; i < *argc; i++)
        newArgv[i] = (*argv)[i];

    rewind(fp);
    int idx = *argc;
    while (fgets(line, sizeof(line), fp))
    {
        char *p = line;
        while (*p == ' ' || *p == '\t')
            p++;
        if (*p == '\0' || *p == '\n' || *p == '#')
            continue;
        size_t l = strlen(p);
        while (l > 0 && (p[l - 1] == '\n' || p[l - 1] == '\r'))
            p[--l] = '\0';
        newArgv[idx] = strdup(p);
        if (newArgv[idx])
            idx++;
    }
    fclose(fp);

    newArgv[newArgc] = nullptr;
    *argc = newArgc;
    *argv = newArgv;
}

int main(int argc, char **argv)
{
    // 1. 加载 libnode.so.137
    // 运行时它与当前 ELF 在同一 bundle libs 目录，ld.musl 因 DT_NEEDED
    // 自动装载；若路径变化可 fallback dlopen。
    // 先尝试 dlopen（兼容性），但实际依赖 DT_NEEDED 作主装载路径。
    void *libnode = dlopen(LIBNODE_SONAME, RTLD_NOW | RTLD_GLOBAL);
    if (!libnode)
    {
        // 回退：从 /proc/self/maps 搜索 libnode
        FILE *maps = fopen("/proc/self/maps", "r");
        if (maps)
        {
            char buf[4096];
            while (fgets(buf, sizeof(buf), maps))
            {
                if (strstr(buf, LIBNODE_SONAME))
                {
                    char *path = strrchr(buf, ' ');
                    if (path)
                    {
                        while (*path == ' ')
                            path++;
                        size_t plen = strlen(path);
                        if (plen > 0 && path[plen - 1] == '\n')
                            path[plen - 1] = '\0';
                        libnode = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
                        if (libnode)
                            break;
                    }
                }
            }
            fclose(maps);
        }
    }
    if (!libnode)
    {
        fprintf(stderr, "ERROR: Cannot load %s: %s\n", LIBNODE_SONAME, dlerror());
        return 127;
    }

    // 2. 解析 node::Start
    auto nodeStart = (NodeStartFunc)dlsym(libnode, "_ZN4node5StartEiPPc");
    if (!nodeStart)
    {
        // fallback C 链接名
        nodeStart = (NodeStartFunc)dlsym(libnode, "node::Start");
    }
    if (!nodeStart)
    {
        // 再 fallback 弱符号
        nodeStart = (NodeStartFunc)dlsym(RTLD_DEFAULT, "node::Start");
    }
    if (!nodeStart)
    {
        fprintf(stderr, "ERROR: Cannot find node::Start: %s\n", dlerror());
        return 127;
    }

    // 3. 加载额外 flags（jitless 等）
    const char *exePath = argv[0];
    if (exePath)
        LoadExtraFlags(exePath, &argc, &argv);

    // 4. 委托给 node
    return nodeStart(argc, argv);
}
