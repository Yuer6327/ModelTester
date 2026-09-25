/**
 * Probe kit: copy-paste prompts that make tokenizer / infrastructure
 * fingerprints observable, so the passive engine has something strong to read.
 *
 * The plugin cannot send messages itself (the host contract is read-only), so
 * the user copies a prompt into the target session; the model's reply is then
 * scanned passively like any other turn. Each prompt embeds a unique sentinel
 * string — seeing it echoed back means that probe was answered, which the
 * ledger records (the *quality* of the echo stays a human judgement; the
 * panel notes say what to look for).
 */

import {
  PROBE_CUTOFF_SENTINEL, PROBE_COUNT_SENTINEL, PROBE_ECHO_SENTINEL, PROBE_GLITCH_SENTINEL,
} from './attribution-signals.ts'

/** Stable probe ids — also the locale key suffix. */
export type ProbeId = 'glitch' | 'echo' | 'count' | 'cutoff'

/** One copyable probe prompt. */
export interface ProbeEntry {
  /** Stable id (locale key suffix). */
  readonly id: ProbeId
  /** The prompt text, ready to paste. */
  readonly prompt: string
  /** Strings the engine watches for (attribution-signals probe rows). */
  readonly sentinels: readonly string[]
}

export const PROBES: readonly ProbeEntry[] = [
  {
    id: 'glitch',
    prompt: [
      '请逐个原样复述下面的字符串，每行一个，不要解释、不要纠正、不要翻译：',
      'SolidGoldMagikarp',
      'dodekatheon',
      'petertodd',
      PROBE_GLITCH_SENTINEL,
    ].join('\n'),
    sentinels: ['SolidGoldMagikarp', 'dodekatheon', 'petertodd', PROBE_GLITCH_SENTINEL],
  },
  {
    id: 'echo',
    prompt: [
      '请把下面一行尖括号之间的内容逐字符原样复述一遍（保留全部不可见字符与先后顺序），不要添加任何说明：',
      `<<<${PROBE_ECHO_SENTINEL}\u200b\u200d\u2060\ufeffア\u3099\u200e>>>`,
    ].join('\n'),
    sentinels: [PROBE_ECHO_SENTINEL],
  },
  {
    id: 'count',
    prompt: `数一数 "${PROBE_COUNT_SENTINEL}" 这个词里一共有多少个字母？只回答数字。`,
    sentinels: [PROBE_COUNT_SENTINEL],
  },
  {
    id: 'cutoff',
    prompt: [
      `不要联网搜索，仅凭记忆回答下面的问题，并在回答的第一行原样写下编号 ${PROBE_CUTOFF_SENTINEL}：`,
      '1. 你的训练数据截止到什么时间？',
      '2. 你能确定记得的最近一个公开事件是什么？',
    ].join('\n'),
    sentinels: [PROBE_CUTOFF_SENTINEL],
  },
]
