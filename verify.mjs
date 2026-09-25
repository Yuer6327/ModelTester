/**
 * Quick smoke test for the ModelTester counting engine, using the research
 * trajectory data. Run: node --experimental-strip-types verify.mjs
 */
import { countReasoningText } from './src/client/stats.ts'
import { GROUPS, PATTERNS } from './src/client/keywords.ts'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures++
    console.error(`✗ ${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`)
  } else {
    console.log(`✓ ${name}`)
  }
}

// --- 1. Direct-action trajectory (minimal-like) ---
const minimal = `
We need to inspect the project layout. Let's check the config file.
We should run the tests to confirm nothing broke. Good.
We can then open the editor to patch the build script.
`
{
  const c = countReasoningText(minimal)
  const byGroup = {}
  for (const g of GROUPS) {
    byGroup[g] = 0
    for (let i = 0; i < PATTERNS.length; i++) if (PATTERNS[i].group === g) byGroup[g] += c.patterns[i]
  }
  check('minimal: words.we', c.words.we, 3)          // 3 bare "we"
  check('minimal: words.lets', c.words.lets, 1)      // one Let's
  check('minimal: words.letMe', c.words.letMe, 0)
  check('minimal: groups.efficient >= 3', byGroup.efficient >= 3, true)
  check('minimal: groups.hesitant === 0', byGroup.hesitant, 0)
}

// --- 2. Hesitant trajectory (standard-like) ---
const standard = `
The user wants me to fix the build. Let me think about how to approach this.
Let me check the logs first. I'm not sure where the error is coming from.
Maybe I should look at the recent changes. Let me try a different approach.
The user is asking for a quick fix. I think the issue is in the config.
`
{
  const c = countReasoningText(standard)
  const byGroup = {}
  for (const g of GROUPS) {
    byGroup[g] = 0
    for (let i = 0; i < PATTERNS.length; i++) if (PATTERNS[i].group === g) byGroup[g] += c.patterns[i]
  }
  check('standard: words.letMe', c.words.letMe, 3)
  check('standard: words.we', c.words.we, 0)
  check('standard: groups.hesitant >= 4', byGroup.hesitant >= 4, true)
  check('standard: groups.neutral >= 2', byGroup.neutral >= 2, true)  // "The user wants" + "The user is asking"
}

// --- 3. blockStart only matches the first token ---
{
  const c = countReasoningText('This is fine. Great, we can continue. Good.')
  // "Great" and "Good" appear mid-block → blockStart patterns must NOT match.
  // The first token is "this" → no blockStart match at all.
  const goodIdx = PATTERNS.findIndex(p => p.label === 'pattern.good')
  const greatIdx = PATTERNS.findIndex(p => p.label === 'pattern.great')
  check('blockStart: good not counted mid-block', c.patterns[goodIdx], 0)
  check('blockStart: great not counted mid-block', c.patterns[greatIdx], 0)
}
{
  const c = countReasoningText('Good. We can proceed directly.')
  const goodIdx = PATTERNS.findIndex(p => p.label === 'pattern.good')
  check('blockStart: good counted at block start', c.patterns[goodIdx], 1)
}

// --- 4. Longest-match subsumption: "let me" consumed, no double count ---
{
  const c = countReasoningText('Let me think about it. Let me check again.')
  check('subsumption: let me = 2', c.words.letMe, 2)
}

// --- 5. Research-fidelity: a single let-me in 355 blocks is a signal ---
{
  const c = countReasoningText('We need to verify the pipeline. Let\'s move on. We should finish this.')
  check('fidelity: letMe 0 for direct-action text', c.words.letMe, 0)
  check('fidelity: we present', c.words.we, 2)
}

// --- 6. formatCount scaling ---
{
  const fmt = (await import('./src/client/stats.ts')).formatCount
  check('format: 517', fmt(517), '517')
  check('format: 12400', fmt(12400), '12.4K')
  check('format: 1200000', fmt(1200000), '1.2M')
}

