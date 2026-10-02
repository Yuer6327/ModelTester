#!/usr/bin/env node
/**
 * Mine family-specific glitch canaries from the official tokenizer.json
 * reference vocabs (.attr-corpus/tokenizers-json/, refreshed 2026-09-26).
 *
 * A canary is a short text S such that the SERVING tokenizer produces ONE
 * under-trained token for it. If the model echoes S with degenerate
 * repetition (the SolidGoldMagikarp signature), the serving vocab contains
 * that single token — and if S decodes to exactly one vocab entry in family
 * X and in NO other reference family, the degeneration points at X.
 *
 * Pipeline per family:
 *   1. Decode every vocab token into sendable text:
 *      - GPT-2 byte-level vocabs (Ġ/Ċ markers present): map chars → bytes via
 *        the standard byte↔unicode table, then strict UTF-8 decode (split
 *        multibyte merges don't decode and are skipped — they cannot be sent
 *        as text anyway);
 *      - SentencePiece vocabs (▁ / <0xNN>): keep only marker-free literal
 *        pieces, used verbatim.
 *   2. Keep decoded texts that are 3–10 printable chars, no control/whitespace
 *      runs, no U+FFFD.
 *   3. A candidate canary must be unique: present as a decoded text in exactly
 *      one family's set (checked across all reference vocabs).
 *   4. Rank by a pathological-texture score (mixed scripts, rare Unicode
 *      blocks, repetition runs, symbol density) — the vocab alone cannot prove
 *      under-training, so this picks the tokens MOST LIKELY to glitch; the
 *      live echo behavior is the actual measurement (degenerate ⇒ under-trained).
 *   5. Emit src/client/canaries.ts (FAMILY_CANARIES) — regenerate by running
 *      this script; the table is data, the panel never invents canaries.
 *
 * Honesty notes carried into the generated table: uniqueness is relative to
 * the reference vocabs; a serving vocab outside the reference set can still
 * contain a canary by coincidence, and a well-trained canary echoes cleanly
 * (no signal, no false positive). Degenerate echo is measured at run time by
 * the panel (canaryEchoOf), never asserted here.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CORPUS = '.attr-corpus/tokenizers-json'
const OUT = 'src/client/canaries.ts'
const PER_FAMILY = 3

/** Standard GPT-2 byte↔unicode table (bytes → printable mapped chars). */
function byteCharTables() {
  const bs = []
  for (let b = 33; b <= 126; b++) bs.push(b)
  for (let b = 161; b <= 172; b++) bs.push(b)
  for (let b = 174; b <= 255; b++) bs.push(b)
  const cs = [...bs]
  let n = 0
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b)
      cs.push(256 + n)
      n += 1
    }
  }
  const charToByte = new Map()
  const byteToChar = new Map()
  for (let i = 0; i < bs.length; i++) {
    charToByte.set(String.fromCodePoint(cs[i]), bs[i])
    byteToChar.set(bs[i], String.fromCodePoint(cs[i]))
  }
  return { charToByte, byteToChar }
}
const { charToByte } = byteCharTables()

/** Decode one vocab token into sendable text (null when not transportable). */
function decodeToken(token, gpt2) {
  if (/[\u0000-\u001F\u007F\uFFFD]/.test(token)) return null
  // Template-shaped pieces never become canaries: serving stacks may parse
  // them as tool-call / reasoning markup instead of echoing them as text.
  // Bracket-pipe combos ([|role|], <|x|>) are role dialects — excluded too.
  if (/[<>]/.test(token) || /^\[[A-Za-z_]+\]$/.test(token)) return null
  if (token.includes('[|') || token.includes('|]')) return null
  // Reserved placeholders ([unusedN], <|dummyN|>, >>UNUSED_n<<) say nothing
  // about a vocab's linguistic texture — the repo treats them as unmatched.
  if (/unused|dummy|placeholder|_pad|never_used/i.test(token)) return null
  if (gpt2) {
    if (token.includes('▁')) return null
    const bytes = []
    for (const ch of token) {
      const b = charToByte.get(ch)
      if (b === undefined) return null
      bytes.push(b)
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
      // Marker chars (▁/Ġ/Ċ …) surfacing from byte sequences never round-trip as literal text.
      if(/[▁ĠĊĪŊ]/.test(text)) return null
      return text
    } catch {
      return null
    }
  }
  // SentencePiece: only marker-free literal pieces round-trip as-is.
  if (token.includes('▁') || /^<0x[0-9A-F]{2}>$/.test(token)) return null
  return token
}

