#!/usr/bin/env node
/**
 * Fertility reference-vector confusion analysis (offline, no network).
 *
 * The consensus gate (fertility-score.ts) accepts a family when ≥ INLIER_MIN
 * dimensions fall within WRAPPER_TOL of one common wrapper offset, with
 * ≤ INLIER_L1_MAX residual mass in that cluster. This script exhaustively
 * checks, for every ordered family pair (measured = B, hypothesized = A),
 * whether ANY single per-run wrapper offset could make A pass the gate on
 * B's true deltas — under the constant-offset model the gate is designed for:
 *
 *   r_i(A) = (P_i − P_0) − ΔA_i = ΔB_i − ΔA_i + (w_i − w_0)  →  w_i ≡ w_0
 *   ⇒ r_i(A) = ΔB_i − ΔA_i − d  for the run's single offset d
 *
 * A pair is CONFUSABLE iff some integer d gives A ≥ INLIER_MIN inliers with
 * ≤ INLIER_L1_MAX mass — i.e. the gate could rank A over B in a clean run.
 * Identical reference vectors (near-duplicate families) are confusable by
 * construction and are reported as such; the panel presents them as pairs.
 *
 * Everything else the script asserts is a hard property of the shipped
 * constants: every NON-confusable pair must be rejected under EVERY offset,
 * and the true family must always score a perfect cluster. Exit 0 = the
 * threshold set (WRAPPER_TOL / INLIER_MIN / INLIER_L1_MAX) is consistent
 * with the reference table; the printed confusable pairs are the honest
 * resolution limit of the 9-dimension battery.
 */
import { FERTILITY_FAMILIES } from './src/client/fertility.ts'
import { fertilityVerdictOf, INLIER_L1_MAX, INLIER_MIN, WRAPPER_TOL } from './src/client/fertility-score.ts'

const DIMS = 9
/** Offset search span: wider than any observed gateway wrapper spread. */
const OFFSET_MAX = 600

const dimDelta = (family, i) => family.deltas[i]

/** Best case for A against true B over all single offsets: {inliers, mass, offset}. */
function bestWrongCase(a, b) {
  let best = { inliers: -1, mass: Infinity, offset: 0 }
  for (let d = -OFFSET_MAX; d <= OFFSET_MAX; d++) {
    let inliers = 0
    let mass = 0
    for (let i = 0; i < DIMS; i++) {
      const r = dimDelta(b, i) - dimDelta(a, i) - d
      if (Math.abs(r) <= WRAPPER_TOL) {
        inliers += 1
        mass += Math.abs(r)
      }
    }
    // Gate pass: cluster ≥ INLIER_MIN and mass ≤ INLIER_L1_MAX; rank prefers
    // more inliers, then less mass — keep the strongest wrong-case.
    if (inliers > best.inliers || (inliers === best.inliers && mass < best.mass)) {
      best = { inliers, mass, offset: d }
    }
  }
  return best
}

/**
 * End-to-end sanity of the consensus math with synthetic measurements: build
 * P_i = ΔF_i + d for every family F and several constant offsets d, run the
 * SHIPPED fertilityVerdictOf, and require F to rank first with a perfect
 * cluster (inliers = dims, drift only from coverage — never from pollution).
 */
let failed = 0
const fail = (message) => {
  console.error(`FAIL ${message}`)
  failed += 1
}

{
  // Bit-identical vectors are one equivalence class: any member may rank
  // first (the scorer's tiebreak is alphabetical family id).
  const classOf = (family) => FERTILITY_FAMILIES
    .filter(other => other.deltas.every((v, i) => v === family.deltas[i]))
    .map(other => other.id)
  let checked = 0
  for (const family of FERTILITY_FAMILIES) {
    for (const d of [-128, -5, 0, 7, 512]) {
      // T0 is the differencing baseline; deltas[] are the T1..T9 reference
      // deltas relative to it. A synthetic run = reference + constant offset.
      const turns = [
        { probeId: 'T0', status: 'answered', promptTokens: d },
        ...family.deltas.map((delta, i) => ({
          probeId: `T${i + 1}`,
          status: 'answered',
          promptTokens: delta + d,
        })),
      ]
      const verdict = fertilityVerdictOf(turns)
      const top = verdict.candidates[0]
      checked += 1
      if (!classOf(family).includes(top?.family.id)) fail(`synthetic run of ${family.id} @ offset ${d} ranked ${top?.family.id} first`)
      else if (top.inliers !== DIMS || top.inlierL1 !== 0) fail(`synthetic run of ${family.id} @ offset ${d}: imperfect own cluster (${top.inliers}/${DIMS}, mass ${top.inlierL1})`)
      else if (verdict.drift) fail(`synthetic clean run of ${family.id} @ offset ${d} flagged drift`)
    }
  }
  if (failed === 0) console.log(`ok  synthetic runs: true family (or its vector twin) ranks first with a perfect cluster (${checked} runs)`)
}