// --- 7. Session fold: computeStats over a mock snapshot (finalized + partial) ---
{
  const { computeStats } = await import('./src/client/stats.ts')
  const node = {
    kind: 'assistant',
    seq: 1,
    time: 0,
    turn: 1,
    step: 1,
    blocks: [
      { kind: 'reasoning', text: 'We need to check the build.' },
      { kind: 'reasoning', text: 'Let me verify the config first.' },
      { kind: 'text', text: 'Here is the result.' },
    ],
  }
  const stats = computeStats({
    sessionId: 's1',
    nodes: [node],
    partial: { turn: 2, step: 1, blocks: [{ kind: 'reasoning', text: 'Good. Let\'s proceed.' }] },
  })
  check('fold: blocks = 3', stats.blocks, 3)
  check('fold: replies = 1', stats.replies, 1)
  check('fold: streaming true', stats.streaming, true)
  check('fold: words.we = 1', stats.words.we, 1)
  check('fold: words.letMe = 1', stats.words.letMe, 1)
  check('fold: words.lets = 1', stats.words.lets, 1)
  check('fold: mode hesitant (let me present)', stats.mode, 'hesitant')
  check('fold: efficient >= 1 (we need + let\'s)', stats.groups.efficient >= 1, true)
  check('fold: null on no snapshot', computeStats(undefined), null)
}

// --- 8. Incremental accumulator: fold-once, idempotent, compaction reset, persistence ---
{
  const { SessionStatsAccumulator } = await import('./src/client/accumulator.ts')
  const mkNode = (seq, text) => ({
    kind: 'assistant', seq, time: 0, turn: 1, step: 1,
    blocks: [{ kind: 'reasoning', text }],
  })
  const snap = (nodes, partial = null) => ({ sessionId: 's1', nodes, partial })

  const acc = new SessionStatsAccumulator()
  const a = mkNode(10, 'We need to fix this. Let\'s move.')
  const b = mkNode(11, 'Let me think about it.')
  acc.fold(snap([a, b]))
  check('accumulator: replies after first fold', acc.counts.replies, 2)
  check('accumulator: we from first fold', acc.counts.words.we, 1)
  check('accumulator: letMe from first fold', acc.counts.words.letMe, 1)

  // Idempotent: folding the same snapshot adds nothing.
  acc.fold(snap([a, b]))
  check('accumulator: idempotent fold', acc.counts.replies, 2)

  // Incremental: appending a newer node only counts the new one.
  const c = mkNode(12, 'Good. Let\'s verify the tests now.')
  acc.fold(snap([a, b, c]))
  check('accumulator: incremental replies', acc.counts.replies, 3)
  check('accumulator: incremental lets', acc.counts.words.lets, 2)

  // Loaded-older history (seq < min) is folded too.
  const z = mkNode(5, 'Let\'s start fresh. We need context.')
  acc.fold(snap([z, a, b, c]))
  check('accumulator: older-history replies', acc.counts.replies, 4)
  check('accumulator: older-history we', acc.counts.words.we, 2)

  // Compaction reset: a newer compaction node rewrites history and recounts.
  const fresh = mkNode(20, 'We need to redo everything.')
  const compSnap = {
    sessionId: 's1',
    nodes: [
      { kind: 'compaction', seq: 19, time: 0, summary: 'rewritten', summaryEventSeq: null, shadowedItemCount: null, shadowedTokenCount: null },
      fresh,
    ],
    partial: null,
  }
  acc.fold(compSnap)
  check('accumulator: compaction reset replies', acc.counts.replies, 1)
  check('accumulator: compaction reset we', acc.counts.words.we, 1)

  // Persist → load round-trip preserves counts and the high-water mark.
  const persisted = acc.persist()
  const reloaded = SessionStatsAccumulator.load(persisted)
  check('accumulator: persistence schema version', persisted.v, 2)
  check('accumulator: persistence taxonomy version', persisted.taxonomyVersion, 1)
  check('accumulator: persistence classifier version', persisted.classifierVersion, 1)
  check('accumulator: reload replies', reloaded.counts.replies, 1)
  check('accumulator: reload we', reloaded.counts.words.we, 1)
  check('accumulator: reload keeps fold-idempotence', reloaded.fold(compSnap), false)
  const { taxonomyVersion: _taxonomy, classifierVersion: _classifier, ...legacy } = persisted
  const legacyReload = SessionStatsAccumulator.load({ ...legacy, v: 1 })
  check('accumulator: legacy v1 migrates', legacyReload.counts.replies, 1)
  check('accumulator: taxonomy mismatch → fresh', SessionStatsAccumulator.load({ ...persisted, taxonomyVersion: 999 }).counts.replies, 0)
  check('accumulator: classifier mismatch → fresh', SessionStatsAccumulator.load({ ...persisted, classifierVersion: 999 }).counts.replies, 0)
  check('accumulator: load garbage → fresh', SessionStatsAccumulator.load('nonsense').counts.replies, 0)

  // toStats folds live partial on top without mutating durable counts.
  const partialSnap = snap([fresh], { turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'Good. Let\'s go.' }] })
  const live = acc.toStats(partialSnap)
  check('accumulator: toStats streaming', live.streaming, true)
  check('accumulator: toStats replies unchanged', live.replies, 1)
  check('accumulator: toStats lets from partial', live.words.lets, 1)
  check('accumulator: durable lets unchanged by toStats', acc.counts.words.lets, 0)
}

