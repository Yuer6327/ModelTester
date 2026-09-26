/**
 * Batch probe-test scoring (pure logic — no host calls, no React).
 *
 * The runner in `apply.ts` drives all selected probes through one fresh
 * session and hands the collected reply texts here. The family scanner reads
 * the vendors' distinctive template tokens (src/client/tokenizers.ts) off the
 * replies — including visible text, where elicited tool-call formats land.
 * Tokens the template-recognition probe lists itself are excluded, so a reply
 * that merely *quotes* them cannot fake a template hit; every other token of
 * each family's set stays scannable.
 *
 * The aggregate combines the passive engine's session report with the probe
 * artifacts into a ranked guess + confidence label. Per the repo's rules this
 * is a hypothesis, not an identity claim: confidence reflects how much
 * independent evidence stacks up, and tier-1 engine leaks remain the only path
 * to a strong verdict.
 */

import type { AttributionReport } from './attribution.ts'
import { VENDORS, type Vendor } from './attribution-signals.ts'
import { PROBES, type ProbeEntry } from './probes.ts'
import { TOKENIZER_FEATURE_SETS } from './tokenizers.ts'

/**
 * Rough token estimate for a probe prompt (the user's provider bills these):
 * CJK/full-width ≈ 1.1 token/char, other scripts ≈ 1/3.6, plus ~24 tokens of
 * chat-template overhead. A heuristic by design — the exact count is the
 * provider's business.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let total = 0
  for (const ch of text) {
    total += 1
    if (/[\u3000-\u9fff\uff00-\uffef\u3040-\u30ff]/u.test(ch)) cjk += 1
  }
  return Math.round(cjk * 1.1 + (total - cjk) / 3.6) + 24
}

/** Tokens the template-recognition probe lists itself — excluded from family scanning. */
export function recognitionListedTokens(): readonly string[] {
  return TOKENIZER_FEATURE_SETS.map(set => set.tokens[0])
}

/** One vendor's template tokens found verbatim in the batch replies. */
export interface FamilyHit {
  readonly vendor: Vendor
  /** Distinct tokens found (deduped, recognition-probe-listed excluded). */
  readonly tokens: readonly string[]
}

/** Scan batch reply text for distinctive vendor template tokens. */
export function familyHitsOf(
  text: string,
  exclude: readonly string[] = recognitionListedTokens(),
): readonly FamilyHit[] {
  const hits: { vendor: Vendor; tokens: string[] }[] = []
  for (const set of TOKENIZER_FEATURE_SETS) {
    const found = new Set<string>()
    for (const token of set.tokens) {
      if (exclude.includes(token)) continue
      if (text.includes(token)) found.add(token)
    }
    if (found.size > 0) hits.push({ vendor: set.vendor, tokens: [...found] })
  }
  return hits
}

/** One vendor's combined batch support. */
export interface BatchCandidate {
  readonly vendor: Vendor
  /** Engine score + probe artifact support. */
  readonly score: number
  /** Tier-1 leak rows fired by the passive engine. */
  readonly tier1: number
  /** Distinct template tokens elicited by the probes. */
  readonly probeTokens: number
}

/** The batch aggregate: a ranked guess with a confidence label. */
export interface BatchGuess {
  readonly vendor: Vendor | null
  readonly confidence: 'none' | 'low' | 'medium' | 'high'
  readonly candidates: readonly BatchCandidate[]
  readonly hits: readonly FamilyHit[]
}

export interface AggregateBatchInput {
  /** The passive engine's report over the batch session (null when empty). */
  readonly engine: AttributionReport | null
  /** Probe-elicited template-token hits over the collected replies. */
  readonly hits: readonly FamilyHit[]
  /** How many probes were answered (display only). */
  readonly answered: number
  readonly total: number
}

/**
 * Combine the engine report and the probe artifacts. Probe tokens weigh 2
 * each (capped at 3 distinct per vendor): they are template-family evidence,
 * one layer below a tier-1 leak. `high` needs a clear lead AND structural
 * support (a tier-1 engine row or ≥2 distinct elicited tokens).
 */
export function aggregateBatch(input: AggregateBatchInput): BatchGuess {
  const scores = new Map<Vendor, { score: number; tier1: number; probeTokens: number }>()
  const bump = (vendor: Vendor, score: number, tier1 = 0, probeTokens = 0): void => {
    const current = scores.get(vendor) ?? { score: 0, tier1: 0, probeTokens: 0 }
    current.score += score
    current.tier1 += tier1
    current.probeTokens += probeTokens
    scores.set(vendor, current)
  }
  for (const candidate of input.engine?.candidates ?? []) {
    bump(candidate.vendor, candidate.score, candidate.tier1)
  }
  for (const hit of input.hits) {
    bump(hit.vendor, Math.min(hit.tokens.length, 3) * 2, 0, hit.tokens.length)
  }
  const candidates = VENDORS
    .map(vendor => ({ vendor, ...(scores.get(vendor) ?? { score: 0, tier1: 0, probeTokens: 0 }) }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.probeTokens - a.probeTokens)
  const top = candidates[0]
  const runnerUp = candidates[1]?.score ?? 0
  const confidence = top === undefined
    ? 'none'
    : top.score >= 8 && top.score >= runnerUp + 4 && (top.tier1 > 0 || top.probeTokens >= 2)
      ? 'high'
      : top.score >= 4 ? 'medium' : 'low'
  return { vendor: top?.vendor ?? null, confidence, candidates, hits: input.hits }
}

/** Probes ordered for the batch checklist: structural canaries first. */
export function orderedProbes(): readonly ProbeEntry[] {
  return [...PROBES].sort((a, b) =>
    b.confidence - a.confidence || estimateTokens(a.prompt) - estimateTokens(b.prompt))
}
