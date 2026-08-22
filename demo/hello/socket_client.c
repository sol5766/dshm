// Abstract Unix socket client — connects to @pty_diag_test
// compiled with HarmonyOS SDK clang: same flags as hello.c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <stddef.h>
#include <sys/socket.h>
#include <sys/un.h>

int main(int argc, char *argv[]) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        printf("SOCKET_FAIL: errno=%d (%s)\n", errno, strerror(errno));
        fflush(stdout);
        return 1;
    }

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    // Abstract socket: first byte is \0, rest is the name
    socklen_t addrlen = sizeof(struct sockaddr_un);

    // If arg given, treat as file socket path; otherwise use abstract @pty_diag_test
    if (argc > 1) {
        // File-based socket
        strncpy(addr.sun_path, argv[1], sizeof(addr.sun_path) - 1);
    } else {
        // Abstract socket: first byte \0, rest is name
        addr.sun_path[0] = '\0';
        strncpy(addr.sun_path + 1, "pty_diag_test", sizeof(addr.sun_path) - 2);
        addrlen = offsetof(struct sockaddr_un, sun_path) + 1 + strlen("pty_diag_test");
    }
    if (connect(fd, (struct sockaddr*)&addr, addrlen) < 0) {
        printf("CONNECT_FAIL: errno=%d (%s)\n", errno, strerror(errno));
        fflush(stdout);
        close(fd);
        return 1;
    }

    const char *msg = "HELLO_FROM_ABSTRACT_CLIENT";
    write(fd, msg, strlen(msg));

    char buf[256];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    if (n > 0) {
        buf[n] = '\0';
        printf("SERVER_REPLY: %s\n", buf);
    }

    close(fd);
    printf("ABSTRACT_SOCKET_OK\n");
    fflush(stdout);

    // Raw syscall exit — nostartfiles has no _exit() runtime
    register long x8 __asm__("x8") = 94;
    register long x0 __asm__("x0") = 0;
    __asm__ volatile("svc #0" : : "r"(x8), "r"(x0));
    __builtin_unreachable();
    return 0;
}
