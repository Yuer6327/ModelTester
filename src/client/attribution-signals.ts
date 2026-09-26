/**
 * Versioned attribution signal table: which output fingerprints point at
 * which vendor family.
 *
 * This is the data core of the attribution view. Every row is a *structural*
 * fingerprint (a leaked artifact, a trajectory vocabulary, a probe canary) —
 * never an identity claim. Community-attested artifacts start as tier-1/2
 * rows; folklore style markers stay tier-3; anything unrecorded is caught by
 * the generic anomaly detectors so a new dirty token surfaces as evidence
 * before it becomes a table row.
 *
 * Weights are deliberately small integers and only ever *support* a candidate:
 *   - tier 1 — vendor-directed infrastructure leaks (near-deterministic);
 *   - tier 2 — trajectory / unattributed-but-attested artifacts;
 *   - tier 3 — folklore style markers and probe echoes (manual judgement).
 * A candidate only reaches `likely` through a tier-1 row (see `attribution.ts`).
 *
 * Adding a community report is a one-row edit here; bump ATTRIBUTION_VERSION.
 */

import { PATTERNS } from './keywords.ts'
import type { WordCounts } from './stats.ts'
import type { PatternCounts } from './stats.ts'

/** Community-attested dirty tokens leaking into reasoning (case-insensitive substring). */
const DIRTY_PATTERNS: readonly { id: string; pattern: RegExp }[] = [
  { id: 'Nameeee', pattern: /\bNameeee\b/ },
  { id: 'antml:thinking', pattern: /antml:thinking/i },
  { id: '<antml', pattern: /<\/?antml\b/i },
  { id: 'EDMFunc', pattern: /\bEDMFunc\b/ },
  { id: 'everydaycalculation', pattern: /\beverydaycalculation\b/i },
]

/** Version of the attribution table and scoring rules. */
export const ATTRIBUTION_VERSION = 7 as const

/** Vendor families the evidence table can support. */
export type Vendor =
  | 'deepseek' | 'anthropic' | 'openai' | 'google' | 'qwen' | 'zhipu' | 'moonshot' | 'minimax'
  | 'xiaomi' | 'meituan' | 'internlm' | 'step' | 'yi' | 'meta' | 'mistral' | 'nvidia' | 'xai' | 'ling'

/** Stable union of every signal id (scanned + derived) — also the locale key suffix. */
export type SignalId =
  | 'antml-ns' | 'fp-v4pro' | 'fp-generic' | 'edm-func' | 'everyday-calc' | 'nameeee'
  | 'style-delve' | 'anom-ns-tag' | 'anom-hex' | 'anom-ident' | 'anom-repeat'
  | 'probe-glitch-r50k' | 'probe-glitch-cl100k' | 'probe-echo' | 'probe-cutoff' | 'probe-count'
  | 'probe-toolfmt' | 'probe-refusal' | 'probe-ctxwin' | 'probe-identity' | 'probe-sysprompt'
  | 'tmpl-minimax' | 'tmpl-kimi' | 'tmpl-glm' | 'tmpl-glm-roles' | 'tmpl-deepseek' | 'tmpl-llama' | 'tmpl-mistral-tools'
  | 'tmpl-inst' | 'tmpl-chatml' | 'tmpl-qwen' | 'tmpl-gemma' | 'tmpl-ling'
  | 'tmpl-xiaomi' | 'tmpl-meituan' | 'tmpl-internlm' | 'tmpl-step' | 'tmpl-yi'
  | 'traj-minimal' | 'traj-standard' | 'style-emdash'

/** Display order (also the tiebreak for equal scores). */
export const VENDORS: readonly Vendor[] = [
  'deepseek', 'anthropic', 'openai', 'google', 'qwen', 'zhipu', 'moonshot', 'minimax',
  'xiaomi', 'meituan', 'internlm', 'step', 'yi', 'meta', 'mistral', 'nvidia', 'xai', 'ling',
]

/** Evidence strength class. */
export type EvidenceTier = 1 | 2 | 3

/** What kind of output surface the evidence came from. */
export type EvidenceKind = 'dirty-token' | 'leak' | 'template' | 'trajectory' | 'style' | 'probe' | 'anomaly'

