/**
 * ModelTester counting engine.
 *
 * Folds reasoning-surface volumes (blocks, characters, replies) into one
 * session-wide snapshot. Volume counting is incremental: the session
 * accumulator (`accumulator.ts`) only folds nodes whose seq lies outside the
 * already-counted range, and a stream delta recounts at most the one
 * in-flight block.
 *
 * The R1-era keyword/trajectory classifier has been retired: style folklore
 * is not structural evidence, and the quantitative tokenizer layer lives in
 * the usage-delta fertility fingerprint (`fertility.ts`). What remains is the
 * reasoning-health diagnostic (a model streaming text with no reasoning
 * blocks is flagged, never word-counted) and the attribution report.
 */

import type { AssistantBlockView, ConversationView } from './conversation.ts'
import { attributeSession, emptyAttribution, type AttributionReport } from './attribution.ts'

/** Reasoning-output health. */
export type ReasoningAnomaly = 'none' | 'missing' | 'low'

/**
 * Session-wide stats folded from a conversation snapshot. `blocks` and
 * `chars` are always the *reasoning* surface (the evidence method); text
 * blocks contribute only diagnostic totals used to flag a missing/starved
 * reasoning trajectory.
 */
export interface TrajectoryStats {
  /** Reasoning health: flags a model that streamed output as text instead of reasoning. */
  readonly anomaly: ReasoningAnomaly
  /** Reasoning blocks seen (finalized nodes + in-flight partial). */
  readonly blocks: number
  /** Reasoning characters. */
  readonly chars: number
  /** Visible text blocks (diagnostic only). */
  readonly textBlocks: number
  /** Visible text characters (diagnostic only). */
  readonly textChars: number
  /** Completed assistant messages. */
  readonly replies: number
  /** Whether a turn is streaming right now. */
  readonly streaming: boolean
  /**
   * Vendor-attribution report over the same surface: ranked candidates plus
   * the per-signal evidence ledger (structural fingerprints — never an
   * identity claim).
   */
  readonly attribution: AttributionReport
}

/** Mutable session-wide fold target. */
export interface SessionCounts {
  blocks: number
  chars: number
  replies: number
}

/** Fresh, zeroed session fold target. */
export function emptySessionCounts(): SessionCounts {
  return { blocks: 0, chars: 0, replies: 0 }
}

/**
 * Fold one block into a session count target. Non-reasoning blocks contribute
 * nothing to the reasoning volumes.
 * @param target - mutable session counts.
 * @param block - assistant block.
 */
export function foldBlock(target: SessionCounts, block: AssistantBlockView): void {
  if (block.kind !== 'reasoning') return
  if (block.text === undefined || block.text === '') return
  target.blocks += 1
  target.chars += block.text.length
}

/**
 * Classify reasoning health from output volumes. Text contributes only as a
 * diagnostic: when a conversation carries visible text but no (or almost no)
 * reasoning, the reasoning surface the evidence method reads does not exist,
 * and the panel reports it rather than inventing counts.
 * @param reasoningChars - reasoning characters (0 when none).
 * @param reasoningBlocks - reasoning block count.
 * @param textChars - visible text characters.
 * @param textBlocks - visible text block count.
 * @returns the anomaly grade.
 */
export function anomalyOf(
  reasoningChars: number,
  reasoningBlocks: number,
  textChars: number,
  textBlocks: number,
): ReasoningAnomaly {
  if (textChars === 0 && textBlocks === 0) return 'none'
  if (reasoningBlocks === 0 || reasoningChars === 0) return 'missing'
  if (reasoningChars / textChars < 0.05) return 'low'
  return 'none'
}

/**
 * Derive the presentational stats from a fold target.
 * @param counts - folded reasoning volumes.
 * @param streaming - whether a turn is streaming.
 * @param diagnostics - visible-text totals used for the anomaly grade.
 * @param attribution - vendor-attribution report (defaults to empty).
 */
export function toTrajectoryStats(
  counts: SessionCounts,
  streaming: boolean,
  diagnostics: { textBlocks: number; textChars: number },
  attribution: AttributionReport = emptyAttribution(),
): TrajectoryStats {
  return {
    anomaly: anomalyOf(counts.chars, counts.blocks, diagnostics.textChars, diagnostics.textBlocks),
    blocks: counts.blocks,
    chars: counts.chars,
    textBlocks: diagnostics.textBlocks,
    textChars: diagnostics.textChars,
    replies: counts.replies,
    streaming,
    attribution,
  }
}

/**
 * One-shot fold over a snapshot — kept for tests and the no-session null case.
 * The live panel uses the incremental accumulator (`accumulator.ts`).
 * @param snapshot - current conversation snapshot (undefined → null result).
 * @returns stats, or null while no session is current.
 */
export function computeStats(snapshot: ConversationView | undefined): TrajectoryStats | null {
  if (snapshot === undefined) return null
  const counts = emptySessionCounts()
  let textBlocks = 0
  let textChars = 0
  const fold = (block: AssistantBlockView): void => {
    if (block.kind === 'reasoning') foldBlock(counts, block)
    else if (block.kind === 'text' && block.text !== undefined) {
      textBlocks += 1
      textChars += block.text.length
    }
  }
  for (const node of snapshot.nodes) {
    if (node.kind !== 'assistant') continue
    counts.replies += 1
    for (const block of node.blocks ?? []) fold(block)
  }
  if (snapshot.partial !== null) {
    for (const block of snapshot.partial.blocks) fold(block)
  }
  return toTrajectoryStats(counts, snapshot.partial !== null, { textBlocks, textChars }, attributeSession(snapshot))
}

/** Human-scale reasoning characters: 12.4K / 1.2M. */
export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(value)
}
