#!/usr/bin/env node
/**
 * Vendor-attribution drill (dev tool, not part of the plugin bundle).
 *
 * Probe sections against an OpenAI-compatible endpoint. All evidence is
 * structural (tokenizer / chat-template / serving-stack artifacts), never an
 * identity claim; snapshots keep the raw data so re-interpretation offline
 * stays possible. Forensic layering: an observation only identifies the layer
 * capable of producing it — the synthesis labels which layers agree instead of
 * collapsing everything into one verdict.
 *
 *   --usage     Usage-delta fertility fingerprint: send the fixed probe texts
 *               (fingerprint-texts.json), record usage.prompt_tokens, diff
 *               against the T0 baseline. Compare offline with
 *               fingerprint-reference.py. Usage telemetry is the most
 *               tamper-resistant surface: faking it corrupts the provider's
 *               own billing. (Default section, backward compat.)
 *   --logprobs  Vocab-size fingerprint. Two probes:
 *                 a) legacy POST /completions with echo:true + logprobs — the
 *                    piece strings are a tokenization fingerprint of T4, and
 *                    the teacher-forced token_logprobs values are an
 *                    under-trained-token probability profile (checkpoint-level
 *                    signature); token IDs when the server is vLLM-class
 *                    (OpenAI official returns strings only — their absence is
 *                    itself a stack signal);
 *                 b) chat completions with logprobs:true over a rare-character
 *                    elicitation prompt, to push high-id tokens into the window.
 *               The observed max token id is a LOWER BOUND on vocab size; the
 *               mapping reports candidate FAMILIES (close neighbors stay
 *               pairs, we never collapse them into a verdict).
 *   --inject    Special-token injection battery: append each family's
 *               turn/stop token to a user message and compare the completion
 *               against a baseline without it. A family token that perturbs
 *               the reply while ALL controls survive means the serving
 *               tokenizer parsed the token — the template family is live on
 *               that path. A 4xx "special token" rejection is an OpenAI-style
 *               input-guard hint; the truncated-form control catches
 *               regex-sanitizing gateways. prompt_tokens deltas show whether
 *               the token survived into tokenization.
 *   --models    GET /models listing: catalog ids often leak upstream names
 *               (operator-layer evidence; a catalog name can mislead, but it
 *               is cheap and frequently decisive).
 *   --errors    Error envelope: send malformed requests and record the error
 *               shape (code type, serde-style keywords, message text) — the
 *               serving-stack fingerprint (Rust vs Java vs Python stacks).
 *   --context   Context ceiling ladder: send padded prompts of growing token
 *               counts (repeated "apple " ≈ 1 token per repeat), stop at the
 *               first failure, extract the limit from error text when stated.
 *               A measured ceiling rules whole generations in or out.
 *   --batch     All of the above + a cross-layer synthesis (family votes per
 *               layer, ranked guess with confidence label). --all is an alias.
 *   --sibling <model>  Same-gateway catalog A/B (repeatable): run the usage
 *               battery against named sibling models and compare delta
 *               vectors (L1) and wrapper constants against the target. Exact
 *               delta identity with a named sibling is near-deterministic.
 *
 * Usage:
 *   OPENCODE_ZEN_API_KEY=… node fingerprint-drill.mjs <model> [baseURL]
 *     [--usage|--logprobs|--inject|--models|--errors|--context|--batch]
 *     [--sibling <model>]… [--context-steps 8000,64000,256000,1000000]
 *   (no flags = --usage)
 * Snapshots are written to .attr-corpus/fingerprints/<model>-<timestamp>.json
 * (gitignored; override the directory with FINGERPRINT_OUT_DIR) for drift
 * comparison across runs (substitution auditing).
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const KEY = process.env.OPENCODE_ZEN_API_KEY
if (!KEY) { console.error('OPENCODE_ZEN_API_KEY missing'); process.exit(1) }

const KNOWN_FLAGS = new Set(['--usage', '--logprobs', '--inject', '--models', '--errors', '--context', '--batch', '--all', '--sibling', '--context-steps'])
const argv = process.argv.slice(2)
const positional = []
const flags = new Set()
const siblings = []
let contextStepsArg = null
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--sibling') {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) { console.error('--sibling requires a model id'); process.exit(1) }
    siblings.push(argv[++i])
  } else if (a === '--context-steps') {
    if (argv[i + 1] === undefined) { console.error('--context-steps requires a CSV of token counts'); process.exit(1) }
    contextStepsArg = argv[++i]
  } else if (a.startsWith('--')) {
    flags.add(a)
  } else {
    positional.push(a)
  }
}
const unknown = [...flags].filter(f => !KNOWN_FLAGS.has(f))
if (unknown.length > 0) {
  console.error(`unknown flag(s): ${unknown.join(' ')} — known: ${[...KNOWN_FLAGS].join(' ')}`)
  process.exit(1)
}
const MODEL = positional[0] ?? 'space-bunny-free'
const BASE = positional[1] ?? 'https://opencode.ai/zen/v1'
const batch = flags.has('--batch') || flags.has('--all')
const ALL_SECTIONS = ['models', 'usage', 'logprobs', 'inject', 'errors', 'context']
let sections = batch ? [...ALL_SECTIONS] : ALL_SECTIONS.filter(s => flags.has(`--${s}`))
if (sections.length === 0) sections = ['usage']
if (siblings.length > 0 && !sections.includes('usage')) sections.push('usage')
sections.sort((a, b) => ALL_SECTIONS.indexOf(a) - ALL_SECTIONS.indexOf(b))

const textsFile = JSON.parse(readFileSync(new URL('./fingerprint-texts.json', import.meta.url), 'utf8'))
const texts = textsFile.texts
const ids = Object.keys(texts).sort()

/** Curated response headers (serving-stack fingerprint; allowlisted to avoid PII). */
let lastHeaders = null
function curateHeaders(headers) {
  const out = {}
  for (const [k, v] of headers.entries()) {
    if (/^(server|date|cf-ray|x-request-id|x-vllm-.*|anthropic-.*|openai-.*|x-ratelimit-.*|retry-after)$/i.test(k)) {
      out[k] = String(v).slice(0, 120)
    }
  }
  return Object.keys(out).length > 0 && Object.keys(out).length <= 25 ? out : null
}