/** One countable fingerprint → vendor mapping. */
export interface AttributionSignal {
  /** Stable id (locale key suffix + ledger key). */
  readonly id: SignalId
  readonly kind: EvidenceKind
  readonly tier: EvidenceTier
  /**
   * Global regexes over reasoning text (probe rows also run over visible
   * text). Counts are summed across matchers. Empty for *derived* rows
   * (`trajectory` density rules) that the engine computes from the counting
   * engine's totals.
   */
  readonly match: readonly RegExp[]
  /** Support weight per vendor candidate; empty = unattributed artifact. */
  readonly vendors: Partial<Record<Vendor, number>>
  /** Short research note (tooltip). */
  readonly rationale: string
}

/** Sentinel embedded in the echo battery prompt; seeing it means the probe was answered. */
export const PROBE_ECHO_SENTINEL = 'MT-ECHO-7f3a9c'
/** Sentinel for the knowledge-cutoff probe. */
export const PROBE_CUTOFF_SENTINEL = 'MT-CUTOFF-2468ace'
/** Sentinel for the letter-count probe. */
export const PROBE_COUNT_SENTINEL = 'MT-CNT-ttstrawberryberry-2468'
/** Sentinel line of the glitch-token battery. */
export const PROBE_GLITCH_SENTINEL = 'MT-GLITCH-BATTERY-0813'
/** Sentinel for the tool-call format elicitation probe. */
export const PROBE_TOOLFMT_SENTINEL = 'MT-TOOLFMT-4e8a21'
/** Sentinel for the refusal-shape battery. */
export const PROBE_REFUSAL_SENTINEL = 'MT-REFUSAL-71c93b'
/** Sentinel for the context-window self-report probe. */
export const PROBE_CONTEXT_SENTINEL = 'MT-CTXWIN-a1f86d'
/** Sentinel for the identity grid probe. */
export const PROBE_IDENTITY_SENTINEL = 'MT-IDENT-58b2c4'
/** Sentinel for the system-prompt extraction probe. */
export const PROBE_SYS_PROMPT_SENTINEL = 'MT-SYSPRM-3c9e77'

/** Clone a pattern with the global flag for match counting. */
function globalize(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
}

/** Vendor mapping for the community dirty tokens (gray-signals is the pattern source). */
const DIRTY_ATTRIBUTION: Readonly<Record<string, {
  id: SignalId
  tier: EvidenceTier
  vendors: Partial<Record<Vendor, number>>
  rationale: string
}>> = {
  'antml:thinking': {
    id: 'antml-ns',
    tier: 1,
    vendors: { anthropic: 6 },
    rationale: 'Anthropic tool-use XML namespace (antml) leaked into reasoning — community-attested gray artifact.',
  },
  '<antml': {
    id: 'antml-ns',
    tier: 1,
    vendors: { anthropic: 6 },
    rationale: 'Anthropic tool-use XML namespace (antml) leaked into reasoning — community-attested gray artifact.',
  },
  EDMFunc: {
    id: 'edm-func',
    tier: 2,
    vendors: {},
    rationale: 'Community-attested backend marker; vendor not yet established.',
  },
  everydaycalculation: {
    id: 'everyday-calc',
    tier: 2,
    vendors: {},
    rationale: 'Community-attested backend marker; vendor not yet established.',
  },
  Nameeee: {
    id: 'nameeee',
    tier: 2,
    vendors: {},
    rationale: 'Degenerate repetition artifact; vendor unknown.',
  },
}

/** Regex-table rows for the community dirty tokens, merged by attribution id. */
const dirtySignals: AttributionSignal[] = (() => {
  const byId = new Map<string, { match: RegExp[]; row: (typeof DIRTY_ATTRIBUTION)[string] }>()
  for (const token of DIRTY_PATTERNS) {
    const row = DIRTY_ATTRIBUTION[token.id]
    if (row === undefined) continue
    const existing = byId.get(row.id)
    if (existing === undefined) {
      byId.set(row.id, { match: [globalize(token.pattern)], row })
    } else {
      existing.match.push(globalize(token.pattern))
    }
  }
  return [...byId.values()].map(({ match, row }) => ({
    id: row.id,
    kind: 'dirty-token',
    tier: row.tier,
    match,
    vendors: row.vendors,
    rationale: row.rationale,
  }))
})()

