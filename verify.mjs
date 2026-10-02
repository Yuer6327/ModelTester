#!/usr/bin/env node
/**
 * Offline regression for the ModelTester counting/attribution engines.
 * Run: node --experimental-strip-types verify.mjs
 */
import { ok } from 'node:assert/strict'

let failures = 0
function check(name, actual, expected) {
  const passed = JSON.stringify(actual) === JSON.stringify(expected)
  if (!passed) {
    failures++
    console.error(`✗ ${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`)
  } else {
    console.log(`✓ ${name}`)
  }
}

// --- 1. formatCount scaling ---
{
  const { formatCount } = await import('./src/client/stats.ts')
  check('format: 517', formatCount(517), '517')
  check('format: 12400', formatCount(12400), '12.4K')
  check('format: 1200000', formatCount(1200000), '1.2M')
}

// --- 2. Session fold: computeStats over a mock snapshot ---
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
  check('fold: textBlocks = 1', stats.textBlocks, 1)
  check('fold: null on no snapshot', computeStats(undefined), null)
}

// --- 3. Incremental accumulator: fold-once, idempotent, compaction reset, persistence ---
{
  const { SessionStatsAccumulator, PERSISTENCE_VERSION } = await import('./src/client/accumulator.ts')
  const mkNode = (seq, text) => ({
    kind: 'assistant', seq, time: 0, turn: 1, step: 1,
    blocks: [{ kind: 'reasoning', text }],
  })
  const snap = (nodes, partial = null) => ({ sessionId: 's1', nodes, partial })

  const acc = new SessionStatsAccumulator()
  const a = mkNode(10, 'first reasoning block')
  const b = mkNode(11, 'second reasoning block')
  acc.fold(snap([a, b]))
  check('accumulator: replies after first fold', acc.counts.replies, 2)
  check('accumulator: blocks after first fold', acc.counts.blocks, 2)

  acc.fold(snap([a, b]))
  check('accumulator: idempotent fold', acc.counts.replies, 2)

  const c = mkNode(12, 'third reasoning block')
  acc.fold(snap([a, b, c]))
  check('accumulator: incremental replies', acc.counts.replies, 3)

  const z = mkNode(5, 'older reasoning block')
  acc.fold(snap([z, a, b, c]))
  check('accumulator: older-history replies', acc.counts.replies, 4)

  const fresh = mkNode(20, 'rewritten reasoning block')
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

  const persisted = acc.persist()
  check('accumulator: persistence schema version', persisted.v, PERSISTENCE_VERSION)
  const reloaded = SessionStatsAccumulator.load(persisted)
  check('accumulator: reload replies', reloaded.counts.replies, 1)
  check('accumulator: reload keeps fold-idempotence', reloaded.fold(compSnap), false)
  check('accumulator: old schema → fresh', SessionStatsAccumulator.load({ ...persisted, v: 2 }).counts.replies, 0)
  check('accumulator: load garbage → fresh', SessionStatsAccumulator.load('nonsense').counts.replies, 0)

  const partialSnap = snap([fresh], { turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'live block' }] })
  const live = acc.toStats(partialSnap)
  check('accumulator: toStats streaming', live.streaming, true)
  check('accumulator: toStats replies unchanged', live.replies, 1)
  check('accumulator: toStats adds live block', live.blocks, 2)
  check('accumulator: durable counts unchanged by toStats', acc.counts.blocks, 1)
}