async function chat(body, timeoutMs = 120_000) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, stream: false, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  lastHeaders = curateHeaders(res.headers) ?? lastHeaders
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function legacyCompletion(body) {
  const res = await fetch(`${BASE}/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, stream: false, ...body }),
    signal: AbortSignal.timeout(120_000),
  })
  lastHeaders = curateHeaders(res.headers) ?? lastHeaders
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

/* ------------------------------------------------------- family vocabulary */

/** Vendor keyword patterns over free text (catalog ids, family labels, sibling names). */
const FAMILY_PATTERNS = [
  { vendor: 'minimax', re: /minimax/i },
  { vendor: 'zhipu', re: /\bglm\b|zhipu|z\.ai/i },
  { vendor: 'deepseek', re: /deepseek/i },
  { vendor: 'qwen', re: /qwen|tongyi/i },
  { vendor: 'moonshot', re: /kimi|moonshot/i },
  { vendor: 'meta', re: /\bllama\b|\bmeta\b/i },
  { vendor: 'mistral', re: /mistral|mixtral/i },
  { vendor: 'google', re: /gemma|gemini|google/i },
  { vendor: 'openai', re: /\bgpt|openai/i },
  { vendor: 'anthropic', re: /claude|anthropic/i },
  { vendor: 'ling', re: /\bling\b|inclusion/i },
  { vendor: 'xiaomi', re: /\bmimo\b|xiaomi/i },
  { vendor: 'xai', re: /\bgrok\b|x\.ai/i },
  { vendor: 'meituan', re: /longcat|meituan/i },
  { vendor: 'nvidia', re: /nemotron|nvidia/i },
  { vendor: 'internlm', re: /internlm|intern-s/i },
  { vendor: 'step', re: /stepfun|step-3/i },
  { vendor: 'yi', re: /\byi-\d|01-ai/i },
]

function familiesOf(text) {
  return FAMILY_PATTERNS.filter(f => f.re.test(text)).map(f => f.vendor)
}

/* ---------------------------------------------------------------- --usage */

async function runUsage(model = MODEL) {
  const usage = {}
  for (const id of ids) {
    try {
      const { status, json } = await chat({ model, messages: [{ role: 'user', content: texts[id] }], max_tokens: 1 })
      const u = json?.usage
      if (u === undefined || u === null) {
        console.log(`[${model}] ${id} -> ${status} (no usage)`, JSON.stringify(json)?.slice(0, 160) ?? '')
        continue
      }
      usage[id] = { prompt: u.prompt_tokens, completion: u.completion_tokens, total: u.total_tokens }
      console.log(`[${model}] ${id} -> ${status} prompt=${u.prompt_tokens} chars=${texts[id].length}`)
    } catch (err) {
      console.log(`[${model}] ${id} -> FAIL: ${err.message}`)
    }
  }

  const baseline = usage.T0?.prompt
  const deltas = {}
  for (const id of ids) {
    if (id === 'T0' || usage[id] === undefined || baseline === undefined) continue
    deltas[id] = usage[id].prompt - baseline
  }
  console.log(`[${model}] deltas vs T0:`, JSON.stringify(deltas))
  return { usage, deltas }
}

/* ------------------------------------------------------------- --logprobs */

/**
 * Vocab-size references: padded vocab_size from each family's LATEST
 * official config.json / tokenizer_config.json on HuggingFace, re-captured
 * 2026-09-26 via proxy (raw captures in .attr-corpus/tokenizers/). These
 * shift across generations — re-verify before promoting an observation to a
 * declaration. Neighbor clusters are reported as candidate PAIRS/GROUPS,
 * never collapsed: ~131k {mistral, longcat, nemotron}, ~129k {deepseek,
 * step}, ~152-157k {xiaomi, glm, internlm, ling}, ~200-202k {o200k, minimax,
 * llama4}.
 */
const VOCAB_REFERENCES = [
  { family: 'gpt2/r50k', maxId: 50257 },
  { family: 'cl100k (GPT-3.5/4)', maxId: 100277 },
  { family: 'yi-34b', maxId: 64000 },
  { family: 'step-3.5', maxId: 128896 },
  { family: 'deepseek-v4.1 (v3 line)', maxId: 129280 },
  { family: 'mistral-small-3.x', maxId: 131072 },
  { family: 'longcat-flash (meituan)', maxId: 131072 },
  { family: 'nemotron-3 (nvidia)', maxId: 131072 },
  { family: 'mimo-v2.6 (xiaomi)', maxId: 152576 },
  { family: 'glm-5.3 (zhipu)', maxId: 154880 },
  { family: 'intern-s1-pro (internlm)', maxId: 155008 },
  { family: 'ling-mini-2.0', maxId: 157184 },
  { family: 'kimi-k3 (moonshot, tiktoken)', maxId: 163840 },
  { family: 'o200k (GPT-4o)', maxId: 200057 },
  { family: 'minimax-m3', maxId: 200064 },
  { family: 'llama-4 (meta)', maxId: 202048 },
  { family: 'qwen3.8', maxId: 248320 },
  { family: 'gemma-3 (google)', maxId: 262208 },
]

/** Candidate families whose vocab reference sits within tolerance of an observed id. */
function vocabCandidates(maxId, tolerance = 0.02) {
  if (!Number.isFinite(maxId) || maxId <= 0) return []
  return VOCAB_REFERENCES
    .filter(r => Math.abs(maxId - r.maxId) / r.maxId <= tolerance)
    .map(r => ({ family: r.family, referenceMaxId: r.maxId, delta: maxId - r.maxId }))
}

/**
 * Harvest token IDs from any logprobs shape: vLLM-class servers expose
 * integer-keyed dicts or token_id fields; OpenAI official returns token
 * strings only (ids stay empty — that absence is itself a stack signal).
 */
function harvestIds(node) {
  const found = []
  const walk = (x, depth = 0) => {
    if (depth > 8 || x === null || typeof x !== 'object') return
    if (Array.isArray(x)) { for (const item of x) walk(item, depth + 1); return }
    for (const [k, v] of Object.entries(x)) {
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) {
        if (/^(token_?id|id)$/i.test(k)) found.push(v)
      }
      if (/^\d+$/.test(k) && typeof v === 'number') found.push(Number(k))
      walk(v, depth + 1)
    }
  }
  walk(node)
  return found
}

function summarizeIds(rawIds) {
  const unique = [...new Set(rawIds)].sort((a, b) => a - b)
  const maxId = unique.length > 0 ? unique[unique.length - 1] : 0
  return { ids: unique.slice(-600), maxId, candidates: vocabCandidates(maxId) }
}

async function runLogprobs() {
  const out = {}

  // a) Echo tokenization: legacy /completions echo gives the piece strings for
  //    the prompt itself (T4, mixed scripts — comparable 1:1 with
  //    fingerprint-reference.py) plus teacher-forced logprob values: the
  //    model's probability profile on under-trained tokens is a
  //    checkpoint-level signature (UTF-inspired).
  try {
    const { status, json } = await legacyCompletion({ prompt: texts.T4, echo: true, logprobs: 1, max_tokens: 1, temperature: 0 })
    const lp = json?.choices?.[0]?.logprobs
    const pieces = Array.isArray(lp?.tokens) ? lp.tokens.slice(0, 1200) : []
    const { ids: tokenIds, maxId, candidates } = summarizeIds(harvestIds(lp))
    const tokenLogprobs = Array.isArray(lp?.token_logprobs) ? lp.token_logprobs.slice(0, 1200) : null
    out.echo = { supported: pieces.length > 0, status, pieces, tokenIds, maxId, candidates, tokenLogprobs }
    console.log(`logprobs echo: status=${status} pieces=${pieces.length} ids=${tokenIds.length} maxId=${maxId}` +
      (candidates.length > 0 ? ` -> candidates: ${candidates.map(c => c.family).join(' | ')}` : ''))
  } catch (err) {
    out.echo = { supported: false, error: err.message }
    console.log(`logprobs echo: FAIL ${err.message}`)
  }

  // b) Rare-token elicitation: echo T4 back through chat completions with
  //    logprobs to push high-id tokens (and their top-k alternatives) into the
  //    observable window.
  try {
    const { status, json } = await chat({
      messages: [{ role: 'user', content: `请原样输出下面的字符序列，不要解释、不要纠正：\n${texts.T4}` }],
      logprobs: true,
      top_logprobs: 5,
      max_tokens: 96,
      temperature: 0,
    })
    const lp = json?.choices?.[0]?.logprobs
    const { ids: tokenIds, maxId, candidates } = summarizeIds(harvestIds(lp))
    out.rare = { supported: tokenIds.length > 0, status, tokenIds, maxId, candidates }
    console.log(`logprobs rare: status=${status} ids=${tokenIds.length} maxId=${maxId}` +
      (candidates.length > 0 ? ` -> candidates: ${candidates.map(c => c.family).join(' | ')}` : ''))
  } catch (err) {
    out.rare = { supported: false, error: err.message }
    console.log(`logprobs rare: FAIL ${err.message}`)
  }

  out.vocabReferences = VOCAB_REFERENCES
  out.note = 'Observed max token id is a lower bound on vocab size; close neighbors are reported as candidate pairs, never collapsed. Token ids require a vLLM-class server (OpenAI official returns strings only); the echo piece vector from (a) is the offline tiebreaker via fingerprint-reference.py, and echo token_logprobs values are an under-trained-token probability profile (checkpoint-level).'
  return out
}

/* --------------------------------------------------------------- --inject */

/** Turn/stop tokens per family (from the official tokenizer_config.json set in src/client/tokenizers.ts). */
const INJECT_TOKENS = [
  { token: '<|im_end|>', family: 'qwen/chatml' },
  { token: '<|endoftext|>', family: 'shared (qwen et al.)' },
  { token: '<｜end▁of▁sentence｜>', family: 'deepseek+step' },
  { token: '<｜User｜>', family: 'deepseek+step' },
  { token: '<|user|>', family: 'glm (zhipu)' },
  { token: '<|end_of_msg|>', family: 'kimi-k3 (moonshot)' },
  { token: '<end_of_turn>', family: 'gemma (google)' },
  { token: '<|eot_id|>', family: 'llama (meta)' },
  { token: '</mm:think>', family: 'minimax' },
  { token: '<|mimo_video_start|>', family: 'mimo (xiaomi)' },
  { token: '<longcat_think>', family: 'longcat (meituan)' },
  { token: '<|EOT|>', family: 'step-3.5' },
  { token: '<|im_sep|>', family: 'yi-34b' },
  { token: '<protein>', family: 'intern-s1 (internlm)' },
]

/** Controls: fakes must never fire; the truncated form catches regex sanitizers. */
const INJECT_CONTROLS = [
  { token: '<|zenx_end|>', family: 'control: fake' },
  { token: '<|im_end', family: 'control: truncated form' },
  { token: 'MTEST-FAKE-VFEN-7741', family: 'control: fake' },
]

/** Vendor mapping for the inject battery's family labels ('shared' votes for nobody). */
const INJECT_FAMILY_VENDORS = {
  'qwen/chatml': ['qwen'],
  'shared (qwen et al.)': [],
  'deepseek+step': ['deepseek', 'step'],
  'glm (zhipu)': ['zhipu'],
  'kimi-k3 (moonshot)': ['moonshot'],
  'gemma (google)': ['google'],
  'llama (meta)': ['meta'],
  minimax: ['minimax'],
  'mimo (xiaomi)': ['xiaomi'],
  'longcat (meituan)': ['meituan'],
  'step-3.5': ['step'],
  'yi-34b': ['yi'],
  'intern-s1 (internlm)': ['internlm'],
}

const INJECT_TASK = '请把 "banana" 原样重复三遍，只输出重复的单词，不要解释。'

function injectOutcome(entry, baselineChars) {
  if (entry.status >= 400) return 'rejected'
  // finish=length: the model exhausted max_tokens (reasoning models burn the
  // budget on thinking before emitting visible text) — inconclusive, NOT
  // truncation evidence. Only stop-finish anomalies count as token parsing.
  if (entry.finishReason === 'length') return 'budget'
  if (entry.completionChars === 0) return 'empty'
  if (entry.completionChars <= 3) return 'short'
  if (entry.completionChars < baselineChars * 0.5 || entry.completionChars > baselineChars * 2.5) return 'deviant'
  return 'ok'
}

async function runInject() {
  const results = []
  const send = async (token) => {
    const content = token === null ? INJECT_TASK : `${INJECT_TASK}\n${token}`
    try {
      const { status, json } = await chat({ messages: [{ role: 'user', content }], max_tokens: 128, temperature: 0 })
      const choice = json?.choices?.[0]
      const text = typeof choice?.message?.content === 'string' ? choice.message.content : ''
      const rejected = status >= 400
      const errorText = rejected ? JSON.stringify(json)?.slice(0, 200) : null
      return {
        status,
        rejected,
        errorText,
        finishReason: rejected ? null : choice?.finish_reason ?? null,
        completionChars: rejected ? 0 : Array.from(text).length,
        completionSample: rejected ? null : text.slice(0, 120),
        promptTokens: json?.usage?.prompt_tokens ?? null,
      }
    } catch (err) {
      return { status: 0, rejected: false, errorText: err.message, finishReason: null, completionChars: 0, completionSample: null, promptTokens: null }
    }
  }

  const baselineRes = await send(null)
  const baselineChars = Math.max(baselineRes.completionChars, 1)

  for (const [isControl, group] of [[false, INJECT_TOKENS], [true, INJECT_CONTROLS]]) {
    for (const { token, family } of group) {
      const res = await send(token)
      const entry = {
        token,
        family,
        isControl,
        status: res.status,
        outcome: res.errorText !== null && !res.rejected ? 'error' : injectOutcome({ ...res, status: res.rejected ? 400 : res.status }, baselineChars),
        finishReason: res.finishReason,
        completionChars: res.completionChars,
        completionSample: res.completionSample,
        promptTokens: res.promptTokens,
        promptTokensDelta: res.promptTokens !== null && baselineRes.promptTokens !== null
          ? res.promptTokens - baselineRes.promptTokens
          : null,
      }
      if (res.errorText !== null) entry.errorText = res.errorText
      results.push(entry)
      const pad = token.length > 26 ? '' : ' '.repeat(26 - token.length)
      console.log(`inject ${JSON.stringify(token)} ${pad} ${family.padEnd(26)} -> ${entry.outcome}` +
        ` (${entry.completionChars} chars, finish=${entry.finishReason}, promptΔ=${entry.promptTokensDelta})`)
    }
  }

  const controlsOk = results.filter(r => r.isControl).every(r => r.outcome === 'ok' || r.outcome === 'budget')
  const firingEntries = results
    .filter(r => !r.isControl && r.outcome !== 'ok' && r.outcome !== 'error' && r.outcome !== 'budget')
    .map(r => ({ token: r.token, family: r.family }))
  const firingFamilies = firingEntries.map(r => `${r.token} (${r.family})`)
  console.log(`inject summary: controls ${controlsOk ? 'all ok' : 'FIRED — sanitizer suspected; family hits are not tokenizer evidence'}` +
    (controlsOk && firingFamilies.length > 0 ? `; family tokens perturbed the reply: ${firingFamilies.join(', ')}` : ''))

  return {
    task: INJECT_TASK,
    baseline: {
      status: baselineRes.status,
      finishReason: baselineRes.finishReason,
      completionChars: baselineRes.completionChars,
      completionSample: baselineRes.completionSample,
      promptTokens: baselineRes.promptTokens,
    },
    results,
    controlsOk,
    firingEntries,
    firingFamilies,
    note: 'A family token perturbing the reply with a STOP finish (empty/short/deviant) while ALL controls stay ok/budget means the serving tokenizer parsed it — template-family evidence, not an identity claim. finish=length is recorded as "budget" (reasoning exhausted max_tokens — inconclusive). The truncated-form control firing indicates gateway regex sanitization (downgrade). A 4xx special-token rejection is an OpenAI-style input guard. promptTokensDelta shows whether the token survived tokenization (0 = stripped/normalized, 1 = parsed as one special token).',
  }
}

/* --------------------------------------------------------------- --models */

async function runModels() {
  try {
    const res = await fetch(`${BASE.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(60_000),
    })
    lastHeaders = curateHeaders(res.headers) ?? lastHeaders
    const json = await res.json().catch(() => null)
    const rawIds = Array.isArray(json?.data)
      ? json.data.map(m => (typeof m === 'string' ? m : m?.id)).filter(id => typeof id === 'string')
      : []
    const leakHits = {}
    for (const id of rawIds) {
      for (const f of FAMILY_PATTERNS) {
        if (f.re.test(id)) (leakHits[f.vendor] ??= []).push(id)
      }
    }
    for (const vendor of Object.keys(leakHits)) leakHits[vendor] = [...new Set(leakHits[vendor])].slice(0, 5)
    console.log(`models: status=${res.status} count=${rawIds.length}` +
      (Object.keys(leakHits).length > 0 ? ` leak hits: ${Object.entries(leakHits).map(([v, list]) => `${v}(${list.length})`).join(' ')}` : ''))
    return {
      supported: rawIds.length > 0,
      status: res.status,
      count: rawIds.length,
      ids: rawIds.slice(0, 200),
      leakHits,
      note: 'Catalog ids are operator-layer evidence: a listing name can mislead (aliases/resellers), but upstream-name leakage in the catalog is cheap and frequently decisive. Use with --sibling for exact A/B.',
    }
  } catch (err) {
    console.log(`models: FAIL ${err.message}`)
    return { supported: false, error: err.message }
  }
}

