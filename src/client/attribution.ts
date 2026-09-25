/**
 * Attribution engine: turns leaked artifacts into a ranked vendor-candidate
 * list with a per-signal evidence ledger.
 *
 * Symmetric to the gray probe (`graytest.ts`): every assistant node is scanned
 * independently (cached by node identity), then a session aggregate ranks
 * vendor families. The engine never claims identity — it reports which
 * *structural fingerprints* fired and how much support each family has:
 *
 *  - tier-1 vendor-directed leaks (antml namespace, `fp_…` strings) can push a
 *    candidate to `likely` when it clearly leads the runner-up;
 *  - tier-2 trajectory/artifact rows cap at `possible`;
 *  - tier-3 folklore/probe rows only ever add support.
 *
 * Unattributed artifacts (unknown dirty tokens, anomaly-detector hits) go to
 * the ledger without a vendor so the community loop can promote them into
 * table rows. All scanning is passive: reasoning text plus, for probe
 * sentinels only, visible text.
 */

import type { AssistantBlockView, ConversationView } from './conversation.ts'
import type { GrayProbe } from './graytest.ts'
import {
  ALL_SIGNALS, ATTRIBUTION_VERSION, DERIVED_SIGNALS, SCANNED_SIGNALS, VENDORS, derivedHits,
  type AttributionSignal, type EvidenceKind, type EvidenceTier, type SignalId, type TrajectoryInput, type Vendor,
} from './attribution-signals.ts'

/** Re-exported table version (single source: attribution-signals.ts). */
export { ATTRIBUTION_VERSION }

/** Session-level attribution verdict (same wording family as the gray probe). */
export type AttributionVerdict = 'none' | 'possible' | 'likely'

/** One signal's accumulated evidence across the loaded conversation. */
export interface AttributionEvidence {
  /** Signal id (or derived-row id). */
  readonly id: SignalId
  readonly kind: EvidenceKind
  readonly tier: EvidenceTier
  /** Vendor this evidence supports; null for unattributed artifacts. */
  readonly vendor: Vendor | null
  /** Total match occurrences (matcher-summed; derived rows fire once). */
  readonly count: number
  /** Turn number the evidence first appeared in; −1 for derived/session rows. */
  readonly firstTurn: number
  /** Up to three context snippets (±40 chars). */
  readonly samples: readonly string[]
}

/** One vendor family's aggregated support. */
export interface VendorScore {
  readonly vendor: Vendor
  /** Summed support weight (dirty-token/leak counts saturate at 3). */
  readonly score: number
  /** How many distinct tier-1 rows fired for this vendor. */
  readonly tier1: number
  readonly verdict: AttributionVerdict
}

/** Per-turn attribution summary row. */
export interface TurnAttribution {
  /** Turn number, or −1 when unknown. */
  readonly turn: number
  /** True for the in-flight partial. */
  readonly live: boolean
  /** Best-supported vendor from this turn's own hits; null when none fired. */
  readonly top: Vendor | null
  /** Signal ids first seen in this turn (new dirty tokens / leaks / anomalies). */
  readonly newTokens: readonly string[]
  /** Host TTFT for the turn; null without timing. */
  readonly ttftMs: number | null
}

/** Session attribution report consumed by the panel. */
export interface AttributionReport {
  readonly verdict: AttributionVerdict
  /** Positive-score candidates, best first. */
  readonly candidates: readonly VendorScore[]
  /** Evidence ledger, strongest first, capped at 40 entries. */
  readonly evidence: readonly AttributionEvidence[]
  /** Ledger subset without a vendor assignment (community-report queue). */
  readonly unattributed: readonly AttributionEvidence[]
  /** Per-turn rows, oldest first; the last may be the live partial. */
  readonly turns: readonly TurnAttribution[]
}

const LEDGER_CAP = 40
/** Support saturation: repeated occurrences of one artifact stop counting past 3. */
const COUNT_SATURATION = 3

const SIGNAL_BY_ID: ReadonlyMap<string, AttributionSignal> = new Map(ALL_SIGNALS.map(s => [s.id, s]))

