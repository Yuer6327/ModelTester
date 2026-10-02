/**
 * Usage-delta fertility fingerprint — the plugin port of the drill's
 * quantitative tokenizer identification (fingerprint-drill.mjs --usage +
 * fingerprint-reference.py).
 *
 * The serving gateway reports per-turn usage; prompt-side tokens (total −
 * output) equal a per-message framing constant + the prompt text's token
 * count under the SERVING tokenizer. Sending the fixed fertility texts in
 * one session and differencing consecutive turns cancels both the session
 * wrapper and the framing constant, yielding the same delta vector the
 * drill measures with stateless requests:
 *
 *   measured(T_i) = P_i − P_{i−1} − C_{i−1}      (= tokens(T_i) + framing)
 *   vector_i      = measured(T_i) − measured(T0)  (= reference delta_i)
 *
 * where P = per-turn prompt-side usage, C = the previous turn's output
 * tokens. The vector is compared against the reference delta vectors from
 * the vendors' official tokenizers (captured 2026-09-26); L1 distance 0 is
 * an exact tokenizer-family match. Usage is billing data — the most
 * anti-forensics-resistant surface (faking it is faking one's own bill).
 *
 * Session protocol: each text goes to its OWN fresh session — that session's
 * prompt-side usage is wrapper + text tokens, and differencing across
 * sessions cancels the wrapper. Reply tokens never enter the measurement
 * (prompt side only), so uncapped reply lengths do not pollute the vector.
 * The shared-session alternative (differencing consecutive turns) fails on
 * the real host: the harness manages context dynamically, so per-turn prompt
 * deltas are not the text's tokens.
 *
 * Reference absences are honest: Moonshot K3 (tiktoken format) and InternLM
 * (vocab.json) ship no tokenizer.json and are missing from the table.
 * Near-duplicate vectors (deepseek-v4 == step, mistral == nemotron) are
 * reported as candidate pairs, never collapsed into one claim.
 *
 * FERTILITY_VERSION bumps when the texts or the reference table change.
 */

/** Version of the fertility probe texts, the reference table and the verdict
 *  schema (panel-persist keys stored verdicts on this; a bump invalidates
 *  stale stored verdicts so they are never re-displayed under new semantics). */
export const FERTILITY_VERSION = 3 as const

/** Fixed probe texts: T0 baseline + T1–T9 tokenizer-divergence dimensions. */
export const FERTILITY_TEXTS: readonly { readonly id: string; readonly text: string }[] = [
  { id: "T0", text: "Hi." },
  { id: "T1", text: "The ERESOLVE error appears because pnpm cannot reconcile the peer-dependency ranges declared by the two plugins; resolution therefore backtracks until it exceeds the configured retry budget and aborts the install." },
  { id: "T2", text: "The ERESOLVE error appears because pnpm cannot reconcile the peer-dependency ranges declared by the two plugins; resolution therefore backtracks until it exceeds the configured retry budget and aborts the install。而中文分词的粒度与英文显著不同：词与词之间没有空格，标点符号使用全角形式，例如「模型家族检测」和分词器的Token化策略。" },
  { id: "T3", text: "if (x[0] === \"a\" && y!.bar) { console.log(`${z}: ${JSON.stringify(w?.[1] ?? {})}`); } // eslint-disable-line @typescript-eslint/no-non-null-assertion" },
  { id: "T4", text: "Mixed scripts: 传入参数 🌀🚀 flags=0x1F4A9, naïve façade — Ångström Æ Ø 传𠀀 ſzette ₹ ₹€¥ ｷﾀｰ (half-width katakana) ①②③ Ⅷ ﷽" },
  { id: "T5", text: "2026-09-25T10:09:36Z 1,234,567 0xDEADBEEF 3.14159265358979 version>=2.1.0-beta.1+build.42 user@example.com https://example.com/a?b=1&c=2#frag" },
  { id: "T6", text: "👨‍👩‍👧‍👦 🏳️‍🌈 🇨🇳🇯🇵🇰🇷🇩🇪 #️⃣*️⃣0️⃣ 👍🏽🖐🏻👨🏼‍🎨 ZWJ sequences and flag emoji split wildly across vocabularies." },
  { id: "T7", text: "แผนการไทยมีเอกลักษณ์ 한국어는 교착어이며 형태소가 풍부하다 Русский язык использует падежи extensively for inflection." },
  { id: "T8", text: "function f() {\n\t\tconst a = 1;\n\t\tif (a) {\n\t\t\treturn `\n\t\t\t\tindented template\n\t\t\t`;\n\t\t}\n\t}\n    mixed tabs and four-space indent blocks      with trailing runs." },
  { id: "T9", text: "最小二乘法 least squares 拟合 residual 平方和 最小化 loss=L(θ)+λ‖θ‖₁ where λ trades sparsity against 均方误差, iterating until 收敛。" },
]

