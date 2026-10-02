#!/usr/bin/env node
/**
 * Offline regression for the batch probe-test scoring (src/client/batch.ts)
 * and the probe kit invariants (src/client/probes.ts). Pure logic, no React,
 * no host, no network. Run: node --experimental-strip-types verify-batch.mjs
 */
import { deepEqual, ok } from 'node:assert/strict'

const { batchScanText, estimateTokens, familyHitsOf, identityClaimsOf, aggregateBatch, orderedProbes, recognitionListedTokens, canaryEchoOf, batchEngineReportOf } =
  await import('./src/client/batch.ts')
const { PROBES } = await import('./src/client/probes.ts')
const { TOKENIZER_FEATURE_SETS } = await import('./src/client/tokenizers.ts')
const { ALL_SIGNALS } = await import('./src/client/attribution-signals.ts')
const { FAMILY_CANARIES } = await import('./src/client/canaries.ts')

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures += 1
    console.error(`FAIL  ${name} — ${err.message}`)
  }
}

check('estimateTokens: CJK-dense prompts cost more per char than ascii', () => {
  const cjk = estimateTokens('模型家族检测分词器'.repeat(4))
  const ascii = estimateTokens('model family detection tokenizer'.repeat(4))
  ok(cjk > ascii, `${cjk} !> ${ascii}`)
})

check('estimateTokens: floor of template overhead', () => {
  ok(estimateTokens('') >= 20)
})

check('recognitionListedTokens: one per tokenizer feature set', () => {
  deepEqual(recognitionListedTokens().length, TOKENIZER_FEATURE_SETS.length)
})

check('familyHitsOf: elicits family tokens from replies', () => {
  const text = '好的，我会这样调用：<｜Assistant｜>tool_call，然后 <arg_key>city</arg_key>'
  const vendors = familyHitsOf(text).map(h => h.vendor)
  ok(vendors.includes('deepseek'), `deepseek missing: ${vendors}`)
  ok(vendors.includes('zhipu'), `zhipu missing: ${vendors}`)
})

check('familyHitsOf: recognition-probe-listed tokens are excluded (quote-proof)', () => {
  // tokens[0] of each set is what the recognition probe quotes back — they
  // must not score: '<sop>' (zhipu), '<|im_start|>' (qwen), '<｜begin▁of▁sentence｜>' (deepseek).
  const text = '1. <|im_start|> 2. <sop> 3. <｜begin▁of▁sentence｜>'
  deepEqual(familyHitsOf(text), [])
})

check('familyHitsOf: second tokens of each set still score', () => {
  const text = '<|im_end|> </mm:think> [TOOL_CALLS] <end_of_turn>'
  const vendors = familyHitsOf(text).map(h => h.vendor).sort()
  deepEqual(vendors, ['google', 'minimax', 'mistral', 'qwen'].sort())
})

check('batchScanText: recognition turn excluded so reasoning-derived tokens cannot score', () => {
  // A reasoning text discussing the token list derives related tokens by
  // analogy (`[/INST]` from `[INST]`) — the template turn is dropped whole.
  const text = batchScanText([
    { probeId: 'template', text: '认识，[/INST] 是关闭标记；对应 <|im_end|>' },
    { probeId: 'toolformat', text: 'MT-TOOLFMT-4e8a21 native <minimax:tool_call>' },
  ])
  const hits = familyHitsOf(text).map(h => h.vendor)
  ok(hits.includes('minimax'), `minimax missing: ${hits}`)
  ok(!hits.includes('mistral') && !hits.includes('qwen'), `derived tokens leaked: ${hits}`)
})

check('batchScanText: fertility metering turns never feed the family scanner', () => {
  const text = batchScanText([
    { probeId: 'fert-T1', text: '</mm:think> [TOOL_CALLS]' },
    { probeId: 'natural', text: 'plain answer' },
  ])
  deepEqual(familyHitsOf(text), [])
})

check('identityClaimsOf: self-report vendors extracted from the identity turn only', () => {
  const claims = identityClaimsOf([
    { probeId: 'identity', text: '我是 MiniMax 开发的助手，运行在闭源网关上。' },
    { probeId: 'natural', text: 'I am an OpenAI-style agent.' },
  ])
  deepEqual(claims, ['minimax'])
  deepEqual(identityClaimsOf([{ probeId: 'identity', text: '' }]), [])
})

