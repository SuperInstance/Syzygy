/* =============================================================================
 * syz_crdt.h — join-semilattice cell mesh + Lamport LWW  [SHARD 0008]
 * -----------------------------------------------------------------------------
 * HASH MARK (read this by context):
 *   WHAT     : A bounded join-semilattice (S, join) over cell state. A cell is a
 *              packed value {r,g,b,code} plus a Lamport clock <t,node>. Merge is
 *              idempotent, commutative, associative; conflicts resolve by
 *              last-write-wins on the clock. No coordinator, no lock. Invariant I3.
 *   STATE    : HEWN — algebra proven in memory by tests/test_crdt.c. No network.
 *   RUNS     : syz_lamport_gt / syz_cell_merge / syz_cell_leq / syz_cell_eq,
 *              syz_lamport_tick, syz_crdt_grid_init (arena-resident cells),
 *              syz_crdt_write, syz_crdt_merge_cell, syz_crdt_merge_grid,
 *              syz_crdt_digest. tests/test_crdt.c: idempotence, commutativity,
 *              associativity, LWW determinism, convergence under random order,
 *              duplication and gossip grouping (sh tests/run.sh).
 *   SHORTCUT : Pure algebra, in memory. State-based (whole-cell) merge only; no
 *              delta encoding, no wire packet, no UDP (next shard). Clock is a
 *              32-bit counter that saturates at UINT32_MAX (bounded lattice; a
 *              saturated node no longer orders its own later writes). Node ids
 *              must be unique per writer; equal clocks from DIFFERENT values are
 *              a protocol violation, but are still merged deterministically.
 *   TIE RULE : CAUTION in the mark is resolved here, per-field: on equal clocks
 *              the merged cell takes max(r), max(g), max(b), max(code)
 *              independently (blob:7957 scalar max, extended componentwise). The
 *              join is then "max clock, componentwise max of the values that
 *              carry it" — a genuine semilattice (associative, unlike a
 *              lexicographic pick). Recorded in ledger.csv.
 *   ASSUMES  : 0002 (cell array lives in the arena; NULL on exhaustion). Cells
 *              are produced by 0001/0005; the mesh carries them opaquely.
 *   BETTER-WHEN: The real lossy-network convergence test over UDP with
 *              adversarial reorder/drop/duplicate (a later shard) turns the
 *              in-memory laws into a receipt under actual loss; and the tie rule
 *              is validated against a real fleet workload.
 *   SEED     : docs/seed/blob.md 7940-7978 (semilattice + LWW), 3824-3866
 *              (fleet node/bin layout), 7707-7778 (transceiver, not built here).
 *   NEXT     : 0009 UDP transceiver: packed wire [seq|bins|cells...] over
 *              multicast (native + wasm shim), then the adversarial test.
 *
 * Pure integer, libc-free, FPU-free, header-only.
 * ========================================================================== */
#ifndef SYZ_CRDT_H
#define SYZ_CRDT_H

#include <stdint.h>
#include <stddef.h>
#include "syz_arena.h"

/* 12 bytes, no padding. t == 0 is the bottom (never written). */
typedef struct {
    uint32_t t;                     /* Lamport counter                      */
    uint32_t node;                  /* writer id (tie-break)                */
    uint8_t  r, g, b, code;         /* packed value                         */
} SyzCell;

/* Strict total order on clocks: <tA,nA> > <tB,nB>. */
static inline int syz_lamport_gt(uint32_t tA, uint32_t nA, uint32_t tB, uint32_t nB) {
    return tA > tB || (tA == tB && nA > nB);
}

static inline uint8_t syz_u8max(uint8_t a, uint8_t b) { return a > b ? a : b; }

static inline int syz_cell_eq(SyzCell a, SyzCell b) {
    return a.t == b.t && a.node == b.node && a.r == b.r && a.g == b.g &&
           a.b == b.b && a.code == b.code;
}

