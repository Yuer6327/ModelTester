/**
 * ModelTester reasoning-trajectory panel.
 *
 * A `shell.overlay` entry (root scope) docked to the top-right of the frame.
 * Renders live per-session trajectory stats produced by the stats store
 * (`session-store.ts`): real-time incremental folding, complete-history paging
 * on session focus, and local persistence — the panel never re-counts what it
 * already counted.
 *
 * One surface, two rounded-rectangle shapes: a compact chip when collapsed
 * and a card when expanded, morphed on a critically-damped spring
 * (interruptible — a re-click retargets from the on-screen values, never the
 * targets) anchored at the right dock so it grows leftward from the edge.
 * The transition degrades to an instant swap under `prefers-reduced-motion`.
 *
 * Styling mirrors the shipped `DetailsPanel` (theme tokens only, CSS Modules,
 * hover-reveal scrollbar via the harness's `--dsh-scrollbar-*` elevated-surface
 * rebind, keyboard-focus + reduced-motion preserved).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatCount, type TrajectoryStats } from './stats.ts'
import { evidencePack, type AttributionEvidence, type AttributionReport } from './attribution.ts'
import { ALL_SIGNALS, type Vendor } from './attribution-signals.ts'
import { loadStoredBatch, loadStoredFertility, saveStoredBatch, saveStoredFertility, type StoredBatch, type StoredFertility } from './panel-persist.ts'
import { aggregateBatch, batchScanText, estimateTokens, familyHitsOf, identityClaimsOf, orderedProbes, type BatchGuess } from './batch.ts'
import { FERTILITY_VERSION, FERTILITY_FAMILIES, FERTILITY_TEXTS } from './fertility.ts'
import { fertilitySequence, fertilityVerdictOf } from './fertility-score.ts'
import { PROBES, type ProbeEntry } from './probes.ts'
import { loadTestSessions, clearTestSessions } from './panel-persist.ts'
import type { HistoryState } from './session-store.ts'
import type { BatchProgress, ModelTesterActions, ModelTesterPanelProps } from './slots.ts'
import css from './ModelTesterPanel.module.css'

/** Card width when expanded. */
const CARD_W = 320
/** Collapsed chip height. */
const CHIP_H = 36
/** Collapsed chip corner radius (a rounded rectangle, not a pill). */
const CHIP_R = 10
/** Expanded card corner radius. */
const CARD_R = 12
/** Card content cap: 560px or the viewport minus dock margins. */
const MAX_H = () => Math.min(560, Math.max(240, (typeof window === 'undefined' ? 900 : window.innerHeight) - 32))

/** Apple-style spring: critically damped (damping ratio 1.0), ~0.4s response. */
const SPRING_RESPONSE = 0.4
const SPRING_OMEGA = (2 * Math.PI) / SPRING_RESPONSE
const SPRING_K = SPRING_OMEGA * SPRING_OMEGA
const SPRING_C = 2 * Math.sqrt(SPRING_K) // zeta = 1.0

/** Candidates shown before the "show all" expander kicks in. */
const CANDIDATE_VISIBLE = 5

/** Animated morph state. `o` = card-layer opacity (chip = 1 − o). */
interface Morph {
  w: number
  h: number
  r: number
  o: number
}

const CHIP_MORPH: Morph = { w: 0, h: CHIP_H, r: CHIP_R, o: 0 }

/** Read the persisted open/collapsed preference (best-effort). */
function readOpenPreference(): boolean {
  try {
    return window.localStorage.getItem('dsh-modeltester.open') !== '0'
  } catch {
    return true
  }
}

/** Persist the panel's open state (best-effort). */
function writeOpenPreference(open: boolean): void {
  try {
    window.localStorage.setItem('dsh-modeltester.open', open ? '1' : '0')
  } catch {
    /* storage unavailable (private mode etc.): non-fatal */
  }
}

