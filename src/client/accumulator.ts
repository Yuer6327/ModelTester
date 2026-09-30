/**
 * Per-session trajectory accumulator with durable persistence.
 *
 * The accumulator folds assistant reasoning volumes into session counts using
 * a high-water mark over the monotonic `seq` space: nodes whose seq lies
 * OUTSIDE the already-counted [minSeq, maxSeq] range are new (appended
 * messages have higher seq; history paged in via `loadOlder` has lower seq),
 * so a revisit after reload folds only what is new and never re-walks the
 * conversation.
 *
 * Compaction rewrites history under fresh seqs — a new `compaction` node whose
 * seq exceeds the last observed one resets the accumulator and recounts the
 * current window, so compacted sessions never double- or under-count.
 *
 * The block text itself is never recounted: `foldBlock` is idempotent per
 * block and only reasoning blocks contribute.
 */

import type { ConversationNodeView, ConversationView } from './conversation.ts'
import { attributeSession, attributionTurnCacheFor } from './attribution.ts'
import {
  emptySessionCounts, foldBlock, toTrajectoryStats,
  type SessionCounts, type TrajectoryStats,
} from './stats.ts'

/** Version of the persisted accumulator schema. */
export const PERSISTENCE_VERSION = 3 as const

/** The current versioned schema written to localStorage. */
export interface VersionedPersistedSessionStats {
  v: typeof PERSISTENCE_VERSION
  minSeq: number
  maxSeq: number
  lastCompactionSeq: number
  blocks: number
  chars: number
  replies: number
  textBlocks: number
  textChars: number
}

/** Read a finite persisted number, defaulting malformed values to zero. */
function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** One session's live accumulator. */
export class SessionStatsAccumulator {
  private minSeq = Number.POSITIVE_INFINITY
  private maxSeq = Number.NEGATIVE_INFINITY
  private lastCompactionSeq = 0
  /** Folded reasoning volumes (the only surface counted). */
  readonly counts: SessionCounts = emptySessionCounts()
  /** Visible-text diagnostic totals — block count + characters only. */
  private textBlocks = 0
  private textChars = 0
  /** Per-session attribution-scan memoization (keyed by assistant node identity). */
  readonly attributionTurnCache = attributionTurnCacheFor(this)

  /**
   * Fold a snapshot into the accumulator. Detects compaction and only counts
   * nodes whose seq is outside the already-counted range.
   * @param snapshot - current conversation snapshot.
   * @returns whether the durable counts changed.
   */
  fold(snapshot: ConversationView): boolean {
    let maxCompaction = 0
    for (const node of snapshot.nodes) {
      if (node.kind === 'compaction' && node.seq > maxCompaction) maxCompaction = node.seq
    }
    if (maxCompaction > this.lastCompactionSeq) {
      // History rewritten: drop the stale window and recount what is present.
      this.lastCompactionSeq = maxCompaction
      this.resetCounts()
      for (const node of snapshot.nodes) {
        if (node.kind === 'assistant') this.foldNode(node)
      }
      return true
    }

    let changed = false
    for (const node of snapshot.nodes) {
      if (node.kind !== 'assistant') continue
      if (node.seq >= this.minSeq && node.seq <= this.maxSeq) continue
      this.foldNode(node)
      changed = true
    }
    return changed
  }

  /** Trajectory stats for the current snapshot, including live in-flight blocks. */
  toStats(snapshot: ConversationView): TrajectoryStats {
    const live: SessionCounts = {
      blocks: this.counts.blocks,
      chars: this.counts.chars,
      replies: this.counts.replies,
    }
    let textBlocks = this.textBlocks
    let textChars = this.textChars
    if (snapshot.partial !== null) {
      for (const block of snapshot.partial.blocks) {
        if (block.kind === 'reasoning') foldBlock(live, block)
        else if (block.kind === 'text' && block.text !== undefined) {
          textBlocks += 1
          textChars += block.text.length
        }
      }
    }
    return toTrajectoryStats(
      live,
      snapshot.partial !== null,
      { textBlocks, textChars },
      attributeSession(snapshot, this.attributionTurnCache),
    )
  }

  /** Whether the accumulator carries any folded data (drives cache reuse). */
  get empty(): boolean {
    return this.counts.replies === 0 && this.counts.blocks === 0
  }

  /** Serialize for durable storage. */
  persist(): VersionedPersistedSessionStats {
    return {
      v: PERSISTENCE_VERSION,
      minSeq: this.minSeq === Number.POSITIVE_INFINITY ? 0 : this.minSeq,
      maxSeq: this.maxSeq === Number.NEGATIVE_INFINITY ? -1 : this.maxSeq,
      lastCompactionSeq: this.lastCompactionSeq,
      blocks: this.counts.blocks,
      chars: this.counts.chars,
      replies: this.counts.replies,
      textBlocks: this.textBlocks,
      textChars: this.textChars,
    }
  }

  /** Rehydrate from durable storage; returns a fresh accumulator on mismatch. */
  static load(data: unknown): SessionStatsAccumulator {
    const acc = new SessionStatsAccumulator()
    if (typeof data !== 'object' || data === null) return acc
    const raw = data as {
      v?: unknown
      minSeq?: unknown
      maxSeq?: unknown
      lastCompactionSeq?: unknown
      blocks?: unknown
      chars?: unknown
      replies?: unknown
      textBlocks?: unknown
      textChars?: unknown
    }
    if (raw.v !== PERSISTENCE_VERSION) return acc
    if (typeof raw.minSeq === 'number') acc.minSeq = raw.minSeq
    if (typeof raw.maxSeq === 'number') acc.maxSeq = raw.maxSeq
    if (typeof raw.lastCompactionSeq === 'number') acc.lastCompactionSeq = raw.lastCompactionSeq
    acc.counts.blocks = finiteNumber(raw.blocks)
    acc.counts.chars = finiteNumber(raw.chars)
    acc.counts.replies = finiteNumber(raw.replies)
    acc.textBlocks = finiteNumber(raw.textBlocks)
    acc.textChars = finiteNumber(raw.textChars)
    return acc
  }

  private foldNode(node: ConversationNodeView): void {
    this.counts.replies += 1
    for (const block of node.blocks ?? []) {
      if (block.kind === 'reasoning') foldBlock(this.counts, block)
      else if (block.kind === 'text' && block.text !== undefined) {
        this.textBlocks += 1
        this.textChars += block.text.length
      }
    }
    if (node.seq < this.minSeq) this.minSeq = node.seq
    if (node.seq > this.maxSeq) this.maxSeq = node.seq
  }

  private resetCounts(): void {
    this.minSeq = Number.POSITIVE_INFINITY
    this.maxSeq = Number.NEGATIVE_INFINITY
    this.counts.blocks = 0
    this.counts.chars = 0
    this.counts.replies = 0
    this.textBlocks = 0
    this.textChars = 0
  }
}
