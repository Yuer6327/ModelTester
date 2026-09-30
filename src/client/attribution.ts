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
 *
 * Two guards keep the ranking honest:
 *
 *  - **User-echo suppression** — a token the *user* pasted (probe prompts list
 *    vendor specials verbatim) and that resurfaces in the model's reasoning is
 *    an echo, not a serving-template leak. Any non-probe match whose matched
 *    string also occurs in the session's user/system text is dropped before
 *    counting. Probe-sentinel rows are exempt: their strings live in the
 *    prompt by design.
 *  - **Confidence coefficient** — raw weights are turned into a 0–1
 *    coefficient per candidate: each ledger row contributes a tier-calibrated
 *    probability (tier-1 near-deterministic, tier-3 folklore) scaled by its
 *    table weight and sharpened by occurrences (saturating at 3, like the
 *    score); rows combine by noisy-OR, so independent strong evidence
 *    outranks piles of weak rows and nothing exceeds 1. Candidates are ranked
 *    by the coefficient; `likely` additionally needs tier-1 support and a
 *    clear coefficient lead.
 */

import type { AssistantBlockView, ConversationNodeView, ConversationView } from './conversation.ts'
import {
  ALL_SIGNALS, ATTRIBUTION_VERSION, SCANNED_SIGNALS, VENDORS,
  type AttributionSignal, type EvidenceKind, type EvidenceTier, type SignalId, type Vendor,
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
  /** Calibrated confidence coefficient in [0, 1] (noisy-OR over ledger rows). */
  readonly confidence: number
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

/**
 * Confidence calibration: base probability that a row of the given tier is
 * genuine family evidence, scaled by the row's table weight (weight 6 = the
 * strongest curated rows, 1 = folklore). Deliberately conservative — tier 2
 * peaks at 0.45 and tier 3 (style/probe folklore) stays under 0.12 so piles
 * of weak rows cannot outvote a tier-1 structural leak.
 */
const TIER_CONF_BASE: Readonly<Record<EvidenceTier, number>> = { 1: 0.95, 2: 0.45, 3: 0.12 }
/** Strongest table weight — the denominator of the per-row weight fraction. */
const MAX_SIGNAL_WEIGHT = 6
/** Verdict thresholds on the coefficient (mirrors the old score-based gates). */
const LIKELY_CONFIDENCE = 0.75
const LIKELY_LEAD = 0.2
const POSSIBLE_CONFIDENCE = 0.2

const SIGNAL_BY_ID: ReadonlyMap<string, AttributionSignal> = new Map(ALL_SIGNALS.map(s => [s.id, s]))

/** One node's raw scan result (cached). */
interface NodeScan {
  /** The blocks array the scan was computed from (identity → cache validity). */
  blocks: unknown
  /** Length of the user-echo corpus the scan was filtered against (validity). */
  echoLen: number
  /** True when the prompting turn was itself a token-vocabulary discussion. */
  discussion: boolean
  /** Non-probe signal hits over reasoning text (user-echoes already dropped). */
  hits: { id: SignalId; count: number; samples: string[] }[]
  /** Probe-signal hits over reasoning + visible text. */
  probeHits: { id: SignalId; count: number; samples: string[] }[]
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

/**
 * Count global-regex matches and capture bounded context samples. Matches
 * whose string occurs in `echo` (the session's user/system text) are dropped:
 * a token the user pasted and the model repeats back is not a leak.
 */
function scanRegex(text: string, re: RegExp, samples: string[], sampleCap: number, echo: string): number {
  const matches = text.match(re)
  if (matches === null) return 0
  let count = 0
  for (const m of matches) {
    if (echo !== '' && echo.includes(m)) continue
    count += 1
    if (samples.length >= sampleCap) continue
    const at = text.indexOf(m)
    if (at < 0) continue
    const start = Math.max(0, at - 40)
    const end = Math.min(text.length, at + m.length + 40)
    const snippet = text.slice(start, end).replace(/\s+/gu, ' ').trim()
    if (snippet !== '') samples.push(snippet)
  }
  return count
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

/**
 * Scan one assistant node's blocks for every table row. `echo` is the
 * session's user/system text: non-probe matches whose string appears in it
 * are dropped (user-echo suppression). `discussion` marks a turn whose own
 * prompt listed template tokens (the recognition probe, or a user asking
 * about a token): every template/anomaly match in such a turn's reasoning is
 * vocabulary discussion — including *derived* tokens the model only wrote by
 * analogy (`<|im_start|>` → `<|im_end|>`, `[INST]` → `[/INST]`) — and is
 * dropped wholesale. Probe rows are always exempt: their sentinels are
 * embedded in the prompt by design.
 */
export function scanNode(
  blocks: readonly AssistantBlockView[],
  turn: number,
  ttftMs: number | null,
  echo = '',
  discussion = false,
): NodeScan {
  const reasoning = reasoningText(blocks)
  const visible = visibleText(blocks)
  const hits: NodeScan['hits'] = []
  const probeHits: NodeScan['probeHits'] = []

  // Dirty-token match strings feed the anomaly filter (EDMFunc-like rows are
  // already recorded; the anomaly detectors are for *unrecorded* leaks).
  const recorded = new Set<string>()

  for (const signal of SCANNED_SIGNALS) {
    const isProbe = signal.kind === 'probe'
    const isDiscussion = discussion && (signal.kind === 'template' || signal.kind === 'anomaly')
    if (isDiscussion) continue
    const scope = isProbe ? (reasoning + '\n' + visible) : reasoning
    if (scope === '') continue
    const suppression = isProbe ? '' : echo
    let count = 0
    const samples: string[] = []
    for (const re of signal.match) {
      count += scanRegex(scope, re, samples, 2, suppression)
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
    echoLen: echo.length,
    discussion,
    hits: hits.filter(h => h.count > 0),
    probeHits: probeHits.filter(h => h.count > 0),
    turn,
    ttftMs,
  }
}

/** Cached scan for one node (recomputed when blocks, echo corpus, or discussion state moves). */
function cachedScan(
  key: object,
  blocks: readonly AssistantBlockView[],
  turn: number,
  ttftMs: number | null,
  echo: string,
  discussion: boolean,
  cache: WeakMap<object, NodeScan>,
): NodeScan {
  const cached = cache.get(key)
  if (cached !== undefined && cached.blocks === blocks
    && cached.echoLen === echo.length && cached.discussion === discussion) return cached
  const scan = scanNode(blocks, turn, ttftMs, echo, discussion)
  cache.set(key, scan)
  return scan
}

/** Empty report (no reasoning loaded). */
export function emptyAttribution(): AttributionReport {
  return { verdict: 'none', candidates: [], evidence: [], unattributed: [], turns: [] }
}

/**
 * User-echo corpus: all text carried by non-assistant, non-compaction nodes.
 * Host node shapes differ by kind — user/steering/context nodes carry
 * `content` message parts (`{type:'text',text}`), some kinds carry assistant-
 * style `blocks` — so both are read defensively. A reasoning match that
 * occurs verbatim in this text is an echo of the user side's own words, not
 * an independent leak.
 */
function nodeEchoText(node: ConversationNodeView): string[] {
  const parts: string[] = []
  const pushParts = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const part of list) {
      if (typeof part === 'object' && part !== null) {
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string' && text !== '') parts.push(text)
      }
    }
  }
  pushParts(node.content)
  for (const block of node.blocks ?? []) {
    if (typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts
}

function userEchoOf(snapshot: ConversationView): string {
  const parts: string[] = []
  for (const node of snapshot.nodes) {
    if (node.kind === 'assistant' || node.kind === 'compaction') continue
    parts.push(...nodeEchoText(node))
  }
  return parts.join('\n')
}

/** Combined matcher over every template row — detects vocabulary-discussion prompts. */
const TEMPLATE_PROMPT_RE: RegExp = (() => {
  const sources = SCANNED_SIGNALS
    .filter(signal => signal.kind === 'template')
    .flatMap(signal => signal.match.map(re => re.source))
  return new RegExp(sources.join('|'))
})()

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
 * Attribute the loaded conversation. The gray probe stays a separate surface
 * (the panel shows its verdict as the gray-signal strength line) and is not
 * recomputed here.
 */
export function attributeSession(
  snapshot: ConversationView,
  cache: WeakMap<object, NodeScan> = attributionTurnCacheFor(attributeSession),
): AttributionReport {
  const entries: { key: object; blocks: readonly AssistantBlockView[]; live: boolean; ttftMs: number | null; turn: number; prompt: string }[] = []
  // User/steering prompt text accumulated since the previous assistant node —
  // the prompting turn this assistant output answers.
  let pendingPrompt: string[] = []
  for (const node of snapshot.nodes) {
    if (node.kind === 'assistant') {
      const { turn, ttftMs } = readTtft(node)
      entries.push({ key: node, blocks: node.blocks ?? [], live: false, ttftMs, turn, prompt: pendingPrompt.join('\n') })
      pendingPrompt = []
      continue
    }
    if (node.kind === 'compaction') { pendingPrompt = []; continue }
    pendingPrompt.push(...nodeEchoText(node))
  }
  if (snapshot.partial !== null) {
    const { turn } = readTtft(snapshot.partial)
    entries.push({ key: snapshot.partial, blocks: snapshot.partial.blocks, live: true, ttftMs: null, turn, prompt: pendingPrompt.join('\n') })
  }
  if (entries.length === 0) return emptyAttribution()

  // User-side text for echo suppression (probe prompts list vendor tokens
  // verbatim — a batch session's reasoning is full of quoted tokens that must
  // not score as leaks).
  const echo = userEchoOf(snapshot)

  // Per-node scans + per-turn rows (first-seen bookkeeping runs in turn order).
  const seen = new Set<string>()
  const turns: TurnAttribution[] = []
  const totals = new Map<SignalId, { count: number; firstTurn: number; samples: string[] }>()

  for (const entry of entries) {
    // A turn prompted with template tokens is a vocabulary discussion: every
    // template/anomaly match in its reasoning (quoted *or* derived by
    // analogy) is discussion, never a serving-layer leak.
    const discussion = entry.prompt !== '' && TEMPLATE_PROMPT_RE.test(entry.prompt)
    const scan = cachedScan(entry.key, entry.blocks, entry.turn, entry.ttftMs, echo, discussion, cache)

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
  evidence.sort((a, b) => {
    const sa = SIGNAL_BY_ID.get(a.id)
    const sb = SIGNAL_BY_ID.get(b.id)
    const wa = sa === undefined ? 0 : weightOf(sa)
    const wb = sb === undefined ? 0 : weightOf(sb)
    return a.tier - b.tier || wb - wa || b.count - a.count
  })
  const ledger = evidence.slice(0, LEDGER_CAP)

  // Candidate scoring.
  const scores = new Map<Vendor, number>()
  const tier1 = new Map<Vendor, number>()
  for (const entry of ledger) {
    const signal = SIGNAL_BY_ID.get(entry.id)
    if (signal === undefined) continue
    for (const [vendor, weight] of Object.entries(signal.vendors) as [Vendor, number][]) {
      scores.set(vendor, (scores.get(vendor) ?? 0) + scoreContribution(signal, vendor, entry.count))
      if (signal.tier === 1) tier1.set(vendor, (tier1.get(vendor) ?? 0) + 1)
    }
  }

  // Confidence coefficient: noisy-OR over the ledger rows supporting each
  // vendor. A row contributes tierBase × (weight/6), sharpened by occurrence
  // count (saturating at 3, mirroring the score's saturation); independent
  // rows multiply their complements, so stacked weak evidence hits diminishing
  // returns while one tier-1 structural leak dominates.
  const rowProbabilities = new Map<Vendor, number[]>()
  for (const entry of ledger) {
    const signal = SIGNAL_BY_ID.get(entry.id)
    if (signal === undefined) continue
    for (const [vendor, weight] of Object.entries(signal.vendors) as [Vendor, number][]) {
      if (weight <= 0) continue
      const p1 = TIER_CONF_BASE[signal.tier] * (weight / MAX_SIGNAL_WEIGHT)
      const p = 1 - (1 - p1) ** Math.min(entry.count, COUNT_SATURATION)
      const rows = rowProbabilities.get(vendor)
      if (rows === undefined) rowProbabilities.set(vendor, [p])
      else rows.push(p)
    }
  }
  const confidenceOf = (vendor: Vendor): number => {
    const rows = rowProbabilities.get(vendor)
    if (rows === undefined) return 0
    return 1 - rows.reduce((product, p) => product * (1 - p), 1)
  }

  const candidates: VendorScore[] = []
  for (const vendor of VENDORS) {
    const score = scores.get(vendor) ?? 0
    if (score <= 0) continue
    candidates.push({ vendor, score, confidence: confidenceOf(vendor), tier1: tier1.get(vendor) ?? 0, verdict: 'none' })
  }
  // Rank by the coefficient first: independent structural evidence outranks
  // accumulated weak support even when the raw scores tie or invert.
  candidates.sort((a, b) => b.confidence - a.confidence || b.score - a.score)

  // Verdict rule: a candidate reaches `likely` only with tier-1 support AND a
  // clear coefficient lead over the runner-up; tier-2/3-only support caps at
  // `possible`.
  const runnerConfidence = candidates.length > 1 ? candidates[1].confidence : 0
  const ranked: VendorScore[] = candidates.map((candidate, index) => ({
    ...candidate,
    verdict: index === 0 && candidate.tier1 > 0
      && candidate.confidence >= LIKELY_CONFIDENCE
      && candidate.confidence >= runnerConfidence + LIKELY_LEAD
      ? 'likely'
      : candidate.confidence >= POSSIBLE_CONFIDENCE
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
  meta: { sessionId: string | undefined },
): Record<string, unknown> {
  return {
    product: 'modeltester',
    attributionVersion: ATTRIBUTION_VERSION,
    sessionId: meta.sessionId,
    exportedAt: new Date().toISOString(),
    verdict: report.verdict,
    candidates: report.candidates,
    evidence: report.evidence,
  }
}