/** Script/blocks that mark a token as likely under-trained. */const RARE_BLOCK_TESTS = [
  /[\u4DB5-\u4DBF\u20000-\u2A6DF]/, // CJK ext B+
  /[\u1D300-\u1D35F]/, // Yijing / Tai Xuan
  /[\uFE10-\uFE1F\uFE30-\uFE4F]/, // vertical forms
  /[\uFE50-\uFE6F\uFF65-\uFF9F]/, // small forms / halfwidth kana
  /[\u1D000-\u1D0FF\u1D100-\u1D1FF]/, // musical notation
  /[\u2E80-\u2EFF\u2F00-\u2FDF]/, // CJK radicals
  /[\u31C0-\u31EF\u31F0-\u31FF]/, // CJK strokes / katakana phonetic ext
  /[\uA000-\uA48F\uA490-\uA4CF]/, // Yi / Yi radicals
  /[\u1700-\u171F\u1800-\u18AF\u1980-\u19DF]/, // Tagalog / Mongolian / New Tai Lue
  /[\u2800-\u28FF]/, // Braille
  /[\u0590-\u05FF\u0600-\u06FF\u0E00-\u0E7F]/, // Hebrew / Arabic / Thai roots
]
function scriptWeirdness(text) {
  const scripts = new Set()
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if (c >= 0x2E80 && c <= 0x9FFF) scripts.add('cjk')
    else if (c >= 0x3040 && c <= 0x30FF) scripts.add('kana')
    else if (c >= 0xAC00 && c <= 0xD7AF) scripts.add('hangul')
    else if (c >= 0x0400 && c <= 0x04FF) scripts.add('cyrillic')
    else if (c >= 0x0370 && c <= 0x03FF) scripts.add('greek')
    else if (c >= 0x0600 && c <= 0x06FF) scripts.add('arabic')
    else if (c >= 0x0E00 && c <= 0x0E7F) scripts.add('thai')
    else if (c >= 0x0041 && c <= 0x007A) scripts.add('latin')
    else if (c >= 0x2000 && c <= 0x2BFF) scripts.add('symbol')
    else scripts.add('other')
  }
  let score = (scripts.size - 1) * 3
  for (const re of RARE_BLOCK_TESTS) if (re.test(text)) score += 4
  if (/(.)\1{2,}/u.test(text)) score += 2
  const symbols = [...text].filter(ch => /[\u2000-\u2BFF\uFF00-\uFFEF]/u.test(ch)).length
  score += Math.min(symbols, 3)
  if (/^[\u0041-\u007A]+$/.test(text)) score -= 6 // plain ASCII word: almost surely well-trained
  // Single-script letter words (any alphabet) are usually trained enough to
  // echo cleanly — demote them so punctuation garbage and script mixes lead.
  const letters = [...text].filter(ch => /\p{L}/u.test(ch)).length
  if (scripts.size === 1 && letters / [...text].length >= 0.8) score -= 3
  return score
}

// --- Load and decode every reference vocab.
const files = readdirSync(CORPUS).filter(f => f.endsWith('.json'))
const textsByFamily = new Map()
const meta = []
for (const file of files) {
  const id = file.replace(/\.json$/, '')
  const json = JSON.parse(readFileSync(join(CORPUS, file), 'utf8'))
  const vocab = json.model?.vocab
  if (!vocab) throw new Error(`no model.vocab in ${file}`)
  const keys = Object.keys(vocab)
  // Regime by marker share: GPT-2 byte-level vocabs map whole ranges through
  // Ġ/Ċ; a stray literal Ġ in an SP vocab must not flip the decoder.
  const marked = keys.filter(k => k.includes('Ġ') || k.includes('Ċ')).length
  const gpt2 = marked / keys.length > 0.05
  const texts = new Set()
  for (const token of keys) {
    const text = decodeToken(token, gpt2)
    if (text !== null && text.length >= 3 && text.length <= 10 && !/\s/u.test(text)) texts.add(text)
  }
  textsByFamily.set(id, texts)
  meta.push({ id, gpt2, size: Object.keys(vocab).length, decoded: texts.size })
}
console.log('decoded transportable texts per family:')
for (const m of meta) console.log(`  ${m.id.padEnd(14)} ${m.gpt2 ? 'gpt2-byte' : 'spm-literal'}  vocab ${m.size}  → ${m.decoded} texts`)

