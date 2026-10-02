/**
 * Cross-channel final verdict (pure logic — no React, no host calls).
 *
 * The panel owns three detection channels, each with its own evidence
 * scale:
 *
 *  - **usage fingerprint** (`fertility`): billing-grade usage deltas vs the
 *    official-tokenizer reference vectors. An exact match reproduces a
 *    reference vector bit-for-bit across all 9 divergence dimensions — the
 *    strongest identification the plugin can make.
 *  - **probe kit** (`batch`): elicited template artifacts merged with the
 *    passive engine's report over the batch session (noisy-OR in
 *    batch.ts).
 *  - **lexicon evidence** (`lexicon`): the passive engine's reasoning-side
 *    leaks for the current session (attribution.ts).
 *
 * They measure different surfaces, so their confidences are never merged
 * into one number. The final verdict is simply the strongest channel's own
 * result; when another channel independently names the same vendor, the
 * panel reports the agreement without inflating the confidence.
 *
 * One confidence scale ([0, 1]) across channels:
 *
 *  - fertility exact           → 0.95 (bit-exact reference match, 9/9 dims)
 *  - fertility drift-corrected → 0.70 (majority-cluster consensus)
 *  - batch / lexicon           → their own noisy-OR coefficients
 *                                (batch `high` gates at 0.8, lexicon
 *                                `possible` gates at 0.2)
 *
 * A channel without a presentable result ranks at 0 and sinks below every
 * channel that has one; resultless channels keep the standing order
 * (fertility → batch → lexicon), which is also the panel's section order —
 * so the default layout leads with the usage fingerprint, the most
 * quantitative and anti-forensics-resistant surface.
 */

import type { AttributionReport } from './attribution.ts'
import type { Vendor } from './attribution-signals.ts'
import type { StoredBatch, StoredFertility } from './panel-persist.ts'
import type { FertilityCandidate, FertilityVerdict } from './fertility-score.ts'
import { INLIER_L1_MAX, INLIER_MIN } from './fertility-score.ts'

/** The three detection channels, in the panel's standing order. */
export type ChannelId = 'fertility' | 'batch' | 'lexicon'

/** Display grade of a channel result — the channel's own verdict vocabulary. */
export type ChannelGrade =
  | 'exact' | 'corrected' // fertility
  | 'high' | 'medium' | 'low' // batch
  | 'likely' | 'possible' // lexicon
  | 'inconclusive' // measured/run, but nothing presentable
  | 'unmeasured' | 'unrun' | 'none' // never run / passive without evidence

/** One channel's result on the shared confidence scale. */
export interface ChannelResult {
  readonly channel: ChannelId
  /** The named vendor; null when this channel presents no verdict. */
  readonly vendor: Vendor | null
  /** Vendors tied with `vendor` (fertility near-duplicate vector pairs). */
  readonly tied: readonly Vendor[]
  /** Confidence on the shared [0, 1] scale (0 = no presentable result). */
  readonly confidence: number
  readonly grade: ChannelGrade
}

/** True when the channel presents a verdict row. */
export function hasResult(result: ChannelResult): boolean {
  return result.vendor !== null && result.confidence > 0
}

const NO_RESULT = (channel: ChannelId, grade: ChannelGrade): ChannelResult =>
  ({ channel, vendor: null, tied: [], confidence: 0, grade })

/**
 * The usage-fingerprint channel. Grading mirrors the fertility card's
 * honesty tiers: exact (clean run, raw L1 0 over 9/9 dims), drift-corrected
 * (majority residual cluster identifies a family), else inconclusive.
 */
