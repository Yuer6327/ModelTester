#!/usr/bin/env node
/**
 * Offline regression for the drift-corrected fertility scoring
 * (fertility-score.ts) and the persisted-verdict schema bridge
 * (panel-persist.ts). No network, no credentials.
 *
 * The polluted fixture replays the REAL readings captured 2026-10-01 from
 * the desktop host (leveldb fert-run state): three distinct session
 * wrappers (9617 / 9460 / ~19.3-19.7k) with the serving tokenizer actually
 * minimax-m3 all along — the naive T0-relative vector ranked xiaomi first
 * by noise; the consensus scorer must recover minimax.
 *
 * Run: node --experimental-strip-types verify-fertility-score.mjs
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

const { fertilityVerdictOf, INLIER_MIN, SPREAD_MAX } = await import('./src/client/fertility-score.ts')

const turnsOf = (p) => Object.entries(p).map(([id, promptTokens]) => ({ probeId: `fert-${id}`, status: 'answered', promptTokens }))

// minimax-m3 absolute token counts (official tokenizer, fertility-reference.json).
const MM = { T0: 2, T1: 40, T2: 78, T3: 47, T4: 62, T5: 66, T6: 68, T7: 44, T8: 47, T9: 38 }
// deepseek-v4 absolute counts (identical vector family: step).
const DS = { T0: 2, T1: 42, T2: 80, T3: 52, T4: 64, T5: 69, T6: 68, T7: 33, T8: 47, T9: 41 }

// --- 1. Clean run: constant wrapper → exact minimax, no drift -------------
{
  const W = 500
  const p = Object.fromEntries(Object.entries(MM).map(([id, c]) => [id, W + c]))
  const v = fertilityVerdictOf(turnsOf(p))
  check('clean: top family = minimax-m3', v.candidates[0].family.id, 'minimax-m3')
  check('clean: raw L1 = 0', v.candidates[0].l1, 0)
  check('clean: consensus inliers = 9', v.candidates[0].inliers, 9)
  check('clean: offset = 0', v.candidates[0].offset, 0)
  check('clean: drift = false', v.drift, false)
  check('clean: measured 9/9', v.measured, 9)
  check('clean: wrapper baseline', v.wrapperBaseline, 502)
}

// --- 2. Real polluted run (2026-10-01 desktop capture) ---------------------
// Three wrapper populations: A=9617 (T0,T1,T4,T6,T9), B=9460 (T3,T7,T8),
// C≈2× wrapper (T2,T5 — crash-resume double sends). Serving tokenizer was
// minimax-m3 throughout; the naive vector must NOT decide the verdict.
{
  const p = { T0: 9619, T1: 9657, T2: 19359, T3: 9505, T4: 9679, T5: 19697, T6: 9685, T7: 9502, T8: 9505, T9: 9655 }
  const v = fertilityVerdictOf(turnsOf(p))
  check('polluted: top family = minimax-m3 (was xiaomi under raw L1)', v.candidates[0].family.id, 'minimax-m3')
  check('polluted: xiaomi NOT ranked first', v.candidates.findIndex(c => c.family.id === 'xiaomi') > 0, true)
  check('polluted: drift = true', v.drift, true)
  check('polluted: spread reported (> SPREAD_MAX)', v.wrapperSpread > SPREAD_MAX, true)
  check(`polluted: majority cluster ≥ ${INLIER_MIN} dims`, v.candidates[0].inliers >= INLIER_MIN, true)
  check('polluted: majority cluster residual mass = 0', v.candidates[0].inlierL1, 0)
  check('polluted: majority offset = 0 (T0 sits in the majority cluster)', v.candidates[0].offset, 0)
  check('polluted: minority dims still visible in raw L1', v.candidates[0].l1 > 1000, true)
}

// --- 3. Hopeless drift: unique wrapper per session → no family call --------
{
  const p = Object.fromEntries(Object.entries(MM).map(([id, c], i) => [id, 5000 + i * 731 + c]))
  const v = fertilityVerdictOf(turnsOf(p))
  check('hopeless: drift = true', v.drift, true)
  check(`hopeless: no family reaches ${INLIER_MIN} inliers (inconclusive tier)`, v.candidates[0].inliers < INLIER_MIN, true)
}

// --- 3b. Outlier dims: the targeted-retry surface ----------------------------
{
  // Clean run: no outliers, nothing to retry.
  const clean = fertilityVerdictOf(turnsOf(Object.fromEntries(Object.entries(MM).map(([id, c]) => [id, 500 + c]))))
  check('outliers: clean run has none', clean.outlierDims, [])
  // Polluted run: the minority-wrapper sessions must be named so the runner
  // can re-measure exactly those. The fixture has three wrapper populations —
  // A=9617 (T0,T1,T4,T6,T9), B=9460 (T3,T7,T8), C≈2× (T2,T5) — so every
  // non-A dim is an outlier.
  const polluted = fertilityVerdictOf(turnsOf({ T0: 9619, T1: 9657, T2: 19359, T3: 9505, T4: 9679, T5: 19697, T6: 9685, T7: 9502, T8: 9505, T9: 9655 }))
  check('outliers: polluted run names the drifted dims', polluted.outlierDims, ['T2', 'T3', 'T5', 'T7', 'T8'])
  // A targeted re-draw of ALL outliers lands back on the majority wrapper
  // (9617) → the drift flag clears and the clean 9/9 exact match returns.
  // Repaired absolutes = 9617 + the MM reference counts.
  const repaired = fertilityVerdictOf(turnsOf({ T0: 9619, T1: 9657, T2: 9695, T3: 9664, T4: 9679, T5: 9683, T6: 9685, T7: 9661, T8: 9664, T9: 9655 }))
  check('outliers: after re-draw drift clears', repaired.drift, false)
  check('outliers: after re-draw verdict is exact minimax', [repaired.candidates[0].family.id, repaired.candidates[0].l1], ['minimax-m3', 0])
}

// --- 4. Near-duplicate pair still ties on a clean run -----------------------
{
  const W = 800
  const p = Object.fromEntries(Object.entries(DS).map(([id, c]) => [id, W + c]))
  const v = fertilityVerdictOf(turnsOf(p))
  check('near-tie: deepseek first, step second, both L1 0', [v.candidates[0].family.id, v.candidates[1].family.id, v.candidates[0].l1, v.candidates[1].l1], ['deepseek-v4', 'step', 0, 0])
  check('near-tie: same consensus key (tied display)', [v.candidates[0].inliers, v.candidates[0].inlierL1], [v.candidates[1].inliers, v.candidates[1].inlierL1])
}

// --- 5. Incomplete run: ranks on the covered dims, never 9/9 exact ----------
{
  const W = 300
  const p = { T0: W + MM.T0, T1: W + MM.T1, T2: W + MM.T2, T3: W + MM.T3, T4: W + MM.T4 }
  const v = fertilityVerdictOf(turnsOf(p))
  check('partial: measured 4/9 (T0 is the baseline, not a dim)', v.measured, 4)
  check('partial: usable', v.usable, true)
  check('partial: top = minimax over 4 dims', v.candidates[0].family.id, 'minimax-m3')
  check('partial: covered dims = 4', v.candidates[0].dims, 4)
}

// --- 6. Persisted-record bridge: v1 legacy candidates get consensus defaults
{
  const { parseStoredFertility } = await import('./src/client/panel-persist.ts')
  const legacy = {
    at: '2026-10-01T01:31:56.000Z',
    verdict: {
      measured: 9,
      usable: true,
      wrapperBaseline: 9619,
      candidates: [{ familyId: 'minimax-m3', l1: 20155, dims: 9 }],
    },
  }
  const stored = parseStoredFertility(legacy)
  check('persist: legacy record accepted', stored !== null, true)
  check('persist: legacy candidate degrades to full-inlier', [stored.verdict.candidates[0].inliers, stored.verdict.candidates[0].offset], [9, 0])
  check('persist: legacy drift defaults false', stored.verdict.drift, false)
  check('persist: legacy outlierDims defaults empty', stored.verdict.outlierDims, [])
  check('persist: v2 shape roundtrip keeps drift', parseStoredFertility({
    at: 'x', verdict: { measured: 9, usable: true, wrapperBaseline: 502, wrapperSpread: 10496, drift: true, candidates: [{ familyId: 'minimax-m3', l1: 20155, dims: 9, inliers: 4, inlierL1: 0, offset: 0 }] },
  }).verdict.drift, true)
  check('persist: junk rejected', parseStoredFertility({ at: 5 }), null)
}

if (failures > 0) {
  console.error(`verify-fertility-score: ${failures} failure(s)`)
  process.exit(1)
}
console.log('verify-fertility-score: PASS')