// --- 4. Live snapshots refresh before notifying subscribers; history state is explicit ---
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
    nodes: [{ kind: 'assistant', seq: 1, time: 0, turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'fresh' }] }],
  }
  for (const fn of [...sessionListeners]) fn()
  check('live observable refreshes snapshot before notify', live.getSnapshot().nodes[0].blocks[0].text, 'fresh')
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

  // v3 record round-trips; older records are rejected outright.
  const v3Storage = new Map()
  const storage = {
    getItem: key => v3Storage.get(key) ?? null,
    setItem: (key, value) => { v3Storage.set(key, value) },
  }
  const roundHistory = {
    sessionId: 'roundtrip', openState: 'open', hasMore: false, loadingOlder: false, partial: null,
    nodes: [{ kind: 'assistant', seq: 1, time: 0, turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'one block' }] }],
  }
  const roundListeners = new Set()
  const roundSession = {
    getSnapshot: () => roundHistory,
    subscribe: fn => { roundListeners.add(fn); return () => roundListeners.delete(fn) },
    loadOlder: async () => {},
  }
  const roundSessions = {
    list: { getSnapshot: () => ({ current: 'roundtrip' }), subscribe: () => () => {} },
    binding: id => id === 'roundtrip' ? { session: roundSession } : undefined,
  }
  createStatsStore(roundSessions, storage)
  // The durable write is debounced — wait it out.
  for (let attempt = 0; attempt < 50 && v3Storage.size === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  const persistedKey = [...v3Storage.keys()][0]
  check('storage: persisted under v3 key', persistedKey !== undefined && persistedKey.includes('v3.'), true)
  const persisted = JSON.parse(v3Storage.get(persistedKey))
  const reloaded = (await import('./src/client/accumulator.ts')).SessionStatsAccumulator.load(persisted)
  check('storage: v3 record reloads', reloaded.counts.replies, 1)
}

// --- 5. Host snapshot projection: top-level slice and rc.8+ chat.legacy fallback ---
{
  const { conversationViewOf, sessionCarriesNodes } = await import('./src/client/conversation.ts')
  const topLevel = conversationViewOf({
    sessionId: 's1',
    nodes: [{ kind: 'assistant', seq: 1, blocks: [{ kind: 'reasoning', text: 'fresh' }] }],
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
        nodes: [{ kind: 'assistant', seq: 2, blocks: [{ kind: 'reasoning', text: 'go' }] }],
        partial: null,
      },
    },
  })
  check('view: chat.legacy nodes', legacyOnly.nodes[0].seq, 2)
  check('view: chat.legacy default open', legacyOnly.openState, 'open')
  check('view: missing sessionId is undefined', conversationViewOf({ nodes: [] }), undefined)

  const acc = new (await import('./src/client/accumulator.ts')).SessionStatsAccumulator()
  acc.fold(legacyOnly)
  check('view: accumulator folds chat.legacy', acc.counts.replies, 1)

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
          nodes: [{ kind: 'assistant', seq: 4, blocks: [{ kind: 'reasoning', text: 'go' }], partial: null }],
          partial: { blocks: [{ kind: 'reasoning', text: 'stream' }] },
        },
      }
      : undefined,
  }
  const split = conversationViewOf(alphaSession, { views })
  check('view: 0.1.2 views.get(chat).legacy nodes', split.nodes[0].seq, 4)
  check('view: 0.1.2 views.get(chat).legacy partial', split.partial !== null, true)
}

// --- 6. Reasoning-health anomaly: text-without-reasoning is reported, never counted ---
{
  const { computeStats } = await import('./src/client/stats.ts')
  const snap = (nodes, partial = null) => ({ sessionId: 's1', nodes, partial })

  const missing = computeStats(snap([{
    kind: 'assistant', seq: 1, time: 0, turn: 1, step: 1,
    blocks: [{ kind: 'text', text: 'plain reply text' }],
  }]))
  check('anomaly: all-text → missing', missing.anomaly, 'missing')
  check('anomaly: missing leaves blocks 0', missing.blocks, 0)
  check('anomaly: missing tracks text chars', missing.textBlocks, 1)

  const normal = computeStats(snap([{
    kind: 'assistant', seq: 1, time: 0, turn: 1, step: 1,
    blocks: [
      { kind: 'reasoning', text: 'planning text' },
      { kind: 'text', text: 'the fix' },
    ],
  }]))
  check('anomaly: reasoning+short-text → none', normal.anomaly, 'none')

  const starved = computeStats(snap([{
    kind: 'assistant', seq: 1, time: 0, turn: 1, step: 1,
    blocks: [
      { kind: 'reasoning', text: 'ok' },
      { kind: 'text', text: 'a long visible reply. '.repeat(40) },
    ],
  }]))
  check('anomaly: reasoning:text ratio < 5% → low', starved.anomaly, 'low')

  const bare = computeStats(snap([{ kind: 'assistant', seq: 1, time: 0, turn: 1, step: 1, blocks: [] }]))
  check('anomaly: empty assistant → none', bare.anomaly, 'none')
}