/* The join. Total, pure, branch-only. */
static inline SyzCell syz_cell_merge(SyzCell a, SyzCell b) {
    if (syz_lamport_gt(a.t, a.node, b.t, b.node)) return a;
    if (syz_lamport_gt(b.t, b.node, a.t, a.node)) return b;
    a.r = syz_u8max(a.r, b.r);       /* equal clocks: per-field max */
    a.g = syz_u8max(a.g, b.g);
    a.b = syz_u8max(a.b, b.b);
    a.code = syz_u8max(a.code, b.code);
    return a;
}

/* Partial order induced by the join: a <= b  iff  a join b == b. */
static inline int syz_cell_leq(SyzCell a, SyzCell b) {
    return syz_cell_eq(syz_cell_merge(a, b), b);
}

/* Lamport tick: strictly after everything seen locally and remotely. */
static inline uint32_t syz_lamport_tick(uint32_t local, uint32_t seen) {
    uint32_t m = local > seen ? local : seen;
    return m == 0xFFFFFFFFu ? m : m + 1u;
}

/* ---- arena-resident grid of cells ---------------------------------------- */
typedef struct {
    SyzCell *cells;   /* arena memory */
    size_t   n;
} SyzCrdtGrid;

/* All cells start at bottom (t==0). Returns 0 on success, -1 if arena is full. */
static inline int syz_crdt_grid_init(SyzCrdtGrid *g, SyzArena *a, size_t n) {
    size_t i;
    if (n > (size_t)-1 / sizeof(SyzCell)) return -1;
    g->cells = (SyzCell *)syz_arena_alloc16(a, n * sizeof(SyzCell));
    if (!g->cells) { g->n = 0; return -1; }
    g->n = n;
    for (i = 0; i < n; i++) {
        SyzCell z = {0, 0, 0, 0, 0, 0};
        g->cells[i] = z;
    }
    return 0;
}

/* Local write: a monotone update (join with a strictly newer cell). */
static inline void syz_crdt_write(SyzCrdtGrid *g, size_t i, uint32_t node,
                                  uint8_t r, uint8_t gg, uint8_t b, uint8_t code) {
    SyzCell c;
    if (i >= g->n) return;
    c.t = syz_lamport_tick(g->cells[i].t, 0);
    c.node = node; c.r = r; c.g = gg; c.b = b; c.code = code;
    g->cells[i] = syz_cell_merge(g->cells[i], c);
}

/* Receive one remote cell (any order, any duplication). */
static inline void syz_crdt_merge_cell(SyzCrdtGrid *g, size_t i, SyzCell remote) {
    if (i < g->n) g->cells[i] = syz_cell_merge(g->cells[i], remote);
}

/* dst := dst join src. Grids must be the same size; returns -1 otherwise. */
static inline int syz_crdt_merge_grid(SyzCrdtGrid *dst, const SyzCrdtGrid *src) {
    size_t i;
    if (dst->n != src->n) return -1;
    for (i = 0; i < dst->n; i++)
        dst->cells[i] = syz_cell_merge(dst->cells[i], src->cells[i]);
    return 0;
}

static inline int syz_crdt_grid_eq(const SyzCrdtGrid *a, const SyzCrdtGrid *b) {
    size_t i;
    if (a->n != b->n) return 0;
    for (i = 0; i < a->n; i++)
        if (!syz_cell_eq(a->cells[i], b->cells[i])) return 0;
    return 1;
}

/* FNV-1a over field values (padding-independent) for cheap state comparison. */
static inline uint32_t syz_crdt_digest(const SyzCrdtGrid *g) {
    uint32_t h = 2166136261u; size_t i; int k;
    for (i = 0; i < g->n; i++) {
        const SyzCell *c = &g->cells[i];
        uint32_t w[3];
        w[0] = c->t; w[1] = c->node;
        w[2] = (uint32_t)c->r | ((uint32_t)c->g << 8) | ((uint32_t)c->b << 16) |
               ((uint32_t)c->code << 24);
        for (k = 0; k < 3; k++) {
            int s;
            for (s = 0; s < 32; s += 8) { h ^= (w[k] >> s) & 0xFFu; h *= 16777619u; }
        }
    }
    return h;
}

#endif /* SYZ_CRDT_H */
