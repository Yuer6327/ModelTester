#!/usr/bin/env node
/**
 * Offline regression for fingerprint-drill.mjs (dev tool).
 *
 * Boots a local OpenAI-compatible mock (deterministic usage accounting, echo
 * logprobs with vLLM-style integer token ids, injection-aware completions,
 * context-limit errors, catalog listing, error envelopes) and runs the drill
 * against it — `--batch --sibling` and default (`--usage`) — then asserts the
 * snapshot sections. No network, no credentials: the mock ignores auth and the
 * dummy key is not a secret.
 *
 * Run: node verify-fingerprint-drill.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const DRILL = join(ROOT, 'fingerprint-drill.mjs')

const texts = JSON.parse(readFileSync(join(ROOT, 'fingerprint-texts.json'), 'utf8')).texts

/** Mirror of the drill's INJECT_TOKENS — family tokens the mock truncates on. */
const FAMILY_TOKENS = [
  '<|im_end|>', '<|endoftext|>', '<｜end▁of▁sentence｜>', '<｜User｜>', '<|user|>',
  '<|end_of_msg|>', '<end_of_turn>', '<|eot_id|>', '</mm:think>',
  '<|mimo_video_start|>', '<longcat_think>', '<|EOT|>', '<|im_sep|>', '<protein>',
]

const CONTEXT_LIMIT = 300_000

function chatResponse(body) {
  if (body.logprobs === true) {
    // vLLM-style: integer-keyed dicts inside top_logprobs. 151935 lands on the
    // glm(151552)/qwen3(151936) neighbor pair; '42' is noise.
    const entry = {
      token: '𠀀', logprob: -0.1, bytes: null,
      top_logprobs: [{ token: '𠀀', logprob: -0.1, bytes: null, logprobs: { '151935': -0.1, '42': -2.5 } }],
    }
    return {
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '𠀀𠀀𠀀' }, logprobs: { content: [entry, entry, entry] } }],
      usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
    }
  }
  const messages = body.messages ?? []
  if (messages.length === 0) {
    return { error: { code: 'invalid_request_error', message: 'serde validation error: invalid type, expected a non-empty sequence' } }
  }
  if (messages[0].role === 'invalid_role_test') {
    return { error: { code: 4001, message: 'jackson deserialization failure: unknown role enumerator' } }
  }
  const content = messages.at(-1)?.content ?? ''
  if (content.includes('banana')) {
    // The fake control simulates a reasoning model burning max_tokens: empty
    // content with finish=length must classify as "budget" (inconclusive).
    if (content.endsWith('<|zenx_end|>')) {
      return { choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }], usage: { prompt_tokens: 9, completion_tokens: 128, total_tokens: 137 } }
    }
    const familyHit = FAMILY_TOKENS.find(t => content.endsWith(t))
    return {
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: familyHit ? '' : 'banana banana banana' } }],
      usage: { prompt_tokens: familyHit ? 10 : 9, completion_tokens: familyHit ? 0 : 7, total_tokens: familyHit ? 10 : 16 },
    }
  }
  if (content.startsWith('apple ')) {
    const tokens = Math.ceil(content.length / 6)
    if (tokens > CONTEXT_LIMIT) {
      return { error: { message: `This model's maximum context length is ${CONTEXT_LIMIT} tokens. However, your request has ${tokens} tokens.` } }
    }
    return {
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
      usage: { prompt_tokens: tokens, completion_tokens: 1, total_tokens: tokens + 1 },
    }
  }
  const prompt = 7 + Math.ceil(Array.from(content).length / 3)
  return {
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: prompt, completion_tokens: 1, total_tokens: prompt + 1 },
  }
}

function completionResponse(body) {
  const pieces = Array.from(String(body.prompt ?? ''))
  // 129000 lands on the llama3(128256)/deepseek(129280) neighbor pair; '42' is noise.
  const top = pieces.map((_ch, i) => (i === 0 ? { '128300': -0.3, '129000': -0.31 } : i === 2 ? { '42': -0.9 } : null))
  return {
    choices: [{
      index: 0, finish_reason: 'stop', text: '',
      logprobs: { tokens: pieces, token_logprobs: pieces.map(() => -0.25), top_logprobs: top },
    }],
    usage: { prompt_tokens: pieces.length, completion_tokens: 1, total_tokens: pieces.length + 1 },
  }
}