/** The panel: one element that morphs between chip (collapsed) and card (expanded). */
export function ModelTesterPanel({ useStats, t, actions }: ModelTesterPanelProps) {
  const snap = useStats(state => state)
  const stats = snap.stats
  // Older host/plugin stores do not expose history metadata; preserve their
  // rendering contract with the old loading/idle interpretation.
  const historyState: HistoryState = snap.historyState ?? (snap.loading ? 'syncing' : 'complete')
  const historyPages = snap.historyPages ?? 0
  const [open, setOpen] = useState(readOpenPreference)

  const cardRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const [cardH, setCardH] = useState(0)
  const [chipW, setChipW] = useState(0)

  // Live morph values + per-axis velocity (presentation state for the spring).
  const [morph, setMorph] = useState<Morph>(CHIP_MORPH)
  const live = useRef({ ...CHIP_MORPH, vw: 0, vh: 0, vr: 0, vo: 0, running: false })
  const first = useRef(true)

  const toggle = (): void => {
    setOpen(prev => {
      const next = !prev
      writeOpenPreference(next)
      return next
    })
  }

  // Measure the card's natural (uncapped) height and the chip's natural width.
  useEffect(() => {
    const card = cardRef.current
    const chip = chipRef.current
    if (card === null || chip === null) return
    const cardObs = new ResizeObserver(() => setCardH(card.offsetHeight))
    const chipObs = new ResizeObserver(() => setChipW(chip.offsetWidth))
    cardObs.observe(card)
    chipObs.observe(chip)
    return () => {
      cardObs.disconnect()
      chipObs.disconnect()
    }
  }, [])

  // Morph spring: retarget whenever open state, content height, or chip width
  // moves. Starts from the live presentation values (interruptible).
  useEffect(() => {
    const target: Morph = open
      ? { w: CARD_W, h: Math.min(cardH || CARD_W, MAX_H()), r: CARD_R, o: 1 }
      : { w: chipW || 108, h: CHIP_H, r: CHIP_R, o: 0 }

    if (first.current) {
      first.current = false
      const s = live.current
      s.w = target.w; s.h = target.h; s.r = target.r; s.o = target.o
      s.vw = s.vh = s.vr = s.vo = 0
      setMorph(target)
      return
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const s = live.current
      s.w = target.w; s.h = target.h; s.r = target.r; s.o = target.o
      s.vw = s.vh = s.vr = s.vo = 0
      setMorph(target)
      return
    }

    const s = live.current
    s.running = true
    let raf = 0
    let last = performance.now()

    const frame = (now: number): void => {
      if (!s.running) return
      const dt = Math.min((now - last) / 1000, 1 / 30)
      last = now

      // Semi-implicit Euler integration per axis (independent springs).
      const ax = -SPRING_K * (s.w - target.w) - SPRING_C * s.vw
      s.vw += ax * dt
      s.w += s.vw * dt
      const ah = -SPRING_K * (s.h - target.h) - SPRING_C * s.vh
      s.vh += ah * dt
      s.h += s.vh * dt
      const ar = -SPRING_K * (s.r - target.r) - SPRING_C * s.vr
      s.vr += ar * dt
      s.r += s.vr * dt
      const ao = -SPRING_K * (s.o - target.o) - SPRING_C * s.vo
      s.vo += ao * dt
      s.o += s.vo * dt

      const settled = Math.abs(s.w - target.w) < 0.5
        && Math.abs(s.h - target.h) < 0.5
        && Math.abs(s.r - target.r) < 0.5
        && Math.abs(s.o - target.o) < 0.005
        && Math.abs(s.vw) < 0.5
        && Math.abs(s.vh) < 0.5
        && Math.abs(s.vr) < 0.5
        && Math.abs(s.vo) < 0.005

      if (settled) {
        s.w = target.w; s.h = target.h; s.r = target.r; s.o = target.o
        s.vw = s.vh = s.vr = s.vo = 0
        setMorph(target)
        return
      }
      setMorph({ w: s.w, h: s.h, r: s.r, o: s.o })
      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => {
      s.running = false
      cancelAnimationFrame(raf)
    }
  }, [open, cardH, chipW])

  const cardVisible = morph.o > 0
  const chipVisible = morph.o < 1
  const attrTop = stats?.attribution.candidates[0]

  // Run state lives HERE, not in ProbesSection: a run switches the current
  // session (fertility: once per item), and a transient `stats === null`
  // unmounts ProbesSection — component state there would be lost mid-run.
  // Results are also persisted to localStorage so they survive a reload.
  const statsRef = useRef(stats)
  statsRef.current = stats

  const [fertRunning, setFertRunning] = useState(false)
  const [fertStatus, setFertStatus] = useState<Record<string, BatchProgress['status']>>({})
  const [fertStored, setFertStored] = useState<StoredFertility | null>(loadStoredFertility)
  const [fertError, setFertError] = useState('')
  const [fertInterrupted, setFertInterrupted] = useState<{ startedAt: string; done: number; total: number } | null>(null)

  // Detect an interrupted fertility run once on mount (crash / host restart).
  useEffect(() => {
    const found = actions?.interruptedFertility?.() ?? null
    if (found !== null) setFertInterrupted({ startedAt: found.startedAt, done: found.items.filter(i => i.status !== 'pending').length, total: found.total })
  }, [actions])

  /** Fertility run: one fresh session per text, scored by usage deltas.
   *  Resumes an interrupted run automatically (persisted readings reused). */
  const runFertility = async (): Promise<void> => {
    if (fertRunning || actions?.runFertility === undefined) return
    setFertRunning(true)
    setFertStored(null)
    setFertError('')
    const interrupted = actions?.interruptedFertility?.()
    const prefill: Record<string, BatchProgress['status']> = {}
    if (interrupted !== null && interrupted !== undefined) {
      for (const it of interrupted.items) {
        if (it.status !== 'pending') prefill[it.id] = it.status
      }
    }
    setFertStatus(prefill)
    const items = fertilitySequence()
    try {
      const response = await actions.runFertility(items, progress0 => {
        setFertStatus(prev => ({ ...prev, [progress0.probeId]: progress0.status }))
      })
      if (!response.ok || response.turns === undefined) {
        setFertError(response.error ?? 'unavailable')
        return
      }
      const at = new Date().toISOString()
      const verdict = fertilityVerdictOf(response.turns.map(turn => ({
        probeId: turn.probeId,
        status: turn.status,
        promptTokens: turn.promptTokens ?? null,
      })))
      const record = { at, verdict }
      setFertStored(record)
      saveStoredFertility(record)
    } catch {
      setFertError('unavailable')
    } finally {
      setFertRunning(false)
    }
  }

  const [batchRunning, setBatchRunning] = useState(false)
  const [batchStatus, setBatchStatus] = useState<Record<string, BatchProgress['status']>>({})
  const [batchStored, setBatchStored] = useState<StoredBatch | null>(loadStoredBatch)
  const [batchError, setBatchError] = useState('')

  /** Standard batch run: one fresh session, all given probes in order. */
  const runBatch = async (items: readonly { id: string; text: string }[]): Promise<void> => {
    if (batchRunning || actions?.runBatch === undefined) return
    setBatchRunning(true)
    setBatchStored(null)
    setBatchError('')
    setBatchStatus({})
    try {
      const response = await actions.runBatch(items, progress0 => {
        setBatchStatus(prev => ({ ...prev, [progress0.probeId]: progress0.status }))
      })
      if (!response.ok || response.turns === undefined) {
        setBatchError(response.error ?? 'unavailable')
        return
      }
      const answered = response.turns.filter(turn => turn.status === 'answered').length
      const record: StoredBatch = {
        at: new Date().toISOString(),
        guess: aggregateBatch({
          engine: statsRef.current?.attribution ?? null,
          hits: familyHitsOf(batchScanText(response.turns)),
          answered,
          total: items.length,
        }),
        claims: identityClaimsOf(response.turns),
        coverage: { answered, total: items.length },
      }
      setBatchStored(record)
      saveStoredBatch(record)
    } catch {
      setBatchError('unavailable')
    } finally {
      setBatchRunning(false)
    }
  }

  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [cleanupMessage, setCleanupMessage] = useState<'' | 'none' | 'unavailable' | 'done'>('')
  const [cleanupCount, setCleanupCount] = useState(0)

  /**
   * One-click FULL battery: every registered test item — all standard probes
   * plus the fertility sequence, including anything added later — then both
   * verdict cards. Selection-free by contract.
   */
  const runAllTests = async (): Promise<void> => {
    if (batchRunning || fertRunning) return
    await runBatch(PROBES.map(probe => ({ id: probe.id, text: probe.prompt })))
    await runFertility()
  }

  /** Bulk-delete the sessions this plugin minted during test runs. */
  const runCleanup = async (): Promise<void> => {
    if (cleanupBusy || actions?.cleanupTestSessions === undefined) return
    setCleanupBusy(true)
    setCleanupMessage('')
    const ids = loadTestSessions()
    if (ids.length === 0) {
      setCleanupMessage('none')
      setCleanupBusy(false)
      return
    }
    try {
      const response = await actions.cleanupTestSessions(ids)
      if (!response.ok) {
        setCleanupMessage('unavailable')
      } else {
        clearTestSessions(response.removed ?? [])
        setCleanupCount(response.removed?.length ?? 0)
        setCleanupMessage('done')
      }
    } catch {
      setCleanupMessage('unavailable')
    } finally {
      setCleanupBusy(false)
    }
  }

  return (
    <div
      className={css.root}
      data-attr={stats?.attribution.verdict}
      data-streaming={stats?.streaming || undefined}
      role="region"
      aria-label={t('panel.aria')}
      style={{ width: morph.w, height: morph.h, borderRadius: morph.r }}
    >
      {/* Collapsed chip layer (opacity fades out as the card grows in). */}
      <button
        ref={chipRef}
        type="button"
        className={css.chip}
        onClick={toggle}
        aria-expanded={open}
        title={t('panel.title')}
        style={{
          opacity: 1 - morph.o,
          visibility: chipVisible ? 'visible' : 'hidden',
          pointerEvents: morph.o < 0.5 ? 'auto' : 'none',
        }}
      >
        <span className={css.chipDot} data-attr={stats?.attribution.verdict} aria-hidden="true" />
        <span>ModelTester</span>
        {attrTop !== undefined && attrTop.verdict !== 'none' ? (
          <span className={css.chipMode} data-attr={attrTop.verdict}>{t(`vendor.${attrTop.vendor}`)}</span>
        ) : null}
      </button>

      {/* Expanded card layer (clipped by the morphing root while it grows). */}
      <div
        ref={cardRef}
        className={css.card}
        style={{
          opacity: morph.o,
          visibility: cardVisible ? 'visible' : 'hidden',
          pointerEvents: morph.o > 0.5 ? 'auto' : 'none',
        }}
      >
        <PanelCard
          open={open}
          onToggle={toggle}
          t={t}
          stats={stats}
          sessionId={snap.sessionId}
          actions={actions}
          loading={snap.loading}
          historyState={historyState}
          historyPages={historyPages}
          fert={{
            running: fertRunning,
            status: fertStatus,
            stored: fertStored,
            error: fertError,
            interrupted: fertInterrupted,
            run: () => { void runFertility() },
          }}
          batch={{
            running: batchRunning,
            status: batchStatus,
            stored: batchStored,
            error: batchError,
            run: () => { void runAllTests() },
          }}
          cleanup={{
            busy: cleanupBusy,
            message: cleanupMessage,
            count: cleanupCount,
            run: () => { void runCleanup() },
          }}
        />
      </div>
    </div>
  )
}

/** Run state owned by the stable panel root (survives session switches). */
interface FertState {
  running: boolean
  status: Record<string, BatchProgress['status']>
  stored: StoredFertility | null
  error: string
  /** Interrupted run detected at mount — resumable via run(). */
  interrupted: { startedAt: string; done: number; total: number } | null
  run: () => void
}

/** Batch-run state owned by the stable panel root (survives session switches). */
interface BatchState {
  running: boolean
  status: Record<string, BatchProgress['status']>
  stored: StoredBatch | null
  error: string
  run: () => void
}

/**
 * Cleanup UI switch. The 0.1.7 host sessions face has no delete verb, and the
 * durable archive API (`ctx.workspaceRegistry` archiveSession/unarchiveSession)
 * stays inside the host — neither is reachable from the plugin contract face,
 * so the button could only ever end in "unavailable". Hidden until a host face
 * ships a plugin-reachable delete/archive verb; the action machinery and
 * session tracking stay wired underneath.
 */
const CLEANUP_UI_SHOWN = false

/** Test-session cleanup state owned by the stable panel root. */
interface CleanupState {
  busy: boolean
  message: '' | 'none' | 'unavailable' | 'done'
  count: number
  run: () => void
}

/** Expanded card body. */
function PanelCard({
  open,
  onToggle,
  t,
  stats,
  sessionId,
  actions,
  loading,
  historyState,
  historyPages,
  fert,
  batch,
  cleanup,
}: {
  open: boolean
  onToggle: () => void
  t: ModelTesterPanelProps['t']
  stats: TrajectoryStats | null
  sessionId: string | undefined
  actions?: ModelTesterActions
  loading: boolean
  historyState: HistoryState
  historyPages: number
  fert: FertState
  batch: BatchState
  cleanup: CleanupState
}) {
  return (
    <>
      <header className={css.header}>
        <h2 className={css.title}>{t('panel.title')}</h2>
        <button
          type="button"
          className={css.toggle}
          onClick={onToggle}
          aria-expanded={open}
          aria-label={t('panel.collapse')}
          title={t('panel.collapse')}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 3h8M2 6h5M2 9h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </header>
      <div className={css.body}>
        {stats === null ? (
          <p className={css.empty}>{t('panel.noSession')}</p>
        ) : (
          <>
            <StatusRow stats={stats} loading={loading} historyState={historyState} t={t} />
            {(historyState === 'limited' || historyState === 'error') && (
              <HistoryNotice state={historyState} pages={historyPages} t={t} />
            )}
            <AttributionSection stats={stats} sessionId={sessionId} t={t} />
            <ProbesSection
              t={t}
              actions={actions}
              fert={fert}
              batch={batch}
              cleanup={cleanup}
            />
            {stats.anomaly !== 'none' && <ReasoningAlert stats={stats} t={t} />}
          </>
        )}
      </div>
    </>
  )
}

/** Live status strip: streaming dot, sync state, reasoning block / char counts, replies. */
function StatusRow({ stats, loading, historyState, t }: {
  stats: NonNullable<TrajectoryStats>
  loading: boolean
  historyState: HistoryState
  t: ModelTesterPanelProps['t']
}) {
  const syncLabel = historyState === 'syncing'
    ? t('panel.syncing')
    : historyState === 'limited'
      ? t('panel.historyLimited')
      : historyState === 'error'
        ? t('panel.historyError')
        : stats.streaming ? t('panel.streaming') : t('panel.idle')
  return (
    <div className={css.status}>
      <span className={css.statusItem}>
        <span className={css.liveDot} data-syncing={loading || undefined} aria-hidden="true" />
        {syncLabel}
      </span>
      <span className={css.statusItem}>
        {t('panel.reasoningBlocks')}
        <b className={css.value}>{stats.blocks}</b>
      </span>
      <span className={css.statusItem}>
        {t('panel.reasoningChars')}
        <b className={css.value}>{formatCount(stats.chars)}</b>
      </span>
      <span className={css.statusItem}>
        {t('panel.replies')}
        <b className={css.value}>{stats.replies}</b>
      </span>
    </div>
  )
}

/** Warn when the panel is showing a partial or failed history sync. */
function HistoryNotice({
  state,
  pages,
  t,
}: {
  state: Extract<HistoryState, 'limited' | 'error'>
  pages: number
  t: ModelTesterPanelProps['t']
}) {
  const limited = state === 'limited'
  return (
    <div className={css.alert} role="status">
      <span className={css.alertIcon} aria-hidden="true">!</span>
      <div className={css.alertBody}>
        <p className={css.alertTitle}>{limited ? t('panel.historyLimited') : t('panel.historyError')}</p>
        <p className={css.alertFacts}>
          {limited ? `${t('panel.historyLimitedHint')} (${pages} pages)` : t('panel.historyErrorHint')}
        </p>
      </div>
    </div>
  )
}

/** Reasoning-health alert: the model streamed output as text with no (or almost no) reasoning blocks. */
function ReasoningAlert({ stats, t }: { stats: TrajectoryStats; t: ModelTesterPanelProps['t'] }) {
  const missing = stats.anomaly === 'missing'
  return (
    <div className={css.alert} role="alert">
      <span className={css.alertIcon} aria-hidden="true">!</span>
      <div className={css.alertBody}>
        <p className={css.alertTitle}>{missing ? t('panel.reasoningMissing') : t('panel.reasoningLow')}</p>
        <p className={css.alertFacts}>
          {t('panel.reasoningBlocks')} {stats.blocks} · {t('panel.reasoningChars')} {formatCount(stats.chars)}
          <span className={css.alertSep}>/</span>
          {t('panel.textBlocks')} {stats.textBlocks} · {t('panel.textChars')} {formatCount(stats.textChars)}
        </p>
        <p className={css.alertHint}>{t('panel.reasoningAlertHint')}</p>
      </div>
    </div>
  )
}

/** GitHub README section that documents the attribution scoring rules. */
const ATTR_DOCS_HREF = 'https://github.com/Yuer6327/ModelTester#attribution'

/** Rationale lookup for the evidence-row tooltips. */
const SIGNAL_RATIONALE: ReadonlyMap<string, string> = new Map(ALL_SIGNALS.map(signal => [signal.id, signal.rationale]))

/** Evidence-row accent by weight tier (bright state tokens). */
const TIER_ACCENT: Readonly<Record<number, string>> = {
  1: 'var(--dsw-alias-brand-primary)',
  2: 'var(--dsw-alias-state-warn-primary)',
  3: 'var(--dsw-alias-label-secondary)',
}

/** Session attribution ranking: candidates ordered by confidence, evidence grouped under each. */
function AttributionSection({ stats, sessionId, t }: {
  stats: NonNullable<TrajectoryStats>
  sessionId: string | undefined
  t: ModelTesterPanelProps['t']
}) {
  const attr = stats.attribution
  const [exported, setExported] = useState(false)
  const [showAll, setShowAll] = useState(false)
  // Only the strongest suspects are shown by default; the rest stay one
  // click away (rank order is confidence, so the cut is at the tail).
  const visibleCandidates = showAll ? attr.candidates : attr.candidates.slice(0, CANDIDATE_VISIBLE)
  const hiddenCount = attr.candidates.length - visibleCandidates.length

  const exportEvidence = async (): Promise<void> => {
    try {
      const pack = evidencePack(attr, { sessionId })
      await navigator.clipboard.writeText(JSON.stringify(pack, null, 2))
      setExported(true)
      setTimeout(() => setExported(false), 1200)
    } catch {
      /* clipboard unavailable: non-fatal */
    }
  }

  return (
    <section className={css.section} data-attr={attr.verdict}>
      <div className={css.modeRow}>
        <h3 className={css.modeLabel}>{t('attr.label')}</h3>
        <span className={css.attrBadge} data-attr={attr.verdict}>
          {t(`attr.${attr.verdict}`)}
        </span>
        <a
          className={css.attrDocs}
          href={ATTR_DOCS_HREF}
          target="_blank"
          rel="noreferrer"
          title={t('attr.docs')}
          aria-label={t('attr.docs')}
        >
          ?
        </a>
        <button type="button" className={css.probeBtn} onClick={() => { void exportEvidence() }}>
          {exported ? t('attr.copied') : t('attr.export')}
        </button>
      </div>
      {attr.candidates.length === 0 ? (
        <p className={css.empty}>{t('attr.empty')}</p>
      ) : (
        <>
          {visibleCandidates.map((candidate, rank) => {
            const own = attr.evidence.filter(entry => entry.vendor === candidate.vendor)
            const confidence = Math.round(candidate.confidence * 100)
            return (
              <div className={css.candidate} data-attr={candidate.verdict} key={candidate.vendor}>
                <div className={css.candidateHead}>
                  <span className={css.candidateRank} aria-hidden="true">{rank + 1}</span>
                  <span className={css.candidateName}>{t(`vendor.${candidate.vendor}`)}</span>
                  <span className={css.candidateScore}>
                    <b>{confidence}%</b>
                    {' '}
                    {t('attr.score')} {candidate.score}
                    {candidate.verdict !== 'none' ? ` · ${t(`attr.${candidate.verdict}`)}` : ''}
                  </span>
                </div>
                <div className={css.confidenceBar} aria-hidden="true">
                  <span style={{ width: `${Math.max(4, confidence)}%` }} />
                </div>
                {own.length > 0 && (
                  <div className={css.candidateEvidence}>
                    {own.map(entry => (
                      <EvidenceRow key={entry.id} entry={entry} t={t} />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {hiddenCount > 0 && (
            <button type="button" className={css.probeBtn} onClick={() => setShowAll(true)}>
              {t('attr.showAll')} ({hiddenCount})
            </button>
          )}
          {showAll && attr.candidates.length > CANDIDATE_VISIBLE && (
            <button type="button" className={css.probeBtn} onClick={() => setShowAll(false)}>
              {t('attr.showTop')}
            </button>
          )}
        </>
      )}
      {attr.unattributed.length > 0 && (
        <p className={css.leakFacts}>
          {t('attr.unattributed')}
          {attr.unattributed.slice(0, 4).map(entry => {
            const sample = entry.samples[0]
            return (
              <code className={css.leakCode} key={entry.id}>
                {sample !== undefined ? sample : t(`attr.signal.${entry.id}`)}
              </code>
            )
          })}
        </p>
      )}
    </section>
  )
}

/** One evidence-ledger row: tier dot, signal label, occurrence count. */
function EvidenceRow({ entry, t }: { entry: AttributionEvidence; t: ModelTesterPanelProps['t'] }) {
  const rationale = SIGNAL_RATIONALE.get(entry.id) ?? ''
  const sample = entry.samples[0]
  const title = sample !== undefined ? `${rationale} — ${sample}` : rationale
  return (
    <span className={css.patternItem} title={title}>
      <span
        className={css.patternDot}
        style={{ background: TIER_ACCENT[entry.tier] }}
        aria-hidden="true"
      />
      <span className={css.patternKey}>{t(`attr.signal.${entry.id}`)}</span>
      <span className={css.patternCount}>×{entry.count}</span>
    </span>
  )
}

/**
 * Probe kit + batch runner. When the host face supports `runBatch`, the
 * section offers the one-click FULL battery — every registered test item
 * (all standard probes plus the fertility sequence, including anything added
 * later) — with both verdict cards; results persist across reloads. Without
 * the batch face, rows keep the per-probe send/copy fallback.
 */
function ProbesSection({ t, actions, fert, batch, cleanup }: {
  t: ModelTesterPanelProps['t']
  actions?: ModelTesterActions
  fert: FertState
  batch: BatchState
  cleanup: CleanupState
}) {
  const probes = useMemo(() => orderedProbes(), [])
  const canBatch = typeof actions?.runBatch === 'function'
  const canFertility = typeof actions?.runFertility === 'function'
  const canSend = typeof actions?.sendProbe === 'function'
  const trackedSessions = useMemo(() => loadTestSessions().length, [])
  const batteryTokens = useMemo(() => {
    const prompts = [...PROBES.map(p => p.prompt), ...FERTILITY_TEXTS.map(t => t.text)]
    return prompts.reduce((sum, prompt) => sum + estimateTokens(prompt), 0)
  }, [])

  return (
    <section className={css.section}>
      <div className={css.modeRow}>
        <h3 className={css.modeLabel}>{t('attr.probes')}</h3>
        <span className={css.attrBadge}>{t('attr.probesHint')}</span>
      </div>
      {(canBatch || canFertility) && (
        <div className={css.batchBar}>
          {fert.interrupted !== null && !fert.running && (
            <span className={css.attrBadge}>
              {t('attr.fertility.interrupted')
                .replace('{done}', String(fert.interrupted.done))
                .replace('{total}', String(fert.interrupted.total))}
            </span>
          )}
          <span className={css.batchTokens}>≈{formatCount(batteryTokens)} tok</span>
          <button
            type="button"
            className={css.probeBtn}
            disabled={fert.running || !canFertility}
            title={fert.interrupted !== null ? t('attr.fertility.resumeNote') : t('attr.fertility.note')}
            onClick={fert.run}
          >
            {fert.running
              ? t('attr.batch.running')
              : fert.interrupted !== null
                ? t('attr.fertility.resume')
                : t('attr.fertility.run')}
          </button>
          <button
            type="button"
            className={css.probeBtn}
            disabled={batch.running || fert.running || !canBatch}
            title={t('attr.batch.allNote')}
            onClick={batch.run}
          >
            {batch.running || fert.running ? t('attr.batch.running') : t('attr.batch.run')}
          </button>
        </div>
      )}
      {canBatch && batch.running && (
        <p className={css.empty}>
          {t('attr.batch.progress')} {Object.values(batch.status).filter(s => s === 'answered' || s === 'timeout').length}/{PROBES.length}
        </p>
      )}
      <div className={css.patternList}>
        {probes.map(probe => (
          <ProbeRow
            key={probe.id}
            probe={probe}
            t={t}
            actions={actions}
            canBatch={canBatch}
            status={batch.status[probe.id]}
          />
        ))}
      </div>
      {batch.error !== '' && <p className={css.empty}>{t('attr.batch.unavailable')}</p>}
      {fert.running && (
        <p className={css.empty}>
          {t('attr.fertility.progress')} {Object.values(fert.status).filter(s => s === 'answered' || s === 'timeout').length}/{fertilitySequence().length}
        </p>
      )}
      {fert.error !== '' && <p className={css.empty}>{t('attr.batch.unavailable')}</p>}
      {fert.stored !== null && <FertilityCard stored={fert.stored} t={t} />}
      {batch.stored !== null && <BatchGuessCard stored={batch.stored} t={t} />}
      {CLEANUP_UI_SHOWN && canBatch && (
        <div className={css.batchBar}>
          <button
            type="button"
            className={css.probeBtn}
            disabled={cleanup.busy}
            title={t('attr.cleanup.note')}
            onClick={cleanup.run}
          >
            {cleanup.busy ? t('attr.batch.running') : `${t('attr.cleanup.run')}${trackedSessions > 0 ? ` (${trackedSessions})` : ''}`}
          </button>
          {cleanup.message === 'done' && <span className={css.empty}>{t('attr.cleanup.done')} {cleanup.count}</span>}
          {cleanup.message === 'none' && <span className={css.empty}>{t('attr.cleanup.none')}</span>}
          {cleanup.message === 'unavailable' && <span className={css.empty}>{t('attr.cleanup.unavailable')}</span>}
        </div>
      )}
    </section>
  )
}

/** One probe row of the batch checklist (or the send/copy fallback). */
function ProbeRow({ probe, t, actions, canBatch, status }: {
  probe: ProbeEntry
  t: ModelTesterPanelProps['t']
  actions?: ModelTesterActions
  canBatch: boolean
  status: BatchProgress['status'] | undefined
}) {
  const [feedback, setFeedback] = useState('')

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(probe.prompt)
      setFeedback(t('attr.copied'))
      setTimeout(() => setFeedback(''), 1200)
    } catch {
      /* clipboard unavailable: non-fatal */
    }
  }
  const send = async (): Promise<void> => {
    if (actions?.sendProbe === undefined) return
    try {
      const result = await actions.sendProbe(probe.prompt)
      setFeedback(result.ok ? t('attr.sent') : t('attr.sendFail'))
    } catch {
      setFeedback(t('attr.sendFail'))
    }
    setTimeout(() => setFeedback(''), 1600)
  }

  return (
    <span className={css.patternItem} title={t(`attr.probe.${probe.id}.note`)}>
      <span className={css.patternKey}>{t(`attr.probe.${probe.id}`)}</span>
      <span className={css.batchConf} data-conf={probe.confidence}>{t(`attr.conf.${probe.confidence}`)}</span>
      <span className={css.batchTokens}>≈{estimateTokens(probe.prompt)}</span>
      {status !== undefined && <span className={css.batchStatus} data-status={status}>{t(`attr.batch.status.${status}`)}</span>}
      {!canBatch && (typeof actions?.sendProbe === 'function' ? (
        <button type="button" className={css.probeBtn} onClick={() => { void send() }}>
          {feedback !== '' ? feedback : t('attr.send')}
        </button>
      ) : (
        <button type="button" className={css.probeBtn} onClick={() => { void copy() }}>
          {feedback !== '' ? feedback : t('attr.copy')}
        </button>
      ))}
      {canBatch && (
        <button type="button" className={css.probeBtn} onClick={() => { void copy() }} title={t('attr.copy')}>
          {feedback !== '' ? feedback : t('attr.copy')}
        </button>
      )}
    </span>
  )
}

/** The fertility verdict: usage-delta fingerprint vs official tokenizers. */
function FertilityCard({ stored, t }: {
  stored: StoredFertility
  t: ModelTesterPanelProps['t']
}) {
  const verdict = stored.verdict
  const top = verdict.candidates[0]
  const exact = top !== undefined && top.l1 === 0 && verdict.measured === 9
  const tie = verdict.candidates[1] !== undefined && verdict.candidates[1].l1 === top.l1
  const tied = tie ? verdict.candidates.filter(candidate => candidate.l1 === top.l1) : [top]
  return (
    <div className={css.batchGuess} data-confidence={exact ? 'high' : 'low'}>
      <div className={css.modeRow}>
        <h3 className={css.modeLabel}>{t('attr.fertility.card')}</h3>
        <span className={css.attrBadge}>{t('attr.fertility.coverage')} {verdict.measured}/9</span>
      </div>
      {!verdict.usable || top === undefined ? (
        <p className={css.empty}>{t('attr.fertility.incomplete')}</p>
      ) : (
        <>
          <div className={css.candidate} data-attr={exact ? 'likely' : 'possible'}>
            <div className={css.candidateHead}>
              <span className={css.candidateName}>
                {tied.length > 1
                  ? tied.map(candidate => t(`vendor.${candidate.family.vendor}`)).join(' / ')
                  : t(`vendor.${top.family.vendor}`)}
              </span>
              <span className={css.candidateScore}>
                L1 <b>{top.l1}</b>
                {exact ? ` · ${t('attr.fertility.exact')}` : tie ? ` · ${t('attr.fertility.pair')}` : ''}
              </span>
            </div>
            <div className={css.candidateEvidence}>
              {verdict.candidates.slice(0, 3).map(candidate => (
                <span className={css.patternItem} key={candidate.family.id} title={candidate.family.model}>
                  <span className={css.patternKey}>{t(`vendor.${candidate.family.vendor}`)}</span>
                  <span className={css.patternCount}>L1 {candidate.l1}</span>
                </span>
              ))}
            </div>
          </div>
          {verdict.wrapperBaseline !== null && (
            <p className={css.leakFacts}>{t('attr.fertility.wrapper')} {verdict.wrapperBaseline}</p>
          )}
          <p className={css.leakFacts}>{t('attr.fertility.measuredAt')} {new Date(stored.at).toLocaleString()}</p>
        </>
      )}
    </div>
  )
}

/** The batch aggregate: ranked guess + confidence + coverage + elicited tokens. */
function BatchGuessCard({ stored, t }: {
  stored: StoredBatch
  t: ModelTesterPanelProps['t']
}) {
  const { guess, claims, coverage, at } = stored
  return (
    <div className={css.batchGuess} data-confidence={guess.confidence}>
      <div className={css.modeRow}>
        <h3 className={css.modeLabel}>{t('attr.batch.guess')}</h3>
        <span className={css.attrBadge}>{coverage.answered}/{coverage.total} {t('attr.batch.answeredCount')}</span>
      </div>
      {guess.vendor === null ? (
        <p className={css.empty}>{t('attr.batch.noGuess')}</p>
      ) : (
        <div className={css.candidate} data-attr={guess.confidence === 'high' ? 'likely' : guess.confidence === 'none' ? 'none' : 'possible'}>
          <div className={css.candidateHead}>
            <span className={css.candidateName}>{t(`vendor.${guess.vendor}`)}</span>
            <span className={css.candidateScore}>
              {t('attr.batch.confidence')} <b>{t(`attr.batch.conf.${guess.confidence}`)}</b>
              {guess.confidenceValue > 0 ? ` · ${Math.round(guess.confidenceValue * 100)}%` : ''}
            </span>
          </div>
          {guess.hits.length > 0 && (
            <div className={css.candidateEvidence}>
              {guess.hits.map(hit => (
                <span className={css.patternItem} key={hit.vendor} title={hit.tokens.join(' · ')}>
                  <span className={css.patternKey}>{t(`vendor.${hit.vendor}`)}</span>
                  <span className={css.patternCount}>×{hit.tokens.length}</span>
                </span>
              ))}
            </div>
          )}
          {claims.length > 0 && (
            <p className={css.leakFacts}>
              {t('attr.batch.selfReport')}
              {claims.map(claim => (
                <code className={css.leakCode} key={claim}>{t(`vendor.${claim}`)}</code>
              ))}
            </p>
          )}
          <p className={css.leakFacts}>{t('attr.batch.measuredAt')} {new Date(at).toLocaleString()}</p>
        </div>
      )}
    </div>
  )
}