/** One node's raw scan result (cached). */
interface NodeScan {
  /** The blocks array the scan was computed from (identity → cache validity). */
  blocks: unknown
  /** Non-probe signal hits over reasoning text. */
  hits: { id: SignalId; count: number; samples: string[] }[]
  /** Probe-signal hits over reasoning + visible text. */
  probeHits: { id: SignalId; count: number; samples: string[] }[]
  /** Em-dash occurrences in reasoning (for the density-derived style row). */
  emDash: number
  /** Reasoning characters scanned. */
  chars: number
  turn: number
  ttftMs: number | null
}

const caches: WeakMap<object, WeakMap<object, NodeScan>> = new WeakMap()

/** Per-session scan memoization (keyed by assistant node identity). */
export function attributionTurnCacheFor(owner: object): WeakMap<object, NodeScan> {
  let cache = caches.get(owner)
  if (cache === undefined) {
    cache = new WeakMap()
    caches.set(owner, cache)
  }
  return cache
}

/** Count global-regex matches and capture bounded context samples. */
function scanRegex(text: string, re: RegExp, samples: string[], sampleCap: number): number {
  const matches = text.match(re)
  if (matches === null) return 0
  for (const m of matches) {
    if (samples.length >= sampleCap) break
    const at = text.indexOf(m)
    if (at < 0) continue
    const start = Math.max(0, at - 40)
    const end = Math.min(text.length, at + m.length + 40)
    const snippet = text.slice(start, end).replace(/\s+/gu, ' ').trim()
    if (snippet !== '') samples.push(snippet)
  }
  return matches.length
}

function readTtft(node: object): { turn: number; ttftMs: number | null } {
  const t = (node as { timing?: unknown }).timing
  const stepStart = typeof t === 'object' && t !== null
    && typeof (t as { stepStartTime?: unknown }).stepStartTime === 'number'
    ? (t as { stepStartTime: number }).stepStartTime
    : null
  const firstToken = typeof t === 'object' && t !== null
    && typeof (t as { firstTokenTime?: unknown }).firstTokenTime === 'number'
    ? (t as { firstTokenTime: number }).firstTokenTime
    : null
  const turnNo = typeof (node as { turn?: unknown }).turn === 'number'
    ? (node as { turn: number }).turn
    : -1
  return { turn: turnNo, ttftMs: stepStart !== null && firstToken !== null ? firstToken - stepStart : null }
}

function reasoningText(blocks: readonly AssistantBlockView[]): string {
  return blocks
    .filter(b => b.kind === 'reasoning' && typeof b.text === 'string' && b.text !== '')
    .map(b => b.text as string)
    .join('\n')
}

function visibleText(blocks: readonly AssistantBlockView[]): string {
  return blocks
    .filter(b => b.kind === 'text' && typeof b.text === 'string' && b.text !== '')
    .map(b => b.text as string)
    .join('\n')
}

/** Scan one assistant node's blocks for every table row. */
export function scanNode(blocks: readonly AssistantBlockView[], turn: number, ttftMs: number | null): NodeScan {
  const reasoning = reasoningText(blocks)
  const visible = visibleText(blocks)
  const hits: NodeScan['hits'] = []
  const probeHits: NodeScan['probeHits'] = []

  // Dirty-token match strings feed the anomaly filter (EDMFunc-like rows are
  // already recorded; the anomaly detectors are for *unrecorded* leaks).
  const recorded = new Set<string>()

  for (const signal of SCANNED_SIGNALS) {
    const isProbe = signal.kind === 'probe'
    const scope = isProbe ? (reasoning + '\n' + visible) : reasoning
    if (scope === '') continue
    let count = 0
    const samples: string[] = []
    for (const re of signal.match) {
      count += scanRegex(scope, re, samples, 2)
    }
    if (count === 0) continue
    if (signal.kind === 'dirty-token') {
      for (const re of signal.match) {
        for (const m of scope.match(re) ?? []) recorded.add(m)
      }
    }
    ;(isProbe ? probeHits : hits).push({ id: signal.id, count, samples })
  }

  // Anomaly hits that duplicate a recorded dirty token are dropped.
  for (const hit of hits) {
    const signal = SIGNAL_BY_ID.get(hit.id)
    if (signal?.kind !== 'anomaly') continue
    for (const re of signal.match) {
      for (const m of reasoning.match(re) ?? []) {
        if (recorded.has(m)) hit.count = Math.max(0, hit.count - 1)
      }
    }
  }

  return {
    blocks,
    hits: hits.filter(h => h.count > 0),
    probeHits: probeHits.filter(h => h.count > 0),
    emDash: (reasoning.match(/—/gu) ?? []).length,
    chars: reasoning.length,
    turn,
    ttftMs,
  }
}

