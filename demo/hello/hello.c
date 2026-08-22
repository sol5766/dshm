#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <sys/syscall.h>

int main(int argc, char *argv[]) {
    // ── Minimal output marker ───────────────────────────────────
    printf("HELLO_ELF_OK\n");
    printf("PID=%d\n", getpid());
    printf("PPID=%d\n", getppid());
    printf("UID=%d\n", getuid());
    printf("GID=%d\n", getgid());

    // ── Test argument ───────────────────────────────────────────
    const char *source = getenv("ELF_TEST_SOURCE");
    printf("ELF_TEST_SOURCE=%s\n", source ? source : "(not set)");

    // ── Print all args ──────────────────────────────────────────
    printf("ARGC=%d\n", argc);
    for (int i = 0; i < argc; i++) {
        printf("ARGV[%d]=%s\n", i, argv[i]);
    }

    // Use raw syscall to exit — _exit() may crash without full startup code
    fflush(stdout);
    // SYS_exit_group = 94 on aarch64
    register long x8 __asm__("x8") = 94;  // __NR_exit_group
    register long x0 __asm__("x0") = 0;
    __asm__ volatile("svc #0" : : "r"(x8), "r"(x0));
    __builtin_unreachable();
    return 0;
}