check('panel persist: stored verdicts validate and malformed records reject', async () => {
  const { parseStoredBatch, parseStoredFertility } = await import('./src/client/panel-persist.ts')
  const fertility = parseStoredFertility({
    at: '2026-09-26T08:00:00.000Z',
    verdict: {
      measured: 9, usable: true, wrapperBaseline: 11375, measuredCounts: { T0: 11377 },
      candidates: [{ familyId: 'minimax-m3', l1: 0, dims: 9 }, { familyId: 'no-such-family', l1: 9, dims: 9 }],
    },
  })
  ok(fertility === null, 'unknown familyId must reject the whole record')

  const good = parseStoredFertility({
    at: '2026-09-26T08:00:00.000Z',
    verdict: {
      measured: 9, usable: true, wrapperBaseline: 11375, measuredCounts: { T0: 11377 },
      candidates: [{ familyId: 'minimax-m3', l1: 0, dims: 9 }],
    },
  })
  ok(good !== null && good.verdict.candidates[0].family.id === 'minimax-m3' && good.verdict.candidates[0].l1 === 0,
    'valid fertility record must rehydrate with the family object')

  // Unknown vendor names survive as null ("nothing rankable") so records
  // written before a vendor-table rename/retirement keep loading.
  const unknownVendor = parseStoredBatch({ at: 'x', guess: { vendor: 'nope', confidence: 'high', confidenceValue: 1, hits: [] } })
  ok(unknownVendor !== null && unknownVendor.guess.vendor === null,
    'unknown vendor must coerce to null, record still loads')
  const batch = parseStoredBatch({
    at: '2026-09-26T08:00:00.000Z',
    guess: { vendor: 'minimax', confidence: 'low', confidenceValue: 0.25, hits: [{ vendor: 'qwen', tokens: ['<|im_end|>'] }] },
    claims: ['minimax', 'not-a-vendor'],
    coverage: { answered: 11, total: 11 },
  })
  ok(batch !== null && batch.guess.vendor === 'minimax' && batch.claims.length === 1 && batch.coverage.answered === 11,
    'valid batch record must parse with claims filtered to known vendors')
})

check('orderedProbes: structural canaries first, stable ordering', () => {
  const probes = orderedProbes()
  ok(probes[0].confidence === 3, `first probe confidence ${probes[0].confidence}`)
  for (let i = 1; i < probes.length; i++) {
    ok(probes[i - 1].confidence >= probes[i].confidence, 'confidence must be non-increasing')
  }
  deepEqual(probes.length, PROBES.length)
})

check('aggregateBatch: probe tokens + engine score rank the guess', () => {
  const guess = aggregateBatch({
    engine: {
      verdict: 'likely',
      candidates: [{ vendor: 'deepseek', score: 5, confidence: 0.5, tier1: 1, verdict: 'likely' }],
      evidence: [],
      unattributed: [],
      turns: [],
    },
    hits: [{ vendor: 'minimax', tokens: ['</mm:think>', '<mm:think>'] }],
    answered: 5,
    total: 5,
  })
  ok(guess.vendor === 'deepseek', `top ${guess.vendor}`)
  ok(guess.confidence === 'medium', `${guess.confidence} (deepseek 0.5 vs minimax 0.4375 — close race stays medium)`)
  ok(guess.confidenceValue > 0.4 && guess.confidenceValue < 0.6, `coefficient ${guess.confidenceValue} out of band`)
})

check('aggregateBatch: clear cross-layer lead reaches high confidence', () => {
  const guess = aggregateBatch({
    engine: {
      verdict: 'likely',
      candidates: [{ vendor: 'minimax', score: 6, confidence: 0.95, tier1: 1, verdict: 'likely' }],
      evidence: [],
      unattributed: [],
      turns: [],
    },
    hits: [{ vendor: 'minimax', tokens: ['</mm:think>', ']!p~[', '[e~['] }],
    answered: 5,
    total: 5,
  })
  ok(guess.vendor === 'minimax')
  ok(guess.confidence === 'high', `${guess.confidence} (0.95 ⊕ 3 tokens ≈ 0.979, runner 0, tier1 + 3 tokens)`)
  ok(guess.confidenceValue > 0.9 && guess.confidenceValue < 1, `coefficient ${guess.confidenceValue} out of band`)
})

check('aggregateBatch: engine coefficient outranks token-only support', () => {
  // Equal scores: a tier-1 engine candidate must outrank probe-token support.
  const guess = aggregateBatch({
    engine: {
      verdict: 'likely',
      candidates: [{ vendor: 'step', score: 6, confidence: 0.95, tier1: 1, verdict: 'likely' }],
      evidence: [],
      unattributed: [],
      turns: [],
    },
    hits: [{ vendor: 'minimax', tokens: ['<mm:think>', '<minimax:tool_call>', ']!p~['] }],
    answered: 5,
    total: 5,
  })
  ok(guess.vendor === 'step', `top ${guess.vendor} (0.95 vs token-only 0.578)`)
  ok(guess.candidates[0].confidence > guess.candidates[1].confidence, 'confidence must order candidates')
})

