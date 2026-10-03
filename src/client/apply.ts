/**
 * ModelTester browser plugin body.
 *
 * Registers a `shell.overlay` entry (the layout's frame-wide floating layer —
 * additive and root-scoped) that hosts the reasoning-trajectory stats panel.
 * The panel receives the current session's live conversation slice through
 * an inject `hooks` compartment built over `ctx.sessions` (and, on 0.1.2+,
 * `ctx.uiConversation` for the nodes that left SessionFace).
 *
 * Types come from the intersection of rc.7–0.1.1 (`dsh-client-runtime`) and
 * 0.1.2+ (`dsh-api-session-controller` + locale + ui-layout). The apply
 * argument is a structural ClientContext so the file typechecks without
 * either of those host packages as a value import.
 */

// Type-only merges: Context.locale (locale plugin) and the `shell.overlay`
// SlotMap declaration (ui-layout). Both are erased at compile time.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  conversationViewOf, sessionPresetOf, type AssistantBlockView, type ConversationPort, type ConversationView, type ConversationNodeView,
} from './conversation.ts'
import { ModelTesterPanel } from './ModelTesterPanel.tsx'
import { trackTestSession } from './panel-persist.ts'
import { createStatsStore } from './session-store.ts'
import type { BatchProgress, BatchTurnResult, ModelTesterActions, ModelTesterFace } from './slots.ts'
import { en, NS, zh, type ModelTesterKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    modeltester: ModelTesterKey
  }
}

/**
 * Cordis services required by the browser half.
 *
 * 0.2.0 treats this array as the ctx service authorization list (undeclared
 * services are unreachable); 0.1.x reads it as an activation-order hint, so
 * extra names are inert there. `remote`/`remote.workspace` power the
 * test-session archive action and are feature-detected at runtime — hosts
 * without them degrade to "unavailable", never hang.
 */
export const inject = ['slots', 'sessions', 'uiConversation', 'locale', 'remote', 'remote.workspace']

/**
 * Browser root context as far as apply() is concerned.
 *
 * `ClientContext` lived on `@deepseek-ai/dsh-client-runtime/client` through
 * 0.1.1; 0.1.2 deleted that package. The methods below are the intersection
 * of the two hosts and are all that apply() calls.
 */
interface ClientContext {
  readonly sessions: import('./conversation.ts').SessionsPort
  readonly slots: {
    inject(name: string, callback: () => unknown): unknown
    register(options: object, component: unknown): unknown
  }
  readonly locale: {
    register(ns: string, dicts: Record<string, unknown>): () => void
  }
  effect(callback: () => unknown, name?: string): unknown
  get(name: string): unknown
}

/**
 * Mount the ModelTester panel.
 * @param ctx - Browser root context.
 */
export function apply(ctx: ClientContext): void {
  // Dictionaries first: the register() locale seat renders through the
  // locale face, so the namespace must exist before the panel mounts.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'modeltester: dictionaries')

  // The stats store owns live folding, full-history paging, and persistence.
  // uiConversation is looked up lazily: it must not be a cordis inject, or
  // the fiber would hang forever on hosts that never provide it (rc.7–0.1.1).
  const stats = createStatsStore(
    ctx.sessions,
    typeof window === 'undefined' ? undefined : window.localStorage,
    conversationBindingOf(ctx),
  )

  // `slots.inject` defers the registration until ui-layout declares
  // `shell.overlay` (handles boot-order regardless of the graph edge).
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'modeltester',
    locale: NS,
    inject: (): ModelTesterFace => ({
    hooks: { stats },
    actions: {
      sendProbe: sendProbeOf(ctx),
      runBatch: runBatchOf(ctx),
      runFertility: runFertilityOf(ctx),
      rerunFertilityProbes: rerunFertilityProbesOf(ctx),
      interruptedFertility: interruptedFertilityOf(ctx),
      cleanupTestSessions: cleanupTestSessionsOf(ctx),
      archiveTestSessions: archiveTestSessionsOf(ctx),
      probePresetCatalog: probePresetCatalogOf(ctx),
    },
    }),
  }, ModelTesterPanel))
}

/**
 * Feature-detected session face used by the probe actions, across host
 * shapes: 0.1.x (`create()` → id, `open(id)`) and 0.2.0 (`create(request)` →
 * `{ sessionId }`, `open` replaced by the retain/ready reference mechanism).
 */
interface ProbeSessionsPort {
  create?: (request?: unknown) => Promise<unknown>
  open?: (id: string) => void
  retain?: (id: string, options: { source: string }) => {
    binding: { session?: unknown }
    ready: Promise<unknown>
    release(): void
  }
  using?: (
    id: string,
    options: { source: string },
    operation: (reference: { binding: { session?: unknown } }) => Promise<unknown>,
  ) => Promise<unknown>
  binding?: (id: string) => { session?: { prompt?: unknown; getSnapshot?: () => unknown } } | undefined
}

/**
 * Create one fresh session and bring it to the open state across host shapes.
 *
 * 0.1.x: `create()` returns the id and `open(id)` opens it. 0.2.0: `create()`
 * returns `{ sessionId }` and `open` is gone — the session opens through the
 * retain/ready reference mechanism instead, so the caller must keep the
 * returned reference alive until the prompt (and any reply polling) settles
 * and then call `release()`; releasing starts local scope teardown.
 *
 * `agentPreset` (0.2.0 `SessionCreateRequest.agentPreset`) requests a harness
 * scaffold for the probe session — per-session and immutable once created.
 * The request is best-effort: when the host rejects it (unknown id, older
 * host, strict request validation), the creation is retried WITHOUT the
 * preset and the caller sees no resolved preset — a requested-but-unresolved
 * preset must surface as "unconfirmed", never silently as control success.
 * The resolved preset comes from the create return value when the host
 * reports it, else from the live projection channels (detection read).
 * @param sessions - feature-detected sessions port.
 * @param agentPreset - preset to request, or undefined to follow the host default.
 * @returns the open session id, its prompt face, a release thunk (0.2.0
 * only), and the preset the session actually carries (when detectable), or
 * undefined when the host lacks the face entirely.
 */
