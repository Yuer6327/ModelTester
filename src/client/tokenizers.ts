/**
 * Tokenizer feature sets: distinctive special tokens pulled from the vendors'
 * official `tokenizer_config.json` (latest generation of each family, fetched
 * via the HF mirror on 2026-09-25; raw captures live in `.attr-corpus/tokenizers/`).
 *
 * These lists power the template-recognition probe and document what the
 * `tmpl-*` attribution rows match against. Anthropic and OpenAI do not
 * publish their tokenizers — Anthropic is covered by the antml artifact rows
 * and OpenAI by the `fp_…` / glitch-battery rows instead.
 */

import type { Vendor } from './attribution-signals.ts'

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
    model: 'DeepSeek-V3.2',
    source: 'deepseek-ai/DeepSeek-V3.2',
    tokens: ['<｜begin▁of▁sentence｜>', '<｜end▁of▁sentence｜>', '<｜User｜>', '<｜Assistant｜>', '<｜tool▁calls▁begin｜>'],
  },
  {
    vendor: 'qwen',
    model: 'Qwen3-235B-A22B-Instruct-2507',
    source: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    tokens: ['<|im_start|>', '<|im_end|>', '<|object_ref_start|>', '<|box_start|>', '<|quad_start|>', '<|vision_start|>'],
  },
  {
    vendor: 'zhipu',
    model: 'GLM-4.6',
    source: 'zai-org/GLM-4.6',
    tokens: ['<|observation|>', '<|system|>', '<|user|>', '<|assistant|>', '<arg_key>', '<arg_value>', '/nothink', '<|begin_of_box|>'],
  },
  {
    vendor: 'moonshot',
    model: 'Kimi-K2-Thinking',
    source: 'moonshotai/Kimi-K2-Thinking',
    tokens: ['<|im_middle|>', '<|im_user|>', '<|im_assistant|>', '<|im_system|>', '<|tool_calls_section_begin|>', '<|tool_call_begin|>'],
  },
  {
    vendor: 'minimax',
    model: 'MiniMax-M2.1',
    source: 'MiniMaxAI/MiniMax-M2.1',
    tokens: ['<minimax:tool_call>', '</minimax:tool_call>', ']<]image[>[', ']<]speech[>[', ']<]video[>[', ']!p~[', '[e~['],
  },
  {
    vendor: 'meta',
    model: 'Llama-4-Scout / Llama-3.3',
    source: 'unsloth/Llama-4-Scout-17B-16E-Instruct',
    tokens: ['<|begin_of_text|>', '<|header_start|>', '<|header_end|>', '<|eot|>', '<|eom|>', '<|python_start|>', '<|eot_id|>', '<|start_header_id|>'],
  },
  {
    vendor: 'mistral',
    model: 'Mistral-Small-3.2-24B-Instruct',
    source: 'unsloth/Mistral-Small-3.2-24B-Instruct-2506',
    tokens: ['[INST]', '[/INST]', '[TOOL_CALLS]', '[AVAILABLE_TOOLS]', '[/AVAILABLE_TOOLS]', '[SYSTEM_PROMPT]', '[ARGS]', '[CALL_ID]'],
  },
  {
    vendor: 'google',
    model: 'Gemma-3-27B-IT',
    source: 'unsloth/gemma-3-27b-it',
    tokens: ['<start_of_turn>', '<end_of_turn>', '<bos>', '<eos>'],
  },
  {
    vendor: 'ling',
    model: 'Ling-1T',
    source: 'inclusionAI/Ling-1T',
    tokens: ['<|role_end|>', '<|startoftext|>'],
  },
]

/** Vendors whose tokenizers are not public (covered by artifact rows instead). */
export const NON_PUBLIC_TOKENIZER_VENDORS: readonly { vendor: Vendor; note: string }[] = [
  { vendor: 'anthropic', note: 'tokenizer unpublished; covered by the antml namespace artifact rows' },
  { vendor: 'openai', note: 'tokenizer unpublished; covered by the fp_… rows and the cl100k/r50k glitch batteries' },
]
