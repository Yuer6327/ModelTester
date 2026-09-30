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

/** Version of the fertility probe texts and the reference table. */
export const FERTILITY_VERSION = 1 as const

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

/** Reference delta vectors from the vendors' official tokenizers (captured 2026-09-26). */
export const FERTILITY_FAMILIES: readonly FertilityFamily[] = [
  { id: "minimax-m3", vendor: "minimax", model: "MiniMax-M3 (vocab 200064)", deltas: [38, 76, 45, 60, 64, 66, 42, 45, 36] },
  { id: "deepseek-v4", vendor: "deepseek", model: "DeepSeek-V4.1-Flash (vocab 129280; Step-3.5 逐位同向量)", deltas: [40, 78, 50, 62, 67, 66, 31, 45, 39] },
  { id: "step", vendor: "step", model: "Step-3.5-Flash (vocab 128896; 与 deepseek-v4 同向量)", deltas: [40, 78, 50, 62, 67, 66, 31, 45, 39] },
  { id: "llama", vendor: "meta", model: "Llama-4 (vocab 202048)", deltas: [38, 76, 44, 63, 64, 69, 25, 45, 38] },
  { id: "glm", vendor: "zhipu", model: "GLM-5.3 (vocab 154880)", deltas: [37, 79, 45, 68, 68, 73, 48, 45, 42] },
  { id: "qwen", vendor: "qwen", model: "Qwen3.8 (vocab 248320)", deltas: [37, 75, 45, 66, 84, 100, 24, 52, 40] },
  { id: "gemma", vendor: "google", model: "Gemma-3 (vocab 262208)", deltas: [37, 78, 52, 56, 90, 47, 26, 50, 40] },
  { id: "mistral", vendor: "mistral", model: "Mistral-Small-3.x (vocab 131072; Nemotron 逐位同向量)", deltas: [38, 90, 47, 72, 87, 123, 35, 45, 50] },
  { id: "nemotron", vendor: "nvidia", model: "NVIDIA Nemotron (vocab 131072; 与 mistral 同向量)", deltas: [38, 90, 47, 72, 87, 123, 33, 45, 50] },
  { id: "ling", vendor: "ling", model: "Ling-2.0 (vocab 157184)", deltas: [38, 74, 47, 66, 86, 75, 32, 55, 40] },
  { id: "xiaomi", vendor: "xiaomi", model: "MiMo-V2.6 (vocab 152576)", deltas: [37, 80, 45, 67, 84, 64, 37, 45, 44] },
  { id: "longcat", vendor: "meituan", model: "LongCat (vocab 131072)", deltas: [38, 76, 45, 70, 86, 69, 66, 45, 39] },
  { id: "yi", vendor: "yi", model: "Yi-34B (vocab 64000)", deltas: [40, 82, 61, 97, 91, 122, 118, 51, 48] },
]