async function createOpenedSession(
  sessions: ProbeSessionsPort,
  agentPreset?: string,
): Promise<{ id: string; session?: { prompt?: unknown }; release?: () => void; agentPreset?: string } | undefined> {
  if (typeof sessions.create !== 'function') return undefined
  let created: { sessionId?: string; agentPreset?: unknown } | string | undefined
  let presetRejected = false
  try {
    created = (await sessions.create(agentPreset === undefined ? {} : { agentPreset })) as typeof created
  } catch (error) {
    if (agentPreset === undefined) throw error
    // Unknown preset id or preset-ignorant host: retry on the host default
    // and let `presetRejected` keep the audit honest.
    presetRejected = true
    created = (await sessions.create({})) as typeof created
    void error
  }
  const id = typeof created === 'string' ? created : (created?.sessionId ?? undefined)
  if (id === undefined) return undefined
  trackTestSession(id)
  const resolved = !presetRejected && typeof created === 'object'
    && typeof created.agentPreset === 'string' && created.agentPreset !== ''
    ? created.agentPreset
    : undefined
  const preset = resolved ?? detectSessionPreset(sessions, id)
  if (typeof sessions.open === 'function') {
    sessions.open(id)
    const session = sessions.binding?.(id)?.session
    return { id, session, ...(preset === undefined ? {} : { agentPreset: preset }) }
  }
  if (typeof sessions.retain !== 'function') return undefined
  const reference = sessions.retain(id, { source: 'gateway' })
  await reference.ready
  const bound = (sessions.binding?.(id) ?? (reference.binding as { session?: { prompt?: unknown } } | undefined)) as
    | { session?: { prompt?: unknown } }
    | undefined
  const session = bound?.session
  return { id, session, release: () => reference.release(), ...(preset === undefined ? {} : { agentPreset: preset }) }
}

/**
 * Detection read of one session's agent preset over the live list snapshot:
 * the summary row (`projectionValues.agentPreset` — the channel the host UI
 * reads) first, then the projection channel (`values.agentPreset`). Both
 * channels populate asynchronously after creation, so callers re-read at
 * measurement time rather than trusting one early snapshot.
 */
function detectSessionPreset(sessions: ProbeSessionsPort, id: string): string | undefined {
  try {
    const snap = (sessions as { list?: { getSnapshot?: () => unknown } }).list?.getSnapshot?.() as
      | { byId?: Record<string, unknown>; projectionsBySession?: Map<string, unknown> | Record<string, unknown> }
      | undefined
    if (snap === undefined) return undefined
    const row = snap.byId?.[id]
    const proj = snap.projectionsBySession
    const projection = proj === undefined ? undefined : proj instanceof Map ? proj.get(id) : proj[id]
    return sessionPresetOf(row, projection)
  } catch {
    return undefined
  }
}

/**
 * Probe-send over the host sessions face: `create()` a fresh session, `open()`
 * it as current, then `prompt()` the probe text through the session face — the
 * same client contract the web app's own input uses. Every member is
 * feature-detected; older hosts simply report `unavailable`.
 */
