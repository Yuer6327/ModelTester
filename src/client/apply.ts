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
import { createStatsStore } from './session-store.ts'
import type { BatchProgress, BatchTurnResult, ModelTesterActions, ModelTesterFace } from './slots.ts'
import { en, NS, zh, type ModelTesterKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    modeltester: ModelTesterKey
  }
}

/** Cordis services required by the browser half. */
export const inject = ['slots', 'sessions', 'locale']

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
      actions: { sendProbe: sendProbeOf(ctx), runBatch: runBatchOf(ctx) },
    }),
  }, ModelTesterPanel))
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
      const sessions = ctx.sessions as unknown as {
        create?: () => Promise<string>
        open?: (id: string) => void
        binding?: (id: string) => {
          session?: {
            prompt?: (parts: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') =>
              Promise<{ ok?: boolean; error?: { message?: string } }>
          }
        }
      }
      if (typeof sessions.create !== 'function' || typeof sessions.open !== 'function') {
        return { ok: false, error: 'unavailable' }
      }
      const id = await sessions.create()
      sessions.open(id)
      const session = sessions.binding?.(id)?.session
      const prompt = (session as { prompt?: unknown } | undefined)?.prompt
      if (typeof prompt !== 'function') return { ok: false, error: 'unavailable' }
      const result = await (prompt as (parts: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') =>
        Promise<{ ok?: boolean; error?: { message?: string } }>).call(session, [{ type: 'text', text }], 'queue')
      if (result !== undefined && result !== null && result.ok === false) {
        return { ok: false, error: result.error?.message ?? 'rejected' }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
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
      const sessions = ctx.sessions as unknown as {
        create?: () => Promise<string>
        open?: (id: string) => void
        binding?: (id: string) => {
          session?: {
            prompt?: (parts: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') =>
              Promise<{ ok?: boolean; error?: { message?: string } }>
            getSnapshot?: () => unknown
          }
        }
      }
      if (typeof sessions.create !== 'function' || typeof sessions.open !== 'function') {
        return { ok: false, error: 'unavailable' }
      }
      const id = await sessions.create()
      sessions.open(id)
      const session = sessions.binding?.(id)?.session
      const prompt = (session as { prompt?: unknown } | undefined)?.prompt
      if (typeof prompt !== 'function') return { ok: false, error: 'unavailable' }
      const poll = pollOf(ctx, id, sessions)
      if (poll === null) return { ok: false, error: 'unavailable' }

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
/** Host sessions face subset used by the batch runner (all feature-detected). */
interface BatchSessionsPort {
  create?: () => Promise<string>
  open?: (id: string) => void
  binding?: (id: string) => {
    session?: {
      prompt?: (parts: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') =>
        Promise<{ ok?: boolean; error?: { message?: string } }>
      getSnapshot?: () => unknown
    }
  }
}

function pollOf(
  ctx: ClientContext,
  id: string,
  sessions: BatchSessionsPort,
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
    const sessionRaw = readSession?.()
    const conversationRaw = readConversation?.()
    if (sessionRaw === undefined) return conversationRaw === undefined ? undefined : conversationViewOf(conversationRaw)
    return conversationViewOf(sessionRaw, conversationRaw ?? sessionRaw)
  }
}

function assistantCountOf(view: ConversationView | undefined): number {
  return view?.nodes.filter(node => node.kind === 'assistant').length ?? 0
}

function blockTextOf(nodes: readonly ConversationNodeView[]): string {
  return nodes
    .flatMap(node => node.blocks ?? [])
    .filter(block => (block.kind === 'reasoning' || block.kind === 'text') && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
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
      return { probeId, status: 'answered', text: blockTextOf(nodes.slice(before)) }
    }
  }
  const view = poll()
  const nodes = view?.nodes.filter(node => node.kind === 'assistant') ?? []
  return { probeId, status: 'timeout', text: blockTextOf(nodes.slice(before)) }
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