/** Vendor-directed leak rows (own patterns; the gray probe keeps its combined FINGERPRINT_RE). */
const leakSignals: readonly AttributionSignal[] = [
  {
    id: 'fp-v4pro',
    kind: 'leak',
    tier: 1,
    match: [/\bfp_v4pro_[a-zA-Z0-9][a-zA-Z0-9_\-]{2,}\b/g],
    vendors: { deepseek: 5 },
    rationale: 'fp_v4pro_… deployment strings name DeepSeek\'s own V4 Pro backend (community-observed, e.g. fp_v4pro_20260812_prod).',
  },
  {
    id: 'fp-generic',
    kind: 'leak',
    tier: 1,
    match: [/\bfp_(?!v4pro_)[a-zA-Z0-9][a-zA-Z0-9_\-]{3,}\b/g],
    vendors: { openai: 4 },
    rationale: 'fp_… strings match OpenAI-style API fingerprint identifiers.',
  },
]

/** Generic anomaly detectors — unrecorded leaks surface here before they become rows. */
const anomalySignals: readonly AttributionSignal[] = [
  {
    id: 'anom-ns-tag',
    kind: 'anomaly',
    tier: 2,
    match: [/<\/?(?!antml\b)[a-z][a-z0-9]*:[a-z][\w-]*>/gi],
    vendors: {},
    rationale: 'Non-standard namespaced XML tag — unrecorded scaffold leak; copy it to the community.',
  },
  {
    id: 'anom-hex',
    kind: 'anomaly',
    tier: 2,
    match: [/\b[a-f0-9]{16,64}\b/gi],
    vendors: {},
    rationale: 'Long hex run — possible backend hash/id leak.',
  },
  {
    id: 'anom-ident',
    kind: 'anomaly',
    tier: 2,
    match: [/\b[A-Z][A-Za-z0-9]{2,}(?:Func|Invoke|ToolCall|Schema)\b/g],
    vendors: {},
    rationale: 'CamelCase backend identifier (EDMFunc-like) not in the recorded table.',
  },
  {
    id: 'anom-repeat',
    kind: 'anomaly',
    tier: 2,
    match: [/(\b\w{2,12}\b)(?:[\s,、，]+\1){3,}/gi],
    vendors: {},
    rationale: 'Degenerate repetition run — glitch-like behavior.',
  },
]

/**
 * Chat-template leak rows. A special token from the serving template leaking
 * into reasoning is near-deterministic evidence of the template family (the
 * same class of artifact as antml). Sources: the vendors' official
 * `chat_template.jinja` files and the template-leak literature. Scanned over
 * reasoning only — an answer *quoting* a token (e.g. the recognition probe's
 * reply) must not fire the row.
 */