// --- 7. Attribution engine: vendor ranking + evidence ledger ---
{
  const { attributeSession, emptyAttribution, evidencePack, scanNode } = await import('./src/client/attribution.ts')
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
  const antml = attributeSession(viewOf([asNode(antmlText)]))
  check('attr: antml → anthropic top', antml.candidates[0]?.vendor, 'anthropic')
  check('attr: antml session likely', antml.verdict, 'likely')
  check('attr: antml ledger sample', (antml.evidence.find(e => e.id === 'antml-ns')?.samples.length ?? 0) >= 1, true)

  // fp_v4pro_… → deepseek; generic fp_ → openai.
  const v4 = attributeSession(viewOf([asNode('fp_v4pro_20260812_prod leaked in the chain.')]))
  check('attr: fp_v4pro → deepseek likely', v4.candidates[0]?.vendor === 'deepseek' && v4.verdict === 'likely', true)
  const fpg = attributeSession(viewOf([asNode('the trace said fp_abc123def0 twice: fp_abc123def0')]))
  check('attr: fp_ → openai likely', fpg.candidates[0]?.vendor === 'openai' && fpg.verdict === 'likely', true)

  // Plain text without structural evidence yields NO candidates (R1-era
  // style/trajectory rows are retired — style is not evidence).
  const plain = attributeSession(viewOf([asNode("We need to check the build. Let me think. I should delve into it — really — once more.")]))
  check('attr: style text → no candidates (folklore retired)', plain.candidates.length, 0)

  // Unattributed dirty token → ledger without vendor; verdict none; anomaly
  // detector must not double-count the recorded token.
  const unknown = attributeSession(viewOf([asNode('EDMFunc showed up mid-plan.')]))
  check('attr: EDMFunc unattributed', unknown.unattributed.some(e => e.id === 'edm-func'), true)
  check('attr: unattributed verdict none', unknown.verdict, 'none')
  check('attr: EDMFunc not double-counted by anomaly detector', unknown.evidence.some(e => e.id === 'anom-ident'), false)

  // Chat-template leaks are tier-1, passive (reasoning surface only).
  const tmpl = (text) => attributeSession(viewOf([asNode(text)]))
  check('attr: glm observation → zhipu top', tmpl('plan uses <|observation|> next').candidates[0]?.vendor, 'zhipu')
  const ds = tmpl('user asked; <｜Assistant｜> should reply')
  // Step-3.5 clones the full-width frame, so the shared row is tier-2 —
  // DeepSeek caps at `possible` from template tokens alone.
  check('attr: deepseek template token → deepseek possible (tier-2 shared with step)', ds.candidates[0]?.vendor === 'deepseek' && ds.verdict === 'possible', true)
  const stp = tmpl('wrap up <|EOT|> now')
  check('attr: step-3.5 EOT → step likely (step-unique tier-1)', stp.candidates[0]?.vendor === 'step' && stp.verdict === 'likely', true)
  const inst = tmpl('[INST] echoed frame')
  check('attr: [INST] credits mistral', inst.candidates[0]?.vendor, 'mistral')
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
  }])).evidence.some(e => e.id === 'tmpl-glm'), false)

  // Probe sentinels are scanned over visible text too.
  const probe = attributeSession(viewOf([{
    kind: 'assistant', seq: 1, turn: 1,
    blocks: [{ kind: 'text', text: 'SolidGoldMagikarp\nMT-ECHO-7f3a9c' }],
  }]))
  check('attr: glitch canary (visible text, diagnostic)', probe.evidence.some(e => e.id === 'probe-glitch-r50k'), true)
  check('attr: glitch canary carries no vendor (direction is human judgement)', probe.evidence.some(e => e.id === 'probe-glitch-r50k' && e.vendor !== null), false)
  check('attr: echo sentinel (visible text)', probe.evidence.some(e => e.id === 'probe-echo'), true)

  // Anomaly detectors catch unrecorded leaks (unknown namespaced tag, hex run).
  const anom = attributeSession(viewOf([asNode('<sys:internal> route via deadbeefdeadbeefcafe deadbeefdeadbeefcafe')]))
  check('attr: unknown namespaced tag flagged', anom.evidence.some(e => e.id === 'anom-ns-tag'), true)
  check('attr: hex run flagged', anom.evidence.some(e => e.id === 'anom-hex'), true)

  // Per-turn rows: first-seen evidence is new, later repeats are not.
  const mixed = attributeSession(viewOf([
    asNode('Free-form preamble.', 1),
    asNode('<antml:thinking> ok', 2),
    asNode('<antml:thinking> again', 3),
  ]))
  check('attr: turn2 new token antml-ns', mixed.turns[1]?.newTokens.includes('antml-ns'), true)
  check('attr: turn3 antml no longer new', mixed.turns[2]?.newTokens.includes('antml-ns'), false)
  check('attr: turn2 top anthropic', mixed.turns[1]?.top, 'anthropic')

  // computeStats wires the report into TrajectoryStats; empty stays empty.
  const { computeStats } = await import('./src/client/stats.ts')
  const wired = computeStats(viewOf([asNode('<antml:thinking> go')]))
  check('attr: computeStats carries attribution', wired?.attribution.verdict, 'likely')
  check('attr: no snapshot → null stats', computeStats(undefined), null)
  check('attr: emptyAttribution is none', emptyAttribution().verdict, 'none')

  const pack = evidencePack(antml, { sessionId: 's-attr' })
  check('attr: evidence pack json', typeof JSON.stringify(pack), 'string')
  check('attr: evidence pack verdict', pack.verdict, 'likely')

  const scanned = scanNode([{ kind: 'reasoning', text: '<antml:thinking>' }], 1, null)
  check('attr: scanNode finds antml', scanned.hits.some(h => h.id === 'antml-ns'), true)
  check('attr: scanNode echo suppression drops pasted token',
    scanNode([{ kind: 'reasoning', text: 'wrap <|EOT|> up' }], 1, null, 'pasted: <|EOT|>').hits.some(h => h.id === 'tmpl-step'), false)
  check('attr: scanNode without echo keeps the hit',
    scanNode([{ kind: 'reasoning', text: 'wrap <|EOT|> up' }], 1, null).hits.some(h => h.id === 'tmpl-step'), true)
}