export function fertilityChannel(stored: StoredFertility | null | undefined): ChannelResult {
  if (stored === null || stored === undefined) {
    return NO_RESULT('fertility', 'unmeasured')
  }
  const verdict = stored.verdict
  const top = verdict.candidates[0]
  if (!verdict.usable || top === undefined) {
    return NO_RESULT('fertility', 'inconclusive')
  }
  const tied = tiedVendorsOf(verdict, top)
  const exact = top.l1 === 0 && verdict.measured === 9 && !verdict.drift
  const corrected = !exact && top.inliers >= INLIER_MIN && top.inlierL1 <= INLIER_L1_MAX
  if (exact) {
    return { channel: 'fertility', vendor: top.family.vendor, tied, confidence: 0.95, grade: 'exact' }
  }
  if (corrected) {
    return { channel: 'fertility', vendor: top.family.vendor, tied, confidence: 0.7, grade: 'corrected' }
  }
  return NO_RESULT('fertility', 'inconclusive')
}

/** Fertility near-duplicate pairs: candidates with the identical consensus key. */
function tiedVendorsOf(verdict: FertilityVerdict, top: FertilityCandidate): readonly Vendor[] {
  const keyOf = (candidate: FertilityCandidate): string =>
    `${candidate.inliers}|${candidate.inlierL1}|${candidate.l1}`
  return verdict.candidates
    .filter(candidate => keyOf(candidate) === keyOf(top))
    .map(candidate => candidate.family.vendor)
}

/**
 * The probe-kit channel: the batch aggregate's ranked guess with its own
 * coefficient. `low` guesses keep their (sub-0.45) coefficient — they rank
 * honestly below stronger evidence instead of being promoted.
 */
export function batchChannel(stored: StoredBatch | null | undefined): ChannelResult {
  if (stored === null || stored === undefined) {
    return NO_RESULT('batch', 'unrun')
  }
  const { guess } = stored
  if (guess.vendor === null || guess.confidence === 'none' || guess.confidenceValue <= 0) {
    return NO_RESULT('batch', 'none')
  }
  return {
    channel: 'batch',
    vendor: guess.vendor,
    tied: [],
    confidence: guess.confidenceValue,
    grade: guess.confidence,
  }
}

/**
 * The lexicon channel: the passive engine's top candidate for the current
 * session. `none` verdicts (sub-0.2 coefficient noise) never present.
 */
export function lexiconChannel(report: AttributionReport | null | undefined): ChannelResult {
  if (report === null || report === undefined) {
    return NO_RESULT('lexicon', 'none')
  }
  const top = report.candidates[0]
  if (top === undefined || top.verdict === 'none' || top.confidence <= 0) {
    return NO_RESULT('lexicon', 'none')
  }
  return {
    channel: 'lexicon',
    vendor: top.vendor,
    tied: [],
    confidence: top.confidence,
    grade: top.verdict,
  }
}

/**
 * Panel order: channels with a result first, by confidence; resultless
 * channels sink in the standing order (fertility → batch → lexicon).
 */
export function rankChannels(channels: readonly ChannelResult[]): readonly ChannelResult[] {
  return channels
    .map((result, index) => ({ result, index }))
    .sort((a, b) =>
      (hasResult(b.result) ? 1 : 0) - (hasResult(a.result) ? 1 : 0)
      || b.result.confidence - a.result.confidence
      || a.index - b.index)
    .map(entry => entry.result)
}

/** The final verdict: the strongest channel's result (null when none has one). */
export function finalVerdictOf(channels: readonly ChannelResult[]): ChannelResult | null {
  return channels.find(hasResult) ?? null
}

/** Vendor set a result names (ties included). */
function vendorsOf(result: ChannelResult): readonly Vendor[] {
  if (result.tied.length > 0) return result.tied
  return result.vendor !== null ? [result.vendor] : []
}

/**
 * How many result channels agree with `top` on a vendor (including `top`
 * itself). Cross-family ties count: a batch `deepseek` agrees with a
 * fertility `deepseek-v4 | step` near-duplicate pair.
 */
export function agreementWith(top: ChannelResult, channels: readonly ChannelResult[]): number {
  const named = vendorsOf(top)
  if (named.length === 0) return 1
  const vendors = new Set(named)
  let count = 1
  for (const result of channels) {
    if (result === top || !hasResult(result)) continue
    if (vendorsOf(result).some(vendor => vendors.has(vendor))) count += 1
  }
  return count
}
