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
import { ALL_SIGNALS } from './attribution-signals.ts'
import { aggregateBatch, estimateTokens, familyHitsOf, orderedProbes, type BatchGuess } from './batch.ts'
import { type ProbeEntry } from './probes.ts'
import { GROUPS, PATTERNS, type Group, type Mode } from './keywords.ts'
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

/** Accent color for dots and bars (bright state tokens). */
const GROUP_ACCENT: Readonly<Record<Group, string>> = {
  efficient: 'var(--dsw-alias-state-success-primary)',
  hesitant: 'var(--dsw-alias-state-warn-primary)',
  neutral: 'var(--dsw-alias-label-secondary)',
}

/** Readable text color for the mode badge (no background; warn uses the harness's readable label token). */
const MODE_TEXT: Readonly<Record<Group, string>> = {
  efficient: 'var(--dsw-alias-state-success-primary)',
  hesitant: 'var(--dsw-alias-state-warn-label)',
  neutral: 'var(--dsw-alias-label-secondary)',
}

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
  const mode = stats?.mode
  const attrTop = stats?.attribution.candidates[0]

  return (
    <div
      className={css.root}
      data-mode={mode}
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
        <span className={css.chipDot} data-mode={mode} data-attr={stats?.attribution.verdict} aria-hidden="true" />
        <span>ModelTester</span>
        {attrTop !== undefined && attrTop.verdict !== 'none' ? (
          <span className={css.chipMode} data-attr={attrTop.verdict}>{t(`vendor.${attrTop.vendor}`)}</span>
        ) : mode === 'efficient' ? (
          <span className={css.chipMode}>{t('mode.efficient')}</span>
        ) : mode === 'hesitant' ? (
          <span className={css.chipMode}>{t('mode.hesitant')}</span>
        ) : mode === 'neutral' ? (
          <span className={css.chipMode}>{t('mode.neutral')}</span>
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
        />
      </div>
    </div>
  )
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
            <ProbesSection t={t} actions={actions} engine={stats.attribution} />
            {stats.anomaly !== 'none' ? (
              <ReasoningAlert stats={stats} t={t} />
            ) : (
              <>
                <ModeSection stats={stats} t={t} />
                <PatternSection stats={stats} t={t} />
                <Footer stats={stats} t={t} />
              </>
            )}
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
  const totalScore = attr.candidates.reduce((sum, c) => sum + c.score, 0)

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
        attr.candidates.map((candidate, rank) => {
          const own = attr.evidence.filter(entry => entry.vendor === candidate.vendor)
          const share = totalScore > 0 ? Math.round((candidate.score / totalScore) * 100) : 0
          return (
            <div className={css.candidate} data-attr={candidate.verdict} key={candidate.vendor}>
              <div className={css.candidateHead}>
                <span className={css.candidateRank} aria-hidden="true">{rank + 1}</span>
                <span className={css.candidateName}>{t(`vendor.${candidate.vendor}`)}</span>
                <span className={css.candidateScore}>
                  <b>{candidate.score}</b>
                  {' '}
                  {share}%
                  {candidate.verdict !== 'none' ? ` · ${t(`attr.${candidate.verdict}`)}` : ''}
                </span>
              </div>
              <div className={css.confidenceBar} aria-hidden="true">
                <span style={{ width: `${Math.max(4, share)}%` }} />
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
        })
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
 * section becomes a checklist: probes ordered by structural confidence, each
 * with a token-cost estimate, select-all, and a one-click run that drives all
 * selected probes through one fresh session and reports a ranked guess with a
 * confidence label. Without the batch face, rows keep the per-probe
 * send/copy fallback.
 */
function ProbesSection({ t, actions, engine }: {
  t: ModelTesterPanelProps['t']
  actions?: ModelTesterActions
  engine: AttributionReport
}) {
  const probes = useMemo(() => orderedProbes(), [])
  const canBatch = typeof actions?.runBatch === 'function'
  const canSend = typeof actions?.sendProbe === 'function'
  const [selected, setSelected] = useState<Set<string>>(() => new Set(probes.map(p => p.id)))
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Record<string, BatchProgress['status']>>({})
  const [guess, setGuess] = useState<BatchGuess | null>(null)
  const [coverage, setCoverage] = useState({ answered: 0, total: 0 })
  const [error, setError] = useState('')

  const selectedProbes = probes.filter(probe => selected.has(probe.id))
  const totalTokens = selectedProbes.reduce((sum, probe) => sum + estimateTokens(probe.prompt), 0)

  const toggle = (id: string): void => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = (): void => {
    setSelected(prev => (prev.size === probes.length ? new Set<string>() : new Set(probes.map(p => p.id))))
  }

  const run = async (): Promise<void> => {
    if (running || !canBatch || actions?.runBatch === undefined || selectedProbes.length === 0) return
    setRunning(true)
    setGuess(null)
    setError('')
    setProgress({})
    const items = selectedProbes.map(probe => ({ id: probe.id, text: probe.prompt }))
    try {
      const response = await actions.runBatch(items, progress0 => {
        setProgress(prev => ({ ...prev, [progress0.probeId]: progress0.status }))
      })
      if (!response.ok || response.turns === undefined) {
        setError(response.error ?? 'unavailable')
        return
      }
      const text = response.turns.map(turn => turn.text).join('\n')
      const answered = response.turns.filter(turn => turn.status === 'answered').length
      setCoverage({ answered, total: items.length })
      setGuess(aggregateBatch({ engine, hits: familyHitsOf(text), answered, total: items.length }))
    } catch {
      setError('unavailable')
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className={css.section}>
      <div className={css.modeRow}>
        <h3 className={css.modeLabel}>{t('attr.probes')}</h3>
        <span className={css.attrBadge}>{t('attr.probesHint')}</span>
      </div>
      {canBatch && (
        <div className={css.batchBar}>
          <label className={css.batchSelectAll}>
            <input
              type="checkbox"
              checked={selected.size === probes.length}
              ref={node => {
                if (node !== null) node.indeterminate = selected.size > 0 && selected.size < probes.length
              }}
              onChange={toggleAll}
            />
            {t('attr.batch.selectAll')}
          </label>
          <span className={css.batchTokens}>≈{formatCount(totalTokens)} tok</span>
          <button type="button" className={css.probeBtn} disabled={running || selectedProbes.length === 0} onClick={() => { void run() }}>
            {running ? t('attr.batch.running') : t('attr.batch.run')}
          </button>
        </div>
      )}
      <div className={css.patternList}>
        {probes.map(probe => (
          <ProbeRow
            key={probe.id}
            probe={probe}
            t={t}
            actions={actions}
            canBatch={canBatch}
            selected={selected.has(probe.id)}
            onToggle={toggle}
            status={progress[probe.id]}
          />
        ))}
      </div>
      {error !== '' && <p className={css.empty}>{t('attr.batch.unavailable')}</p>}
      {guess !== null && <BatchGuessCard guess={guess} coverage={coverage} t={t} />}
    </section>
  )
}

/** One probe row of the batch checklist (or the send/copy fallback). */
function ProbeRow({ probe, t, actions, canBatch, selected, onToggle, status }: {
  probe: ProbeEntry
  t: ModelTesterPanelProps['t']
  actions?: ModelTesterActions
  canBatch: boolean
  selected: boolean
  onToggle: (id: string) => void
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
      {canBatch && (
        <input type="checkbox" className={css.batchCheck} checked={selected} onChange={() => onToggle(probe.id)} />
      )}
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

/** The batch aggregate: ranked guess + confidence + coverage + elicited tokens. */
function BatchGuessCard({ guess, coverage, t }: {
  guess: BatchGuess
  coverage: { answered: number; total: number }
  t: ModelTesterPanelProps['t']
}) {
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
            <span className={css.candidateScore}>{t('attr.batch.confidence')} <b>{t(`attr.batch.conf.${guess.confidence}`)}</b></span>
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
        </div>
      )}
    </div>
  )
}

/** Trajectory-mode badge on the same row as the label, plus per-category share bars. */
function ModeSection({ stats, t }: { stats: NonNullable<TrajectoryStats>; t: ModelTesterPanelProps['t'] }) {
  return (
    <section className={css.section}>
      <div className={css.modeRow}>
        <h3 className={css.modeLabel}>{t('panel.modeLabel')}</h3>
        <span className={css.modeBadge} data-mode={stats.mode} style={{ color: MODE_TEXT[stats.mode] }}>
          {t(`mode.${stats.mode}`)}
        </span>
      </div>
      {GROUPS.map(group => (
        <div className={css.barRow} key={group}>
          <span className={css.barLabel}>{t(`group.${group}`)}</span>
          <span className={css.barTrack}>
            <span
              className={css.barFill}
              style={{ width: `${Math.round(stats.shares[group] * 100)}%`, background: GROUP_ACCENT[group] }}
            />
          </span>
          <span className={css.barValue}>{stats.groups[group]}</span>
        </div>
      ))}
    </section>
  )
}

/** Keyword breakdown: nonzero patterns grouped by category, plus raw word metrics. */
function PatternSection({ stats, t }: { stats: NonNullable<TrajectoryStats>; t: ModelTesterPanelProps['t'] }) {
  const rows = useMemo(() => stats.patterns
    .map((count, index) => ({ pattern: PATTERNS[index], count, index }))
    .filter(row => row.count > 0)
    .sort((a, b) => {
      const ga = GROUPS.indexOf(a.pattern.group)
      const gb = GROUPS.indexOf(b.pattern.group)
      return ga !== gb ? ga - gb : b.count - a.count
    }), [stats])

  return (
    <section className={css.section}>
      <h3 className={css.sectionLabel}>{t('panel.patternsLabel')}</h3>
      <div className={css.metrics}>
        <span className={css.metric}>
          we <b className={css.metricValue}>{stats.words.we}</b>
        </span>
        <span className={css.metric}>
          let&rsquo;s <b className={css.metricValue}>{stats.words.lets}</b>
        </span>
        <span className={css.metric}>
          let me <b className={css.metricValue}>{stats.words.letMe}</b>
        </span>
        <span className={css.metric}>
          I <b className={css.metricValue}>{stats.words.firstPerson}</b>
        </span>
      </div>
      {rows.length === 0 ? (
        <p className={css.empty}>{t('panel.noKeywords')}</p>
      ) : (
        <div className={css.patternList}>
          {rows.map(row => (
            <span
              key={row.index}
              className={css.patternItem}
              title={row.pattern.note}
            >
              <span
                className={css.patternDot}
                style={{ background: GROUP_ACCENT[row.pattern.group] }}
                aria-hidden="true"
              />
              <span className={css.patternKey}>{t(row.pattern.label)}</span>
              <span className={css.patternCount}>{row.count}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

/** Footer: hesitation-pressure health note. */
function Footer({ stats, t }: { stats: NonNullable<TrajectoryStats>; t: ModelTesterPanelProps['t'] }) {
  const health: 'low' | 'mid' | 'high' = stats.hesitation === 0
    ? 'low'
    : stats.hesitation < 0.5 && stats.words.letMe <= 5
      ? 'mid'
      : 'high'
  return (
    <footer className={css.footer}>
      <div className={css.healthRow}>
        {t('panel.healthLabel')}
        <b className={css.healthValue} data-health={health}>{t(`panel.health.${health}`)}</b>
      </div>
    </footer>
  )
}

export type { Mode }
