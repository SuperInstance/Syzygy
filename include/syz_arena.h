/* =============================================================================
 * syz_arena.h — zero-allocation linear arena  [SHARD 0002]
 * -----------------------------------------------------------------------------
 * HASH MARK (read this by context):
 *   WHAT     : A fixed linear bump-pointer arena. One caller-provided backing
 *              buffer, offset allocation, O(1), no malloc/free/GC. Invariant I1.
 *   STATE    : HEWN — functions now, covered by tests/test_arena.c.
 *   RUNS     : syz_arena_init/alloc/alloc16/reset/used/high_water/mark/rollback.
 *              tests/test_arena.c: 29 checks, 0 failures (sh tests/run.sh).
 *   SHORTCUT : Single monotonic bump pointer, no free list; reset (or rollback
 *              to a saved mark) is the only reclaim. Failure returns NULL and
 *              leaves the arena unchanged. Alignment must be a power of two.
 *   ASSUMES  : Caller owns/provisions the backing buffer (static array at boot).
 *              Downstream (0004 planes, 0005 fused frames, 0008 wire buffers)
 *              allocate from here and check for NULL. Nothing upstream.
 *   BETTER-WHEN: A static-analysis pass over high_water turns "no heap" from a
 *              claim into a checked receipt (I1 verifiability); 0005 uses
 *              mark/rollback for per-frame scratch instead of full reset.
 *   SEED     : docs/seed/blob.md 8309-8323 (core_arena_init / core_arena_alloc,
 *              (current + alignMask) & ~alignMask), 262-272 (invariant I1).
 *   NEXT     : 0005-fused (src/dst frames), 0004-yuv-ingest (planes), then a
 *              high-water witness so I1 is checked, not asserted.
 *
 * Deviations from the seed, all bug-hardening: the capacity check is written
 * as size > cap - aligned so it cannot wrap around; the aligned-offset
 * computation is checked for wrap; non-power-of-two alignment is refused.
 * Pure integer, libc-free, FPU-free, header-only.
 * ========================================================================== */
#ifndef SYZ_ARENA_H
#define SYZ_ARENA_H

#include <stdint.h>
#include <stddef.h>

typedef struct {
    uint8_t *buffer;     /* backing region (not owned)            */
    size_t   capacity;   /* bytes in region                       */
    size_t   offset;     /* bump pointer: next free byte          */
    size_t   high_water; /* max offset ever reached (I1 witness)  */
} SyzArena;

#define SYZ_ARENA_ALIGN 16u

static inline void syz_arena_init(SyzArena *a, void *buf, size_t cap) {
    a->buffer = (uint8_t *)buf;
    a->capacity = cap;
    a->offset = 0;
    a->high_water = 0;
}

/* Returns NULL on exhaustion, bad alignment, or overflow; arena unchanged. */
static inline void *syz_arena_alloc(SyzArena *a, size_t size, size_t align) {
    size_t mask, aligned;
    if (align == 0 || (align & (align - 1)) != 0) return NULL;
    mask = align - 1;
    if (a->offset > (size_t)-1 - mask) return NULL;
    aligned = (a->offset + mask) & ~mask;
    if (aligned > a->capacity || size > a->capacity - aligned) return NULL;
    a->offset = aligned + size;
    if (a->offset > a->high_water) a->high_water = a->offset;
    return (void *)&a->buffer[aligned];
}

static inline void *syz_arena_alloc16(SyzArena *a, size_t size) {
    return syz_arena_alloc(a, size, SYZ_ARENA_ALIGN);
}

/* All-or-nothing reclaim. high_water is deliberately kept. */
static inline void syz_arena_reset(SyzArena *a) { a->offset = 0; }

static inline size_t syz_arena_used(const SyzArena *a) { return a->offset; }
static inline size_t syz_arena_high_water(const SyzArena *a) { return a->high_water; }

/* Scoped scratch: save the offset, roll back to it later. */
static inline size_t syz_arena_mark(const SyzArena *a) { return a->offset; }
static inline void syz_arena_rollback(SyzArena *a, size_t mark) {
    if (mark <= a->offset) a->offset = mark;
}

#endif /* SYZ_ARENA_H */