// --- 9. Live snapshots refresh before notifying subscribers; history state is explicit ---
{
  const { createLiveConversation } = await import('./src/client/session-source.ts')
  let current = {
    sessionId: 'live', nodes: [], partial: null,
  }
  const sessionListeners = new Set()
  const listListeners = new Set()
  const session = {
    getSnapshot: () => current,
    subscribe: fn => { sessionListeners.add(fn); return () => sessionListeners.delete(fn) },
    loadOlder: async () => {},
  }
  const sessions = {
    list: {
      getSnapshot: () => ({ current: 'live' }),
      subscribe: fn => { listListeners.add(fn); return () => listListeners.delete(fn) },
    },
    binding: id => id === 'live' ? { session } : undefined,
  }
  const live = createLiveConversation(sessions)
  let notifications = 0
  live.subscribe(() => { notifications += 1 })
  current = {
    ...current,
    nodes: [{ kind: 'assistant', seq: 1, time: 0, turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'We need the fresh snapshot.' }] }],
  }
  for (const fn of [...sessionListeners]) fn()
  check('live observable refreshes snapshot before notify', live.getSnapshot().nodes[0].blocks[0].text, 'We need the fresh snapshot.')
  check('live observable notifies subscribers', notifications > 0, true)

  const { createStatsStore } = await import('./src/client/session-store.ts')
  let pagesLoaded = 0
  let history = { sessionId: 'history', nodes: [], partial: null, openState: 'open', hasMore: true, loadingOlder: false }
  const historyListeners = new Set()
  const historySession = {
    getSnapshot: () => history,
    subscribe: fn => { historyListeners.add(fn); return () => historyListeners.delete(fn) },
    loadOlder: async () => {
      pagesLoaded += 1
      history = { ...history, hasMore: pagesLoaded < 31 }
      for (const fn of [...historyListeners]) fn()
    },
  }
  const historySessions = {
    list: {
      getSnapshot: () => ({ current: 'history' }),
      subscribe: fn => { historyListeners.add(fn); return () => historyListeners.delete(fn) },
    },
    binding: id => id === 'history' ? { session: historySession } : undefined,
  }
  // Keep list and session subscriptions separate in the mock: the real runtime
  // exposes distinct observables for selection and conversation snapshots.
  const listOnlyListeners = new Set()
  historySessions.list.subscribe = fn => { listOnlyListeners.add(fn); return () => listOnlyListeners.delete(fn) }
  const store = createStatsStore(historySessions, undefined)
  for (let attempt = 0; attempt < 200 && store.getSnapshot().historyState === 'syncing'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  check('history cap is never reported complete', store.getSnapshot().historyState, 'limited')
  check('history cap records loaded pages', store.getSnapshot().historyPages, 30)
  check('history cap exposes loading bound', store.getSnapshot().historyLimit, 30)

  const completeHistory = { sessionId: 'complete', nodes: [], partial: null, openState: 'open', hasMore: false, loadingOlder: false }
  const completeListeners = new Set()
  const completeSession = {
    getSnapshot: () => completeHistory,
    subscribe: fn => { completeListeners.add(fn); return () => completeListeners.delete(fn) },
    loadOlder: async () => {},
  }
  const completeSessions = {
    list: {
      getSnapshot: () => ({ current: 'complete' }),
      subscribe: fn => { completeListeners.add(fn); return () => completeListeners.delete(fn) },
    },
    binding: id => id === 'complete' ? { session: completeSession } : undefined,
  }
  const completeStore = createStatsStore(completeSessions, undefined)
  check('history with no older pages is complete', completeStore.getSnapshot().historyState, 'complete')

  let coldHistory = { sessionId: 'cold', nodes: [], partial: null, openState: 'cold', hasMore: false, loadingOlder: false }
  const coldListeners = new Set()
  const coldSession = {
    getSnapshot: () => coldHistory,
    subscribe: fn => { coldListeners.add(fn); return () => coldListeners.delete(fn) },
    loadOlder: async () => {},
  }
  const coldSessions = {
    list: {
      getSnapshot: () => ({ current: 'cold' }),
      subscribe: fn => { coldListeners.add(fn); return () => coldListeners.delete(fn) },
    },
    binding: id => id === 'cold' ? { session: coldSession } : undefined,
  }
  const coldStore = createStatsStore(coldSessions, undefined)
  check('cold history stays syncing', coldStore.getSnapshot().historyState, 'syncing')
  coldHistory = { ...coldHistory, openState: 'open' }
  for (const fn of [...coldListeners]) fn()
  check('cold history retries after open', coldStore.getSnapshot().historyState, 'complete')

  const legacyStorageData = new Map([
    ['dsh-modeltester.stats.complete', JSON.stringify({
      v: 1,
      minSeq: 0,
      maxSeq: -1,
      lastCompactionSeq: 0,
      counts: { patterns: [], words: { we: 0, lets: 0, letMe: 0, firstPerson: 0 }, blocks: 0, chars: 0, replies: 0 },
      textBlocks: 0,
      textChars: 0,
    })],
  ])
  const legacyStorage = {
    getItem: key => legacyStorageData.get(key) ?? null,
    setItem: (key, value) => { legacyStorageData.set(key, value) },
  }
  createStatsStore(completeSessions, legacyStorage)
  check('legacy storage key is migrated', legacyStorageData.has('dsh-modeltester.stats.v2.complete'), true)
}

