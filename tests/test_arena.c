/* =============================================================================
 * test_arena.c — passing test for SHARD 0002 (arena)
 * HASH MARK:
 *   WHAT   : Proves distinct/aligned/in-bounds allocs, reset, over-allocation.
 *   STATE  : HEWN — earns 0002 its HEWN mark.
 *   RUNS   : `sh tests/run.sh`
 *   SEED   : docs/seed/blob.md 8309-8323, 262-272.
 * ========================================================================== */
#include <stdio.h>
#include <stdint.h>
#include "syz_arena.h"

static int failures = 0, checks = 0;
#define CHECK(cond, msg) do {                                  \
    checks++;                                                  \
    if (!(cond)) { printf("  FAIL: %s\n", msg); failures++; }  \
    else         { printf("  ok  : %s\n", msg); }              \
} while (0)

static uint8_t pool[1024];

static void test_alloc(void) {
    SyzArena a; uint8_t *p[8]; int i, distinct = 1, aligned = 1, inb = 1;
    size_t sizes[8] = {1, 3, 16, 5, 33, 7, 64, 2};
    printf("[alloc] distinct, aligned, in bounds\n");
    syz_arena_init(&a, pool, sizeof pool);
    CHECK(syz_arena_used(&a) == 0, "fresh arena used == 0");
    for (i = 0; i < 8; i++) {
        p[i] = (uint8_t *)syz_arena_alloc16(&a, sizes[i]);
        if (!p[i]) { distinct = aligned = inb = 0; break; }
        if (((uintptr_t)(p[i] - pool) & 15u) != 0) aligned = 0;
        if (p[i] < pool || p[i] + sizes[i] > pool + sizeof pool) inb = 0;
    }
    CHECK(i == 8, "8 allocations succeed");
    for (i = 1; i < 8 && distinct; i++)
        if (p[i] < p[i-1] + sizes[i-1]) distinct = 0; /* no overlap, monotonic */
    CHECK(distinct, "allocations are distinct and non-overlapping");
    CHECK(aligned, "all offsets 16-byte aligned");
    CHECK(inb, "all allocations within bounds");
    CHECK(p[0] == pool, "first allocation is at offset 0");
    CHECK(p[1] == pool + 16, "second is next 16-aligned offset");
    p[0][0] = 0xAA; p[1][2] = 0xBB;
    CHECK(pool[0] == 0xAA && pool[16 + 2] == 0xBB, "pointers address the arena bytes");
}

static void test_align(void) {
    SyzArena a; void *x; void *y;
    printf("[align] custom alignment\n");
    syz_arena_init(&a, pool, sizeof pool);
    x = syz_arena_alloc(&a, 1, 1);
    y = syz_arena_alloc(&a, 4, 64);
    CHECK(x == pool, "align 1 takes offset 0");
    CHECK(y != NULL && (((uint8_t *)y - pool) & 63) == 0, "align 64 honoured");
    CHECK(syz_arena_alloc(&a, 1, 0) == NULL, "align 0 refused");
    CHECK(syz_arena_alloc(&a, 1, 3) == NULL, "non-power-of-two align refused");
    CHECK(syz_arena_used(&a) == 68, "refused allocs leave arena unchanged");
}

static void test_reset(void) {
    SyzArena a; void *p1, *p2; size_t m;
    printf("[reset] reset, mark/rollback, high-water\n");
    syz_arena_init(&a, pool, sizeof pool);
    p1 = syz_arena_alloc16(&a, 100);
    CHECK(syz_arena_used(&a) == 100, "used == 100");
    syz_arena_reset(&a);
    CHECK(syz_arena_used(&a) == 0, "reset returns offset to 0");
    p2 = syz_arena_alloc16(&a, 100);
    CHECK(p1 == p2, "post-reset allocation reuses the same address");
    CHECK(syz_arena_high_water(&a) == 100, "high-water survives reset");
    m = syz_arena_mark(&a);
    syz_arena_alloc16(&a, 200);
    CHECK(syz_arena_high_water(&a) >= 300, "high-water tracks peak");
    syz_arena_rollback(&a, m);
    CHECK(syz_arena_used(&a) == m, "rollback restores marked offset");
    syz_arena_rollback(&a, 999);
    CHECK(syz_arena_used(&a) == m, "rollback forward is ignored");
}

static void test_over(void) {
    SyzArena a; void *p;
    printf("[over] over-allocation detected\n");
    syz_arena_init(&a, pool, 64);
    CHECK(syz_arena_alloc16(&a, 65) == NULL, "size > capacity -> NULL");
    CHECK(syz_arena_used(&a) == 0, "failed alloc does not move offset");
    p = syz_arena_alloc16(&a, 64);
    CHECK(p == pool, "exact-fit allocation succeeds");
    CHECK(syz_arena_alloc16(&a, 1) == NULL, "full arena -> NULL");
    CHECK(syz_arena_alloc(&a, 0, 1) != NULL, "zero-size at end is in bounds");
    syz_arena_reset(&a);
    CHECK(syz_arena_alloc16(&a, (size_t)-1) == NULL, "SIZE_MAX does not wrap");
    CHECK(syz_arena_alloc16(&a, (size_t)-8) == NULL, "near-SIZE_MAX does not wrap");
    syz_arena_alloc(&a, 1, 1);
    CHECK(syz_arena_alloc(&a, 60, 16) == NULL, "alignment padding counted in bound check");
    syz_arena_init(&a, pool, 0);
    CHECK(syz_arena_alloc16(&a, 1) == NULL, "zero-capacity arena refuses");
}

int main(void) {
    printf("=== Syzygy shard tests: 0002 arena ===\n");
    test_alloc();
    test_align();
    test_reset();
    test_over();
    printf("=== %d checks, %d failures ===\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
