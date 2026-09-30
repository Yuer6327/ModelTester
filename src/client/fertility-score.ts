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
 * wrapper (constant for one host/gateway state), yielding the same delta
 * vector the drill measures with stateless max_tokens=1 requests:
 *
 *   vector_i = P_i − P_0 = tokens(text_i) − tokens(text_0)
 *
 * compared against the official-tokenizer reference by L1 distance (0 =
 * exact family match). Usage is billing data — the most
 * anti-forensics-resistant surface (faking it is faking one's own bill).
 *
 * A shared-session differencing (P_i − P_{i−1} − C_{i−1}) was tried first and
 * rejected on the real host: the harness manages context dynamically
 * (compaction, truncation, per-turn injections), so per-turn prompt deltas
 * inside one session are not the text's tokens.
 *
 * Honesty rules: the wrapper is only *assumed* constant — the verdict carries
 * the baseline so drift is visible; an incomplete run ranks on the dimensions
 * it measured and can never present a 9/9 exact match. Reply tokens never
 * enter the measurement (prompt side only), so uncapped reply lengths do not
 * pollute the vector.
 */

import { FERTILITY_FAMILIES, FERTILITY_TEXTS, type FertilityFamily } from './fertility.ts'

/** One measured fertility turn (one fresh session each, in send order). */
export interface FertilityTurn {
  /** 'T0' (baseline), then 'T1'..'T9'. */
  readonly probeId: string
  readonly status: 'answered' | 'timeout' | 'failed'
  /** Prompt-side tokens (totalTokens − outputTokens) of this session's first reply. */
  readonly promptTokens: number | null
}

/** L1 distance of one reference family against the measured vector. */
export interface FertilityCandidate {
  readonly family: FertilityFamily
  readonly l1: number
  /** Dimensions the L1 was computed over (an incomplete run ranks on fewer). */
  readonly dims: number
}

/** The fertility verdict over one run. */
export interface FertilityVerdict {
  /** Families sorted by L1, best first (near-duplicates stay adjacent). */
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
   * sessions: a gateway whose per-session injections vary will show it as
   * vector noise (elevated L1 across the board).
   */
  readonly wrapperBaseline: number | null
}

/** Fertility send order: T0 baseline, then the nine divergence dimensions. */
export function fertilitySequence(): readonly { id: string; text: string }[] {
  return FERTILITY_TEXTS.map(text => ({ id: `fert-${text.id}`, text: text.text }))
}

/**
 * Compute the measured delta vector and rank the reference families.
 * @param turns - per-session usage readings in send order (fertilitySequence()).
 */
export function fertilityVerdictOf(turns: readonly FertilityTurn[]): FertilityVerdict {
  const measured = new Map<string, number>()
  for (const turn of turns) {
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
  for (const family of FERTILITY_FAMILIES) {
    let l1 = 0
    let count = 0
    for (let i = 0; i < dims.length; i++) {
      const reference = family.deltas[i]
      const value = vector[i]
      if (reference === null || value === null) continue
      l1 += Math.abs(value - reference)
      count += 1
    }
    if (count === 0) continue // nothing comparable for this family
    candidates.push({ family, l1, dims: count })
  }
  candidates.sort((a, b) => a.l1 - b.l1 || b.dims - a.dims || a.family.id.localeCompare(b.family.id))

  const measuredCounts: Record<string, number> = {}
  for (const [id, value] of measured) measuredCounts[id] = value
  return {
    candidates,
    measured: vector.filter(value => value !== null).length,
    measuredCounts,
    usable: base !== undefined && candidates.length > 0,
    wrapperBaseline: base ?? null,
  }
}