// --- Uniqueness across families, then rank by weirdness.
const table = []
for (const { id } of meta) {
  const others = meta.filter(m => m.id !== id).map(m => textsByFamily.get(m.id))
  const candidates = []
  for (const text of textsByFamily.get(id)) {
    if (others.some(set => set.has(text))) continue
    const weird = scriptWeirdness(text)
    if (weird < 1) continue
    candidates.push({ text, weird })
  }
  candidates.sort((a, b) => b.weird - a.weird || a.text.localeCompare(b.text))
  table.push({ id, canaries: candidates.slice(0, PER_FAMILY) })
}

console.log('\nmined canaries (unique to the family across all reference vocabs):')
const missing = []
for (const { id, canaries } of table) {
  if (canaries.length === 0) missing.push(id)
  console.log(`  ${id.padEnd(14)} ${canaries.map(c => JSON.stringify(c.text)).join('  ')}`)
}
if (missing.length > 0) console.log(`families with no candidate: ${missing.join(', ')} (emitted empty — no fabrication)`)

// --- Emit the generated table.
const vendorOf = {
  'minimax-m3': 'minimax', 'deepseek-v4': 'deepseek', step: 'step', llama: 'meta', glm: 'zhipu',
  qwen: 'qwen', gemma: 'google', mistral: 'mistral', nemotron: 'nvidia', ling: 'ling',
  xiaomi: 'xiaomi', longcat: 'meituan', yi: 'yi', ernie: 'baidu', hunyuan: 'tencent',
  seed: 'bytedance', minicpm: 'openbmb', phi: 'microsoft', olmo: 'ai2', granite: 'ibm',
  falcon: 'tii', exaone: 'lg', baichuan: 'baichuan', skywork: 'skywork',
}
const lines = []
lines.push('/**')
lines.push(' * GENERATED FILE — regenerate with `node mine-canaries.mjs`; never hand-edit.')
lines.push(' *')
lines.push(' * Family-specific glitch canaries mined from the official tokenizer.json')
lines.push(' * reference vocabs (.attr-corpus/tokenizers-json/, 2026-09-26 refresh).')
lines.push(' * Each string decodes to exactly ONE vocab entry in its family and in NO')
lines.push(' * other reference family, and is ranked by pathological text texture (mixed')
lines.push(' * scripts, rare Unicode blocks, repetition runs) — the vocab alone cannot')
lines.push(' * prove under-training, so degenerate echo (measured at run time, see')
lines.push(' * canaryEchoOf) is the actual signal: clean echo is no evidence either way.')
lines.push(' * Uniqueness is relative to the reference vocabs.')
lines.push(' */')
lines.push('')
lines.push('import type { Vendor } from \'./attribution-signals.ts\'')
lines.push('')
lines.push('export interface FamilyCanaries {')
lines.push('  readonly familyId: string')
lines.push('  readonly vendor: Vendor')
lines.push('  readonly canaries: readonly string[]')
lines.push('}')
lines.push('')
lines.push('export const FAMILY_CANARIES: readonly FamilyCanaries[] = [')
for (const { id, canaries } of table) {
  const vendor = vendorOf[id]
  if (vendor === undefined) throw new Error(`no vendor mapping for ${id}`)
  if (canaries.length === 0) continue
  const items = canaries.map(c => JSON.stringify(c.text)).join(', ')
  lines.push(`  { familyId: ${JSON.stringify(id)}, vendor: ${JSON.stringify(vendor)}, canaries: [${items}] },`)
}
lines.push(']')
lines.push('')
writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(`\nwrote ${OUT}`)
