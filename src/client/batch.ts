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

/**
 * Batch reply text for the family scanner: VISIBLE reply text only, with the
 * template-recognition turn excluded entirely. Reasoning is where a model
 * *discusses* token vocabularies — quoting the probe's list and deriving
 * related tokens by analogy (`[INST]` → `[/INST]`, `<|im_start|>` →
 * `<|im_end|>`) — so reasoning-side matches are discussion, not elicited
 * artifacts; the passive engine owns the reasoning surface with echo
 * suppression. The recognition probe's visible answer describes tokens
 * without repeating them, but it is still the one turn whose text is *about*
 * the token list, so it stays out of the scan.
 */
export function batchScanText(turns: readonly { probeId: string; text: string }[]): string {
  return turns
    .filter(turn => turn.probeId !== 'template' && !turn.probeId.startsWith('fert-'))
    .map(turn => turn.text)
    .join('\n')
}

/** One vendor's combined batch support. */
export interface BatchCandidate {
  readonly vendor: Vendor
  /** Engine score + probe artifact support (evidence mass, tiebreak only). */
  readonly score: number
  /** Combined confidence coefficient in [0, 1] (engine + probe tokens). */
  readonly confidence: number
  /** Tier-1 leak rows fired by the passive engine. */
  readonly tier1: number
  /** Distinct template tokens elicited by the probes. */
  readonly probeTokens: number
}

/** The batch aggregate: a ranked guess with a confidence label. */
export interface BatchGuess {
  readonly vendor: Vendor | null
  readonly confidence: 'none' | 'low' | 'medium' | 'high'
  /** The top candidate's combined coefficient in [0, 1] (display %). */
  readonly confidenceValue: number
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
 * Combine the engine report and the probe artifacts on one confidence scale.
 * The engine's coefficient and the elicited template tokens (each distinct
 * token is a tier-2-strength row, capped at 3 as near-correlated evidence)
 * merge by noisy-OR, so cross-layer agreement compounds while neither layer
 * alone can exceed its ceiling. `high` needs a clear coefficient lead AND
 * structural support (a tier-1 engine row or ≥2 distinct elicited tokens).
 */
export function aggregateBatch(input: AggregateBatchInput): BatchGuess {
  /** Per-distinct-token row strength (template-family artifact, below a tier-1 leak). */
  const TOKEN_ROW_P = 0.25
  const engine = new Map<Vendor, { score: number; confidence: number; tier1: number; probeTokens: number }>()
  const bump = (vendor: Vendor, score: number, tier1 = 0, probeTokens = 0): void => {
    const current = engine.get(vendor) ?? { score: 0, confidence: 0, tier1: 0, probeTokens: 0 }
    current.score += score
    current.tier1 += tier1
    current.probeTokens += probeTokens
    engine.set(vendor, current)
  }
  for (const candidate of input.engine?.candidates ?? []) {
    bump(candidate.vendor, candidate.score, candidate.tier1)
    const current = engine.get(candidate.vendor)!
    // Engine candidates carry their noisy-OR coefficient; reports from older
    // engines without one degrade to 0 (score still breaks ties).
    current.confidence = 1 - (1 - current.confidence) * (1 - (candidate.confidence ?? 0))
  }
  for (const hit of input.hits) {
    bump(hit.vendor, Math.min(hit.tokens.length, 3) * 2, 0, hit.tokens.length)
    const tokens = Math.min(hit.tokens.length, 3)
    const tokenConfidence = 1 - (1 - TOKEN_ROW_P) ** tokens
    const current = engine.get(hit.vendor)!
    current.confidence = 1 - (1 - current.confidence) * (1 - tokenConfidence)
  }
  const candidates: BatchCandidate[] = [...engine.entries()]
    .map(([vendor, v]) => ({ vendor, ...v }))
    .filter(candidate => candidate.score > 0 || candidate.confidence > 0)
    .sort((a, b) =>
      b.confidence - a.confidence || b.score - a.score || b.probeTokens - a.probeTokens
      || VENDORS.indexOf(a.vendor) - VENDORS.indexOf(b.vendor))
  const top = candidates[0]
  const runnerConfidence = candidates[1]?.confidence ?? 0
  const confidence = top === undefined
    ? 'none'
    : top.confidence >= 0.8 && top.confidence >= runnerConfidence + 0.15 && (top.tier1 > 0 || top.probeTokens >= 2)
      ? 'high'
      : top.confidence >= 0.45 ? 'medium' : 'low'
  return {
    vendor: top?.vendor ?? null,
    confidence,
    confidenceValue: top?.confidence ?? 0,
    candidates,
    hits: input.hits,
  }
}

/** Probes ordered for the batch checklist: structural canaries first. */
export function orderedProbes(): readonly ProbeEntry[] {
  return [...PROBES].sort((a, b) =>
    b.confidence - a.confidence || estimateTokens(a.prompt) - estimateTokens(b.prompt))
}

/**
 * Vendor-name keywords for the identity self-report (bait tier). Self-reported
 * identity is recorded so the human can weigh it against structural evidence —
 * stealth models' self-descriptions are frequently bait, and a contradiction
 * with the structural ranking is itself informative.
 */
const IDENTITY_CLAIM_PATTERNS: readonly { readonly vendor: Vendor; readonly re: RegExp }[] = [
  { vendor: 'deepseek', re: /\bdeepseek\b|深度求索/i },
  { vendor: 'anthropic', re: /\banthropic\b|\bclaude\b/i },
  { vendor: 'openai', re: /\bopenai\b|\bgpt-?[45o]/i },
  { vendor: 'zhipu', re: /\bzhipu\b|\bglm\b|智谱|清华/i },
  { vendor: 'moonshot', re: /\bmoonshot\b|\bkimi\b|月之暗面/i },
  { vendor: 'minimax', re: /\bminimax\b|稀宇/i },
  { vendor: 'qwen', re: /\bqwen\b|通义|阿里云/i },
  { vendor: 'google', re: /\bgoogle\b|\bgemini\b|\bgemma\b|谷歌/i },
  { vendor: 'meta', re: /\bmeta\b|\bllama\b/i },
  { vendor: 'mistral', re: /\bmistral\b/i },
  { vendor: 'xai', re: /\bxai\b|\bgrok\b/i },
  { vendor: 'xiaomi', re: /\bmimo\b|小米/i },
  { vendor: 'meituan', re: /\blongcat\b|美团/i },
  { vendor: 'internlm', re: /\binternlm\b|\bintern-s|书生/i },
  { vendor: 'step', re: /\bstepfun\b|\bstep-\d|阶跃/i },
  { vendor: 'yi', re: /\b01\.ai\b|零一万物|\byi-\d/i },
  { vendor: 'nvidia', re: /\bnvidia\b|英伟达|\bnemotron\b/i },
  { vendor: 'ling', re: /\bling\b|蚂蚁/i },
]

/**
 * Vendor families the identity probe's reply claims to belong to (bait tier).
 * @param turns - the batch turns (the 'identity' probe's reply text is read).
 */
export function identityClaimsOf(turns: readonly { probeId: string; text: string }[]): readonly Vendor[] {
  const text = turns
    .filter(turn => turn.probeId === 'identity')
    .map(turn => turn.text)
    .join('\n')
  if (text === '') return []
  const claimed: Vendor[] = []
  for (const { vendor, re } of IDENTITY_CLAIM_PATTERNS) {
    if (re.test(text)) claimed.push(vendor)
  }
  return claimed
}
