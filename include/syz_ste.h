/* =============================================================================
 * syz_ste.h — straight-through argmax tokenizer  [SHARD 0007]
 * -----------------------------------------------------------------------------
 * HASH MARK (read this by context):
 *   WHAT     : Token selection by integer dot-product of a cell's feature
 *              vector against a codebook (basis) followed by argmax. No softmax,
 *              no exponentials. Forward = hard argmax; the straight-through
 *              estimator (STE) backward path is exposed as integer functions.
 *              Header-only, libc-free, FPU-free, no allocation.
 *   STATE    : HEWN — covered by tests/test_ste.c; also wired into 0005
 *              (syz_fused_tone calls syz_ste_select), fused==composed green.
 *   RUNS     : syz_ste_select(feat, basis, n, k) -> index in [0,n)
 *              syz_ste_select4(feat[4], basis[4][4])  (the 0005 tone slot)
 *              syz_ste_forward(...)  -> index + int64 scores + one-hot
 *              syz_ste_backward(...) -> STE gradients (see below)
 *              syz_ste_backward_identity(...) -> literal dY/dX ~= 1 (blob:8235)
 *   TIE RULE : FIRST maximum wins (strict '>' scan, lowest index kept). n == 0
 *              or NULL args return 0. Deterministic, order-defined.
 *   STRAIGHT-THROUGH FORM (how): argmax has zero gradient a.e., so the forward
 *              value is the one-hot y = e_{argmax s}, s_n = <basis_n, x>. The
 *              backward pass PRETENDS the argmax were the identity on scores:
 *                 dL/ds_n = g_n              (g = incoming grad wrt one-hot y)
 *                 dL/dx_k = sum_n g_n * basis[n][k]
 *                 dL/dbasis[n][k] = g_n * x_k
 *              i.e. the error copies through the selection unchanged and only
 *              the linear dot-product is differentiated. The seed's literal
 *              "dY/dX ~= 1" is syz_ste_backward_identity (g passed as-is).
 *              Gradients are int64 sums (unscaled); any learning-rate/shift is
 *              the caller's. Forward never touches them: inference == forward.
 *   SHORTCUT : Training does NOT exist here: no optimizer, no loss, no basis
 *              update loop. The backward functions are the STE arithmetic only,
 *              tested for algebra, not for convergence. The default basis is the
 *              seed's HARDCODED [4][4] (blob:8184), not learned (SCARF-6).
 *              Scores are int64: selection cannot overflow for int32 inputs
 *              with k <= 2^30.
   ASSUMES  : 0003 supplies the features (luma, g, ...). No arena needed.
 *   BETTER-WHEN: a training harness with gradients (blob:8080-8145: softmax-
 *              gated embeddings in training, argmax at inference, STE dY/dX~=1)
 *              makes the basis learnable — then "differentiable tokenizer" is
 *              true rather than aspirational; also learnable/larger codebooks
 *              (n > 4) and features beyond (luma, g).
 *   SEED     : docs/seed/blob.md 8171-8239 (static selector, basis :8184),
 *              8080-8145 (trainable model), 304-312 (STE invariant claim).
 *   NEXT     : a training harness (loss + basis update using syz_ste_backward)
 *              to earn "learnable"; 0008 carries the tokens over the wire.
 * ========================================================================== */
#ifndef SYZ_STE_H
#define SYZ_STE_H
#include <stdint.h>
#include <stddef.h>

/* Seed static basis (blob:8184, SCARF-3 corrected [4][4]). */
static const int32_t SYZ_STE_BASIS[4][4] = {
    {  32,  64,  64,  32 }, {  64, -32, -32,  64 },
    {  16,  96,  96,  16 }, { -64,  12,  12, -64 }
};

/* Score of codeword n: <basis[n*k .. +k], feat>. basis is row-major n x k. */
static inline int64_t syz_ste_score(const int32_t *feat, const int32_t *row, uint32_t k) {
    int64_t s = 0; uint32_t j;
    for (j = 0; j < k; j++) s += (int64_t)feat[j] * row[j];
    return s;
}

/* Hard argmax token over n codewords of width k; first max wins. */
static inline uint32_t syz_ste_select(const int32_t *feat, const int32_t *basis,
                                      uint32_t n, uint32_t k) {
    uint32_t i, sel = 0; int64_t best = 0;
    if (!feat || !basis || n == 0) return 0;
    for (i = 0; i < n; i++) {
        int64_t s = syz_ste_score(feat, basis + (size_t)i * k, k);
        if (i == 0 || s > best) { best = s; sel = i; }
    }
    return sel;
}

/* Fixed 4x4 form: the drop-in for 0005's tone slot. */
static inline uint32_t syz_ste_select4(const int32_t feat[4], const int32_t basis[4][4]) {
    return syz_ste_select(feat, &basis[0][0], 4, 4);
}

/* Forward with the straight-through state: scores[n] (may be NULL), onehot[n]
 * (may be NULL; 1 at the selected index else 0). Returns the index. */
static inline uint32_t syz_ste_forward(const int32_t *feat, const int32_t *basis,
                                       uint32_t n, uint32_t k,
                                       int64_t *scores, int32_t *onehot) {
    uint32_t i, sel = syz_ste_select(feat, basis, n, k);
    if (scores && feat && basis) for (i = 0; i < n; i++)
        scores[i] = syz_ste_score(feat, basis + (size_t)i * k, k);
    if (onehot) for (i = 0; i < n; i++) onehot[i] = (i == sel);
    return sel;
}

/* STE backward: g[n] = grad wrt one-hot output. gfeat[k] (may be NULL) and
 * gbasis[n*k] (may be NULL) are OVERWRITTEN. Argmax treated as identity. */
static inline void syz_ste_backward(const int32_t *feat, const int32_t *basis,
                                    uint32_t n, uint32_t k, const int32_t *g,
                                    int64_t *gfeat, int64_t *gbasis) {
    uint32_t i, j;
    if (gfeat) for (j = 0; j < k; j++) {
        int64_t a = 0;
        for (i = 0; i < n; i++) a += (int64_t)g[i] * basis[(size_t)i * k + j];
        gfeat[j] = a;
    }
    if (gbasis) for (i = 0; i < n; i++) for (j = 0; j < k; j++)
        gbasis[(size_t)i * k + j] = (int64_t)g[i] * feat[j];
}

/* Literal seed form dY/dX ~= 1: the gradient passes through unchanged. */
static inline void syz_ste_backward_identity(const int32_t *g, int32_t *out, uint32_t n) {
    uint32_t i;
    for (i = 0; i < n; i++) out[i] = g[i];
}
#endif /* SYZ_STE_H */