/** Cached scan for one node (recomputed when the blocks array identity moves). */
function cachedScan(
  key: object,
  blocks: readonly AssistantBlockView[],
  turn: number,
  ttftMs: number | null,
  cache: WeakMap<object, NodeScan>,
): NodeScan {
  const cached = cache.get(key)
  if (cached !== undefined && cached.blocks === blocks) return cached
  const scan = scanNode(blocks, turn, ttftMs)
  cache.set(key, scan)
  return scan
}

/** Empty report (no reasoning loaded). */
export function emptyAttribution(): AttributionReport {
  return { verdict: 'none', candidates: [], evidence: [], unattributed: [], turns: [] }
}

function weightOf(signal: AttributionSignal): number {
  const values = Object.values(signal.vendors)
  return values.length > 0 ? Math.max(...values) : 0
}

function scoreContribution(signal: AttributionSignal, vendor: Vendor, count: number): number {
  const weight = signal.vendors[vendor] ?? 0
  if (weight === 0) return 0
  return signal.kind === 'dirty-token' || signal.kind === 'leak'
    ? weight * Math.min(count, COUNT_SATURATION)
    : weight
}

/**
 * Attribute the loaded conversation. `traj` carries the counting engine's
 * totals for the derived trajectory/style rows; the gray probe stays a
 * separate surface (the panel shows its verdict as the gray-signal strength
 * line) and is not recomputed here.
 */