check('aggregateBatch: nothing fires -> none', () => {
  const guess = aggregateBatch({ engine: null, hits: [], answered: 0, total: 5 })
  ok(guess.vendor === null && guess.confidence === 'none')
  ok(guess.confidenceValue === 0, `coefficient ${guess.confidenceValue} should be 0`)
})

check('canaryEchoOf: degenerate repetition (≥2) points at the owning family', () => {
  const canary = FAMILY_CANARIES.find(set => set.vendor === 'minimax')?.canaries[0]
  ok(canary !== undefined, 'minimax must have mined canaries')
  // Clean echo (one verbatim occurrence) is no evidence…
  ok(canaryEchoOf([{ probeId: 'canary', text: `介绍\n${canary}\n完` }]).length === 0, 'clean echo must not fire')
  // …a repetition loop (twice) is the SolidGoldMagikarp signature.
  const hits = canaryEchoOf([{ probeId: 'canary', text: `${canary}\n${canary}\n${canary}` }])
  deepEqual(hits, [{ vendor: 'minimax', tokens: [canary] }])
})

check('canaryEchoOf: only the canary probe reply counts, other families unaffected', () => {
  const canary = FAMILY_CANARIES.find(set => set.vendor === 'minimax')?.canaries[0]
  ok(canary !== undefined)
  // Same string repeated in a NON-canary turn (quoted by another probe) — no hit.
  ok(canaryEchoOf([{ probeId: 'natural', text: canary + canary }]).length === 0)
})

check('canaryEchoOf: canary strings never collide with the template scan', () => {
  // Every canary must be absent from every family's template-token list —
  // the two scanners read the same reply text and must not cross-fire.
  const templateTokens = new Set(TOKENIZER_FEATURE_SETS.flatMap(set => set.tokens))
  for (const set of FAMILY_CANARIES) {
    for (const canary of set.canaries) {
      ok(!templateTokens.has(canary), `canary ${JSON.stringify(canary)} collides with a template token`)
    }
  }
})

check('batchEngineReportOf: builds a per-probe engine report with echo context', () => {
  const report = batchEngineReportOf([
    {
      probeId: 'natural',
      prompt: '继续常规任务',
      text: '',
      blocks: [{ kind: 'reasoning', text: 'plan uses <|observation|> next' }],
    },
  ])
  ok(report !== null, 'report must exist')
  ok(report.candidates[0]?.vendor === 'zhipu', `top ${report.candidates[0]?.vendor}`)
  // A quoted template token (listed by the probe prompt) must not fire.
  const quoted = batchEngineReportOf([
    {
      probeId: 'template',
      prompt: '逐个判断你是否认识：<|observation|>',
      text: '',
      blocks: [{ kind: 'reasoning', text: '<|observation|> 有点眼熟' }],
    },
  ])
  ok(quoted !== null && quoted.candidates.length === 0, 'user-echo must be suppressed inside the synthetic view')
})

check('batchEngineReportOf: null on empty collection', () => {
  ok(batchEngineReportOf([]) === null)
  ok(batchEngineReportOf([{ probeId: 'natural', text: '' }]) === null)
})

check('every probe sentinel and signal id has a zh locale key', async () => {
  const { zh } = await import('./src/client/locales.ts')
  const { PROBES: probes } = await import('./src/client/probes.ts')
  for (const probe of probes) {
    ok(`attr.probe.${probe.id}` in zh, `missing attr.probe.${probe.id}`)
    ok(`attr.probe.${probe.id}.note` in zh, `missing attr.probe.${probe.id}.note`)
    for (const sentinel of probe.sentinels) {
      ok(probe.prompt.includes(sentinel), `probe ${probe.id} prompt misses its sentinel ${sentinel}`)
    }
  }
  for (const signal of ALL_SIGNALS) {
    ok(`attr.signal.${signal.id}` in zh, `missing attr.signal.${signal.id}`)
  }
})

check('every vendor has zh + en display names and a zh identity-pattern mention', async () => {
  const { zh, en } = await import('./src/client/locales.ts')
  const { VENDORS: vendors } = await import('./src/client/attribution-signals.ts')
  const { IDENTITY_CLAIM_PATTERNS } = await import('./src/client/batch.ts')
  for (const vendor of vendors) {
    ok(`vendor.${vendor}` in zh, `missing zh vendor.${vendor}`)
    ok(`vendor.${vendor}` in en, `missing en vendor.${vendor}`)
    ok(IDENTITY_CLAIM_PATTERNS.some(p => p.vendor === vendor), `missing identity claim pattern for ${vendor}`)
  }
})

if (failures > 0) {
  console.error(`verify-batch: ${failures} failure(s)`)
  process.exit(1)
}
console.log('verify-batch: PASS')
