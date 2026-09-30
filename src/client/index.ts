/**
 * ModelTester browser plugin entry — the `exports["./client"]` bundle root.
 */

export { apply, inject } from './apply.ts'
export type { ModelTesterFace, ModelTesterPanelProps } from './slots.ts'
export { SessionStatsAccumulator, PERSISTENCE_VERSION } from './accumulator.ts'
export type { VersionedPersistedSessionStats } from './accumulator.ts'
export { conversationViewOf, sessionCarriesNodes } from './conversation.ts'
export type {
  AssistantBlockView, ConversationNodeView, ConversationPort, ConversationView,
  OpenStateView, PartialAssistantView, SessionPort, SessionsPort,
} from './conversation.ts'
export { createStatsStore } from './session-store.ts'
export type { HistoryState, StatsSnapshot, StatsStorage } from './session-store.ts'
export {
  anomalyOf, computeStats, emptySessionCounts, foldBlock, formatCount, toTrajectoryStats,
} from './stats.ts'
export type { ReasoningAnomaly, SessionCounts, TrajectoryStats } from './stats.ts'
export {
  ATTRIBUTION_VERSION, attributeSession, attributionTurnCacheFor, emptyAttribution, evidencePack, scanNode,
} from './attribution.ts'
export type {
  AttributionEvidence, AttributionReport, AttributionVerdict, TurnAttribution, VendorScore,
} from './attribution.ts'
export { ALL_SIGNALS, SCANNED_SIGNALS, VENDORS } from './attribution-signals.ts'
export type { EvidenceKind, EvidenceTier, SignalId, Vendor } from './attribution-signals.ts'
export { PROBES } from './probes.ts'
export type { ProbeEntry, ProbeId } from './probes.ts'
export { NON_PUBLIC_TOKENIZER_VENDORS, TOKENIZER_FEATURE_SETS } from './tokenizers.ts'
export type { TokenizerFeatureSet } from './tokenizers.ts'
export { FERTILITY_FAMILIES, FERTILITY_TEXTS, FERTILITY_VERSION } from './fertility.ts'
export type { FertilityFamily } from './fertility.ts'
export { fertilitySequence, fertilityVerdictOf } from './fertility-score.ts'
export type { FertilityCandidate, FertilityTurn, FertilityVerdict } from './fertility-score.ts'
