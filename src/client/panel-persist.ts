/**
 * Panel result persistence (localStorage, best-effort).
 *
 * Run results (batch verdict, fertility fingerprint) are kept so they survive
 * a page reload — runs cost real tokens and the verdict should outlive the
 * tab that produced it. Records carry the version of the machinery that
 * produced them plus a measurement timestamp; malformed or version-mismatched
 * records are rejected on load, never half-applied. Storage failures (private
 * mode, quota) are non-fatal: the panel keeps its in-memory result.
 */

import { VENDORS, type Vendor } from './attribution-signals.ts'
import { FERTILITY_FAMILIES, FERTILITY_VERSION } from './fertility.ts'
import type { BatchGuess } from './batch.ts'
import type { FertilityVerdict } from './fertility-score.ts'

const BATCH_KEY = 'dsh-modeltester.batchresult.v1'
const FERTILITY_KEY = `dsh-modeltester.fertility.v${FERTILITY_VERSION}`

/** One stored batch verdict with its measurement time. */
export interface StoredBatch {
  readonly at: string
  readonly guess: BatchGuess
  readonly claims: readonly Vendor[]
  readonly coverage: { answered: number; total: number }
  /** Agent presets observed across the run's sessions (audit; absent on old records). */
  readonly presets?: readonly string[]
  /** The preset the run requested (audit; absent = no request or old record). */
  readonly presetRequest?: string
}

/** One stored fertility verdict with its measurement time. */
export interface StoredFertility {
  readonly at: string
  readonly verdict: FertilityVerdict
  /** The preset the run requested (audit; absent = no request or old record). */
  readonly presetRequest?: string
}

function readRaw(key: string): unknown {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(key)
    return raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: unknown): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode / quota: non-fatal */
  }
}

function isVendor(value: unknown): value is Vendor {
  return typeof value === 'string' && (VENDORS as readonly string[]).includes(value)
}

const CONFIDENCES = ['none', 'low', 'medium', 'high'] as const

/** Validate a stored batch record (null on any shape/version problem). */
export function parseStoredBatch(raw: unknown): StoredBatch | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { at?: unknown; guess?: unknown; claims?: unknown; coverage?: unknown; presets?: unknown; presetRequest?: unknown }
  if (typeof r.at !== 'string' || typeof r.guess !== 'object' || r.guess === null) return null
  const g = r.guess as { vendor?: unknown; confidence?: unknown; confidenceValue?: unknown; hits?: unknown }
  // vendor: null is a valid stored outcome ("nothing rankable this run").
  const vendor = g.vendor === null || g.vendor === undefined
    ? null
    : isVendor(g.vendor) ? g.vendor : null
  if (typeof g.confidence !== 'string'
    || !(CONFIDENCES as readonly string[]).includes(g.confidence)
    || typeof g.confidenceValue !== 'number' || !Array.isArray(g.hits)) return null
  const hits = []
  for (const hit of g.hits) {
    if (typeof hit !== 'object' || hit === null) return null
    const h = hit as { vendor?: unknown; tokens?: unknown }
    if (!isVendor(h.vendor) || !Array.isArray(h.tokens)) return null
    hits.push({ vendor: h.vendor, tokens: h.tokens.filter((t): t is string => typeof t === 'string') })
  }
  const claims = Array.isArray(r.claims) ? r.claims.filter((c): c is Vendor => isVendor(c)) : []
  const coverage = typeof r.coverage === 'object' && r.coverage !== null
    && typeof (r.coverage as { answered?: unknown }).answered === 'number'
    && typeof (r.coverage as { total?: unknown }).total === 'number'
    ? { answered: (r.coverage as { answered: number }).answered, total: (r.coverage as { total: number }).total }
    : { answered: 0, total: 0 }
  // Preset audit fields: absent on records from before the preset surface.
  const presets = Array.isArray(r.presets)
    ? [...new Set(r.presets.filter((p): p is string => typeof p === 'string' && p !== ''))].sort()
    : undefined
  const presetRequest = typeof r.presetRequest === 'string' && r.presetRequest !== '' ? r.presetRequest : undefined
  return {
    at: r.at,
    claims,
    coverage,
    ...(presets === undefined || presets.length === 0 ? {} : { presets }),
    ...(presetRequest === undefined ? {} : { presetRequest }),
    guess: {
      vendor,
      confidence: g.confidence as BatchGuess['confidence'],
      confidenceValue: g.confidenceValue,
      candidates: [],
      hits,
    },
  }
}