const templateSignals: readonly AttributionSignal[] = [
  {
    id: 'tmpl-minimax',
    kind: 'template',
    tier: 1,
    match: [/<mm:think>/g, /<\/mm:think>/g, /\]<\](?:image|video|speech|frame|minimax|vision pad|start of image|start of video|start of speech|start of frame|end of image|end of video|end of speech|end of frame)\[>\[/g, /<\|content_altered_placeholder\|>/g, /\]!p~\[/g, /\[e~\[/g, /\]~b\]/g, /\]!d~\[/g, /\]~!b\[/g],
    vendors: { minimax: 6 },
    rationale: 'MiniMax-M3 template tokens from the official tokenizer_config.json (re-captured 2026-09-26): the <mm:think> vendor namespace, the bizarre ]<]…[>[ / ]!p~[ bracket-fusion tokens, and <|content_altered_placeholder|>. (M2.7 carries <minimax:tool_call> again; M3 dropped it.)',
  },
  {
    id: 'tmpl-kimi',
    kind: 'template',
    tier: 1,
    match: [/<\|end_of_msg\|>/g, /<\|open\|>/g, /<\|close\|>/g, /<\|sep\|>/g, /\[start_header_id\]/g, /\[end_header_id\]/g, /<osagent_mode>/g, /<\|media_begin\|>/g, /<\|media_content\|>/g, /<\|media_end\|>/g, /<\|media_pad\|>/g],
    vendors: { moonshot: 6 },
    rationale: 'Kimi-K3 template tokens from the official tokenizer_config.json (re-captured 2026-09-26) — K3 replaced the entire K2 im_* family with end_of_msg / open / close / sep / bracket start_header_id / osagent_mode. K3\'s tokenizer itself is tiktoken-format (no tokenizer.json).',
  },
  {
    id: 'tmpl-glm',
    kind: 'template',
    tier: 1,
    match: [/<sop>/g, /<\|observation\|>/g, /<arg_key>/g, /<\/arg_key>/g, /<\|reminder\|>/g],
    vendors: { zhipu: 6 },
    rationale: 'GLM-5.3 template tokens from the official chat_template.jinja (captured 2026-09-26): <sop> (start-of-prompt) is new with GLM-5; <|observation|> and <arg_key> carry over from the GLM-4.x toolbox style; <|reminder|> is 5.x-new.',
  },
  {
    id: 'tmpl-glm-roles',
    kind: 'template',
    tier: 2,
    match: [/<\|system\|>/g, /<\|user\|>/g, /<\|assistant\|>/g],
    vendors: { zhipu: 2 },
    rationale: 'GLM role triple — present in GLM-5.3 but shared with the older Vicuna-style template heritage, so support-only.',
  },
  {
    id: 'tmpl-deepseek',
    kind: 'template',
    tier: 2,
    match: [/<｜begin▁of▁sentence｜>/g, /<｜end▁of▁sentence｜>/g, /<｜Assistant｜>/g, /<｜User｜>/g, /<｜tool▁calls▁begin｜>/g],
    vendors: { deepseek: 3, step: 3 },
    rationale: 'Full-width ｜ (U+FF5C) + ▁ (U+2581) template frame — unmistakable lineage, but NOT DeepSeek-exclusive anymore: StepFun\'s Step-3.5 tokenizer clones the whole frame (captured 2026-09-26). Shared support for both; the vocab-size pair (129280 vs 128896) and Step-unique tokens separate them.',
  },
  {
    id: 'tmpl-step',
    kind: 'template',
    tier: 1,
    match: [/<\|EOT\|>/g, /<｜▁pad▁｜>/g, /<｜fim▁begin｜>/g, /<｜place▁holder▁no▁\d+｜>/g],
    vendors: { step: 6 },
    rationale: 'Step-3.5-Flash-unique tokens (captured 2026-09-26): ASCII <|EOT|> plus the full-width pad / fim / numbered place-holder tokens DeepSeek does not have — separates Step from the DeepSeek-style full-width frame it otherwise clones.',
  },
  {
    id: 'tmpl-chatml',
    kind: 'template',
    tier: 2,
    match: [/<\|im_start\|>/g, /<\|im_end\|>/g],
    vendors: { qwen: 2, yi: 2 },
    rationale: 'ChatML <|im_start|>/<|im_end|> frame — shared by Qwen and Yi (and their derivatives), so support-only for both.',
  },
  {
    id: 'tmpl-qwen',
    kind: 'template',
    tier: 1,
    match: [/<tts_text_bos>/g, /<tts_text_eod>/g, /<tts_text_bos_single>/g, /<\|object_ref_start\|>/g, /<\|quad_start\|>/g, /<\|vision_start\|>/g, /<\|box_start\|>/g],
    vendors: { qwen: 6 },
    rationale: 'Qwen-unique tokens: the Qwen3.8 TTS control tokens (<tts_text_*>, captured 2026-09-26, vocab grew to 248320) plus the Qwen3-era object_ref/quad/vision/box controls for older checkpoints. Note <|audio_pad|> is shared with MiMo and scores nowhere.',
  },
  {
    id: 'tmpl-yi',
    kind: 'template',
    tier: 1,
    match: [/<\|im_sep\|>/g, /<\|startoftext\|>/g],
    vendors: { yi: 5 },
    rationale: 'Yi-34B-Chat tokens (official tokenizer_config): <|im_sep|> is Yi-unique in the ChatML family; <|startoftext|> also appeared in Ling-1T-era configs, so weight 5 not 6.',
  },
  {
    id: 'tmpl-xiaomi',
    kind: 'template',
    tier: 1,
    match: [/<\|mimo_video_start\|>/g, /<\|mimo_video_end\|>/g, /<\|mimo_audio_start\|>/g, /<\|mimo_audio_eod\|>/g, /<\|mimo_audio_end\|>/g],
    vendors: { xiaomi: 6 },
    rationale: 'MiMo-V2.6 vendor namespace (<|mimo_video_*|> / <|mimo_audio_*|>, captured 2026-09-26) — a Qwen-derived tokenizer with an unmistakable mimo_* special-token block.',
  },
  {
    id: 'tmpl-meituan',
    kind: 'template',
    tier: 1,
    match: [/<longcat_think>/g, /<\/longcat_think>/g, /<longcat_tool_call>/g, /<longcat_arg_key>/g, /<longcat_observation>/g, /<longcat_files>/g],
    vendors: { meituan: 6 },
    rationale: 'LongCat vendor namespace (<longcat_*> from the official LongCat-Flash-Lite-Sparse chat template, captured 2026-09-26) — a complete in-template XML dialect no other family uses.',
  },
  {
    id: 'tmpl-internlm',
    kind: 'template',
    tier: 1,
    match: [/<SMILES>/g, /<\/SMILES>/g, /<protein>/g, /<dna>/g, /<rna>/g, /<\|ts\|>/g, /<\|plugin\|>/g, /<\|interpreter\|>/g],
    vendors: { internlm: 6 },
    rationale: 'Intern-S1-Pro scientific-domain tokens (SMILES / protein / dna / rna / timeseries / plugin, captured 2026-09-26) — chemistry- and biology-flavored specials no other family carries.',
  },
  {
    id: 'tmpl-llama',
    kind: 'template',
    tier: 1,
    match: [/<\|begin_of_text\|>/g, /<\|header_start\|>/g, /<\|header_end\|>/g, /<\|eot\|>/g, /<\|eom\|>/g, /<\|python_start\|>/g],
    vendors: { meta: 6 },
    rationale: 'Llama-4 template tokens (begin_of_text / header_start / eot / eom / python_start) from the official tokenizer_config; Llama-4\'s vocab grew to 202048 (near the o200k/minimax cluster), so vocabulary alone no longer separates it — these tokens do.',
  },
  {
    id: 'tmpl-inst',
    kind: 'template',
    tier: 1,
    match: [/\[INST\]/g, /\[\/INST\]/g],
    vendors: { mistral: 5 },
    rationale: '[INST] frame — current in the Mistral-Small-3.x tokenizer (vocab 131072, re-captured 2026-09-26; Llama-2 heritage, dropped from the meta row with the old generations).',
  },
  {
    id: 'tmpl-mistral-tools',
    kind: 'template',
    tier: 1,
    match: [/\[TOOL_CALLS\]/g, /\[AVAILABLE_TOOLS\]/g, /\[\/AVAILABLE_TOOLS\]/g, /\[SYSTEM_PROMPT\]/g, /\[ARGS\]/g, /\[CALL_ID\]/g],
    vendors: { mistral: 6 },
    rationale: 'Mistral tool-call frame tokens ([TOOL_CALLS] / [AVAILABLE_TOOLS] / [ARGS]…) from the official Mistral-Small-3.x tokenizer_config — bracket-style, unique to Mistral.',
  },
  {
    id: 'tmpl-gemma',
    kind: 'template',
    tier: 1,
    match: [/<start_of_turn>/g, /<end_of_turn>/g],
    vendors: { google: 6 },
    rationale: 'Gemma turn markers <start_of_turn>/<end_of_turn>.',
  },
  {
    id: 'tmpl-ling',
    kind: 'template',
    tier: 1,
    match: [/<\|role_end\|>/g, /<role>/g, /<function-name>/g, /<args-json-object>/g],
    vendors: { ling: 5 },
    rationale: 'Ling-mini-2.0 tokens (chat template captured 2026-09-26): <|role_end|> carries over from Ling-1T; the <role> / <function-name> / <args-json-object> tool dialect is 2.0-era. Weight 5 — <|role_end|> is short and generic-looking.',
  },
]