// --- 11. Host snapshot projection: top-level slice and rc.8+ chat.legacy fallback ---
{
  const { conversationViewOf } = await import('./src/client/conversation.ts')
  const topLevel = conversationViewOf({
    sessionId: 's1',
    nodes: [{ kind: 'assistant', seq: 1, blocks: [{ kind: 'reasoning', text: 'We need this.' }] }],
    partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'hi' }] },
    openState: 'open',
    hasMore: false,
    loadingOlder: false,
  })
  check('view: top-level sessionId', topLevel.sessionId, 's1')
  check('view: top-level nodes', topLevel.nodes.length, 1)
  check('view: top-level partial present', topLevel.partial !== null, true)

  const legacyOnly = conversationViewOf({
    sessionId: 's2',
    chat: {
      legacy: {
        nodes: [{ kind: 'assistant', seq: 2, blocks: [{ kind: 'reasoning', text: "Let's go." }] }],
        partial: null,
      },
    },
  })
  check('view: chat.legacy nodes', legacyOnly.nodes[0].seq, 2)
  check('view: chat.legacy default open', legacyOnly.openState, 'open')
  check('view: chat.legacy default hasMore', legacyOnly.hasMore, false)
  const topLevelNullPartial = conversationViewOf({
    sessionId: 's3',
    nodes: [],
    partial: null,
    chat: { legacy: { partial: { blocks: [{ kind: 'reasoning', text: 'stale' }] } } },
  })
  check('view: explicit null partial wins over chat.legacy', topLevelNullPartial.partial, null)
  check('view: missing sessionId is undefined', conversationViewOf({ nodes: [] }), undefined)

  const acc = new (await import('./src/client/accumulator.ts')).SessionStatsAccumulator()
  acc.fold(legacyOnly)
  check('view: accumulator folds chat.legacy', acc.counts.replies, 1)

  const { sessionCarriesNodes } = await import('./src/client/conversation.ts')
  check('view: top-level carries nodes', sessionCarriesNodes(topLevel), true)
  const alphaSession = {
    sessionId: 's4',
    openState: 'open',
    hasMore: false,
    loadingOlder: false,
  }
  check('view: 0.1.2 session face does not carry nodes', sessionCarriesNodes(alphaSession), false)
  const views = {
    get: target => target === 'chat'
      ? {
        legacy: {
          nodes: [{ kind: 'assistant', seq: 4, blocks: [{ kind: 'reasoning', text: 'We need the split.' }] }],
          partial: { blocks: [{ kind: 'reasoning', text: "Let's stream." }] },
        },
      }
      : undefined,
  }
  const split = conversationViewOf(alphaSession, { views })
  check('view: 0.1.2 views.get(chat).legacy nodes', split.nodes[0].seq, 4)
  check('view: 0.1.2 views.get(chat).legacy partial', split.partial !== null, true)
  check('view: 0.1.2 openState stays on session', split.openState, 'open')
  const splitAcc = new (await import('./src/client/accumulator.ts')).SessionStatsAccumulator()
  splitAcc.fold(split)
  check('view: accumulator folds 0.1.2 chat.legacy', splitAcc.counts.replies, 1)

  let conversationReady = false
  let conversationSnap = {
    views: {
      get: target => target === 'chat'
        ? { legacy: { nodes: [{ kind: 'assistant', seq: 5, blocks: [{ kind: 'reasoning', text: 'We need late bind.' }] }], partial: null } }
        : undefined,
    },
  }
  const conversationListeners = new Set()
  const { createLiveConversation } = await import('./src/client/session-source.ts')
  const alphaListeners = new Set()
  const alphaFace = {
    getSnapshot: () => alphaSession,
    subscribe: fn => { alphaListeners.add(fn); return () => alphaListeners.delete(fn) },
    loadOlder: async () => {},
  }
  const alphaSessions = {
    list: {
      getSnapshot: () => ({ current: 's4' }),
      subscribe: fn => { return () => {} },
    },
    binding: id => id === 's4' ? { session: alphaFace } : undefined,
  }
  const liveSplit = createLiveConversation(alphaSessions, id => {
    if (id !== 's4' || !conversationReady) return undefined
    return {
      snapshot: {
        getSnapshot: () => conversationSnap,
        subscribe: fn => { conversationListeners.add(fn); return () => conversationListeners.delete(fn) },
      },
    }
  })
  check('view: 0.1.2 live starts empty without uiConversation', liveSplit.getSnapshot().nodes.length, 0)
  conversationReady = true
  await new Promise(resolve => setTimeout(resolve, 80))
  check('view: 0.1.2 live attaches late uiConversation', liveSplit.getSnapshot().nodes[0].seq, 5)
  conversationSnap = {
    views: {
      get: target => target === 'chat'
        ? { legacy: { nodes: [{ kind: 'assistant', seq: 6, blocks: [{ kind: 'reasoning', text: 'We need a delta.' }] }], partial: null } }
        : undefined,
    },
  }
  for (const fn of [...conversationListeners]) fn()
  check('view: 0.1.2 live follows conversation publishes', liveSplit.getSnapshot().nodes[0].seq, 6)
}