/** Validate a stored fertility record (null on any shape/version problem). */
export function parseStoredFertility(raw: unknown): StoredFertility | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { at?: unknown; verdict?: unknown; presetRequest?: unknown }
  if (typeof r.at !== 'string' || typeof r.verdict !== 'object' || r.verdict === null) return null
  const v = r.verdict as {
    measured?: unknown; measuredCounts?: unknown; wrapperBaseline?: unknown; usable?: unknown
    drift?: unknown; wrapperSpread?: unknown; candidates?: unknown; outlierDims?: unknown; presets?: unknown
  }
  if (typeof v.measured !== 'number' || typeof v.usable !== 'boolean' || !Array.isArray(v.candidates)) return null
  const candidates = []
  for (const candidate of v.candidates) {
    if (typeof candidate !== 'object' || candidate === null) return null
    const c = candidate as { familyId?: unknown; family?: unknown; l1?: unknown; dims?: unknown; inliers?: unknown; inlierL1?: unknown; offset?: unknown }
    // Accept both the normalized shape (familyId) and a legacy shape that
    // serialized the whole family object.
    const familyId = typeof c.familyId === 'string'
      ? c.familyId
      : typeof (c.family as { id?: unknown } | null)?.id === 'string' ? (c.family as { id: string }).id : null
    const family = familyId === null ? undefined : FERTILITY_FAMILIES.find(f => f.id === familyId)
    if (family === undefined || typeof c.l1 !== 'number' || typeof c.dims !== 'number') return null
    // Records from the pre-drift-guard scorer (v1) carry no consensus fields;
    // they degrade to "everything inlier, offset 0" — display-only legacy.
    const inliers = typeof c.inliers === 'number' ? c.inliers : c.dims
    const inlierL1 = typeof c.inlierL1 === 'number' ? c.inlierL1 : c.l1
    const offset = typeof c.offset === 'number' ? c.offset : 0
    candidates.push({ family, l1: c.l1, dims: c.dims, inliers, inlierL1, offset })
  }
  const measuredCounts: Record<string, number> = {}
  if (typeof v.measuredCounts === 'object' && v.measuredCounts !== null) {
    for (const [id, value] of Object.entries(v.measuredCounts)) {
      if (typeof value === 'number') measuredCounts[id] = value
    }
  }
  const wrapperBaseline = typeof v.wrapperBaseline === 'number' ? v.wrapperBaseline : null
  const wrapperSpread = typeof v.wrapperSpread === 'number' ? v.wrapperSpread : null
  const outlierDims = Array.isArray(v.outlierDims)
    ? v.outlierDims.filter((d): d is string => typeof d === 'string')
    : []
  // Preset audit: absent on records from before the preset surface (and on
  // pre-preset scorer output, which parse must not fabricate as "no preset").
  const presets = Array.isArray(v.presets)
    ? [...new Set(v.presets.filter((p): p is string => typeof p === 'string' && p !== ''))].sort()
    : []
  const presetRequest = typeof r.presetRequest === 'string' && r.presetRequest !== '' ? r.presetRequest : undefined
  return {
    at: r.at,
    ...(presetRequest === undefined ? {} : { presetRequest }),
    verdict: {
      candidates,
      measured: v.measured,
      measuredCounts,
      usable: v.usable,
      wrapperBaseline,
      wrapperSpread,
      drift: v.drift === true,
      outlierDims,
      presets,
    },
  }
}

/** Test-created session ids the plugin itself minted (for bulk cleanup). */
const TEST_SESSIONS_KEY = 'dsh-modeltester.test-sessions'

export function trackTestSession(sessionId: string): void {
  try {
    const raw = window.localStorage.getItem(TEST_SESSIONS_KEY)
    const ids: string[] = raw === null ? [] : JSON.parse(raw)
    if (Array.isArray(ids) && !ids.includes(sessionId)) {
      const trimmed = [...ids, sessionId].slice(-200)
      window.localStorage.setItem(TEST_SESSIONS_KEY, JSON.stringify(trimmed))
    }
  } catch {
    /* non-fatal */
  }
}

export function loadTestSessions(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(TEST_SESSIONS_KEY)
    const ids: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function clearTestSessions(removed: readonly string[]): void {
  const remaining = loadTestSessions().filter(id => !removed.includes(id))
  try {
    window.localStorage.setItem(TEST_SESSIONS_KEY, JSON.stringify(remaining))
  } catch {
    /* non-fatal */
  }
}

/** Load the stored batch verdict, if any. */
export function loadStoredBatch(): StoredBatch | null {
  return parseStoredBatch(readRaw(BATCH_KEY))
}

/** Persist a batch verdict (overwrites the previous one). */
export function saveStoredBatch(record: StoredBatch): void {
  writeRaw(BATCH_KEY, record)
}

/** Load the stored fertility verdict, if any. */
export function loadStoredFertility(): StoredFertility | null {
  return parseStoredFertility(readRaw(FERTILITY_KEY))
}

/** Persist a fertility verdict (overwrites the previous one). */
export function saveStoredFertility(record: StoredFertility): void {
  writeRaw(FERTILITY_KEY, record)
}

/** Probe-run parallelism (1–8) the user picked; 4 by default. */
const PARALLELISM_KEY = 'dsh-modeltester.parallelism'

export function loadParallelism(): number {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(PARALLELISM_KEY)
    const value = raw === null ? NaN : Number(raw)
    if (!Number.isFinite(value)) return 4
    return Math.max(1, Math.min(8, Math.round(value)))
  } catch {
    return 4
  }
}

export function saveParallelism(value: number): void {
  const clamped = Math.max(1, Math.min(8, Math.round(value)))
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(PARALLELISM_KEY, String(clamped))
  } catch {
    /* non-fatal */
  }
}

/**
 * Agent preset requested for newly created probe sessions; '' (the default)
 * follows the host default. The picker lists only presets the host's own
 * sessions exposed — preset ids are host-configured data, so the panel never
 * guesses one.
 */
const PROBE_PRESET_KEY = 'dsh-modeltester.probePreset'

export function loadProbePreset(): string {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(PROBE_PRESET_KEY)
    if (raw === null) return ''
    const value = raw.trim()
    // Ids are short host tokens; anything oversized or whitespace-laden is stale junk.
    return value !== '' && value.length <= 64 && !/\s/.test(value) ? value : ''
  } catch {
    return ''
  }
}

export function saveProbePreset(value: string): void {
  try {
    if (typeof window === 'undefined') return
    const trimmed = value.trim()
    if (trimmed === '') window.localStorage.removeItem(PROBE_PRESET_KEY)
    else window.localStorage.setItem(PROBE_PRESET_KEY, trimmed)
  } catch {
    /* non-fatal */
  }
}
