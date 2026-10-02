/**
 * GENERATED FILE — regenerate with `node mine-canaries.mjs`; never hand-edit.
 *
 * Family-specific glitch canaries mined from the official tokenizer.json
 * reference vocabs (.attr-corpus/tokenizers-json/, 2026-09-26 refresh).
 * Each string decodes to exactly ONE vocab entry in its family and in NO
 * other reference family, and is ranked by pathological text texture (mixed
 * scripts, rare Unicode blocks, repetition runs) — the vocab alone cannot
 * prove under-training, so degenerate echo (measured at run time, see
 * canaryEchoOf) is the actual signal: clean echo is no evidence either way.
 * Uniqueness is relative to the reference vocabs.
 */

import type { Vendor } from './attribution-signals.ts'

export interface FamilyCanaries {
  readonly familyId: string
  readonly vendor: Vendor
  readonly canaries: readonly string[]
}

export const FAMILY_CANARIES: readonly FamilyCanaries[] = [
  { familyId: "ernie", vendor: "baidu", canaries: ["اسی‌نین", "‌دیر", "‌لار"] },
  { familyId: "exaone", vendor: "lg", canaries: ["\\**", "\\*^", "^^*"] },
  { familyId: "falcon", vendor: "tii", canaries: ["؟‘‘", "۔‘‘", "‌آباد"] },
  { familyId: "gemma", vendor: "google", canaries: ["ه‌ای", "ه‌ها", "ه‌ی"] },
  { familyId: "glm", vendor: "zhipu", canaries: ["ciación", "éctr", "eración"] },
  { familyId: "hunyuan", vendor: "tencent", canaries: [",$\\", "):《", "-------|:"] },
  { familyId: "ling", vendor: "ling", canaries: ["’éta", "。\\\"", ".qqqxs"] },
  { familyId: "llama", vendor: "meta", canaries: ["’améli", "’attività", "’età"] },
  { familyId: "longcat", vendor: "meituan", canaries: ["......[", "{IEEE", "_{|\\"] },
  { familyId: "minicpm", vendor: "openbmb", canaries: [":\\\\\\\\", "……[", "']]],\\"] },
  { familyId: "minimax-m3", vendor: "minimax", canaries: ["%|████████", "’Académie", "’accéder"] },
  { familyId: "qwen", vendor: "qwen", canaries: ["؟**", "َائ", "َاد"] },
  { familyId: "seed", vendor: "bytedance", canaries: ["…Expand", "’ny", "[–]"] },
  { familyId: "yi", vendor: "yi", canaries: ["……”\\", "…”\\", "’”\\"] },
]