/* --------------------------------------------------------------- --errors */

const STACK_HINTS = [
  { re: /\bserde\b|\brust\b|invalid type|deserializ/i, stack: 'rust/serde-style' },
  { re: /jackson|spring|java\.lang|com\.fasterxml/i, stack: 'java/jackson-style' },
  { re: /pydantic|fastapi|traceback|python/i, stack: 'python-style' },
  { re: /grpc|internal:\s/i, stack: 'grpc-style' },
]

async function runErrors() {
  const probe = async (name, body) => {
    try {
      const { status, json } = await chat(body)
      const payload = json ?? {}
      const errObj = typeof payload.error === 'object' && payload.error !== null ? payload.error : payload
      const message = String(errObj.message ?? errObj.msg ?? '').slice(0, 200)
      const entry = {
        status,
        errorKeys: Object.keys(errObj).slice(0, 10),
        codeType: errObj.code === undefined ? null : typeof errObj.code,
        message,
        stackHints: STACK_HINTS.filter(h => h.re.test(message)).map(h => h.stack),
      }
      console.log(`errors ${name}: status=${status} keys=[${entry.errorKeys.join(',')}] code=${entry.codeType}${entry.stackHints.length > 0 ? ` stack=${entry.stackHints.join('|')}` : ''} msg="${message.slice(0, 80)}"`)
      return entry
    } catch (err) {
      console.log(`errors ${name}: FAIL ${err.message}`)
      return { status: 0, error: err.message }
    }
  }
  const emptyMessages = await probe('empty-messages', { messages: [], max_tokens: 1 })
  const badRole = await probe('bad-role', { messages: [{ role: 'invalid_role_test', content: 'x' }], max_tokens: 1 })
  return {
    emptyMessages,
    badRole,
    note: 'Error envelope shapes (code type, serde keywords, message text) fingerprint the serving stack — an operator-layer signal, not a model-layer one. Pair with response headers.',
  }
}