/**
 * Glitch-token batteries, split by tokenizer family. Sources: the
 * SolidGoldMagikarp research (LessWrong, Rumbelow & Watkins), the follow-up
 * "unspeakable glitch tokens" survey (arXiv:2404.09894) and the garak
 * scanner's public glitch list. These canaries are cl100k/r50k-era vocabulary
 * items; a model that *echoes* them cleanly likely does not share that
 * tokenizer, while degenerate echoing hints it does — the echo itself is only
 * tier-3 support, the behaviour stays a human judgement.
 */
const probeSignals: readonly AttributionSignal[] = [
  {
    id: 'probe-glitch-r50k',
    kind: 'probe',
    tier: 3,
    match: [
      /\bSolidGoldMagikarp\b/gi, /\bdodekatheon\b/gi, /\bDragonbound\b/gi, /裏覚醒/g,
      /\bguiActive\b/g, /\bpractition\b/g, /\bTPPStreamerBot\b/g, /\bTheNitromeFan\b/g,
      /龍喚士/g, /\bSpaceEngineers\b/g,
    ],
    vendors: { openai: 1 },
    rationale: 'GPT-2/r50k-family glitch canaries echoed (garak / SolidGoldMagikarp lists) — clean echo argues against that lineage, degeneration hints at it; judge manually.',
  },
  {
    id: 'probe-glitch-cl100k',
    kind: 'probe',
    tier: 3,
    match: [/\bpetertodd\b/gi, /\b\u30c7\u30e5\u30fc\u30c9\u30a2\u30eb\b/g],
    vendors: { openai: 1 },
    rationale: 'cl100k glitch canaries echoed (petertodd / デュードアル from the "unspeakable glitch tokens" survey) — judge manually.',
  },
  {
    id: 'probe-echo',
    kind: 'probe',
    tier: 3,
    match: [new RegExp(PROBE_ECHO_SENTINEL, 'g')],
    vendors: {},
    rationale: 'Echo-battery sentinel echoed — probe was answered; compare fidelity manually.',
  },
  {
    id: 'probe-cutoff',
    kind: 'probe',
    tier: 3,
    match: [new RegExp(PROBE_CUTOFF_SENTINEL, 'g')],
    vendors: {},
    rationale: 'Cutoff probe answered; compare the date claims manually.',
  },
  {
    id: 'probe-count',
    kind: 'probe',
    tier: 3,
    match: [new RegExp(PROBE_COUNT_SENTINEL, 'g')],
    vendors: {},
    rationale: 'Letter-count probe answered; judge the tokenizer-dependent errors manually.',
  },
  {
    id: 'probe-toolfmt',
    kind: 'probe',
    tier: 3,
    match: [new RegExp(PROBE_TOOLFMT_SENTINEL, 'g')],
    vendors: {},
    rationale: 'Tool-format elicitation answered; the demonstrated call format is the model\'s native template talking — check the reply for family-specific tool-call syntax (batch scanner scores it per family).',
  },
  {
    id: 'probe-refusal',
    kind: 'probe',
    tier: 3,
    match: [new RegExp(PROBE_REFUSAL_SENTINEL, 'g')],
    vendors: {},
    rationale: 'Refusal-shape battery answered; the boundary placement and refusal phrasing are post-training signatures — judge the shape manually.',
  },
  {
    id: 'probe-ctxwin',
    kind: 'probe',
    tier: 3,
    match: [new RegExp(PROBE_CONTEXT_SENTINEL, 'g')],
    vendors: {},
    rationale: 'Context-window self-report answered; claimed window sizes (128k/256k/1M) map loosely to families — self-reports of stealth models are frequently bait.',
  },
  {
    id: 'probe-identity',
    kind: 'probe',
    tier: 3,
    match: [new RegExp(PROBE_IDENTITY_SENTINEL, 'g')],
    vendors: {},
    rationale: 'Identity grid answered; stealth models\' self-descriptions are frequently bait — record the claim, weigh it against structural evidence, and treat contradictions as anomalies.',
  },
  {
    id: 'probe-sysprompt',
    kind: 'probe',
    tier: 3,
    match: [new RegExp(PROBE_SYS_PROMPT_SENTINEL, 'g')],
    vendors: {},
    rationale: 'System-prompt extraction answered; gateway scaffold vocabulary identifies the reseller stack, not the model family.',
  },
]