function reply(res, status, payload) {
  res.setHeader('server', 'mock-srv')
  res.setHeader('x-request-id', 'req_mock123')
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { /* keep {} */ }
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      reply(res, 200, { object: 'list', data: [{ id: 'stealth/space-bunny-alpha' }, { id: 'minimax-m2' }, { id: 'qwen3-coder' }] })
    } else if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      const payload = chatResponse(body)
      reply(res, payload.error !== undefined ? 400 : 200, payload)
    } else if (req.method === 'POST' && req.url?.endsWith('/completions')) {
      reply(res, 200, completionResponse(body))
    } else {
      reply(res, 404, { error: { message: 'not found' } })
    }
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}/v1`

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`)
  else { failures += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const outDir = mkdtempSync(join(tmpdir(), 'fp-drill-'))
// Async spawn: the mock server lives in THIS process, and spawnSync would
// freeze its event loop so the drill's requests could never be answered.
function run(args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OPENCODE_ZEN_API_KEY: 'offline-mock-key', FINGERPRINT_OUT_DIR: outDir }
    const child = spawn(process.execPath, [DRILL, 'mock-model', BASE, ...args], { env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('drill timeout')) }, timeoutMs)
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => { clearTimeout(timer); resolve({ status: code, stdout, stderr }) })
  })
}