/* -------------------------------------------------------------- --context */

function parseContextSteps() {
  const csv = contextStepsArg ?? '8000,64000,256000,1000000'
  return csv.split(',').map(s => Number.parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0)
}

async function runContext() {
  const steps = parseContextSteps()
  const results = []
  for (const targetTokens of steps) {
    const content = `${'apple '.repeat(targetTokens)}\n\nIgnore the padding above. Reply with exactly: OK`
    const timeoutMs = targetTokens >= 100_000 ? 300_000 : 120_000
    try {
      const { status, json } = await chat({ messages: [{ role: 'user', content }], max_tokens: 8, temperature: 0 }, timeoutMs)
      const errText = status >= 400 ? String(json?.error?.message ?? JSON.stringify(json) ?? '').slice(0, 200) : null
      const extractedLimit = errText === null
        ? null
        : (errText.match(/(?:maximum context length|context length)[^\d]{0,40}(\d{3,})/i) ?? errText.match(/(\d{4,})\s*tokens/i))?.[1]
      const entry = {
        targetTokens,
        chars: content.length,
        status,
        ok: status >= 200 && status < 400,
        promptTokens: json?.usage?.prompt_tokens ?? null,
        finishReason: status < 400 ? json?.choices?.[0]?.finish_reason ?? null : null,
        errorSample: errText,
        extractedLimit: extractedLimit !== undefined && extractedLimit !== null ? Number(extractedLimit) : null,
      }
      results.push(entry)
      console.log(`context ~${targetTokens} tok -> ${status}${entry.promptTokens !== null ? ` prompt=${entry.promptTokens}` : ''}${entry.extractedLimit !== null ? ` limit=${entry.extractedLimit}` : ''}`)
      if (!entry.ok) break
    } catch (err) {
      results.push({ targetTokens, chars: content.length, status: 0, ok: false, promptTokens: null, finishReason: null, errorSample: err.message, extractedLimit: null })
      console.log(`context ~${targetTokens} tok -> FAIL ${err.message}`)
      break
    }
  }
  const okSteps = results.filter(r => r.ok).map(r => r.targetTokens)
  const failSteps = results.filter(r => !r.ok && r.status >= 400).map(r => r.targetTokens)
  const ceiling = {
    minOk: okSteps.length > 0 ? Math.max(...okSteps) : null,
    maxFail: failSteps.length > 0 ? Math.min(...failSteps) : null,
    extractedLimits: results.map(r => r.extractedLimit).filter(v => v !== null),
  }
  console.log(`context ceiling: minOk=${ceiling.minOk ?? '—'} maxFail=${ceiling.maxFail ?? '—'}` +
    (ceiling.extractedLimits.length > 0 ? ` stated=${ceiling.extractedLimits.join(',')}` : ''))
  return {
    steps: results,
    ...ceiling,
    note: 'A measured context ceiling rules whole generations in or out (e.g. ≥1M excludes older MiniMax). promptTokens per passing step is the server-side actual count. Behavioral-layer evidence.',
  }
}

