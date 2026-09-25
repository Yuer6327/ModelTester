#!/usr/bin/env node
/**
 * Usage-delta fertility fingerprint drill (dev tool, not part of the plugin
 * bundle).
 *
 * Sends fixed probe texts (fingerprint-texts.json) to a model through an
 * OpenAI-compatible endpoint and records usage.prompt_tokens for each. The
 * gateway's chat-template overhead is constant across calls, so the DELTAS
 * between probes isolate the tokenizer's actual token counts — comparable
 * against local reference counts from each vendor's official tokenizer.json
 * (see fingerprint-reference.py).
 *
 * Usage:
 *   OPENCODE_ZEN_API_KEY=… node fingerprint-drill.mjs <model> [baseURL]
 * Snapshots are written to .attr-corpus/fingerprints/<model>-<timestamp>.json
 * (gitignored) for drift comparison across runs (substitution auditing).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

const KEY = process.env.OPENCODE_ZEN_API_KEY
if (!KEY) { console.error('OPENCODE_ZEN_API_KEY missing'); process.exit(1) }
const MODEL = process.argv[2] ?? 'space-bunny-free'
const BASE = process.argv[3] ?? 'https://opencode.ai/zen/v1'

const texts = JSON.parse(readFileSync(new URL('./fingerprint-texts.json', import.meta.url), 'utf8')).texts
const ids = Object.keys(texts).sort()

const usage = {}
for (const id of ids) {
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: texts[id] }], stream: false, max_tokens: 1 }),
      signal: AbortSignal.timeout(120_000),
    })
    const j = await res.json().catch(() => null)
    const u = j?.usage
    if (u === undefined || u === null) {
      console.log(`${id} -> ${res.status} (no usage)`, JSON.stringify(j)?.slice(0, 160) ?? '')
      continue
    }
    usage[id] = { prompt: u.prompt_tokens, completion: u.completion_tokens, total: u.total_tokens }
    console.log(`${id} -> ${res.status} prompt=${u.prompt_tokens} chars=${texts[id].length}`)
  } catch (err) {
    console.log(`${id} -> FAIL: ${err.message}`)
  }
}

const baseline = usage.T0?.prompt
const deltas = {}
for (const id of ids) {
  if (id === 'T0' || usage[id] === undefined || baseline === undefined) continue
  deltas[id] = usage[id].prompt - baseline
}
console.log('deltas vs T0:', JSON.stringify(deltas))

const outDir = new URL('./.attr-corpus/fingerprints/', import.meta.url)
mkdirSync(outDir, { recursive: true })
const snapshot = {
  model: MODEL,
  baseURL: BASE,
  capturedAt: new Date().toISOString(),
  textsVersion: JSON.parse(readFileSync(new URL('./fingerprint-texts.json', import.meta.url), 'utf8')).comment.slice(0, 40),
  chars: Object.fromEntries(ids.map(id => [id, Array.from(texts[id]).length])),
  usage,
  deltas,
}
const out = new URL(`./${MODEL.replace(/[^\w.-]+/g, '_')}-${Date.now()}.json`, outDir)
writeFileSync(out, JSON.stringify(snapshot, null, 2))
console.log('snapshot:', String(out).replace('file://', ''))