function sendProbeOf(ctx: ClientContext): ModelTesterActions['sendProbe'] {
  return async (text) => {
    try {
      const opened = await createOpenedSession(ctx.sessions as ProbeSessionsPort)
      if (opened === undefined) return { ok: false, error: 'unavailable' }
      const { id, session, release } = opened
      const prompt = (session as { prompt?: unknown } | undefined)?.prompt
      if (typeof prompt !== 'function') {
        release?.()
        return { ok: false, error: 'unavailable' }
      }
      const result = await (prompt as (parts: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') =>
        Promise<{ ok?: boolean; error?: { message?: string } }>).call(session, [{ type: 'text', text }], 'queue')
      if (result !== undefined && result !== null && result.ok === false) {
        release?.()
        return { ok: false, error: result.error?.message ?? 'rejected' }
      }
      // Keep the retained reference alive briefly so the accepted turn can
      // stream back into the live statistics before scope teardown.
      setTimeout(() => release?.(), 30_000)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * Per-session usage reading from the 0.2.0 session projections.
 *
 * `sessions.list.getSnapshot().projectionsBySession` carries a live
 * `tokenUsage` projection per session — served by the host for every session,
 * **including background ones** (unlike the conversation assembly, which only
 * materializes for the main view). This is the collection path that lets the
 * fertility runner measure probes without bringing each session to the front.
 * @param sessions - feature-detected sessions port.
 * @param id - session to read.
 * @returns prompt-side (total − output) and output token counts, or null when
 * the projection has not reported yet.
 */
function projectionUsageOf(
  sessions: ProbeSessionsPort,
  id: string,
): { promptTokens: number; outputTokens: number } | null {
  const list = (sessions as { list?: { getSnapshot?: () => unknown } }).list
  const snap = list?.getSnapshot?.() as
    | { projectionsBySession?: Map<string, unknown> | Record<string, unknown> }
    | undefined
  const proj = snap?.projectionsBySession
  if (!proj) return null
  const entry = proj instanceof Map ? proj.get(id) : (proj as Record<string, unknown>)[id]
  const values = (entry as { values?: unknown } | undefined)?.values
  if (!values) return null
  const tu = (values instanceof Map ? values.get('tokenUsage') : (values as Record<string, unknown>)['tokenUsage']) as
    | { uncachedInputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number }
    | undefined
  if (!tu || typeof tu !== 'object') return null
  const promptTokens = (tu.uncachedInputTokens ?? 0) + (tu.cacheReadTokens ?? 0) + (tu.cacheWriteTokens ?? 0)
  const outputTokens = tu.outputTokens ?? 0
  if (!Number.isSafeInteger(promptTokens) || !Number.isSafeInteger(outputTokens)) return null
  return { promptTokens, outputTokens }
}

/**
 * Wait for a background probe reply using the projections channel: output
 * tokens start growing, then hold steady across three consecutive polls —
 * the stable reading carries the turn's prompt-side count. Wakes fire on
 * projection pushes, so the stability check sees fresh data immediately.
 */
async function waitForProjectionTurn(
  read: () => { promptTokens: number; outputTokens: number } | null,
  probeId: string,
  wakes: readonly ((notify: () => void) => () => void)[] = [],
): Promise<BatchTurnResult> {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let lastOutput = -1
  let stable = 0
  let sawData = false
  let last: { promptTokens: number; outputTokens: number } | null = null
  while (Date.now() < deadline) {
    await waitTick(POLL_INTERVAL_MS, wakes)
    last = read()
    if (last === null) continue
    sawData = true
    if (last.outputTokens > 0 && last.outputTokens === lastOutput) {
      stable += 1
      if (stable >= 3) return { probeId, status: 'answered', text: '', ...last }
    } else {
      stable = 0
    }
    lastOutput = last.outputTokens
  }
  if (!sawData) return { probeId, status: 'timeout', text: '' }
  return { probeId, status: 'timeout', text: '', ...(last ?? {}) }
}

// ---------------------------------------------------------------------------
// Fertility run-state persistence — a run survives host restarts.
//
// Every state transition is written to localStorage immediately: pre-created
// session ids, per-probe readings. After a crash the panel offers to resume,
// completed readings are reused verbatim, and only the missing probes run.
// ---------------------------------------------------------------------------

interface FertRunState {
  startedAt: string
  probeIds: readonly string[]
  /** probeId → pre-created/created session id (survives restarts: the host keeps sessions). */
  sessionIds: Record<string, string>
  /** probeId → agent preset the session actually carries (detection read;
   *  absent entries mean "undetectable", never "no preset"). */
  presets?: Record<string, string>
  /**
   * Probe ids whose text was already pushed into their session. A crash
   * between send and reading leaves the text parked in that session — a
   * resume must give such probes a FRESH session, never re-send into the
   * old one (a double send doubles the wrapper in the reading and corrupts
   * the whole vector; measured 2026-10-01 on the real host).
   */
  sent?: readonly string[]
  /** Completed probe readings, reused verbatim on resume. */
  done: readonly { probeId: string; status: 'answered' | 'timeout' | 'failed'; promptTokens: number | null; outputTokens: number | null; sessionId: string }[]
}

const FERT_RUN_KEY = 'dsh-modeltester.fert-run.v1'

function readFertRunState(storage: Storage | undefined): FertRunState | null {
  if (storage === undefined) return null
  try {
    const raw = storage.getItem(FERT_RUN_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const r = parsed as Partial<FertRunState>
    if (!Array.isArray(r.probeIds) || typeof r.sessionIds !== 'object' || r.sessionIds === null || !Array.isArray(r.done)) return null
    // Preset audit entries: keep only string values (older state files lack the field).
    const presets: Record<string, string> = {}
    if (typeof r.presets === 'object' && r.presets !== null) {
      for (const [id, preset] of Object.entries(r.presets)) {
        if (typeof preset === 'string' && preset !== '') presets[id] = preset
      }
    }
    return { ...r, presets } as FertRunState
  } catch {
    return null
  }
}

function writeFertRunState(storage: Storage | undefined, state: FertRunState): void {
  if (storage === undefined) return
  try {
    storage.setItem(FERT_RUN_KEY, JSON.stringify(state))
  } catch {
    /* private mode / quota: non-fatal */
  }
}

function clearFertRunState(storage: Storage | undefined): void {
  if (storage === undefined) return
  try {
    storage.removeItem(FERT_RUN_KEY)
  } catch {
    /* non-fatal */
  }
}

/** Face for the interrupted-run query exposed to the panel. */
function interruptedFertilityOf(ctx: ClientContext): NonNullable<ModelTesterActions['interruptedFertility']> {
  return () => {
    const state = readFertRunState(typeof window === 'undefined' ? undefined : window.localStorage)
    if (state === null) return null
    const doneMap = new Map(state.done.map(d => [d.probeId, d]))
    const items = state.probeIds.map(id => {
      const d = doneMap.get(id)
      return {
        id,
        status: (d?.status ?? 'pending') as 'answered' | 'timeout' | 'failed' | 'pending',
        promptTokens: d?.promptTokens ?? null,
        sessionId: state.sessionIds[id] ?? null,
      }
    })
    return { startedAt: state.startedAt, total: state.probeIds.length, items }
  }
}

// ---------------------------------------------------------------------------
// Batch run-state persistence — same crash contract as fertility, plus the
// collected reply evidence (text + blocks) so a resumed run rebuilds the
// aggregate without re-asking answered probes.
// ---------------------------------------------------------------------------

interface BatchRunState {
  startedAt: string
  probeIds: readonly string[]
  /** probeId → pre-created/created session id (survives restarts). */
  sessionIds: Record<string, string>
  /** Probe ids whose text was already pushed into their session (resume must
   * abandon those sessions — re-sending would append a second turn). */
  sent?: readonly string[]
  /** Completed probe readings, reused verbatim on resume. */
  done: readonly {
    probeId: string
    status: 'answered' | 'timeout' | 'failed'
    text: string
    promptTokens: number | null
    outputTokens: number | null
    sessionId: string
    prompt?: string
    blocks?: readonly AssistantBlockView[]
    /** Agent preset the session actually carries (detection read), when known. */
    agentPreset?: string
  }[]
}

const BATCH_RUN_KEY = 'dsh-modeltester.batch-run.v1'

function readBatchRunState(storage: Storage | undefined): BatchRunState | null {
  if (storage === undefined) return null
  try {
    const raw = storage.getItem(BATCH_RUN_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const r = parsed as Partial<BatchRunState>
    if (!Array.isArray(r.probeIds) || typeof r.sessionIds !== 'object' || r.sessionIds === null || !Array.isArray(r.done)) return null
    return r as BatchRunState
  } catch {
    return null
  }
}

function writeBatchRunState(storage: Storage | undefined, state: BatchRunState): void {
  if (storage === undefined) return
  try {
    storage.setItem(BATCH_RUN_KEY, JSON.stringify(state))
  } catch {
    /* private mode / quota: non-fatal */
  }
}

function clearBatchRunState(storage: Storage | undefined): void {
  if (storage === undefined) return
  try {
    storage.removeItem(BATCH_RUN_KEY)
  } catch {
    /* non-fatal */
  }
}

/**
 * Bounded worker pool over pending probe indexes. A hard "unavailable" stops
 * the pool; in-flight probes still finish (their callers persist readings),
 * so a resume reuses them. Returns the error message or null.
 */
async function runProbePool(
  pending: readonly number[],
  parallelism: number,
  measure: (index: number) => Promise<void>,
): Promise<string | null> {
  let cursor = 0
  let hardError: string | null = null
  const worker = async (): Promise<void> => {
    while (hardError === null) {
      const slot = cursor
      if (slot >= pending.length) return
      cursor += 1
      try {
        await measure(pending[slot]!)
      } catch (error) {
        hardError = error instanceof Error ? error.message : String(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallelism, pending.length) }, worker))
  return hardError
}

/** Panel-configured parallelism, clamped to the polite 1–8 band. */
function clampParallelism(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return FERTILITY_PARALLELISM
  return Math.max(1, Math.min(8, Math.round(value)))
}

/**
 * Fertility runner: each item gets its OWN fresh session. Per-turn
 * prompt-side usage (totalTokens − outputTokens) is then the gateway wrapper
 * plus that item's text under the serving tokenizer — differencing across
 * items cancels the wrapper without any history accumulation the host's
 * context management would distort.
 *
 * Collection is dual-path: on 0.2.0 the usage readings come from the host's
 * per-session projections, which serve background sessions — the panel never
 * needs to bring a probe session to the front, and switching sessions or
 * models mid-run does not affect already-created probe sessions (all probe
 * sessions are pre-created up front, locking the serving model at start).
 * Because background projections are per-session, the pending probes also
 * run CONCURRENTLY on that path (bounded by FERTILITY_PARALLELISM), cutting
 * wall time to roughly latency × ⌈n / parallelism⌉; the 0.1.x foreground
 * path polls the single open conversation and stays strictly sequential.
 *
 * Crash-safe: the run state (pre-created session ids + completed readings)
 * is persisted after every step. If the host process dies mid-run, the panel
 * offers to resume on restart — finished readings are reused verbatim and
 * only the missing probes run.
 */
function runFertilityOf(ctx: ClientContext): NonNullable<ModelTesterActions['runFertility']> {
  return async (items, onProgress, options) => {
    const storage = typeof window === 'undefined' ? undefined : window.localStorage
    try {
      const sessions = ctx.sessions as unknown as ProbeSessionsPort
      const presetRequest = options?.probePreset
      const turns: BatchTurnResult[] = []

      // --- Resume detection: same probe sequence → continue an interrupted run.
      const prev = readFertRunState(storage)
      const resume = prev !== null
        && prev.probeIds.length === items.length
        && items.every((item, i) => prev.probeIds[i] === item.id)
      const doneMap = new Map<string, FertRunState['done'][number]>()
      const sessionIds: Record<string, string> = {}
      const presets: Record<string, string> = {}
      const sent = new Set<string>()
      if (resume && prev !== null) {
        // Only ANSWERED readings are measurements: failed/timeout probes
        // re-run (their old sessions may already hold the sent text, which
        // the `sent` set below tracks).
        for (const d of prev.done) {
          if (d.status === 'answered' && d.promptTokens !== null) doneMap.set(d.probeId, d)
        }
        Object.assign(sessionIds, prev.sessionIds)
        Object.assign(presets, prev.presets ?? {})
        for (const id of prev.sent ?? []) sent.add(id)
      }

      const state = (): FertRunState => ({
        startedAt: prev?.startedAt ?? new Date().toISOString(),
        probeIds: items.map(item => item.id),
        sessionIds,
        ...(Object.keys(presets).length > 0 ? { presets } : {}),
        sent: [...sent],
        done: [...doneMap.values()],
      })

      // --- Phase 1: pre-create (or re-retain) every probe session up front.
      //      All sessions inherit the same default model at creation time, so
      //      a mid-run model switch cannot mix fingerprints. Created ids are
      //      persisted one by one: a crash right after this loop still leaves
      //      every session recoverable through sessions.retain().
      //      Probes with a reused answered reading need no session. Probes
      //      whose session is `sent`-tainted get a FRESH one — the old session
      //      may already contain the probe text, and re-sending would double
      //      the wrapper in the reading.
      const opened: { id: string; session?: { prompt?: unknown }; release?: () => void; agentPreset?: string }[] = []
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!
        onProgress?.({ index, total: items.length, probeId: item.id, status: 'sending' })
        if (doneMap.has(item.id)) continue
        const existingId = sessionIds[item.id]
        if (existingId !== undefined && !sent.has(item.id) && typeof sessions.retain === 'function') {
          // Resume path: the session survived the restart on the host — re-activate.
          const reference = sessions.retain(existingId, { source: 'gateway' })
          await reference.ready
          const bound = (sessions.binding?.(existingId) ?? (reference.binding as { session?: { prompt?: unknown } } | undefined)) as
            | { session?: { prompt?: unknown } }
            | undefined
          const session = bound?.session
          const preset = presets[item.id] ?? detectSessionPreset(sessions, existingId)
          if (preset !== undefined) presets[item.id] = preset
          opened[index] = { id: existingId, session, release: () => reference.release(), ...(preset === undefined ? {} : { agentPreset: preset }) }
          continue
        }
        const created = await createOpenedSession(sessions, presetRequest)
        if (created === undefined) return { ok: false, error: 'unavailable' }
        sessionIds[item.id] = created.id
        if (created.agentPreset !== undefined) presets[item.id] = created.agentPreset
        sent.delete(item.id)
        opened[index] = created
        writeFertRunState(storage, state())
      }
      if (prev === null || !resume) writeFertRunState(storage, state())

      // 0.2.0 projections channel: per-session tokenUsage projections served
      // for background sessions — the only path where concurrent probe
      // collection is possible (0.1.x polls the single foreground view).
      const list = (sessions as { list?: { getSnapshot?: () => unknown } }).list
      const projectionsChannel = ((list?.getSnapshot?.() as { projectionsBySession?: unknown } | undefined)?.projectionsBySession ?? null) !== null

      // Reused readings (resume) fill their slots up front and report once.
      const turnsByIndex: (BatchTurnResult | undefined)[] = items.map((item, index) => {
        const finished = doneMap.get(item.id)
        if (finished === undefined) return undefined
        onProgress?.({ index, total: items.length, probeId: item.id, status: finished.status })
        return { probeId: item.id, status: finished.status, text: '', promptTokens: finished.promptTokens ?? undefined, outputTokens: finished.outputTokens ?? undefined }
      })
      // Probes that actually need to run (no answered reading yet).
      const pending = items
        .map((_item, index) => index)
        .filter(index => turnsByIndex[index] === undefined)

      const measureProbe = async (index: number): Promise<BatchTurnResult> => {
        const item = items[index]!
        const report = (status: BatchProgress['status']): void =>
          onProgress?.({ index, total: items.length, probeId: item.id, status })
        report('sending')
        const { id, session, release } = opened[index]!
        const prompt = (session as { prompt?: unknown } | undefined)?.prompt
        if (typeof prompt !== 'function') {
          release?.()
          throw new Error('unavailable')
        }
        const send = (prompt as (parts: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') =>
          Promise<{ ok?: boolean; error?: { message?: string } }>).bind(session)
        // Persist BEFORE sending: a crash after the send leaves the text in
        // the session, and the `sent` marker forces any resume onto a fresh
        // session instead of a double send.
        sent.add(item.id)
        writeFertRunState(storage, state())
        const result = await send([{ type: 'text', text: item.text }], 'queue')
        if (result !== undefined && result !== null && result.ok === false) {
          release?.()
          const failedTurn = { probeId: item.id, status: 'failed' as const, text: '' }
          doneMap.set(item.id, { ...failedTurn, promptTokens: null, outputTokens: null, sessionId: id })
          writeFertRunState(storage, state())
          report('failed')
          return failedTurn
        }
        report('waiting')
        let turn: BatchTurnResult
        if (projectionsChannel) {
          // 0.2.0 projections path — readings serve background sessions.
          turn = await waitForProjectionTurn(() => projectionUsageOf(sessions, id), item.id, listWakes(sessions))
        } else {
          // 0.1.x foreground path — conversation snapshot of the open session.
          const poller = pollOf(ctx, id, sessions)
          if (poller === null) {
            release?.()
            throw new Error('unavailable')
          }
          turn = await waitForTurn(poller, 0, item.id)
        }
        // Persist the reading BEFORE releasing: a crash after this line still
        // keeps the measurement, and the release only starts local teardown.
        // The sent marker only clears on an ANSWERED reading — a timeout left
        // the text in the session, so a resume re-runs it in a fresh one.
        if (turn.status === 'answered') sent.delete(item.id)
        // Preset audit: re-read the detection channels at measurement time —
        // they populate asynchronously after creation.
        const preset = opened[index]!.agentPreset ?? detectSessionPreset(sessions, id)
        if (preset !== undefined) presets[item.id] = preset
        doneMap.set(item.id, { probeId: item.id, status: turn.status, promptTokens: turn.promptTokens ?? null, outputTokens: turn.outputTokens ?? null, sessionId: id })
        writeFertRunState(storage, state())
        release?.()
        report(turn.status)
        return { ...turn, ...(preset === undefined ? {} : { agentPreset: preset }) }
      }

      const parallelism = clampParallelism(options?.parallelism)
      if (pending.length > 0 && projectionsChannel && parallelism > 1) {
        // Bounded worker pool: each worker pulls the next pending probe,
        // sends it, and waits for its own session's reading. A hard
        // "unavailable" stops the pool; in-flight probes still finish and
        // persist their readings, so a resume reuses them.
        const hardError = await runProbePool(pending, parallelism, async index => {
          turnsByIndex[index] = await measureProbe(index)
        })
        if (hardError !== null) return { ok: false, error: hardError }
      } else {
        // Sequential: the 0.1.x foreground path (or a parallelism of 1).
        for (const index of pending) {
          turnsByIndex[index] = await measureProbe(index)
        }
      }
      for (let index = 0; index < items.length; index++) turns.push(turnsByIndex[index]!)
      clearFertRunState(storage)
      return { ok: true, turns }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * Targeted drift re-run: re-measure ONLY the given fertility items, each in a
 * FRESH session (never re-sent into an old one — a double send doubles the
 * wrapper and corrupts the vector). No run-state machinery: the stored verdict
 * stays the safe state the whole time, and a crash mid-retry simply means the
 * panel can re-run the retry. The panel merges the fresh readings into the
 * stored measuredCounts and re-scores; only a re-score that clears drift is
 * adopted.
 */
function rerunFertilityProbesOf(ctx: ClientContext): NonNullable<ModelTesterActions['rerunFertilityProbes']> {
  return async (items, onProgress, options) => {
    try {
      const sessions = ctx.sessions as unknown as ProbeSessionsPort
      const presetRequest = options?.probePreset
      const turns: BatchTurnResult[] = []

      // Fresh session per item, pre-created up front (locks the serving model).
      const opened: { id: string; session?: { prompt?: unknown }; release?: () => void; agentPreset?: string }[] = []
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!
        onProgress?.({ index, total: items.length, probeId: item.id, status: 'sending' })
        const created = await createOpenedSession(sessions, presetRequest)
        if (created === undefined) return { ok: false, error: 'unavailable' }
        opened[index] = created
      }

      // 0.2.0 projections channel: usage readings serve background sessions,
      // so the re-runs can go concurrent; 0.1.x polls the foreground view.
      const list = (sessions as { list?: { getSnapshot?: () => unknown } }).list
      const projectionsChannel = ((list?.getSnapshot?.() as { projectionsBySession?: unknown } | undefined)?.projectionsBySession ?? null) !== null

      const measureProbe = async (index: number): Promise<void> => {
        const item = items[index]!
        const report = (status: BatchProgress['status']): void =>
          onProgress?.({ index, total: items.length, probeId: item.id, status })
        report('sending')
        const { id, session, release } = opened[index]!
        const prompt = (session as { prompt?: unknown } | undefined)?.prompt
        if (typeof prompt !== 'function') {
          release?.()
          throw new Error('unavailable')
        }
        const send = (prompt as (parts: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') =>
          Promise<{ ok?: boolean; error?: { message?: string } }>).bind(session)
        const result = await send([{ type: 'text', text: item.text }], 'queue')
        if (result !== undefined && result !== null && result.ok === false) {
          release?.()
          report('failed')
          turns.push({ probeId: item.id, status: 'failed', text: '' })
          return
        }
        report('waiting')
        let turn: BatchTurnResult
        if (projectionsChannel) {
          turn = await waitForProjectionTurn(() => projectionUsageOf(sessions, id), item.id, listWakes(sessions))
        } else {
          const poller = pollOf(ctx, id, sessions)
          if (poller === null) {
            release?.()
            throw new Error('unavailable')
          }
          turn = await waitForTurn(poller, 0, item.id)
        }
        release?.()
        report(turn.status)
        const preset = opened[index]!.agentPreset ?? detectSessionPreset(sessions, opened[index]!.id)
        turns.push({ ...turn, ...(preset === undefined ? {} : { agentPreset: preset }) })
      }

      const parallelism = clampParallelism(options?.parallelism)
      if (projectionsChannel && parallelism > 1) {
        const hardError = await runProbePool(items.map((_item, index) => index), parallelism, measureProbe)
        if (hardError !== null) return { ok: false, error: hardError }
      } else {
        for (let index = 0; index < items.length; index++) await measureProbe(index)
      }
      return { ok: true, turns }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * Live agent-preset catalog over the session list: every preset the host's
 * sessions currently expose (via the detection channels), plus the main-view
 * session's preset. This is how the preset picker bootstraps without a
 * hardcoded id list — presets are host-configured data, so the panel can only
 * enumerate what the host itself shows. Best-effort: a host that exposes
 * neither channel reports an empty catalog with `current: null`.
 */
function probePresetCatalogOf(ctx: ClientContext): NonNullable<ModelTesterActions['probePresetCatalog']> {
  return () => {
    const sessions = ctx.sessions as unknown as ProbeSessionsPort
    const found = new Set<string>()
    let current: string | null = null
    try {
      const snap = (sessions as { list?: { getSnapshot?: () => unknown } }).list?.getSnapshot?.() as
        | { ids?: readonly string[]; byId?: Record<string, unknown>; projectionsBySession?: Map<string, unknown> | Record<string, unknown> }
        | undefined
      if (snap !== undefined) {
        for (const key of snap.ids ?? []) {
          const row = snap.byId?.[key]
          const proj = snap.projectionsBySession
          const projection = proj === undefined ? undefined : proj instanceof Map ? proj.get(key) : proj[key]
          const preset = sessionPresetOf(row, projection)
          if (preset === undefined) continue
          found.add(preset)
          if ((row as { retainedBy?: { mainView?: number } } | undefined)?.retainedBy?.mainView !== undefined
            && ((row as { retainedBy?: { mainView?: number } }).retainedBy?.mainView ?? 0) > 0) {
            current = preset
          }
        }
      }
    } catch {
      /* a hostile snapshot shape must not break the panel */
    }
    return { current, presets: [...found].sort() }
  }
}

/**
 * Bulk-archive the plugin's own test sessions through the client
 * `ctx.remote.workspace` namespace (`WorkspaceRemote.archiveSession`).
 *
 * This is the cleanup that actually exists on 0.2.0: the sessions face has no
 * delete RPC, but the workspace controller archives any session — the same
 * mutation the sidebar's 归档会话 button performs. Archiving removes sessions
 * from the grouping lists while the stored logs stay on disk, so the host's
 * usage dashboards (which fold over the logs) keep their numbers. Hosts
 * without the namespace (0.1.x) report `unavailable`.
 */
export function archiveTestSessionsOf(ctx: ClientContext): NonNullable<ModelTesterActions['archiveTestSessions']> {
  return async (ids) => {
    const remote = ((ctx as { remote?: unknown }).remote ?? ctx.get?.('remote')) as
      | {
          workspace?: {
            archiveSession?: (request: { sessionId: string }) => Promise<{ archivedSessionIds?: readonly string[] }>
          }
        }
    const archive = remote?.workspace?.archiveSession
    if (typeof archive !== 'function') return { ok: false, error: 'unavailable', archived: [] }
    const archived: string[] = []
    for (const id of ids) {
      try {
        await archive.call(remote.workspace, { sessionId: id })
        archived.push(id)
      } catch {
        /* keep archiving the rest; the failed id simply stays listed */
      }
    }
    return { ok: true, archived }
  }
}

/**
 * Bulk cleanup of test-created sessions. The 0.1.7 host sessions face
 * (create/fork/rename/search/list) exposes NO delete — feature-detect a
 * removal member and report honestly when absent, so the button starts
 * working the moment a host ships one.
 */
function cleanupTestSessionsOf(ctx: ClientContext): NonNullable<ModelTesterActions['cleanupTestSessions']> {
  return async (ids) => {
    const sessions = ctx.sessions as unknown as {
      remove?: (id: string) => Promise<unknown> | unknown
      delete?: (id: string) => Promise<unknown> | unknown
      binding?: (id: string) => { session?: { remove?: (id: string) => Promise<unknown> | unknown } } | undefined
    }
    const removeOf = (id: string): (() => unknown) | null => {
      if (typeof sessions.remove === 'function') return () => sessions.remove!(id)
      if (typeof sessions.delete === 'function') return () => sessions.delete!(id)
      const session = sessions.binding?.(id)?.session
      if (session !== undefined && typeof session.remove === 'function') return () => session.remove!(id)
      return null
    }
    const removed: string[] = []
    for (const id of ids) {
      const remove = removeOf(id)
      if (remove === null) return { ok: false, error: 'unavailable', removed: [] }
      try {
        await remove()
        removed.push(id)
      } catch {
        /* keep removing the rest */
      }
    }
    return { ok: true, removed }
  }
}

/**
 * Batch probe-send over the host sessions face: every probe goes to its OWN
 * fresh session, created IMMEDIATELY BEFORE its send. The host focuses the
 * newly created session, and the conversation assembly materializes for that
 * main-view session only — so the probe is sent and collected while its own
 * session owns the view. This is the shape the real host validated
 * (alpha.2's one-session batch collected 11/11; a pre-create + parallel
 * variant measured 2026-10-02 on the desktop host collected 0/12 because
 * background sessions have no assembly — usage projections do, which is why
 * the fertility runner keeps its parallel background path).
 *
 * Per-probe sessions keep the isolation win: later probes never see earlier
 * replies, and no cross-contamination enters the aggregate.
 *
 * Crash-safe: completed readings (text included) are persisted after every
 * step; calling again with the same probe sequence reuses them and only
 * re-runs the missing probes. The 0.1.x path is the same flow with `open()`.
 */
function runBatchOf(ctx: ClientContext): NonNullable<ModelTesterActions['runBatch']> {
  return async (items, onProgress, options) => {
    const storage = typeof window === 'undefined' ? undefined : window.localStorage
    try {
      const sessions = ctx.sessions as unknown as ProbeSessionsPort
      const presetRequest = options?.probePreset
      const turns: BatchTurnResult[] = []

      // --- Resume reuse: same probe sequence → answered readings reused.
      const prev = readBatchRunState(storage)
      const resume = prev !== null
        && prev.probeIds.length === items.length
        && items.every((item, i) => prev.probeIds[i] === item.id)
      const doneMap = new Map<string, BatchRunState['done'][number]>()
      if (resume && prev !== null) {
        for (const d of prev.done) {
          if (d.status === 'answered') doneMap.set(d.probeId, d)
        }
      }
      const state = (): BatchRunState => ({
        startedAt: prev?.startedAt ?? new Date().toISOString(),
        probeIds: items.map(item => item.id),
        sessionIds: {},
        sent: [],
        done: [...doneMap.values()],
      })

      // Reused readings fill their slots up front and report once.
      const turnsByIndex: (BatchTurnResult | undefined)[] = items.map((item, index) => {
        const finished = doneMap.get(item.id)
        if (finished === undefined) return undefined
        onProgress?.({ index, total: items.length, probeId: item.id, status: finished.status })
        return {
          probeId: item.id,
          status: finished.status,
          text: finished.text,
          ...(finished.prompt === undefined ? {} : { prompt: finished.prompt }),
          ...(finished.blocks === undefined ? {} : { blocks: finished.blocks }),
          ...(finished.promptTokens === null ? {} : { promptTokens: finished.promptTokens }),
          ...(finished.outputTokens === null ? {} : { outputTokens: finished.outputTokens }),
          ...(finished.agentPreset === undefined ? {} : { agentPreset: finished.agentPreset }),
        }
      })
      writeBatchRunState(storage, state())

      const pending = items
        .map((_item, index) => index)
        .filter(index => turnsByIndex[index] === undefined)

      for (const index of pending) {
        const item = items[index]!
        const report = (status: BatchProgress['status']): void =>
          onProgress?.({ index, total: items.length, probeId: item.id, status })
        report('sending')
        // Create the probe's own session immediately before sending: the host
        // focuses it, so the assembly exists while this probe is collected.
        const created = await createOpenedSession(sessions, presetRequest)
        if (created === undefined) return { ok: false, error: 'unavailable' }
        const { id, session, release } = created
        const prompt = (session as { prompt?: unknown } | undefined)?.prompt
        if (typeof prompt !== 'function') {
          release?.()
          return { ok: false, error: 'unavailable' }
        }
        const poller = pollOf(ctx, id, sessions)
        if (poller === null) {
          release?.()
          return { ok: false, error: 'unavailable' }
        }
        const before = assistantCountOf(poller.read())
        const send = (prompt as (parts: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') =>
          Promise<{ ok?: boolean; error?: { message?: string } }>).bind(session)
        const result = await send([{ type: 'text', text: item.text }], 'queue')
        if (result !== undefined && result !== null && result.ok === false) {
          doneMap.set(item.id, { probeId: item.id, status: 'failed', text: '', promptTokens: null, outputTokens: null, sessionId: id, prompt: item.text })
          writeBatchRunState(storage, state())
          release?.()
          report('failed')
          turnsByIndex[index] = { probeId: item.id, status: 'failed', text: '', prompt: item.text }
          continue
        }
        report('waiting')
        const turn = await waitForTurn(poller, before, item.id, item.text)
        const preset = created.agentPreset ?? detectSessionPreset(sessions, id)
        doneMap.set(item.id, {
          probeId: item.id,
          status: turn.status,
          text: turn.text,
          promptTokens: turn.promptTokens ?? null,
          outputTokens: turn.outputTokens ?? null,
          sessionId: id,
          prompt: item.text,
          blocks: turn.blocks,
          ...(preset === undefined ? {} : { agentPreset: preset }),
        })
        writeBatchRunState(storage, state())
        release?.()
        report(turn.status)
        turnsByIndex[index] = { ...turn, ...(preset === undefined ? {} : { agentPreset: preset }) }
      }

      for (let index = 0; index < items.length; index++) {
        const turn = turnsByIndex[index]
        if (turn !== undefined) turns.push(turn)
      }
      clearBatchRunState(storage)
      return { ok: true, turns }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** Poll cadence fallback and per-turn ceiling for the runners. Wakes from the
 *  host observables fire first; the timer only bounds the wait. */
const POLL_INTERVAL_MS = 800
const TURN_TIMEOUT_MS = 300_000

/**
 * Max fertility probes in flight at once on the 0.2.0 projections path.
 * Bounded to stay polite with the gateway (free-tier rate limits and the
 * user's own traffic share it); wall time scales roughly as
 * latency × ⌈probes / parallelism⌉. 1 disables concurrency.
 */
const FERTILITY_PARALLELISM = 4

/**
 * Snapshot poller for one session: prefers the 0.1.2+ conversation assembly
 * (`uiConversation.binding(id)`), falls back to the session snapshot (rc.7–
 * 0.1.1 carry nodes on SessionFace). Returns null when neither is pollable.
 *
 * `wakes` are subscribe closures over the same host observables: pushes fire
 * even when Chromium throttles timers in occluded windows, which is the
 * normal state for probe sessions (the main window is usually backgrounded
 * during a batch run) — timer-only polling stalls to ~1 tick/minute there
 * (measured 2026-10-02 on the desktop host).
 */
interface SessionPoller {
  read: () => ConversationView | undefined
  wakes: readonly ((notify: () => void) => () => void)[]
}

function pollOf(
  ctx: ClientContext,
  id: string,
  sessions: ProbeSessionsPort,
): SessionPoller | null {
  const ui = ctx.get('uiConversation') as { binding?: (sessionId: string) => ConversationPort } | undefined
  const conversation = ui !== undefined && typeof ui.binding === 'function' ? ui.binding(id) : undefined
  const sessionPort = sessions.binding?.(id)?.session
  const sessionGet = sessionPort?.getSnapshot
  const readSession = sessionPort !== undefined && typeof sessionGet === 'function'
    ? () => sessionGet.call(sessionPort)
    : null
  const readConversation = conversation !== undefined && typeof conversation.snapshot?.getSnapshot === 'function'
    ? () => conversation.snapshot.getSnapshot()
    : null
  if (readSession === null && readConversation === null) return null
  const wakes: ((notify: () => void) => () => void)[] = []
  if (conversation !== undefined && typeof conversation.snapshot?.subscribe === 'function') {
    wakes.push(notify => conversation.snapshot.subscribe(notify))
  }
  if (sessionPort !== undefined && typeof (sessionPort as { subscribe?: unknown }).subscribe === 'function') {
    const subscribe = (sessionPort as unknown as { subscribe: (fn: () => void) => () => void }).subscribe
    wakes.push(notify => subscribe.call(sessionPort, notify))
  }
  return {
    read: () => {
      try {
        const sessionRaw = readSession?.()
        const conversationRaw = readConversation?.()
        if (sessionRaw === undefined) return conversationRaw === undefined ? undefined : conversationViewOf(conversationRaw)
        return conversationViewOf(sessionRaw, conversationRaw ?? sessionRaw)
      } catch {
        // A session being created/opened may briefly publish nothing pollable.
        return undefined
      }
    },
    wakes,
  }
}

/** Subscriptions over the session-list snapshot — projection updates push. */
function listWakes(sessions: ProbeSessionsPort): readonly ((notify: () => void) => () => void)[] {
  const list = (sessions as { list?: { subscribe?: (fn: () => void) => () => void } }).list
  if (list !== undefined && typeof list.subscribe === 'function') return [notify => list.subscribe!(notify)]
  return []
}

/**
 * One wait tick: settle after `ms` OR at the first observable push, whichever
 * comes first. With working subscriptions a finished reply is seen almost
 * immediately; the timer is only the fallback (throttle-immune check).
 */
async function waitTick(ms: number, wakes: readonly ((notify: () => void) => () => void)[]): Promise<void> {
  if (wakes.length === 0) {
    await new Promise(resolve => setTimeout(resolve, ms))
    return
  }
  let settled = false
  let resolve: () => void = () => {}
  const promise = new Promise<void>(r => { resolve = r })
  const settle = (): void => {
    if (settled) return
    settled = true
    resolve()
  }
  const unsubs: (() => void)[] = []
  for (const wake of wakes) {
    try {
      unsubs.push(wake(settle))
    } catch {
      /* a dead observable must not break the wait */
    }
  }
  const timer = setTimeout(settle, ms)
  await promise
  clearTimeout(timer)
  for (const unsub of unsubs) {
    try {
      unsub()
    } catch {
      /* non-fatal */
    }
  }
}

function assistantCountOf(view: ConversationView | undefined): number {
  return view?.nodes.filter(node => node.kind === 'assistant').length ?? 0
}

/** Visible reply text of the given nodes — the batch scanner's surface. */
function blockTextOf(nodes: readonly ConversationNodeView[]): string {
  return nodes
    .flatMap(node => node.blocks ?? [])
    .filter(block => block.kind === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

/** Raw assistant blocks of the given nodes (reasoning + visible). */
function blocksOf(nodes: readonly ConversationNodeView[]): ConversationNodeView['blocks'] {
  const collected = nodes.flatMap(node => node.blocks ?? [])
  return collected.length > 0 ? collected : undefined
}

/**
 * Host usage shape on assistant nodes (structural read, all optional): the
 * TurnUsagePanel derives prompt-side tokens as totalTokens − outputTokens.
 */
interface NodeUsageView {
  readonly totalTokens?: unknown
  readonly outputTokens?: unknown
}

/** Read one assistant node's usage (undefined when the host omits it). */
function usageOf(node: object): { promptTokens: number; outputTokens: number } | undefined {
  const usage = (node as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const { totalTokens, outputTokens } = usage as NodeUsageView
  if (typeof totalTokens !== 'number' || typeof outputTokens !== 'number') return undefined
  if (!Number.isSafeInteger(totalTokens) || !Number.isSafeInteger(outputTokens)) return undefined
  return { promptTokens: totalTokens - outputTokens, outputTokens }
}

/** Poll until a new complete assistant turn exists (partial folded) or time out. */
async function waitForTurn(
  poller: SessionPoller,
  before: number,
  probeId: string,
  prompt?: string,
): Promise<BatchTurnResult> {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await waitTick(POLL_INTERVAL_MS, poller.wakes)
    const view = poller.read()
    const nodes = view?.nodes.filter(node => node.kind === 'assistant') ?? []
    if (nodes.length > before && view?.partial === null) {
      const node = nodes[before]!
      const tail = nodes.slice(before)
      const blocks = blocksOf(tail)
      return {
        probeId,
        status: 'answered',
        text: blockTextOf(tail),
        ...(prompt === undefined ? {} : { prompt }),
        ...(blocks === undefined ? {} : { blocks }),
        ...usageOf(node),
      }
    }
  }
  const view = poller.read()
  const nodes = view?.nodes.filter(node => node.kind === 'assistant') ?? []
  const node = nodes[before]
  const tail = nodes.slice(before)
  const blocks = blocksOf(tail)
  return {
    probeId,
    status: 'timeout',
    text: blockTextOf(tail),
    ...(prompt === undefined ? {} : { prompt }),
    ...(blocks === undefined ? {} : { blocks }),
    ...(node === undefined ? {} : usageOf(node) ?? {}),
  }
}
/**
 * Resolve the 0.1.2+ conversation assembly for one session, if the host
 * provides `ctx.uiConversation`. Missing or throwing is a no-op: rc.7–0.1.1
 * keep `nodes`/`partial` on SessionFace, so the live source still counts.
 */
function conversationBindingOf(ctx: { get: (name: string) => unknown }): (id: string) => ConversationPort | undefined {
  return (id) => {
    const ui = ctx.get('uiConversation') as { binding?: (sessionId: string) => ConversationPort } | undefined
    if (ui === undefined || typeof ui.binding !== 'function') return undefined
    const binding = ui.binding(id)
    if (binding === undefined || typeof binding.snapshot?.getSnapshot !== 'function') return undefined
    return binding
  }
}