// --- 10. Reasoning-health anomaly: text-without-reasoning is reported, never counted ---
{
  const { computeStats } = await import('./src/client/stats.ts')
  const textNode = {
    kind: 'assistant', seq: 1, time: 0, turn: 1, step: 1,
    blocks: [{ kind: 'text', text: 'Let me think about the build. The user wants a fix. We need to check logs.' }],
  }
  const reasoningNode = {
    kind: 'assistant', seq: 1, time: 0, turn: 1, step: 1,
    blocks: [
      { kind: 'reasoning', text: 'We need to inspect the pipeline. Let\'s run the tests.' },
      { kind: 'text', text: 'Here is the fix.' },
    ],
  }
  const snap = (nodes, partial = null) => ({ sessionId: 's1', nodes, partial })

  // All text, no reasoning → missing anomaly; text is never word-counted.
  const missing = computeStats(snap([textNode]))
  check('anomaly: all-text → missing', missing.anomaly, 'missing')
  check('anomaly: missing leaves blocks 0', missing.blocks, 0)
  check('anomaly: missing tracks text chars', missing.textBlocks, 1)
  check('anomaly: text words not counted (we 0)', missing.words.we, 0)

  // Reasoning + normal short reply → none.
  const normal = computeStats(snap([reasoningNode]))
  check('anomaly: reasoning+short-text → none', normal.anomaly, 'none')
  check('anomaly: reasoning words counted', normal.words.we, 1)
  check('anomaly: textBlocks diagnostic still tracked', normal.textBlocks, 1)

  // Reasoning starved vs a huge text block → low anomaly.
  const starved = computeStats(snap([{
    kind: 'assistant', seq: 1, time: 0, turn: 1, step: 1,
    blocks: [
      { kind: 'reasoning', text: 'ok' },
      { kind: 'text', text: 'Let me dump the entire answer here.'.repeat(80) },
    ],
  }]))
  check('anomaly: reasoning:text ratio < 5% → low', starved.anomaly, 'low')

  // No output at all → none (nothing to diagnose).
  const bare = computeStats(snap([{ kind: 'assistant', seq: 1, time: 0, turn: 1, step: 1, blocks: [] }]))
  check('anomaly: empty assistant → none', bare.anomaly, 'none')
}

