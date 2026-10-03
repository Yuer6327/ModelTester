/**
 * Fertility scoring — pure functions turning per-turn usage readings into a
 * ranked family hypothesis. The math lives beside the data (fertility.ts):
 *
 * Each fertility text goes to its OWN fresh session, so that session's
 * prompt-side usage (totalTokens − outputTokens) is exactly
 *
 *   P_i = wrapper(session) + tokens(text_i)
 *
 * under the SERVING tokenizer. Differencing across sessions cancels the
 * wrapper only when it is CONSTANT across sessions. On the real host it is
 * not always: dynamic per-session injections (memory blocks, tool state,
 * crash-resume re-sends) can shift the wrapper by hundreds of tokens between
 * sessions, which used to corrupt the naive T0-relative vector and rank
 * whatever family the noise favored (2026-10-01: a polluted run ranked
 * xiaomi over the true minimax by 7 L1 points out of ~20 000).
 *
 * Robust consensus scoring (drift-corrected): for each family F compute the
 * residual of every measured dimension
 *
 *   r_i = (P_i − P_0) − Δref_F,i
 *
 * For the TRUE family, r_i = wrapper_i − wrapper_0, which collapses onto a
 * few discrete wrapper offsets (most sessions usually share one baseline).
 * For a wrong family the residuals scatter, because the reference
 * differences vary per dimension. Each family is therefore scored by its
 * largest residual cluster:
 *
 *   med      = median(r)                       (robust baseline offset)
 *   inliers  = #{ i : |r_i − med| ≤ WRAPPER_TOL }
 *   inlierL1 = Σ |r_i − med| over the inliers
 *
 * Ranking: more inliers first, then smaller in-cluster mass, then raw L1.
 * A clean run (constant wrapper) has med = 0 and reduces to the plain L1
 * ranking — the two agree whenever the old assumption holds.
 *
 * A shared-session differencing (P_i − P_{i−1} − C_{i−1}) was tried first and
 * rejected on the real host: the harness manages context dynamically
 * (compaction, truncation, per-turn injections), so per-turn prompt deltas
 * inside one session are not the text's tokens.
 *
 * Honesty rules: the verdict carries the wrapper baseline, the measured
 * spread and the inlier coverage so drift is visible; an incomplete run
 * ranks on the dimensions it measured and can never present a 9/9 exact
 * match; a drifted run can only present a drift-corrected hypothesis (the
 * panel renders it as such, never as an exact identification). Reply tokens
 * never enter the measurement (prompt side only).
 */

import { FERTILITY_FAMILIES, FERTILITY_TEXTS, type FertilityFamily } from './fertility.ts'

/** Residual band (tokens) counting a dimension into a wrapper-offset cluster. */
export const WRAPPER_TOL = 3

/** Minimum majority-cluster dimensions for a drift-corrected family call. */
export const INLIER_MIN = 4

/** Maximum residual mass (tokens) inside the majority cluster. */
export const INLIER_L1_MAX = 6

/** max(P) − min(P) above which per-session wrapper drift is certain. The
 *  widest reference span any family produces is ≈123 tokens (T6 emoji), so
 *  a spread beyond this cannot be explained by text choice alone. */
export const SPREAD_MAX = 160

/** One measured fertility turn (one fresh session each, in send order). */
export interface FertilityTurn {
  /** 'T0' (baseline), then 'T1'..'T9'. */
  readonly probeId: string
  readonly status: 'answered' | 'timeout' | 'failed'
  /** Prompt-side tokens (totalTokens − outputTokens) of this session's first reply. */
  readonly promptTokens: number | null
  /**
   * Agent preset the session carries (harness scaffold audit — cross-run
   * wrapper baselines only compare within one preset). Undefined = the host
   * did not expose it, which is never conflated with "no preset".
   */
  readonly agentPreset?: string
}

/** L1 distance of one reference family against the measured vector. */
export interface FertilityCandidate {
  readonly family: FertilityFamily
  /** Raw L1 over the covered dimensions (audit display; drift-polluted). */
  readonly l1: number
  /** Dimensions the L1 was computed over (an incomplete run ranks on fewer). */
  readonly dims: number
  /** Dimensions falling inside the majority residual cluster. */
  readonly inliers: number
  /** Residual mass inside the majority cluster (the drift-corrected distance). */
  readonly inlierL1: number
  /** The majority cluster's wrapper offset vs the T0 session (median residual). */
  readonly offset: number
}