// --- 8. User-echo suppression + confidence coefficient ---
{
  const { attributeSession } = await import('./src/client/attribution.ts')
  const asNode = (text, turn = 1) => ({
    kind: 'assistant', seq: turn, turn, time: 0,
    blocks: [{ kind: 'reasoning', text }],
  })
  const viewOf = (nodes) => ({
    sessionId: 'a', nodes, partial: null, openState: 'open', hasMore: false, loadingOlder: false,
  })

  // Probe prompts list vendor tokens verbatim; a batch session's reasoning
  // quotes them. User nodes carry `content` parts on the real host (not
  // `blocks`) — tokens pasted by the user side must not fire template rows.
  const echoed = attributeSession(viewOf([
    { kind: 'user', seq: 0, content: [{ type: 'text', text: '判断你是否认识：<|EOT|>、<sop>、<｜User｜>' }] },
    asNode('第一个 <|EOT|> 眼熟，<sop> 也有印象，<｜User｜> 很常见', 1),
  ]))
  check('attr: user-pasted tokens (content parts) echoed in reasoning do not fire', echoed.candidates.length, 0)
  check('attr: echoed tokens leave no step/zhipu/deepseek ledger rows',
    echoed.evidence.some(e => ['tmpl-step', 'tmpl-glm', 'tmpl-deepseek'].includes(e.id)), false)

  // Vocabulary-discussion turns: derived tokens (`<|im_end|>`, `[/INST]`) are
  // discussion too, not leaks.
  const discussed = attributeSession(viewOf([
    { kind: 'user', seq: 0, content: [{ type: 'text', text: '逐个判断你是否认识：<|im_start|>、[INST]、<sop>' }] },
    asNode('第 1 个是 ChatML 开头，对应 <|im_end|> 结尾；[INST] 的关闭是 [/INST]；<sop> 是开始', 1),
  ]))
  check('attr: discussion turn derived tokens do not fire', discussed.candidates.length, 0)
  check('attr: discussion turn leaves no template/anomaly rows',
    discussed.evidence.some(e => e.id.startsWith('tmpl-') || e.id.startsWith('anom-')), false)

  // A normal turn after a token-discussion turn still catches real leaks.
  const recovered = attributeSession(viewOf([
    { kind: 'user', seq: 0, content: [{ type: 'text', text: '逐个判断你是否认识：<|im_start|>' }] },
    asNode('<|im_start|> 是 ChatML 开头', 1),
    { kind: 'user', seq: 2, content: [{ type: 'text', text: '继续常规任务' }] },
    asNode('plan uses <|observation|> next', 3),
  ]))
  check('attr: genuine leak fires in a normal turn after a discussion turn', recovered.candidates[0]?.vendor, 'zhipu')

  // v11 windowed discussion suppression: the same discussion turn keeps
  // template matches FAR from any quoted token mention (>160 chars), where
  // organic serving-layer leaks actually live.
  const filler = '为了稳妥起见我先逐步分析这段代码的执行路径，确认边界条件与异常分支都覆盖到位，然后再给出最终结论。'.repeat(10)
  const farLeak = attributeSession(viewOf([
    { kind: 'user', seq: 0, content: [{ type: 'text', text: '逐个判断你是否认识：<|im_start|>' }] },
    asNode('<|im_start|> 是 ChatML 开头。' + filler + 'reviewing the plan the backend injected <|observation|> before my turn', 1),
  ]))
  check('attr: v11 — far-away organic leak in a discussion turn still fires', farLeak.candidates[0]?.vendor, 'zhipu')
  // …while a derived token right next to the quote stays suppressed.
  const nearDerived = attributeSession(viewOf([
    { kind: 'user', seq: 0, content: [{ type: 'text', text: '逐个判断你是否认识：<|im_start|>' }] },
    asNode('<|im_start|> 是开头，对应 <|im_end|>。' + filler + 'some unrelated long reasoning text without any template vocabulary at all', 1),
  ]))
  check('attr: v11 — near-quote derived token still suppressed',
    nearDerived.candidates.some(c => c.vendor === 'qwen' || c.vendor === 'yi'), false)

  // Suppression is per-match: a genuine leak alongside user text still fires.
  const genuine = attributeSession(viewOf([
    { kind: 'user', seq: 0, content: [{ type: 'text', text: '你好，继续任务' }] },
    asNode('plan uses <|observation|> next', 1),
  ]))
  check('attr: genuine leak still fires alongside user text', genuine.candidates[0]?.vendor, 'zhipu')

  // Probe sentinels live in the prompt by design — exempt from suppression.
  const sentinel = attributeSession(viewOf([
    { kind: 'user', seq: 0, content: [{ type: 'text', text: '请原样复述 MT-ECHO-7f3a9c' }] },
    { kind: 'assistant', seq: 1, turn: 1, blocks: [{ kind: 'text', text: 'MT-ECHO-7f3a9c' }] },
  ]))
  check('attr: probe sentinel not suppressed by echo', sentinel.evidence.some(e => e.id === 'probe-echo'), true)

  // Coefficient ordering: repeated tier-2 support must not outrank a single
  // tier-1 structural row.
  const race = attributeSession(viewOf([asNode('<|im_start|> <|im_start|> <|im_start|> then <|EOT|>', 1)]))
  check('attr: coefficient ranks tier-1 over stacked tier-2', race.candidates[0]?.vendor, 'step')
  check('attr: stacked tier-2 stays second',
    race.candidates[1]?.vendor === 'qwen' || race.candidates[1]?.vendor === 'yi', true)
  check('attr: tier-1 lead reaches likely', race.verdict, 'likely')
  check('attr: coefficient within bounds',
    race.candidates.every(c => c.confidence > 0 && c.confidence < 1), true)
  check('attr: stacked tier-2 coefficient in 0.3–0.45 band',
    race.candidates.slice(1).every(c => c.confidence > 0.3 && c.confidence < 0.45), true)

  // Tier-2 bands: the shared DeepSeek/Step frame lands in `possible`.
  const ds = attributeSession(viewOf([asNode('user asked; <｜Assistant｜> should reply')]))
  check('attr: shared frame coefficient in tier-2 band',
    ds.candidates[0].confidence > 0.2 && ds.candidates[0].confidence < 0.45, true)
}