try {
  const all = await run(['--batch', '--sibling', 'minimax-m2'])
  check('drill --batch exits 0', all.status === 0, all.error?.message ?? all.stderr?.slice(0, 400) ?? '')
  check('usage summary printed', all.stdout.includes('deltas vs T0'))
  check('inject summary printed', all.stdout.includes('controls all ok'))
  check('synthesis printed', all.stdout.includes('synthesis: guess='))

  const files = readdirSync(outDir).filter(f => f.endsWith('.json'))
  check('one snapshot after run 1', files.length === 1, String(files.length))
  const snap = JSON.parse(readFileSync(join(outDir, files[0]), 'utf8'))

  check('sections = batch set in order',
    JSON.stringify(snap.sections) === JSON.stringify(['models', 'usage', 'logprobs', 'inject', 'errors', 'context']),
    JSON.stringify(snap.sections))
  check('usage deltas positive (T1–T9)', ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'].every(k => snap.deltas[k] > 0), JSON.stringify(snap.deltas))
  check('usage T0 prompt = mock formula', snap.usage.T0.prompt === 7 + Math.ceil(Array.from(texts.T0).length / 3), String(snap.usage.T0?.prompt))
  check('chars counted in code points', snap.chars.T4 === Array.from(texts.T4).length)

  const lp = snap.logprobs
  check('echo supported', lp.echo.supported === true, JSON.stringify(lp.echo).slice(0, 200))
  check('echo pieces = T4 code points', lp.echo.pieces.length === Array.from(texts.T4).length)
  check('echo logprob profile stored', Array.isArray(lp.echo.tokenLogprobs) && lp.echo.tokenLogprobs.length === lp.echo.pieces.length)
  check('echo ids harvested (vLLM-style)', lp.echo.tokenIds.includes(129000) && lp.echo.tokenIds.includes(42))
  check('echo maxId = 129000', lp.echo.maxId === 129000, String(lp.echo.maxId))
  check('echo candidates = ~129k cluster (step/deepseek/mistral/longcat/nemotron)',
    ['step-3.5', 'deepseek-v4.1 (v3 line)', 'mistral-small-3.x', 'longcat-flash (meituan)', 'nemotron-3 (nvidia)']
      .every(f => lp.echo.candidates.some(c => c.family === f)),
    JSON.stringify(lp.echo.candidates))
  check('rare candidates = ~152-155k cluster (mimo/glm/internlm)',
    ['mimo-v2.6 (xiaomi)', 'glm-5.3 (zhipu)', 'intern-s1-pro (internlm)']
      .every(f => lp.rare.candidates.some(c => c.family === f)),
    JSON.stringify(lp.rare.candidates))

  const inj = snap.inject
  check('baseline ok (20 chars, prompt 9)', inj.baseline.completionChars === 20 && inj.baseline.promptTokens === 9,
    JSON.stringify(inj.baseline))
  const familyRows = inj.results.filter(r => !r.isControl)
  const controlRows = inj.results.filter(r => r.isControl)
  check('family tokens all perturbed with promptΔ=1', familyRows.length >= 5 && familyRows.every(r => r.outcome === 'empty' && r.promptTokensDelta === 1),
    JSON.stringify(familyRows.map(r => [r.token, r.outcome, r.promptTokensDelta])))
  check('controls all ok/budget with promptΔ=0', controlRows.length === 3 && controlRows.every(r => (r.outcome === 'ok' || r.outcome === 'budget') && r.promptTokensDelta === 0),
    JSON.stringify(controlRows.map(r => [r.token, r.outcome])))
  check('fake control classed budget, not firing', controlRows.find(r => r.token === '<|zenx_end|>')?.outcome === 'budget')
  check('controlsOk flag true', inj.controlsOk === true)

  const models = snap.models
  check('models listing parsed', models.supported === true && models.count === 3, JSON.stringify(models).slice(0, 200))
  check('models leak hits minimax + qwen', models.leakHits.minimax?.[0] === 'minimax-m2' && models.leakHits.qwen?.[0] === 'qwen3-coder',
    JSON.stringify(models.leakHits))

  const errors = snap.errors
  check('error envelope: empty messages', errors.emptyMessages.status === 400 && errors.emptyMessages.codeType === 'string', JSON.stringify(errors.emptyMessages))
  check('error envelope: rust stack hint', errors.emptyMessages.stackHints.includes('rust/serde-style'), JSON.stringify(errors.emptyMessages.stackHints))
  check('error envelope: bad role numeric code + java hint', errors.badRole.status === 400 && errors.badRole.codeType === 'number' && errors.badRole.stackHints.includes('java/jackson-style'), JSON.stringify(errors.badRole))

  const ctx = snap.context
  check('context ladder: minOk = 256000', ctx.minOk === 256000, JSON.stringify(ctx))
  check('context ladder: maxFail = 1000000', ctx.maxFail === 1000000)
  check('context ladder: stated limit extracted', ctx.extractedLimits.includes(CONTEXT_LIMIT), JSON.stringify(ctx.extractedLimits))

  const sib = snap.sibling
  check('sibling A/B: exact L1=0 over 9 keys', sib.siblings[0].l1 === 0 && sib.siblings[0].commonKeys === 9, JSON.stringify(sib.siblings))
  check('sibling wrapper T0 recorded', sib.siblings[0].t0Prompt === snap.usage.T0.prompt)

  check('headers curated', snap.headers?.['x-request-id'] === 'req_mock123' && snap.headers?.server === 'mock-srv', JSON.stringify(snap.headers))

  const syn = snap.synthesis
  // Mock votes: step wins on inject (6) + logprobs echo (2), but from ONE
  // layer only — confidence caps at medium. minimax has two layers (6).
  check('synthesis guess = step (inject + logprobs, one layer)', syn.guess === 'step', JSON.stringify(syn.votes.slice(0, 3)))
  check('synthesis confidence = medium (single-layer lead)', syn.confidence === 'medium', syn.confidence)
  check('synthesis runner-up minimax spans two layers',
    syn.votes.some(v => v.vendor === 'minimax' && v.layerCount === 2), JSON.stringify(syn.votes.slice(0, 3)))

  const def = await run([])
  check('drill default exits 0', def.status === 0, def.error?.message ?? def.stderr?.slice(0, 400) ?? '')
  const snaps = readdirSync(outDir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(outDir, f), 'utf8')))
  const defaultSnap = snaps.find(s => s.sections.length === 1)
  check('default mode = usage only', defaultSnap !== undefined
    && defaultSnap.logprobs === undefined
    && defaultSnap.inject === undefined
    && defaultSnap.synthesis === undefined
    && defaultSnap.usage?.T0 !== undefined
    && defaultSnap.deltas?.T1 > 0)
} finally {
  server.close()
  rmSync(outDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`verify-fingerprint-drill: ${failures} failure(s)`)
  process.exit(1)
}
console.log('verify-fingerprint-drill: PASS')