/* ---------------------------------------------------- --sibling (A/B A/B) */

async function runSiblings(targetDeltas) {
  const out = []
  for (const model of siblings) {
    const { usage, deltas } = await runUsage(model)
    const common = Object.keys(targetDeltas).filter(k => deltas[k] !== undefined)
    const l1 = common.reduce((sum, k) => sum + Math.abs(targetDeltas[k] - deltas[k]), 0)
    const t0Prompt = usage.T0?.prompt ?? null
    console.log(`sibling ${model}: L1=${l1} over ${common.length} keys, wrapper T0=${t0Prompt ?? '—'}`)
    out.push({ model, deltas, t0Prompt, l1, commonKeys: common.length })
  }
  return {
    siblings: out,
    note: 'Exact delta identity (L1=0) between the stealth model and a named sibling on the same gateway is near-deterministic tokenizer-family evidence; a constant offset across all deltas with L1=0 modulo that offset indicates the same model behind a different wrapper.',
  }
}

/* ----------------------------------------------------- batch synthesis */

function synthesize(parts) {
  const votes = {}
  const vote = (vendor, points, layer, source) => {
    if (vendor === undefined || vendor === null) return
    votes[vendor] ??= { points: 0, layers: {}, sources: [] }
    votes[vendor].points += points
    votes[vendor].layers[layer] = (votes[vendor].layers[layer] ?? 0) + 1
    votes[vendor].sources.push(source)
  }

  // Tokenizer layer: inject battery, logprobs vocab candidates, sibling A/B.
  // firingEntries keep the family label structured at the source — the display
  // strings embed tokens whose parens would break string parsing.
  for (const entry of parts.inject?.firingEntries ?? []) {
    for (const vendor of new Set(INJECT_FAMILY_VENDORS[entry.family] ?? familiesOf(entry.family))) {
      vote(vendor, 2, 'tokenizer', `inject:${entry.family}`)
    }
  }
  for (const c of [...parts.logprobs?.echo?.candidates ?? [], ...parts.logprobs?.rare?.candidates ?? []]) {
    for (const vendor of new Set(familiesOf(c.family))) vote(vendor, 2, 'tokenizer', `logprobs:${c.family}`)
  }
  for (const sib of parts.sibling?.siblings ?? []) {
    if (sib.l1 === 0 && sib.commonKeys >= 3) {
      for (const vendor of new Set(familiesOf(sib.model))) vote(vendor, 3, 'tokenizer', `sibling-exact:${sib.model}`)
    } else if (sib.l1 > 0 && sib.l1 <= 3 && sib.commonKeys >= 3) {
      for (const vendor of new Set(familiesOf(sib.model))) vote(vendor, 1, 'tokenizer', `sibling-near:${sib.model}`)
    }
  }
  // Infra layer: catalog leakage, error envelope stack hints (no family vote).
  for (const [vendor, list] of Object.entries(parts.models?.leakHits ?? {})) {
    vote(vendor, 1, 'infra', `models:${list[0]}`)
  }

  const ranked = Object.entries(votes)
    .map(([vendor, v]) => ({ vendor, ...v, layerCount: Object.keys(v.layers).length }))
    .sort((a, b) => b.points - a.points || b.layerCount - a.layerCount)
  const top = ranked[0]
  let confidence = 'none'
  if (top !== undefined) {
    const sources = top.sources.length
    confidence = top.points >= 6 && top.layerCount >= 2 ? 'high'
      : sources >= 2 ? 'medium'
        : 'low'
  }
  const guess = top?.vendor ?? null
  console.log(`synthesis: guess=${guess ?? '—'} confidence=${confidence}` +
    (top !== undefined ? ` (${Object.entries(top.layers).map(([l, n]) => `${l}×${n}`).join(', ')}; ${top.sources.slice(0, 4).join(', ')})` : ''))
  return {
    votes: ranked,
    guess,
    confidence,
    note: 'Cross-layer synthesis over structural evidence only. Confidence reflects independent LAYERS agreeing (tokenizer vs infra vs behavioral), never a single signal repeated. A guess is a ranked hypothesis, not an identity claim — confirm with fingerprint-reference.py on the usage deltas (the tamper-resistant surface).',
  }
}