// --- 9. Fertility scoring: cross-session usage differencing + L1 verdicts ---
{
  const { fertilitySequence, fertilityVerdictOf } = await import('./src/client/fertility-score.ts')
  const { FERTILITY_FAMILIES, FERTILITY_TEXTS } = await import('./src/client/fertility.ts')

  check('fertility: sequence is [T0, T1..T9]', fertilitySequence().map(t => t.id).join(','),
    FERTILITY_TEXTS.map(t => `fert-${t.id}`).join(','))

  // Simulated sessions: constant wrapper W=1000, tokens(T0)=2, serving counts
  // = reference delta + tokens(T0). Measured prompt side = W + tokens(text).
  const family = FERTILITY_FAMILIES.find(f => f.id === 'minimax-m3')
  const turns = FERTILITY_TEXTS.map(text => {
    const delta = text.id === 'T0' ? 0 : family.deltas[Number(text.id.slice(1)) - 1]
    return { probeId: `fert-${text.id}`, status: 'answered', promptTokens: 1000 + 2 + delta }
  })
  const verdict = fertilityVerdictOf(turns)
  check('fertility: usable verdict', verdict.usable, true)
  check('fertility: all nine dimensions measured', verdict.measured, 9)
  check('fertility: exact family match at L1=0', verdict.candidates[0].family.id, 'minimax-m3')
  check('fertility: top candidate L1 is 0', verdict.candidates[0].l1, 0)
  check('fertility: wrapper baseline is the T0 session prompt side', verdict.wrapperBaseline, 1002)

  // Missing usage readings → incomplete run: ranks on the remaining dims and
  // can no longer be a 9/9 exact match.
  const broken = fertilityVerdictOf(turns.map((turn, index) => index === turns.length - 1 ? { ...turn, promptTokens: null } : turn))
  check('fertility: missing reading drops a dimension', broken.measured, 8)
  check('fertility: incomplete run ranks on 8 dims', broken.candidates[0].dims, 8)

  // No baseline (T0 missing) → unusable.
  const noBase = fertilityVerdictOf(turns.slice(1))
  check('fertility: no baseline → unusable', noBase.usable, false)
}

console.log(failures === 0 ? '\nAll checks passed ✓' : `\n${failures} check(s) FAILED ✗`)
// Let pending dynamic-import module jobs settle before exiting (avoids a
// Windows libuv teardown race that otherwise asserts in win/async.c).
await new Promise(resolve => setTimeout(resolve, 100))
process.exit(failures === 0 ? 0 : 1)
