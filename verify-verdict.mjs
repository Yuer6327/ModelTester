#!/usr/bin/env node
/**
 * Offline regression for the cross-channel verdict (verdict.ts): the
 * confidence scale, the ranked channel order (resultless channels sink in
 * standing order), the final verdict = strongest channel, and the
 * cross-channel agreement (including fertility near-duplicate pairs).
 * Fertility verdicts are produced by the real scorer so grading stays in
 * lockstep with fertility-score.ts. No network, no credentials.
 *
 * Run: node --experimental-strip-types verify-verdict.mjs
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

const {
  agreementWith, batchChannel, finalVerdictOf, fertilityChannel, hasResult, lexiconChannel, rankChannels,
} = await import('./src/client/verdict.ts')
const { fertilityVerdictOf } = await import('./src/client/fertility-score.ts')

const turnsOf = (p) => Object.entries(p).map(([id, promptTokens]) => ({ probeId: `fert-${id}`, status: 'answered', promptTokens }))

// minimax-m3 absolute counts (official tokenizer) — clean run → exact.
const MM = { T0: 2, T1: 40, T2: 78, T3: 47, T4: 62, T5: 66, T6: 68, T7: 44, T8: 47, T9: 38 }
// deepseek-v4 absolute counts — clean run ties deepseek-v4 with step.
const DS = { T0: 2, T1: 42, T2: 80, T3: 52, T4: 64, T5: 69, T6: 68, T7: 33, T8: 47, T9: 41 }

const storedFertility = (verdict) => ({ at: '2026-10-01T00:00:00Z', verdict })
const storedBatch = (vendor, confidence, confidenceValue) => ({
  at: '2026-10-01T00:00:00Z',
  guess: { vendor, confidence, confidenceValue, candidates: [], hits: [] },
  claims: [],
  coverage: { answered: 10, total: 12 },
})
const lexiconReport = (vendor, confidence, verdict) => ({
  verdict,
  candidates: vendor === null ? [] : [{ vendor, score: 4, confidence, tier1: 0, verdict }],
  evidence: [],
  unattributed: [],
  turns: [],
})

// --- 1. Grading: fertility exact / batch / lexicon --------------------------
{
  const fert = fertilityChannel(storedFertility(fertilityVerdictOf(turnsOf(MM))))
  check('fertility exact: vendor', fert.vendor, 'minimax')
  check('fertility exact: grade', fert.grade, 'exact')
  check('fertility exact: confidence', fert.confidence, 0.95)
  check('fertility exact: tied carries the top vendor itself', fert.tied, ['minimax'])

  const batch = batchChannel(storedBatch('minimax', 'high', 0.87))
  check('batch high: vendor', batch.vendor, 'minimax')
  check('batch high: grade', batch.grade, 'high')
  check('batch high: keeps own coefficient', batch.confidence, 0.87)

  const lex = lexiconChannel(lexiconReport('minimax', 0.4, 'possible'))
  check('lexicon possible: vendor', lex.vendor, 'minimax')
  check('lexicon possible: grade', lex.grade, 'possible')
  check('lexicon possible: confidence', lex.confidence, 0.4)
}

// --- 2. Ranked order + final verdict = strongest channel --------------------
{
  const channels = rankChannels([
    fertilityChannel(storedFertility(fertilityVerdictOf(turnsOf(MM)))),
    batchChannel(storedBatch('minimax', 'high', 0.87)),
    lexiconChannel(lexiconReport('deepseek', 0.4, 'possible')),
  ])
  check('ranked: order by confidence', channels.map(c => c.channel), ['fertility', 'batch', 'lexicon'])
  const final = finalVerdictOf(channels)
  check('final: strongest channel', final?.channel, 'fertility')
  check('final: vendor', final?.vendor, 'minimax')
  check('agreement: fertility + batch agree (minimax), lexicon disagrees', agreementWith(final, channels), 2)
}

// --- 3. Resultless fertility sinks; batch leads ------------------------------
{
  const channels = rankChannels([
    fertilityChannel(null),
    batchChannel(storedBatch('zhipu', 'medium', 0.6)),
    lexiconChannel(lexiconReport('deepseek', 0.4, 'possible')),
  ])
  check('unmeasured fertility sinks last', channels.map(c => c.channel), ['batch', 'lexicon', 'fertility'])
  check('final: batch', finalVerdictOf(channels)?.channel, 'batch')
  check('agreement: distinct vendors never stack', agreementWith(finalVerdictOf(channels), channels), 1)
}

// --- 4. Nothing measured anywhere --------------------------------------------
{
  const channels = rankChannels([fertilityChannel(null), batchChannel(null), lexiconChannel(null)])
  check('standing order with no results', channels.map(c => c.channel), ['fertility', 'batch', 'lexicon'])
  check('final: null', finalVerdictOf(channels), null)
  check('hasResult: all false', channels.every(c => !hasResult(c)), true)
}

// --- 5. Hopeless drift → inconclusive, never presents ------------------------
{
  const p = Object.fromEntries(Object.entries(MM).map(([id, c], i) => [id, 5000 + i * 731 + c]))
  const fert = fertilityChannel(storedFertility(fertilityVerdictOf(turnsOf(p))))
  check('hopeless: grade', fert.grade, 'inconclusive')
  check('hopeless: no result', hasResult(fert), false)
  const channels = rankChannels([
    fert,
    batchChannel(storedBatch('qwen', 'low', 0.3)),
    lexiconChannel(lexiconReport('qwen', 0.4, 'possible')),
  ])
  check('inconclusive fertility sinks below low batch', channels.map(c => c.channel), ['lexicon', 'batch', 'fertility'])
  check('final: lexicon outranks low batch', finalVerdictOf(channels)?.channel, 'lexicon')
}

// --- 6. Lexicon noise (verdict none) never presents --------------------------
{
  const lex = lexiconChannel(lexiconReport('deepseek', 0.15, 'none'))
  check('lexicon none: no result', hasResult(lex), false)
  const batch = batchChannel(storedBatch(null, 'none', 0))
  check('batch none: no result', hasResult(batch), false)
}

// --- 7. Near-duplicate pair: tied vendors + cross-family agreement -----------
{
  const fert = fertilityChannel(storedFertility(fertilityVerdictOf(turnsOf(DS))))
  check('tied pair: vendor', fert.vendor, 'deepseek')
  check('tied pair: tied includes step', fert.tied.includes('step'), true)
  check('tied pair: grade exact', fert.grade, 'exact')
  const channels = [
    fert,
    batchChannel(storedBatch('deepseek', 'high', 0.85)),
    lexiconChannel(lexiconReport('step', 0.3, 'possible')),
  ]
  check('agreement: pair counts both family members', agreementWith(fert, channels), 3)
  const ranked = rankChannels(channels)
  check('tied pair still ranks first (confidence tie → standing order)', ranked[0].channel, 'fertility')
}

// --- 8. Low batch ranks below a stronger lexicon report -----------------------
{
  const channels = rankChannels([
    fertilityChannel(null),
    batchChannel(storedBatch('qwen', 'low', 0.3)),
    lexiconChannel(lexiconReport('qwen', 0.4, 'possible')),
  ])
  check('0.4 lexicon above 0.3 batch', channels.map(c => c.channel), ['lexicon', 'batch', 'fertility'])
  check('agreement: qwen twice', agreementWith(finalVerdictOf(channels), channels), 2)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall verdict checks passed')
