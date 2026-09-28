/* =============================================================================
 * test_crdt.c — passing test for SHARD 0008 (CRDT semilattice)
 * HASH MARK:
 *   WHAT   : Proves the join-semilattice laws as executable properties over
 *            many random states, Lamport LWW determinism, and convergence
 *            under random order / duplication / gossip grouping. No network.
 *   STATE  : HEWN — earns 0008 its HEWN mark.
 *   RUNS   : `sh tests/run.sh`
 *   SEED   : docs/seed/blob.md 7940-7978.
 * ========================================================================== */
#include <stdio.h>
#include <stdint.h>
#include "syz_crdt.h"

static int failures = 0, checks = 0;
#define CHECK(cond, msg) do {                                  \
    checks++;                                                  \
    if (!(cond)) { printf("  FAIL: %s\n", msg); failures++; }  \
    else         { printf("  ok  : %s\n", msg); }              \
} while (0)

static uint32_t rs = 0x9E3779B9u;
static uint32_t rnd(void) { rs ^= rs << 13; rs ^= rs >> 17; rs ^= rs << 5; return rs; }

/* Small domains on purpose: force clock ties and value collisions. */
static SyzCell rcell(void) {
    SyzCell c;
    c.t = rnd() % 5;            /* includes bottom t==0 */
    c.node = rnd() % 4;
    c.r = (uint8_t)(rnd() % 6); c.g = (uint8_t)(rnd() % 6);
    c.b = (uint8_t)(rnd() % 6); c.code = (uint8_t)(rnd() % 6);
    return c;
}
/* Fully random, wide domain. */
static SyzCell wcell(void) {
    SyzCell c;
    c.t = rnd(); c.node = rnd();
    c.r = (uint8_t)rnd(); c.g = (uint8_t)rnd(); c.b = (uint8_t)rnd(); c.code = (uint8_t)rnd();
    return c;
}

#define N 20000
static void test_laws(void) {
    int i, idem = 1, comm = 1, assoc = 1, ub = 1, absorb = 1, bot = 1, lww = 1;
    printf("[laws] semilattice laws on %d random triples (narrow + wide domains)\n", 2 * N);
    for (i = 0; i < 2 * N; i++) {
        SyzCell a, b, c, ab, bc; SyzCell z = {0,0,0,0,0,0};
        if (i < N) { a = rcell(); b = rcell(); c = rcell(); }
        else       { a = wcell(); b = wcell(); c = wcell(); }
        if (!syz_cell_eq(syz_cell_merge(a, a), a)) idem = 0;
        if (!syz_cell_eq(syz_cell_merge(a, b), syz_cell_merge(b, a))) comm = 0;
        ab = syz_cell_merge(a, b); bc = syz_cell_merge(b, c);
        if (!syz_cell_eq(syz_cell_merge(ab, c), syz_cell_merge(a, bc))) assoc = 0;
        if (!syz_cell_leq(a, ab) || !syz_cell_leq(b, ab)) ub = 0;     /* x <= x join y */
        if (!syz_cell_eq(syz_cell_merge(ab, a), ab)) absorb = 0;      /* re-merge is a no-op */
        if (!syz_cell_eq(syz_cell_merge(z, a), a)) bot = 0;           /* bottom is identity */
        if (syz_cell_merge(a, b).t < a.t || syz_cell_merge(a, b).t < b.t) lww = 0;
    }
    CHECK(idem,   "idempotent: a join a == a");
    CHECK(comm,   "commutative: a join b == b join a");
    CHECK(assoc,  "associative: (a join b) join c == a join (b join c)");
    CHECK(ub,     "join is an upper bound: a <= a join b, b <= a join b");
    CHECK(absorb, "duplicate delivery is a no-op: (a join b) join a == a join b");
    CHECK(bot,    "bottom (t==0) is the identity");
    CHECK(lww,    "merged clock never regresses");
}

static void test_lww(void) {
    SyzCell a = {5, 1, 10, 20, 30, 40}, b = {5, 2, 99, 1, 1, 1}, m;
    SyzCell newer = {6, 0, 7, 7, 7, 7}, older = {4, 9, 200, 200, 200, 200};
    SyzCell x = {3, 1, 9, 2, 4, 1}, y = {3, 1, 1, 8, 2, 7};
    printf("[lww] Lamport last-write-wins\n");
    CHECK(syz_lamport_gt(6, 0, 5, 9), "higher t wins regardless of node");
    CHECK(syz_lamport_gt(5, 2, 5, 1), "equal t: higher node wins");
    CHECK(!syz_lamport_gt(5, 1, 5, 1), "equal clocks are not greater");
    m = syz_cell_merge(a, b);
    CHECK(syz_cell_eq(m, b) && syz_cell_eq(syz_cell_merge(b, a), b),
          "concurrent writes (same t) resolve to higher node, both orders");
    CHECK(syz_cell_eq(syz_cell_merge(older, newer), newer), "newer clock overrides older");
    CHECK(syz_cell_eq(syz_cell_merge(newer, older), newer), "older cannot override newer");
    m = syz_cell_merge(x, y);
    CHECK(m.t == 3 && m.node == 1 && m.r == 9 && m.g == 8 && m.b == 4 && m.code == 7,
          "equal clocks: per-field max (r,g,b,code)");
    CHECK(syz_lamport_tick(3, 7) == 8 && syz_lamport_tick(9, 2) == 10, "tick = max+1");
    CHECK(syz_lamport_tick(0xFFFFFFFFu, 1) == 0xFFFFFFFFu, "tick saturates (bounded)");
    CHECK(sizeof(SyzCell) == 12, "cell is 12 packed bytes, no padding");
}