export function attributeSession(
  snapshot: ConversationView,
  traj: TrajectoryInput,
  cache: WeakMap<object, NodeScan> = attributionTurnCacheFor(attributeSession),
): AttributionReport {
  const entries: { key: object; blocks: readonly AssistantBlockView[]; live: boolean; ttftMs: number | null; turn: number }[] = []
  for (const node of snapshot.nodes) {
    if (node.kind !== 'assistant') continue
    const { turn, ttftMs } = readTtft(node)
    entries.push({ key: node, blocks: node.blocks ?? [], live: false, ttftMs, turn })
  }
  if (snapshot.partial !== null) {
    const { turn } = readTtft(snapshot.partial)
    entries.push({ key: snapshot.partial, blocks: snapshot.partial.blocks, live: true, ttftMs: null, turn })
  }
  if (entries.length === 0) return emptyAttribution()

  // Per-node scans + per-turn rows (first-seen bookkeeping runs in turn order).
  const seen = new Set<string>()
  const turns: TurnAttribution[] = []
  const totals = new Map<SignalId, { count: number; firstTurn: number; samples: string[] }>()
  let emDash = 0
  let chars = 0

  for (const entry of entries) {
    const scan = cachedScan(entry.key, entry.blocks, entry.turn, entry.ttftMs, cache)
    emDash += scan.emDash
    chars += scan.chars

    const turnHits = [...scan.hits, ...scan.probeHits]
    const turnScores = new Map<Vendor, number>()
    for (const hit of turnHits) {
      const signal = SIGNAL_BY_ID.get(hit.id)
      if (signal === undefined) continue
      // Session ledger.
      const total = totals.get(hit.id)
      if (total === undefined) {
        totals.set(hit.id, { count: hit.count, firstTurn: entry.turn, samples: [...hit.samples] })
      } else {
        total.count += hit.count
        for (const sample of hit.samples) {
          if (total.samples.length < 3 && !total.samples.includes(sample)) total.samples.push(sample)
        }
      }
      // Per-turn support.
      for (const [vendor, weight] of Object.entries(signal.vendors) as [Vendor, number][]) {
        const contribution = signal.kind === 'dirty-token' || signal.kind === 'leak'
          ? weight * Math.min(hit.count, COUNT_SATURATION)
          : weight
        turnScores.set(vendor, (turnScores.get(vendor) ?? 0) + contribution)
      }
    }

    const newTokens = turnHits.map(h => h.id).filter(id => !seen.has(id))
    for (const id of turnHits.map(h => h.id)) seen.add(id)
    let top: Vendor | null = null
    let topScore = 0
    for (const [vendor, score] of turnScores) {
      if (score > topScore) { top = vendor; topScore = score }
    }
    turns.push({ turn: entry.turn, live: entry.live, top, newTokens, ttftMs: entry.ttftMs })
  }

  // Derived rows (trajectory vocabulary, em-dash density) from session totals.
  const derived = derivedHits(traj, emDash, chars)

  // Ledger assembly.
  const evidence: AttributionEvidence[] = []
  for (const [id, total] of totals) {
    const signal = SIGNAL_BY_ID.get(id)
    if (signal === undefined) continue
    const vendor = (Object.keys(signal.vendors) as Vendor[])[0] ?? null
    evidence.push({
      id,
      kind: signal.kind,
      tier: signal.tier,
      vendor,
      count: total.count,
      firstTurn: total.firstTurn,
      samples: total.samples,
    })
  }
  for (const { id, count } of derived) {
    const signal = DERIVED_SIGNALS[id]
    const vendor = (Object.keys(signal.vendors) as Vendor[])[0] ?? null
    evidence.push({
      id,
      kind: signal.kind,
      tier: signal.tier,
      vendor,
      count,
      firstTurn: -1,
      samples: [],
    })
  }
  evidence.sort((a, b) => {
    const sa = SIGNAL_BY_ID.get(a.id) ?? DERIVED_SIGNALS[a.id as keyof typeof DERIVED_SIGNALS]
    const sb = SIGNAL_BY_ID.get(b.id) ?? DERIVED_SIGNALS[b.id as keyof typeof DERIVED_SIGNALS]
    const wa = sa === undefined ? 0 : weightOf(sa)
    const wb = sb === undefined ? 0 : weightOf(sb)
    return a.tier - b.tier || wb - wa || b.count - a.count
  })
  const ledger = evidence.slice(0, LEDGER_CAP)

  // Candidate scoring.
  const scores = new Map<Vendor, number>()
  const tier1 = new Map<Vendor, number>()
  for (const entry of ledger) {
    const signal = SIGNAL_BY_ID.get(entry.id) ?? DERIVED_SIGNALS[entry.id as keyof typeof DERIVED_SIGNALS]
    if (signal === undefined) continue
    for (const [vendor, weight] of Object.entries(signal.vendors) as [Vendor, number][]) {
      scores.set(vendor, (scores.get(vendor) ?? 0) + scoreContribution(signal, vendor, entry.count))
      if (signal.tier === 1) tier1.set(vendor, (tier1.get(vendor) ?? 0) + 1)
    }
  }

  const candidates: VendorScore[] = []
  for (const vendor of VENDORS) {
    const score = scores.get(vendor) ?? 0
    if (score <= 0) continue
    candidates.push({ vendor, score, tier1: tier1.get(vendor) ?? 0, verdict: 'none' })
  }
  candidates.sort((a, b) => b.score - a.score)

  // Verdict rule: a candidate reaches `likely` only with tier-1 support AND a
  // clear lead over the runner-up; tier-2/3-only support caps at `possible`.
  const runnerUp = candidates.length > 1 ? candidates[1].score : 0
  const ranked: VendorScore[] = candidates.map((candidate, index) => ({
    ...candidate,
    verdict: index === 0 && candidate.tier1 > 0 && candidate.score >= 3 && candidate.score >= runnerUp + 2
      ? 'likely'
      : candidate.score >= 3
        ? 'possible'
        : 'none',
  }))

  return {
    verdict: ranked.length > 0 ? ranked[0].verdict : 'none',
    candidates: ranked,
    evidence: ledger,
    unattributed: ledger.filter(e => e.vendor === null),
    turns,
  }
}

/** Build the clipboard evidence pack (pure data — no network). */
export function evidencePack(
  report: AttributionReport,
  meta: { sessionId: string | undefined; gray: GrayProbe },
): Record<string, unknown> {
  return {
    product: 'modeltester',
    attributionVersion: ATTRIBUTION_VERSION,
    sessionId: meta.sessionId,
    exportedAt: new Date().toISOString(),
    verdict: report.verdict,
    candidates: report.candidates,
    evidence: report.evidence,
    gray: {
      verdict: meta.gray.verdict,
      profile: meta.gray.profile,
      imDoing: meta.gray.imDoing,
      dirtyTokens: meta.gray.dirtyTokens,
      fingerprints: meta.gray.fingerprints,
    },
  }
}
