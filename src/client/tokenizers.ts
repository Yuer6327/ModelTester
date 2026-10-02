/**
 * Tokenizer feature sets: distinctive special tokens pulled from the vendors'
 * official `tokenizer_config.json` / chat templates — latest open generation
 * of each family, re-captured from HuggingFace (2026-09-26 refresh; 2026-10-02
 * refresh added ByteDance Seed / AI2 OLMo / IBM Granite / TII Falcon / Baidu
 * ERNIE / LG EXAONE and re-based Yi onto Yi-1.5; raw captures live in
 * `.attr-corpus/tokenizers/`; the offline L1 corpus in
 * `.attr-corpus/tokenizers-json/` is refreshed to the same generations, 25
 * families total).
 *
 * Vendors whose token lists are entirely shared with other families carry no
 * set here (their identity resolves through the usage fingerprint): Baichuan
 * and Skywork (Qwen-derived vocab, MiMo-vector twins) and Hunyuan and
 * MiniCPM (no distinctive specials in their official configs). Closed vendors
 * without published tokenizers are covered differently: Anthropic by the
 * antml artifact rows, OpenAI by the `fp_…` / glitch-battery rows, xAI and
 * NVIDIA by catalog / vocab-size / behavioral layers (Nemotron's specials are
 * reserved placeholders only — a Llama-3 derivative, nothing distinctive to
 * match). Moonshot's K3 tokenizer is tiktoken-format (no tokenizer.json),
 * InternLM ships vocab.json + domain .model files — both are absent from the
 * offline L1 corpus by necessity, not omission.
 */

import type { Vendor } from './attribution-signals.ts'

/** Vendors whose tokenizers are not public (covered by artifact rows instead). */
export const NON_PUBLIC_TOKENIZER_VENDORS: readonly { vendor: Vendor; note: string }[] = [
  { vendor: 'anthropic', note: 'tokenizer unpublished; covered by the antml namespace artifact rows' },
  { vendor: 'openai', note: 'tokenizer unpublished; covered by the fp_… rows and the cl100k/r50k glitch batteries' },
  { vendor: 'xai', note: 'tokenizer unpublished; covered by catalog/vocab-size/behavioral layers' },
  { vendor: 'nvidia', note: 'Nemotron specials are reserved placeholders only (Llama-3 derivative) — nothing distinctive to match; covered by the 131072 vocab cluster and behavioral layers' },
]

/** One vendor's curated distinctive special tokens. */
export interface TokenizerFeatureSet {
  readonly vendor: Vendor
  /** The model generation the tokens were captured from. */
  readonly model: string
  /** Source repository (HF path). */
  readonly source: string
  /** Distinctive tokens: fused special tokens unlikely in other families. */
  readonly tokens: readonly string[]
}

