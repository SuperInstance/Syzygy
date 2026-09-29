/* host.c — runs probe.c on the build machine: prints the golden and exits 0 iff
 * it equals 0x6dbdd1a8. The same probe.c is what you cross-compile. */
#include <stdio.h>
#include <stdint.h>
uint32_t syz_probe_golden(void);
int main(void) {
    uint32_t h = syz_probe_golden();
    printf("probe golden = 0x%08x (%s)\n", h, h == 0x6dbdd1a8u ? "match" : "MISMATCH");
    return h == 0x6dbdd1a8u ? 0 : 1;
}