/** The fertility verdict over one run. */
export interface FertilityVerdict {
  /** Families sorted by consensus (inliers → inlierL1 → L1), best first. */
  readonly candidates: readonly FertilityCandidate[]
  /** Dimensions actually measured (of 9). */
  readonly measured: number
  /** Measured absolute prompt-side counts keyed T0..T9 (display/audit). */
  readonly measuredCounts: Readonly<Record<string, number>>
  /** False when the run is unusable (no baseline or no dimensions). */
  readonly usable: boolean
  /**
   * Baseline prompt-side tokens of the T0 session (wrapper + "Hi.") — the
   * drill's L2 wrapper constant for this gateway entry; track it across
   * snapshots. The per-text wrapper is only *assumed* constant across
   * sessions: when it is not, `drift` is true and the ranking is
   * drift-corrected (see the module doc).
   */
  readonly wrapperBaseline: number | null
  /** max(P) − min(P) over measured sessions; null when fewer than two. */
  readonly wrapperSpread: number | null
  /** True when the wrapper could not be assumed constant (drift-corrected call). */
  readonly drift: boolean
  /**
   * Dimensions OUTSIDE the top family's majority residual cluster (T1..T9
   * ids). These are the readings a wrapper-drift re-run should target: drift
   * is per-session random injection, so re-measuring just the outliers in
   * fresh sessions usually restores the clean 9/9 exact match. Empty on
   * clean runs.
   */
  readonly outlierDims: readonly string[]
  /**
   * Agent presets (harness scaffolds) observed across the measured sessions,
   * sorted. A run under a constant preset lists one entry — the honest
   * precondition for comparing `wrapperBaseline` across runs. Empty when the
   * host exposed no preset (undetectable ≠ absent).
   */
  readonly presets: readonly string[]
}

/** Fertility send order: T0 baseline, then the nine divergence dimensions. */
export function fertilitySequence(): readonly { id: string; text: string }[] {
  return FERTILITY_TEXTS.map(text => ({ id: `fert-${text.id}`, text: text.text }))
}

/** Median of a non-empty number list (average of the two middles when even). */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Compute the measured delta vector and rank the reference families under
 * drift-corrected consensus scoring.
 * @param turns - per-session usage readings in send order (fertilitySequence()).
 */
export function fertilityVerdictOf(turns: readonly FertilityTurn[]): FertilityVerdict {
  const measured = new Map<string, number>()
  const presets = new Set<string>()
  for (const turn of turns) {
    if (turn.agentPreset !== undefined && turn.agentPreset !== '') presets.add(turn.agentPreset)
    if (turn.status !== 'answered') continue
    if (turn.promptTokens === null || !Number.isSafeInteger(turn.promptTokens)) continue
    measured.set(turn.probeId.replace(/^fert-/, ''), turn.promptTokens)
  }
  const base = measured.get('T0')
  const dims = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9']
  const vector = dims.map(id => {
    const value = measured.get(id)
    return base === undefined || value === undefined ? null : value - base
  })

  const candidates: FertilityCandidate[] = []
  const residualDims = new Map<string, { dim: string; residual: number }[]>()
  for (const family of FERTILITY_FAMILIES) {
    const residuals: { dim: string; residual: number }[] = []
    let l1 = 0
    let count = 0
    for (let i = 0; i < dims.length; i++) {
      const reference = family.deltas[i]
      const value = vector[i]
      if (reference === null || value === null) continue
      residuals.push({ dim: dims[i]!, residual: value - reference })
      l1 += Math.abs(value - reference)
      count += 1
    }
    if (count === 0) continue // nothing comparable for this family
    const offset = medianOf(residuals.map(entry => entry.residual))
    let inliers = 0
    let inlierL1 = 0
    for (const { residual } of residuals) {
      if (Math.abs(residual - offset) <= WRAPPER_TOL) {
        inliers += 1
        inlierL1 += Math.abs(residual - offset)
      }
    }
    candidates.push({ family, l1, dims: count, inliers, inlierL1: Math.round(inlierL1 * 10) / 10, offset })
    residualDims.set(family.id, residuals)
  }
  candidates.sort((a, b) =>
    b.inliers - a.inliers
    || a.inlierL1 - b.inlierL1
    || a.l1 - b.l1
    || a.family.id.localeCompare(b.family.id))

  const measuredCounts: Record<string, number> = {}
  for (const [id, value] of measured) measuredCounts[id] = value
  const values = [...measured.values()]
  const wrapperSpread = values.length >= 2 ? Math.max(...values) - Math.min(...values) : null
  const top = candidates[0]
  const drift = top !== undefined && ((wrapperSpread !== null && wrapperSpread > SPREAD_MAX) || top.inliers < top.dims)
  // Outlier dimensions of the TOP family: the readings a targeted re-run
  // should refresh (see FertilityVerdict.outlierDims). Empty unless the top
  // cluster actually lost members.
  const outlierDims: string[] = []
  if (top !== undefined) {
    for (const { dim, residual } of residualDims.get(top.family.id) ?? []) {
      if (Math.abs(residual - top.offset) > WRAPPER_TOL) outlierDims.push(dim)
    }
  }
  return {
    candidates,
    measured: vector.filter(value => value !== null).length,
    measuredCounts,
    usable: base !== undefined && candidates.length > 0,
    wrapperBaseline: base ?? null,
    wrapperSpread,
    drift,
    outlierDims,
    presets: [...presets].sort(),
  }
}