const identical = []
const confusable = []
const separable = []
for (const a of FERTILITY_FAMILIES) {
  for (const b of FERTILITY_FAMILIES) {
    if (a.id >= b.id) continue
    const exact = a.deltas.every((v, i) => v === b.deltas[i])
    if (exact) {
      identical.push([a, b])
      continue
    }
    const wrong = bestWrongCase(a, b) // a hypothesized while b true
    const symmetric = bestWrongCase(b, a) // b hypothesized while a true
    const worst = wrong.inliers >= symmetric.inliers
      && wrong.mass <= symmetric.mass ? wrong : symmetric
    if (worst.inliers >= INLIER_MIN && worst.mass <= INLIER_L1_MAX) {
      confusable.push({ a, b, inliers: worst.inliers, mass: Math.round(worst.mass * 10) / 10, offset: worst.offset })
    } else {
      separable.push([a, b, worst])
    }
  }
}

console.log(`\nnear-duplicate (bit-identical) reference vectors — always presented as pairs:`)
for (const [a, b] of identical) console.log(`  ${a.id} ≡ ${b.id}  (${a.model} / ${b.model})`)

console.log(`\nconfusable under the constant-offset model (gate could rank the wrong family first):`)
if (confusable.length === 0) console.log('  (none)')
for (const { a, b, inliers, mass, offset } of confusable) {
  console.log(`  ${a.id} vs ${b.id}: ${inliers} inliers @ offset ${offset}, mass ${mass} (≥${INLIER_MIN} & ≤${INLIER_L1_MAX} passes)`)
}

const minInliers = Math.min(...separable.map(([, , w]) => w.inliers))
console.log(`\nseparable pairs: ${separable.length}; strongest wrong-case reaches only ${minInliers} inliers (gate needs ${INLIER_MIN})`)
for (const [a, b, w] of separable) {
  if (w.inliers > minInliers - 2) console.log(`  closest: ${a.id} vs ${b.id} — wrong family best case ${w.inliers} inliers, mass ${Math.round(w.mass * 10) / 10}`)
}

if (failed > 0) process.exit(1)

// --- Guard the hardcoded resolution tables in fertility.ts against drift.
{
  const { FERTILITY_CONFUSABLE, FERTILITY_TWINS } = await import('./src/client/fertility.ts')
  // Twin groups: families whose every dimension is within WRAPPER_TOL of each
  // other (single-linkage over the tolerance relation, seeded by table order).
  const withinTol = (a, b) => a.deltas.every((v, i) => Math.abs(v - b.deltas[i]) <= WRAPPER_TOL)
  const groups = []
  for (const family of FERTILITY_FAMILIES) {
    const group = groups.find(members => withinTol(family, FERTILITY_FAMILIES.find(f => f.id === members[0])))
    if (group === undefined) groups.push([family.id])
    else group.push(family.id)
  }
  const twinExpected = new Set(groups.filter(g => g.length > 1).map(g => [...g].sort().join('+')))
  const twinActual = new Set(FERTILITY_TWINS.map(g => [...g].sort().join('+')))
  const confusableExpected = new Set(confusable.map(({ a, b }) => pairKey(a.id, b.id)))
  const confusableActual = new Set(FERTILITY_CONFUSABLE.map(([x, y]) => pairKey(x, y)))
  for (const key of twinExpected) if (!twinActual.has(key)) fail(`FERTILITY_TWINS missing ${key}`)
  for (const key of twinActual) if (!twinExpected.has(key)) fail(`FERTILITY_TWINS has stale ${key}`)
  for (const key of confusableExpected) if (!confusableActual.has(key)) fail(`FERTILITY_CONFUSABLE missing ${key}`)
  for (const key of confusableActual) if (!confusableExpected.has(key)) fail(`FERTILITY_CONFUSABLE has stale ${key}`)
  if (failed === 0) {
    console.log(`ok  fertility.ts resolution tables match the exhaustive analysis (${twinActual.size} twin groups, ${confusableActual.size} confusable pairs)`)
    console.log('    twin groups: ' + [...twinActual].join('  '))
  }
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

if (failed > 0) process.exit(1)
console.log('\nfertility confusion analysis: all properties hold')