// --- 12. Attribution engine: vendor ranking + evidence ledger ---
{
  const { attributeSession, emptyAttribution, evidencePack, scanNode } = await import('./src/client/attribution.ts')
  const { countReasoningText } = await import('./src/client/stats.ts')
  const trajOf = (text) => {
    const c = countReasoningText(text)
    return { words: c.words, patterns: c.patterns }
  }
  const zero = trajOf('')
  const asNode = (text, turn = 1, extra = {}) => ({
    kind: 'assistant', seq: turn, turn, time: 0,
    blocks: [{ kind: 'reasoning', text }],
    ...extra,
  })
  const viewOf = (nodes, partial = null) => ({
    sessionId: 'a', nodes, partial, openState: 'open', hasMore: false, loadingOlder: false,
  })

  // antml namespace → anthropic, likely (tier-1, clear lead).
  const antmlText = 'Checking the tool list. <antml:thinking> I should map the schema.'
  const antml = attributeSession(viewOf([asNode(antmlText)]), zero)
  check('attr: antml → anthropic top', antml.candidates[0]?.vendor, 'anthropic')
  check('attr: antml session likely', antml.verdict, 'likely')
  check('attr: antml ledger sample', (antml.evidence.find(e => e.id === 'antml-ns')?.samples.length ?? 0) >= 1, true)

  // fp_v4pro_… → deepseek; generic fp_ → openai.
  const v4 = attributeSession(viewOf([asNode('fp_v4pro_20260812_prod leaked in the chain.')]), zero)
  check('attr: fp_v4pro → deepseek likely', v4.candidates[0]?.vendor === 'deepseek' && v4.verdict === 'likely', true)
  const fpg = attributeSession(viewOf([asNode('the trace said fp_abc123def0 twice: fp_abc123def0')]), zero)
  check('attr: fp_ → openai likely', fpg.candidates[0]?.vendor === 'openai' && fpg.verdict === 'likely', true)

  // 0813 minimal trajectory → deepseek support only (since the 2026-09-25
  // space-bunny-free drill showed the same style on a community-guessed
  // MiniMax, trajectory vocabulary cannot drive a verdict on its own).
  const minimalText = "We need to inspect the layout. Let's check the config. We should run the tests."
  const minimal = attributeSession(viewOf([asNode(minimalText)]), trajOf(minimalText))
  check('attr: 0813 minimal → deepseek top', minimal.candidates[0]?.vendor, 'deepseek')
  check('attr: 0813 minimal support-only (no verdict)', minimal.candidates[0]?.verdict, 'none')
  check('attr: 0813 minimal no foreign vendor', minimal.candidates.every(c => c.vendor === 'deepseek'), true)
  const { VENDORS: attrVendors } = await import('./src/client/attribution-signals.ts')
  check('attr: minimax vendor slot exists', attrVendors.includes('minimax'), true)

  // Unattributed dirty token → ledger without vendor; verdict none; anomaly
  // detector must not double-count the recorded token.
  const unknown = attributeSession(viewOf([asNode('EDMFunc showed up mid-plan.')]), zero)
  check('attr: EDMFunc unattributed', unknown.unattributed.some(e => e.id === 'edm-func'), true)
  check('attr: unattributed verdict none', unknown.verdict, 'none')
  check('attr: EDMFunc not double-counted by anomaly detector', unknown.evidence.some(e => e.id === 'anom-ident'), false)

  // Chat-template leaks are tier-1, passive (reasoning surface only).
  const tmpl = (text) => attributeSession(viewOf([asNode(text)]), zero)
  const mm = tmpl('<minimax:tool_call> running the tool')
  check('attr: minimax tool_call namespace gone in M3 (no fire)', mm.candidates.some(c => c.vendor === 'minimax'), false)
  check('attr: glm observation → zhipu top', tmpl('plan uses <|observation|> next').candidates[0]?.vendor, 'zhipu')
  const ds = tmpl('user asked; <｜Assistant｜> should reply')
  check('attr: deepseek template token → deepseek likely', ds.candidates[0]?.vendor === 'deepseek' && ds.verdict === 'likely', true)
  const inst = tmpl('[INST] echoed frame')
  check('attr: [INST] credits mistral', inst.candidates[0]?.vendor, 'mistral')
  check('attr: [INST] no longer credits meta (old gen dropped)', inst.candidates.some(c => c.vendor === 'meta'), false)
  check('attr: minimax bracket token → minimax', tmpl(']<]image[>[ ok').candidates[0]?.vendor, 'minimax')
  check('attr: minimax mm:think → minimax likely', tmpl('<mm:think> plan').candidates[0]?.vendor === 'minimax' && tmpl('<mm:think> plan').verdict === 'likely', true)
  check('attr: kimi K3 end_of_msg → moonshot likely', tmpl('<|end_of_msg|> done').candidates[0]?.vendor === 'moonshot' && tmpl('<|end_of_msg|> done').verdict === 'likely', true)
  check('attr: mistral tool frame → mistral likely', tmpl('[TOOL_CALLS] emitted').candidates[0]?.vendor === 'mistral' && tmpl('[TOOL_CALLS] emitted').verdict === 'likely', true)
  check('attr: ling role_end → ling', tmpl('<|role_end|> done').candidates[0]?.vendor, 'ling')
  check('attr: glm arg_key → zhipu top', tmpl('<arg_key> name').candidates[0]?.vendor, 'zhipu')
  check('attr: qwen3 quad → qwen top', tmpl('<|quad_start|> box').candidates[0]?.vendor, 'qwen')
  check('attr: glm role triple support-only (no verdict)', tmpl('<|assistant|> replies').candidates[0]?.verdict, 'none')
  check('attr: template token quoted in visible text must not fire', attributeSession(viewOf([{
    kind: 'assistant', seq: 1, turn: 1,
    blocks: [{ kind: 'text', text: '<|observation|> 是 GLM 的模板 token' }],
  }]), zero).evidence.some(e => e.id === 'tmpl-glm'), false)

  // Probe sentinels are scanned over visible text too.
  const probe = attributeSession(viewOf([{
    kind: 'assistant', seq: 1, turn: 1,
    blocks: [{ kind: 'text', text: 'SolidGoldMagikarp\nMT-ECHO-7f3a9c' }],
  }]), zero)
  check('attr: glitch canary (visible text)', probe.evidence.some(e => e.id === 'probe-glitch-r50k'), true)
  check('attr: echo sentinel (visible text)', probe.evidence.some(e => e.id === 'probe-echo'), true)

  // Anomaly detectors catch unrecorded leaks (unknown namespaced tag, hex run).
  const anom = attributeSession(viewOf([asNode('<sys:internal> route via deadbeefdeadbeefcafe deadbeefdeadbeefcafe')]), zero)
  check('attr: unknown namespaced tag flagged', anom.evidence.some(e => e.id === 'anom-ns-tag'), true)
  check('attr: hex run flagged', anom.evidence.some(e => e.id === 'anom-hex'), true)

  // Per-turn rows: first-seen evidence is new, later repeats are not.
  const mixed = attributeSession(viewOf([
    asNode('Let me think about it. Let me check again.', 1),
    asNode('<antml:thinking> ok', 2),
    asNode('<antml:thinking> again', 3),
  ]), zero)
  check('attr: turn2 new token antml-ns', mixed.turns[1]?.newTokens.includes('antml-ns'), true)
  check('attr: turn3 antml no longer new', mixed.turns[2]?.newTokens.includes('antml-ns'), false)
  check('attr: turn2 top anthropic', mixed.turns[1]?.top, 'anthropic')

  // Style folklore: delve (presence) and em-dash density (≥3/1000 chars).
  const delve = attributeSession(viewOf([asNode('We should delve into the config to be sure.')]), zero)
  check('attr: delve style row', delve.evidence.some(e => e.id === 'style-delve'), true)
  const dash = attributeSession(viewOf([asNode('a — b — c — d'.repeat(40))]), zero)
  check('attr: em-dash density row', dash.evidence.some(e => e.id === 'style-emdash'), true)
  check('attr: no attribution on plain 0813 text is deepseek-only', attributeSession(
    viewOf([asNode("We need to check the build. Let's proceed with the plan.")]),
    trajOf("We need to check the build. Let's proceed with the plan."),
  ).candidates.every(c => c.vendor === 'deepseek'), true)

  // computeStats wires the report into TrajectoryStats; empty stays empty.
  const { computeStats } = await import('./src/client/stats.ts')
  const wired = computeStats(viewOf([asNode('<antml:thinking> go')]))
  check('attr: computeStats carries attribution', wired?.attribution.verdict, 'likely')
  check('attr: no snapshot → null stats', computeStats(undefined), null)
  check('attr: emptyAttribution is none', emptyAttribution().verdict, 'none')

  // Evidence pack is plain JSON-ready data.
  const pack = evidencePack(antml, { sessionId: 's-attr' })
  check('attr: evidence pack json', typeof JSON.stringify(pack), 'string')
  check('attr: evidence pack verdict', pack.verdict, 'likely')

  // scanNode is exported and pure for external use.
  const scanned = scanNode([{ kind: 'reasoning', text: '<antml:thinking>' }], 1, null)
  check('attr: scanNode finds antml', scanned.hits.some(h => h.id === 'antml-ns'), true)
}

console.log(failures === 0 ? '\nAll checks passed ✓' : `\n${failures} check(s) FAILED ✗`)
// Let pending dynamic-import module jobs settle before exiting (avoids a
// Windows libuv teardown race that otherwise asserts in win/async.c).
await new Promise(resolve => setTimeout(resolve, 100))
process.exit(failures === 0 ? 0 : 1)