#define R 6      /* replicas */
#define K 64     /* cells */
#define U 400    /* updates */
static void test_convergence(void) {
    SyzCrdtGrid rep[R], ref;
    static SyzCell val[U]; static uint16_t idx[U]; static int order[U];
    int trial, i, j, r, ok_all = 1, ok_dup = 1, ok_gossip = 1, ok_ref = 1, ok_res = 1;
    uint8_t big[(R + 1) * K * sizeof(SyzCell) + 256];
    SyzArena big_ar;
    printf("[converge] random order / duplication / gossip grouping\n");
    for (trial = 0; trial < 200; trial++) {
        syz_arena_init(&big_ar, big, sizeof big);
        for (r = 0; r < R; r++) if (syz_crdt_grid_init(&rep[r], &big_ar, K)) ok_res = 0;
        if (syz_crdt_grid_init(&ref, &big_ar, K)) ok_res = 0;
        for (i = 0; i < U; i++) {
            val[i] = rcell(); idx[i] = (uint16_t)(rnd() % K);
            syz_crdt_merge_cell(&ref, idx[i], val[i]);  /* reference: one fixed order */
        }
        /* each replica: every update, in its own random order (Fisher-Yates) */
        for (r = 0; r < R; r++) {
            for (i = 0; i < U; i++) order[i] = i;
            for (i = U - 1; i > 0; i--) { j = (int)(rnd() % (uint32_t)(i + 1)); int t = order[i]; order[i] = order[j]; order[j] = t; }
            for (i = 0; i < U; i++) {
                syz_crdt_merge_cell(&rep[r], idx[order[i]], val[order[i]]);
                if (rnd() % 3 == 0)   /* duplicate delivery */
                    syz_crdt_merge_cell(&rep[r], idx[order[i]], val[order[i]]);
            }
        }
        for (r = 1; r < R; r++) if (!syz_crdt_grid_eq(&rep[0], &rep[r])) ok_all = 0;
        for (r = 0; r < R; r++) {
            if (!syz_crdt_grid_eq(&rep[r], &ref)) ok_ref = 0;
            if (syz_crdt_digest(&rep[r]) != syz_crdt_digest(&ref)) ok_ref = 0;
        }
        /* redelivering an entire converged state changes nothing */
        { uint32_t d = syz_crdt_digest(&rep[0]);
          for (r = 1; r < R; r++) syz_crdt_merge_grid(&rep[0], &rep[r]);
          if (syz_crdt_digest(&rep[0]) != d) ok_dup = 0; }
    }
    CHECK(ok_res, "cell grids are arena-resident and allocate");
    CHECK(ok_all, "200 trials: all 6 replicas reach identical state under different random orders");
    CHECK(ok_ref, "every replica equals the fixed-order reference (order-independent)");
    CHECK(ok_dup, "merging converged replicas again is a no-op (idempotent at grid level)");

    /* gossip: replicas hold disjoint shards of the updates, exchange in random pairs */
    for (trial = 0; trial < 200; trial++) {
        int round;
        syz_arena_init(&big_ar, big, sizeof big);
        for (r = 0; r < R; r++) syz_crdt_grid_init(&rep[r], &big_ar, K);
        syz_crdt_grid_init(&ref, &big_ar, K);
        for (i = 0; i < U; i++) {
            SyzCell c = rcell(); size_t k = rnd() % K;
            syz_crdt_merge_cell(&ref, k, c);
            syz_crdt_merge_cell(&rep[rnd() % R], k, c);   /* each update at one replica only */
        }
        for (round = 0; round < 60; round++) {           /* random pairwise anti-entropy */
            int p = (int)(rnd() % R), q = (int)(rnd() % R);
            syz_crdt_merge_grid(&rep[p], &rep[q]);
        }
        for (r = 0; r < R; r++)                           /* connectivity guarantee: ring pass */
            syz_crdt_merge_grid(&rep[(r + 1) % R], &rep[r]);
        for (r = 0; r < R; r++)
            syz_crdt_merge_grid(&rep[(r + 1) % R], &rep[r]);
        for (r = 0; r < R; r++) if (!syz_crdt_grid_eq(&rep[r], &ref)) ok_gossip = 0;
    }
    CHECK(ok_gossip, "200 trials: sharded updates + random pairwise gossip converge to the join of all");
}

static void test_arena(void) {
    static uint8_t buf[512]; SyzArena a; SyzCrdtGrid g, h; size_t before;
    printf("[arena] state lives in the arena, bounded\n");
    syz_arena_init(&a, buf, sizeof buf);
    CHECK(syz_crdt_grid_init(&g, &a, 16) == 0, "16-cell grid allocates");
    CHECK((uint8_t *)g.cells >= buf && (uint8_t *)(g.cells + 16) <= buf + sizeof buf,
          "cells lie inside the arena buffer");
    CHECK(syz_arena_used(&a) == 16 * sizeof(SyzCell), "arena used == n * 12 bytes");
    before = syz_arena_used(&a);
    CHECK(syz_crdt_grid_init(&h, &a, 1000) == -1 && syz_arena_used(&a) == before,
          "over-size grid refused, arena unchanged");
    syz_crdt_write(&g, 3, 7, 1, 2, 3, 4);
    syz_crdt_write(&g, 3, 8, 5, 6, 7, 8);
    CHECK(g.cells[3].t == 2 && g.cells[3].node == 8 && g.cells[3].code == 8,
          "local writes tick the clock and supersede");
    syz_crdt_write(&g, 99, 1, 0, 0, 0, 0);
    CHECK(g.cells[3].t == 2, "out-of-range write ignored");
}

int main(void) {
    printf("=== Syzygy shard tests: 0008 crdt ===\n");
    test_laws();
    test_lww();
    test_convergence();
    test_arena();
    printf("=== %d checks, %d failures ===\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