/** Regex rows (direct scan). Derived rows (trajectory density, em-dash style) are engine-computed. */
export const SCANNED_SIGNALS: readonly AttributionSignal[] = [
  ...dirtySignals,
  ...leakSignals,
  ...templateSignals,
  ...anomalySignals,
  ...probeSignals,
  {
    id: 'style-delve',
    kind: 'style',
    tier: 3,
    match: [/\bdelve(?:s|d)?\b/gi],
    vendors: { openai: 1 },
    rationale: '"delve" lexical folklore marker (GPT-4-era overuse); weak — style drifts across checkpoints.',
  },
]

/** Derived-row ids the engine computes from the counting-engine totals. */
export const DERIVED_SIGNAL_IDS = ['traj-minimal', 'traj-standard', 'style-emdash'] as const

export type DerivedSignalId = (typeof DERIVED_SIGNAL_IDS)[number]

/** Vendor weights of the derived rows, exposed so the engine and tests share them. */
export const DERIVED_SIGNALS: Readonly<Record<DerivedSignalId, AttributionSignal>> = {
  'traj-minimal': {
    id: 'traj-minimal',
    kind: 'trajectory',
    tier: 2,
    match: [],
    vendors: { deepseek: 1 },
    rationale: 'We-need/Let\'s telegraphic minimal-trajectory fingerprint (0813 high-score runs). 2026-09-25 drill: opencode-zen space-bunny-free (community-guessed MiniMax) reasons in the same style — industry-level post-training style, support only.',
  },
  'traj-standard': {
    id: 'traj-standard',
    kind: 'trajectory',
    tier: 2,
    match: [],
    vendors: { deepseek: 1 },
    rationale: 'Let-me-heavy standard-trajectory fingerprint (0813 low-score runs). Same caveat as traj-minimal: style-level, cannot discriminate DeepSeek vs other vendors sharing the recipe.',
  },
  'style-emdash': {
    id: 'style-emdash',
    kind: 'style',
    tier: 3,
    match: [],
    vendors: { anthropic: 1 },
    rationale: 'Em-dash density folklore marker (≥3/1000 chars); weak — style folklore, not evidence of origin.',
  },
}

