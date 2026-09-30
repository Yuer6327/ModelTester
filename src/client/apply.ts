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
  conversationViewOf, type ConversationPort, type ConversationView, type ConversationNodeView,
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

/** Cordis services required by the browser half. */
export const inject = ['slots', 'sessions', 'uiConversation', 'locale']

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
      interruptedFertility: interruptedFertilityOf(ctx),
      cleanupTestSessions: cleanupTestSessionsOf(ctx),
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
 * @param sessions - feature-detected sessions port.
 * @returns the open session id, its prompt face, and a release thunk (0.2.0
 * only), or undefined when the host lacks the face entirely.
 */
async function createOpenedSession(
  sessions: ProbeSessionsPort,
): Promise<{ id: string; session?: { prompt?: unknown }; release?: () => void } | undefined> {
  if (typeof sessions.create !== 'function') return undefined
  const created = (await sessions.create({})) as { sessionId?: string } | string | undefined
  const id = typeof created === 'string' ? created : (created?.sessionId ?? undefined)
  if (id === undefined) return undefined
  trackTestSession(id)
  if (typeof sessions.open === 'function') {
    sessions.open(id)
    const session = sessions.binding?.(id)?.session
    return { id, session }
  }
  if (typeof sessions.retain !== 'function') return undefined
  const reference = sessions.retain(id, { source: 'gateway' })
  await reference.ready
  const bound = (sessions.binding?.(id) ?? (reference.binding as { session?: { prompt?: unknown } } | undefined)) as
    | { session?: { prompt?: unknown } }
    | undefined
  const session = bound?.session
  return { id, session, release: () => reference.release() }
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
 * the stable reading carries the turn's prompt-side count.
 */
async function waitForProjectionTurn(
  read: () => { promptTokens: number; outputTokens: number } | null,
  probeId: string,
): Promise<BatchTurnResult> {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let lastOutput = -1
  let stable = 0
  let sawData = false
  let last: { promptTokens: number; outputTokens: number } | null = null
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
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
    return r as FertRunState
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
 *
 * Crash-safe: the run state (pre-created session ids + completed readings)
 * is persisted after every step. If the host process dies mid-run, the panel
 * offers to resume on restart — finished readings are reused verbatim and
 * only the missing probes run.
 */
function runFertilityOf(ctx: ClientContext): NonNullable<ModelTesterActions['runFertility']> {
  return async (items, onProgress) => {
    const storage = typeof window === 'undefined' ? undefined : window.localStorage
    try {
      const sessions = ctx.sessions as unknown as ProbeSessionsPort
      const turns: BatchTurnResult[] = []

      // --- Resume detection: same probe sequence → continue an interrupted run.
      const prev = readFertRunState(storage)
      const resume = prev !== null
        && prev.probeIds.length === items.length
        && items.every((item, i) => prev.probeIds[i] === item.id)
      const doneMap = new Map<string, FertRunState['done'][number]>()
      const sessionIds: Record<string, string> = {}
      if (resume && prev !== null) {
        for (const d of prev.done) doneMap.set(d.probeId, d)
        Object.assign(sessionIds, prev.sessionIds)
      }

      const state = (): FertRunState => ({
        startedAt: prev?.startedAt ?? new Date().toISOString(),
        probeIds: items.map(item => item.id),
        sessionIds,
        done: [...doneMap.values()],
      })

      // --- Phase 1: pre-create (or re-retain) every probe session up front.
      //      All sessions inherit the same default model at creation time, so
      //      a mid-run model switch cannot mix fingerprints. Created ids are
      //      persisted one by one: a crash right after this loop still leaves
      //      every session recoverable through sessions.retain().
      const opened: { id: string; session?: { prompt?: unknown }; release?: () => void }[] = []
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!
        onProgress?.({ index, total: items.length, probeId: item.id, status: 'sending' })
        const existingId = sessionIds[item.id]
        if (existingId !== undefined && typeof sessions.retain === 'function') {
          // Resume path: the session survived the restart on the host — re-activate.
          const reference = sessions.retain(existingId, { source: 'gateway' })
          await reference.ready
          const bound = (sessions.binding?.(existingId) ?? (reference.binding as { session?: { prompt?: unknown } } | undefined)) as
            | { session?: { prompt?: unknown } }
            | undefined
          const session = bound?.session
          opened[index] = { id: existingId, session, release: () => reference.release() }
          continue
        }
        const created = await createOpenedSession(sessions)
        if (created === undefined) return { ok: false, error: 'unavailable' }
        sessionIds[item.id] = created.id
        opened[index] = created
        writeFertRunState(storage, state())
      }
      if (prev === null || !resume) writeFertRunState(storage, state())

      // --- Phase 2: send each probe and collect through the projections path.
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!
        const report = (status: BatchProgress['status']): void =>
          onProgress?.({ index, total: items.length, probeId: item.id, status })
        const finished = doneMap.get(item.id)
        if (finished !== undefined) {
          // Resume: reuse the persisted reading verbatim.
          turns.push({ probeId: item.id, status: finished.status, text: '', promptTokens: finished.promptTokens ?? undefined, outputTokens: finished.outputTokens ?? undefined })
          report(finished.status)
          continue
        }
        report('sending')
        const { id, session, release } = opened[index]!
        const prompt = (session as { prompt?: unknown } | undefined)?.prompt
        if (typeof prompt !== 'function') {
          release?.()
          return { ok: false, error: 'unavailable' }
        }
        const send = (prompt as (parts: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') =>
          Promise<{ ok?: boolean; error?: { message?: string } }>).bind(session)
        const result = await send([{ type: 'text', text: item.text }], 'queue')
        if (result !== undefined && result !== null && result.ok === false) {
          release?.()
          const failedTurn = { probeId: item.id, status: 'failed' as const, text: '', sessionId: id }
          doneMap.set(item.id, { ...failedTurn, promptTokens: null, outputTokens: null })
          writeFertRunState(storage, state())
          turns.push(failedTurn)
          report('failed')
          continue
        }
        report('waiting')
        let turn: BatchTurnResult
        if (projectionUsageOf(sessions, id) !== null) {
          // 0.2.0 projections path — readings serve background sessions.
          turn = await waitForProjectionTurn(() => projectionUsageOf(sessions, id), item.id)
        } else {
          // 0.1.x foreground path — conversation snapshot of the open session.
          const poll = pollOf(ctx, id, sessions)
          if (poll === null) {
            release?.()
            return { ok: false, error: 'unavailable' }
          }
          turn = await waitForTurn(poll, 0, item.id)
        }
        // Persist the reading BEFORE releasing: a crash after this line still
        // keeps the measurement, and the release only starts local teardown.
        doneMap.set(item.id, { probeId: item.id, status: turn.status, promptTokens: turn.promptTokens ?? null, outputTokens: turn.outputTokens ?? null, sessionId: id })
        writeFertRunState(storage, state())
        release?.()
        turns.push(turn)
        report(turn.status)
      }
      clearFertRunState(storage)
      return { ok: true, turns }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
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
 * Batch probe-send over the host sessions face: create ONE fresh session, then
 * send each probe in order, polling the conversation assembly for the turn to
 * finish before the next probe. Every host member is feature-detected; the
 * action is only meaningfully available when create/open/prompt AND a pollable
 * snapshot exist — otherwise the panel falls back to per-probe copy/send.
 */
function runBatchOf(ctx: ClientContext): NonNullable<ModelTesterActions['runBatch']> {
  return async (items, onProgress) => {
    try {
      const sessions = ctx.sessions as unknown as ProbeSessionsPort
      const opened = await createOpenedSession(sessions)
      if (opened === undefined) return { ok: false, error: 'unavailable' }
      const { id, session, release } = opened
      const prompt = (session as { prompt?: unknown } | undefined)?.prompt
      if (typeof prompt !== 'function') {
        release?.()
        return { ok: false, error: 'unavailable' }
      }
      const poll = pollOf(ctx, id, sessions)
      if (poll === null) {
        release?.()
        return { ok: false, error: 'unavailable' }
      }

      const send = (prompt as (parts: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') =>
        Promise<{ ok?: boolean; error?: { message?: string } }>).bind(session)
      const turns: BatchTurnResult[] = []
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!
        const report = (status: BatchProgress['status']): void =>
          onProgress?.({ index, total: items.length, probeId: item.id, status })
        const before = assistantCountOf(poll())
        report('sending')
        const result = await send([{ type: 'text', text: item.text }], 'queue')
        if (result !== undefined && result !== null && result.ok === false) {
          turns.push({ probeId: item.id, status: 'failed', text: '' })
          report('failed')
          continue
        }
        report('waiting')
        const turn = await waitForTurn(poll, before, item.id)
        turns.push(turn)
        report(turn.status)
      }
      release?.()
      return { ok: true, turns }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** Poll cadence and per-turn ceiling for the batch runner. */
const POLL_INTERVAL_MS = 800
const TURN_TIMEOUT_MS = 150_000

/**
 * Snapshot poller for one session: prefers the 0.1.2+ conversation assembly
 * (`uiConversation.binding(id)`), falls back to the session snapshot (rc.7–
 * 0.1.1 carry nodes on SessionFace). Returns null when neither is pollable.
 */
function pollOf(
  ctx: ClientContext,
  id: string,
  sessions: ProbeSessionsPort,
): (() => ConversationView | undefined) | null {
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
  return () => {
    try {
      const sessionRaw = readSession?.()
      const conversationRaw = readConversation?.()
      if (sessionRaw === undefined) return conversationRaw === undefined ? undefined : conversationViewOf(conversationRaw)
      return conversationViewOf(sessionRaw, conversationRaw ?? sessionRaw)
    } catch {
      // A session being created/opened may briefly publish nothing pollable.
      return undefined
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
  poll: () => ConversationView | undefined,
  before: number,
  probeId: string,
): Promise<BatchTurnResult> {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    const view = poll()
    const nodes = view?.nodes.filter(node => node.kind === 'assistant') ?? []
    if (nodes.length > before && view?.partial === null) {
      const node = nodes[before]!
      return { probeId, status: 'answered', text: blockTextOf(nodes.slice(before)), ...usageOf(node) }
    }
  }
  const view = poll()
  const nodes = view?.nodes.filter(node => node.kind === 'assistant') ?? []
  const node = nodes[before]
  return { probeId, status: 'timeout', text: blockTextOf(nodes.slice(before)), ...(node === undefined ? {} : usageOf(node) ?? {}) }
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