/* ------------------------------------------------------------------- main */

const outBase = process.env.FINGERPRINT_OUT_DIR
const outDir = outBase !== undefined
  ? pathToFileURL(outBase.endsWith('/') || outBase.endsWith('\\') ? outBase : `${outBase}/`)
  : new URL('./.attr-corpus/fingerprints/', import.meta.url)
mkdirSync(outDir, { recursive: true })

const snapshot = {
  model: MODEL,
  baseURL: BASE,
  capturedAt: new Date().toISOString(),
  sections,
}

let targetDeltas = null

if (sections.includes('models')) snapshot.models = await runModels()
if (sections.includes('usage')) {
  const { usage, deltas } = await runUsage()
  targetDeltas = deltas
  snapshot.textsVersion = textsFile.comment.slice(0, 40)
  snapshot.chars = Object.fromEntries(ids.map(id => [id, Array.from(texts[id]).length]))
  snapshot.usage = usage
  snapshot.deltas = deltas
}
if (sections.includes('logprobs')) snapshot.logprobs = await runLogprobs()
if (sections.includes('inject')) snapshot.inject = await runInject()
if (sections.includes('errors')) snapshot.errors = await runErrors()
if (sections.includes('context')) snapshot.context = await runContext()
if (siblings.length > 0) snapshot.sibling = await runSiblings(targetDeltas ?? {})
if (lastHeaders !== null) snapshot.headers = lastHeaders
if (batch) snapshot.synthesis = synthesize(snapshot)

const out = new URL(`./${MODEL.replace(/[^\w.-]+/g, '_')}-${Date.now()}.json`, outDir)
writeFileSync(out, JSON.stringify(snapshot, null, 2))
console.log('snapshot:', String(out).replace('file://', ''))