/** All rows (scanned + derived), for locale lookup and the ledger. */
export const ALL_SIGNALS: readonly AttributionSignal[] = [...SCANNED_SIGNALS, ...Object.values(DERIVED_SIGNALS)]

/** Trajectory totals the engine needs to evaluate the derived rows. */
export interface TrajectoryInput {
  readonly words: WordCounts
  readonly patterns: PatternCounts
}

/** Evaluate the derived-row firing rules against session totals. */
export function derivedHits(
  traj: TrajectoryInput,
  emDashCount: number,
  reasoningChars: number,
): readonly { id: DerivedSignalId; count: number }[] {
  const hits: { id: DerivedSignalId; count: number }[] = []
  let efficient = 0
  for (let i = 0; i < PATTERNS.length; i++) {
    if (traj.patterns[i] === undefined || traj.patterns[i] === 0) continue
    if (PATTERNS[i].group === 'efficient') efficient += traj.patterns[i]
  }
  // Minimal fingerprint: direct-action framing present, zero `let me`.
  if (efficient >= 3 && traj.words.letMe === 0) hits.push({ id: 'traj-minimal', count: 1 })
  // Standard fingerprint: let-me-heavy deliberation without the minimal frame.
  if (traj.words.letMe >= 3 && efficient === 0) hits.push({ id: 'traj-standard', count: 1 })
  // Em-dash density folklore (≥3 per 1000 reasoning chars).
  if (reasoningChars >= 400 && emDashCount * 1000 / reasoningChars >= 3) {
    hits.push({ id: 'style-emdash', count: 1 })
  }
  return hits
}