/** One reference family: vendor slot + official-tokenizer delta vector. */
export interface FertilityFamily {
  readonly id: string
  readonly vendor: import('./attribution-signals.ts').Vendor
  readonly model: string
  /** [T1..T9] deltas vs T0 under the official tokenizer. */
  readonly deltas: readonly (number | null)[]
}

/**
 * Reference delta vectors from the vendors' official tokenizers. Latest open
 * generation of every family as of 2026-10-02 (refreshed via proxy from the
 * official HF repos; the 2026-09-26 generation was 13 families). Reference
 * absences stay honest: Moonshot K3 (tiktoken), InternLM (vocab.json +
 * domain .model files), xAI (no published tokenizer.json) and Cohere (gated)
 * ship no loadable tokenizer.json and are absent by necessity, not omission.
 *
 * Bit-identical vocab twins are kept as separate rows and reported as
 * candidate groups (FERTILITY_TWINS), never collapsed into one claim.
 */
export const FERTILITY_FAMILIES: readonly FertilityFamily[] = [
  { id: "minimax-m3", vendor: "minimax", model: "MiniMax-M3 (vocab 200064)", deltas: [38, 76, 45, 60, 64, 66, 42, 45, 36] },
  { id: "deepseek-v4", vendor: "deepseek", model: "DeepSeek-V4.1-Flash (vocab 129280)", deltas: [40, 78, 50, 62, 67, 66, 31, 45, 39] },
  { id: "step", vendor: "step", model: "Step-3.5-Flash (vocab 128896; 与 deepseek-v4 同向量)", deltas: [40, 78, 50, 62, 67, 66, 31, 45, 39] },
  { id: "llama", vendor: "meta", model: "Llama-4 (vocab 202048)", deltas: [38, 76, 44, 63, 64, 69, 25, 45, 38] },
  { id: "glm", vendor: "zhipu", model: "GLM-5.3 (vocab 154880)", deltas: [37, 79, 45, 68, 68, 73, 48, 45, 42] },
  { id: "qwen", vendor: "qwen", model: "Qwen3.8 (vocab 248320)", deltas: [37, 75, 45, 66, 84, 100, 24, 52, 40] },
  { id: "gemma", vendor: "google", model: "Gemma-3 (vocab 262208)", deltas: [37, 78, 52, 56, 90, 47, 26, 50, 40] },
  { id: "mistral", vendor: "mistral", model: "Mistral-Small-3.x (vocab 131072)", deltas: [38, 90, 47, 72, 87, 123, 35, 45, 50] },
  { id: "nemotron", vendor: "nvidia", model: "NVIDIA Nemotron (vocab 131072; 与 mistral 同向量)", deltas: [38, 90, 47, 72, 87, 123, 33, 45, 50] },
  { id: "ling", vendor: "ling", model: "Ling-2.0 (vocab 157184)", deltas: [38, 74, 47, 66, 86, 75, 32, 55, 40] },
  { id: "xiaomi", vendor: "xiaomi", model: "MiMo-V2.6 (vocab 152576)", deltas: [37, 80, 45, 67, 84, 64, 37, 45, 44] },
  { id: "longcat", vendor: "meituan", model: "LongCat (vocab 131072)", deltas: [38, 76, 45, 70, 86, 69, 66, 45, 39] },
  { id: "yi", vendor: "yi", model: "Yi-1.5-34B (vocab 64000; 01.AI 最新开源词表代)", deltas: [40, 82, 61, 97, 91, 122, 118, 51, 48] },
  { id: "ernie", vendor: "baidu", model: "ERNIE-4.5-21B-A3B (vocab 100295)", deltas: [38, 78, 53, 85, 90, 83, 49, 59, 47] },
  { id: "hunyuan", vendor: "tencent", model: "Hunyuan-A13B-Instruct (vocab 127957)", deltas: [37, 77, 45, 72, 84, 79, 61, 45, 44] },
  { id: "seed", vendor: "bytedance", model: "Seed-OSS-36B-Instruct (vocab 155121)", deltas: [39, 77, 50, 69, 88, 70, 40, 53, 40] },
  { id: "minicpm", vendor: "openbmb", model: "MiniCPM4.1-8B (vocab 73440)", deltas: [39, 80, 61, 78, 92, 54, 103, 62, 44] },
  { id: "phi", vendor: "microsoft", model: "Phi-4 (vocab 100352; Granite-4/OLMo-3 同向量)", deltas: [37, 102, 45, 72, 63, 100, 61, 45, 51] },
  { id: "olmo", vendor: "ai2", model: "OLMo-3-32B (vocab 100278; 与 phi/granite 同向量)", deltas: [37, 102, 45, 72, 63, 100, 61, 45, 51] },
  { id: "granite", vendor: "ibm", model: "Granite-4.0-h-small (vocab 100352; 与 phi 同向量)", deltas: [37, 102, 45, 72, 63, 100, 61, 45, 51] },
  { id: "falcon", vendor: "tii", model: "Falcon-H1-34B-Instruct (vocab 261120)", deltas: [37, 78, 63, 67, 89, 64, 32, 56, 43] },
  { id: "exaone", vendor: "lg", model: "EXAONE-4.0.1-32B (vocab 102400)", deltas: [39, 120, 63, 78, 94, 94, 52, 51, 49] },
  { id: "baichuan", vendor: "baichuan", model: "Baichuan-M2-32B (vocab 151643; 与 xiaomi/skywork 同向量)", deltas: [37, 80, 45, 67, 84, 64, 37, 45, 44] },
  { id: "skywork", vendor: "skywork", model: "Skywork-OR1-32B (vocab 151643; 与 xiaomi/baichuan 同向量)", deltas: [37, 80, 45, 67, 84, 64, 37, 45, 44] },
]