export const TOKENIZER_FEATURE_SETS: readonly TokenizerFeatureSet[] = [
  {
    vendor: 'deepseek',
    model: 'DeepSeek-V4.1-Flash (V3.x line, vocab 129280)',
    source: 'deepseek-ai/DeepSeek-V4.1-Flash',
    tokens: ['<｜begin▁of▁sentence｜>', '<｜end▁of▁sentence｜>', '<｜User｜>', '<｜Assistant｜>', '<｜tool▁calls▁begin｜>'],
  },
  {
    vendor: 'qwen',
    model: 'Qwen3.8-2.4T-A95B (vocab 248320 — grew from 151936)',
    source: 'Qwen/Qwen3.8-2.4T-A95B',
    tokens: ['<|im_start|>', '<|im_end|>', '<tts_text_bos>', '<tts_text_eod>', '<|audio_pad|>', '<|fim_pad|>'],
  },
  {
    vendor: 'zhipu',
    model: 'GLM-5.3 (vocab 154880)',
    source: 'zai-org/GLM-5.3',
    tokens: ['<sop>', '<|observation|>', '<arg_key>', '</arg_key>', '<|reminder|>', '<|system|>'],
  },
  {
    vendor: 'moonshot',
    model: 'Kimi-K3 / K2.x (tiktoken, vocab 163840)',
    source: 'moonshotai/Kimi-K3',
    tokens: ['<|end_of_msg|>', '<|open|>', '<|close|>', '<|sep|>', '[start_header_id]', '[end_header_id]', '<osagent_mode>', '<|media_begin|>', '<|im_middle|>', '<|im_user|>', '<|im_assistant|>', '<|tool_calls_section_begin|>'],
  },
  {
    vendor: 'minimax',
    model: 'MiniMax-M3 / M2.7 (vocab 200064)',
    source: 'MiniMaxAI/MiniMax-M3',
    tokens: ['<mm:think>', '</mm:think>', '<minimax:tool_call>', ']<]minimax[>[', ']<]frame[>[', ']<]image[>[', '<|content_altered_placeholder|>', ']!p~[', '[e~['],
  },
  {
    vendor: 'xiaomi',
    model: 'MiMo-V2.6-Flash-RL (config vocab 152576)',
    source: 'XiaomiMiMo/MiMo-V2.6-Flash-RL',
    tokens: ['<|mimo_video_start|>', '<|mimo_video_end|>', '<|mimo_audio_start|>', '<|mimo_audio_eod|>', '<|mimo_audio_end|>'],
  },
  {
    vendor: 'meituan',
    model: 'LongCat-Flash-Lite-Sparse (vocab 131072)',
    source: 'meituan-longcat/LongCat-Flash-Lite-Sparse',
    tokens: ['<longcat_think>', '</longcat_think>', '<longcat_tool_call>', '<longcat_arg_key>', '<longcat_observation>', '<longcat_files>'],
  },
  {
    vendor: 'internlm',
    model: 'Intern-S1-Pro (config vocab 155008)',
    source: 'internlm/Intern-S1-Pro',
    tokens: ['<|interpreter|>', '<|plugin|>', '<|ts|>', '<SMILES>', '</SMILES>', '<protein>', '<dna>', '<rna>'],
  },
  {
    vendor: 'step',
    model: 'Step-3.5-Flash (vocab 128896 — DeepSeek-style full-width frame)',
    source: 'stepfun-ai/Step-3.5-Flash',
    tokens: ['<|EOT|>', '<｜▁pad▁｜>', '<｜fim▁begin｜>', '<｜place▁holder▁no▁14｜>'],
  },
  {
    vendor: 'yi',
    model: 'Yi-1.5-34B-Chat (vocab 64000 — 01.AI latest open-vocab generation)',
    source: '01-ai/Yi-1.5-34B-Chat',
    tokens: ['<|im_sep|>', '<|startoftext|>'],
  },
  {
    vendor: 'meta',
    model: 'Llama-4-Scout (vocab 202048 — grew from 128256)',
    source: 'unsloth/Llama-4-Scout-17B-16E-Instruct',
    tokens: ['<|begin_of_text|>', '<|header_start|>', '<|header_end|>', '<|eot|>', '<|eom|>', '<|python_start|>'],
  },
  {
    vendor: 'mistral',
    model: 'Mistral-Small-3.x-24B (vocab 131072, 1000 reserved specials)',
    source: 'unsloth/Mistral-Small-24B-Base-2501',
    tokens: ['[INST]', '[/INST]', '[TOOL_CALLS]', '[AVAILABLE_TOOLS]', '[/AVAILABLE_TOOLS]', '[SYSTEM_PROMPT]', '[ARGS]', '[CALL_ID]'],
  },
  {
    vendor: 'google',
    model: 'Gemma-3-27B-IT (vocab 262208)',
    source: 'unsloth/gemma-3-27b-it',
    tokens: ['<start_of_turn>', '<end_of_turn>', '<bos>', '<eos>'],
  },
  {
    vendor: 'ling',
    model: 'Ling-mini-2.0 (vocab 157184)',
    source: 'inclusionAI/Ling-mini-2.0',
    tokens: ['<|role_end|>', '<role>', '<function-name>', '<args-json-object>'],
  },
  {
    vendor: 'bytedance',
    model: 'Seed-OSS-36B-Instruct (vocab 155121)',
    source: 'ByteDance-Seed/Seed-OSS-36B-Instruct',
    tokens: ['<seed:bos>', '<seed:think>', '</seed:think>', '<seed:tool_call>', '</seed:tool_call>', '<seed:cot_budget_reflect>'],
  },
  {
    vendor: 'ai2',
    model: 'OLMo-3-32B (vocab 100278 — vector twin of Phi-4/Granite-4)',
    source: 'allenai/Olmo-3-32B-Think',
    tokens: ['|||PHONE_NUMBER|||', '|||EMAIL_ADDRESS|||', '|||IP_ADDRESS|||', '<|endofprompt|>'],
  },
  {
    vendor: 'ibm',
    model: 'Granite-4.0-h-small (vocab 100352 — vector twin of Phi-4/OLMo-3)',
    source: 'ibm-granite/granite-4.0-h-small',
    tokens: ['<|start_of_role|>', '<|end_of_role|>', '<|start_of_plugin|>', '<|end_of_plugin|>', '<think_on>', '<think_off>'],
  },
  {
    vendor: 'tii',
    model: 'Falcon-H1-34B-Instruct (vocab 261120)',
    source: 'tiiuae/Falcon-H1-34B-Instruct',
    tokens: ['>>TITLE<<', '>>ABSTRACT<<', '>>INTRODUCTION<<', '>>SUMMARY<<', '>>QUESTION<<', '>>ANSWER<<', '>>DOMAIN<<'],
  },
  {
    vendor: 'baidu',
    model: 'ERNIE-4.5-21B-A3B (vocab 100295)',
    source: 'baidu/ERNIE-4.5-21B-A3B-PT',
    tokens: ['<|IMAGE_PLACEHOLDER|>', '<|AUDIO_PLACEHOLDER|>', '<|LOC_0|>'],
  },
  {
    vendor: 'lg',
    model: 'EXAONE-4.0.1-32B (vocab 102400)',
    source: 'LGAI-EXAONE/EXAONE-4.0.1-32B',
    tokens: ['[|endofturn|]', '[|assistant|]', '[|user|]', '[|system|]', '[|tool|]', 'PI:URL', 'PI:EMAIL'],
  },
]
