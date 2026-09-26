#!/usr/bin/env node
/**
 * Offline regression for the batch probe-test scoring (src/client/batch.ts)
 * and the probe kit invariants (src/client/probes.ts). Pure logic, no React,
 * no host, no network. Run: node --experimental-strip-types verify-batch.mjs
 */
import { deepEqual, ok } from 'node:assert/strict'

const { estimateTokens, familyHitsOf, aggregateBatch, orderedProbes, recognitionListedTokens } =
  await import('./src/client/batch.ts')
const { PROBES } = await import('./src/client/probes.ts')
const { TOKENIZER_FEATURE_SETS } = await import('./src/client/tokenizers.ts')
const { ALL_SIGNALS } = await import('./src/client/attribution-signals.ts')

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
      candidates: [{ vendor: 'deepseek', score: 5, tier1: 1, verdict: 'likely' }],
      evidence: [],
      unattributed: [],
      turns: [],
    },
    hits: [{ vendor: 'minimax', tokens: ['</mm:think>', '<mm:think>'] }],
    answered: 5,
    total: 5,
  })
  ok(guess.vendor === 'deepseek', `top ${guess.vendor}`)
  ok(guess.confidence === 'medium', `${guess.confidence} (deepseek 5 vs minimax 4 — close race stays medium)`)
})

check('aggregateBatch: clear cross-layer lead reaches high confidence', () => {
  const guess = aggregateBatch({
    engine: {
      verdict: 'likely',
      candidates: [{ vendor: 'minimax', score: 6, tier1: 1, verdict: 'likely' }],
      evidence: [],
      unattributed: [],
      turns: [],
    },
    hits: [{ vendor: 'minimax', tokens: ['</mm:think>', ']!p~[', '[e~['] }],
    answered: 5,
    total: 5,
  })
  ok(guess.vendor === 'minimax')
  ok(guess.confidence === 'high', `${guess.confidence} (6 + 6 = 12, runner 0, tier1 + 3 tokens)`)
})

check('aggregateBatch: nothing fires -> none', () => {
  const guess = aggregateBatch({ engine: null, hits: [], answered: 0, total: 5 })
  ok(guess.vendor === null && guess.confidence === 'none')
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

if (failures > 0) {
  console.error(`verify-batch: ${failures} failure(s)`)
  process.exit(1)
}
console.log('verify-batch: PASS')
