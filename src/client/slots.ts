/**
 * ModelTester slot contract: the inject face delivered to the `shell.overlay`
 * entry and the composed component props.
 *
 * `shell.overlay` is the layout's frame-wide floating layer (`ui-layout`
 * declares it as a root-scope list slot — additive, click-through until an
 * entry opts into pointer events), which is the documented seat for a surface
 * of the panel's own. The entry carries no owner props; the panel reads the
 * live trajectory stats through the injected `useStats` hook.
 */

import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantBlockView } from './conversation.ts'
import type { StatsSnapshot } from './session-store.ts'

/** One finished probe turn of a batch run. */
export interface BatchTurnResult {
  readonly probeId: string
  readonly status: 'answered' | 'timeout' | 'failed'
  /** Visible reply text captured for this turn ('' when nothing arrived). */
  readonly text: string
  /** Prompt-side usage tokens (total − output) of this turn, when reported. */
  readonly promptTokens?: number
  /** Output (completion) tokens of this turn's reply, when reported. */
  readonly outputTokens?: number
  /** The probe prompt this turn answers (batch runs; feeds echo suppression). */
  readonly prompt?: string
  /** Raw assistant blocks (reasoning + visible) when the host exposed them. */
  readonly blocks?: readonly AssistantBlockView[]
}

/** Progress event for one probe of a batch run. */
export interface BatchProgress {
  readonly index: number
  readonly total: number
  readonly probeId: string
  readonly status: 'sending' | 'waiting' | 'answered' | 'timeout' | 'failed'
}

/** Runner options. `parallelism` bounds concurrent probes (1 = sequential). */
export interface RunOptions {
  readonly parallelism?: number
}

/** Probe-send actions backed by the host sessions face (feature-detected). */
export interface ModelTesterActions {
  /**
   * Create a fresh session, open it as current, and send `text` as the first
   * user prompt. Returns `ok: false` with a stable error when the host face
   * does not expose create/open/prompt.
   */
  sendProbe(text: string): Promise<{ ok: boolean; error?: string }>
  /**
   * Batch runner: each probe goes to its OWN fresh session, created
   * immediately before its send and collected while the host has it focused
   * (the conversation assembly materializes for the focused session only).
   * Probes run sequentially; isolation keeps later probes blind to earlier
   * replies. Completed readings are persisted, so re-calling with the same
   * sequence after a crash reuses them. Optional — present only when the
   * host face exposes create/prompt and a pollable conversation snapshot.
   */
  runBatch?(
    items: readonly { id: string; text: string }[],
    onProgress?: (progress: BatchProgress) => void,
    options?: RunOptions,
  ): Promise<{ ok: boolean; error?: string; turns?: readonly BatchTurnResult[] }>
  /**
   * Fertility runner: like `runBatch`, but usage-only readings (prompt-side
   * tokens per fresh session) — collected via the 0.2.0 session projections
   * where available. Optional for the same reasons as `runBatch`.
   */
  runFertility?(
    items: readonly { id: string; text: string }[],
    onProgress?: (progress: BatchProgress) => void,
    options?: RunOptions,
  ): Promise<{ ok: boolean; error?: string; turns?: readonly BatchTurnResult[] }>
  /**
   * Targeted drift re-run: re-measure ONLY the given fertility items, each in
   * a fresh session, with no run-state machinery — the stored verdict stays
   * the safe state while the outliers are refreshed. The panel merges the
   * new readings into the stored measuredCounts and re-scores.
   */
  rerunFertilityProbes?(
    items: readonly { id: string; text: string }[],
    onProgress?: (progress: BatchProgress) => void,
    options?: RunOptions,
  ): Promise<{ ok: boolean; error?: string; turns?: readonly BatchTurnResult[] }>
  /**
   * Query an interrupted fertility run (crash / host restart mid-run), if any.
   * The panel offers to resume; calling `runFertility` with the same probe
   * sequence automatically reuses the persisted readings and pre-created
   * sessions. Optional.
   */
  interruptedFertility?(): {
    startedAt: string
    total: number
    items: readonly {
      id: string
      status: 'answered' | 'timeout' | 'failed' | 'pending'
      promptTokens: number | null
      sessionId: string | null
    }[]
  } | null
  /**
   * Bulk-remove sessions the plugin itself created during test runs.
   * Feature-detected: the 0.1.7 host sessions face has no delete RPC, so this
   * reports `unavailable` until a host ships one. Optional.
   */
  cleanupTestSessions?(
    ids: readonly string[],
  ): Promise<{ ok: boolean; error?: string; removed?: readonly string[] }>
}

/** Business face injected into the ModelTester panel component. */
export interface ModelTesterFace {
  hooks: {
    /** Live per-session trajectory stats (persisted, full-history). */
    stats: HostObservable<StatsSnapshot>
  }
  /** Optional probe-send actions (present when the host face is available). */
  actions?: ModelTesterActions
}

/** Full composed props of the ModelTester panel. */
export type ModelTesterPanelProps =
  PropsRuntime<'shell.overlay'>
  & InjectFace<ModelTesterFace>
  & PropsLocale<'modeltester'>