/**
 * Resolution limits of the 9-dimension battery, computed exhaustively by
 * `node --experimental-strip-types verify-fertility-confusion.mjs` under the
 * constant-wrapper-offset model the consensus gate assumes. Keep in sync
 * with that script (it re-derives both tables from the reference vectors).
 *
 * - TWINS: groups whose every dimension is within WRAPPER_TOL of each other —
 *   indistinguishable by usage deltas alone, always presented as groups;
 *   separate them with other channels (template leaks, sibling A/B).
 * - CONFUSABLE: family pairs where the wrong family can pass the corrected
 *   gate under some single offset (≥ INLIER_MIN inliers, ≤ INLIER_L1_MAX
 *   mass). A verdict whose top two land on one of these pairs carries real
 *   ambiguity — the panel says so instead of presenting a clean winner.
 */
export const FERTILITY_TWINS: readonly (readonly string[])[] = [
  ["deepseek-v4", "step"],
  ["mistral", "nemotron"],
  ["xiaomi", "baichuan", "skywork"],
  ["phi", "granite", "olmo"],
]

export const FERTILITY_CONFUSABLE: readonly (readonly [string, string])[] = [
  ["baichuan", "glm"],
  ["baichuan", "hunyuan"],
  ["deepseek-v4", "falcon"],
  ["deepseek-v4", "gemma"],
  ["deepseek-v4", "granite"],
  ["deepseek-v4", "olmo"],
  ["deepseek-v4", "phi"],
  ["deepseek-v4", "qwen"],
  ["ernie", "exaone"],
  ["ernie", "falcon"],
  ["ernie", "gemma"],
  ["ernie", "yi"],
  ["exaone", "hunyuan"],
  ["exaone", "longcat"],
  ["exaone", "seed"],
  ["exaone", "yi"],
  ["falcon", "glm"],
  ["falcon", "llama"],
  ["falcon", "longcat"],
  ["falcon", "step"],
  ["falcon", "yi"],
  ["gemma", "minimax-m3"],
  ["gemma", "step"],
  ["gemma", "yi"],
  ["glm", "granite"],
  ["glm", "mistral"],
  ["glm", "nemotron"],
  ["glm", "olmo"],
  ["glm", "phi"],
  ["glm", "qwen"],
  ["glm", "skywork"],
  ["glm", "xiaomi"],
  ["glm", "yi"],
  ["granite", "hunyuan"],
  ["granite", "llama"],
  ["granite", "longcat"],
  ["granite", "minimax-m3"],
  ["granite", "mistral"],
  ["granite", "nemotron"],
  ["granite", "step"],
  ["hunyuan", "llama"],
  ["hunyuan", "longcat"],
  ["hunyuan", "minimax-m3"],
  ["hunyuan", "olmo"],
  ["hunyuan", "phi"],
  ["hunyuan", "skywork"],
  ["hunyuan", "xiaomi"],
  ["hunyuan", "yi"],
  ["llama", "longcat"],
  ["llama", "olmo"],
  ["llama", "phi"],
  ["longcat", "minicpm"],
  ["longcat", "minimax-m3"],
  ["longcat", "mistral"],
  ["longcat", "nemotron"],
  ["longcat", "olmo"],
  ["longcat", "phi"],
  ["longcat", "yi"],
  ["minimax-m3", "olmo"],
  ["minimax-m3", "phi"],
  ["mistral", "nemotron"],
  ["mistral", "olmo"],
  ["mistral", "phi"],
  ["mistral", "qwen"],
  ["mistral", "seed"],
  ["nemotron", "olmo"],
  ["nemotron", "phi"],
  ["nemotron", "qwen"],
  ["olmo", "step"],
  ["phi", "step"],
  ["qwen", "step"],
]

/** True when both family ids share one reference vector (twin group). */
export function fertilityTwinPair(a: string, b: string): boolean {
  return FERTILITY_TWINS.some(group => group.includes(a) && group.includes(b))
}

/** True when the pair can mutually pass the corrected gate under some offset. */
export function fertilityConfusablePair(a: string, b: string): boolean {
  return FERTILITY_CONFUSABLE.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
}
