export const QUALITY_CLASSES = ['good', 'repairable', 'broken', 'junk', 'unknown'] as const
export type QualityClass = (typeof QUALITY_CLASSES)[number]
export type SecurityRisk = 'low' | 'medium' | 'high'
export type Repairability = 'ready' | 'repairable' | 'not_repairable'
export type EvolutionValue = 'high' | 'medium' | 'low'
export type Stage = 'review' | 'install' | 'verification'

export const REASON_CODE = /^[a-z0-9][a-z0-9._-]{0,79}$/u
export const OBSERVATION_ID = /^quality_[a-f0-9]{32}$/u
export const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
export const COMMIT = /^[a-f0-9]{40}$/u
const VERSION = /^[A-Za-z0-9._+-]{1,40}$/u

export interface QualityObservation {
  schemaVersion: 1
  id: string
  createdAt: string
  repository: string
  commit: string
  localModification: boolean
  policyVersion: string
  autoevoVersion: string
  dshVersion: string | null
  stage: Stage
  outcome: string
  reasonCodes: string[]
  securityRisk: SecurityRisk
  repairability: Repairability | null
  evolutionValue: EvolutionValue | null
}

export interface QualityAssessment {
  repository: string
  classification: QualityClass
  repairability: number | null
  evolutionValue: number | null
  confidence: number | null
  observationCount: number
  reasonCodes: string[]
  updatedAt: string | null
}

export interface SnapshotFile {
  schemaVersion: 1
  updatedAt: string
  assessments: QualityAssessment[]
}

export function boundedReasonCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.normalize('NFKC').trim().toLowerCase())
    .filter((item) => REASON_CODE.test(item)))]
    .sort()
    .slice(0, 24)
}

function boundedText(value: unknown, max: number, pattern?: RegExp): string | null {
  if (typeof value !== 'string') return null
  const text = value.normalize('NFKC').trim()
  if (!text || text.length > max) return null
  if (pattern && !pattern.test(text)) return null
  return text
}

export function parseObservation(raw: unknown): QualityObservation | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const id = boundedText(item.id, 48, OBSERVATION_ID)
  const repository = boundedText(item.repository, 120, REPOSITORY)
  const commit = typeof item.commit === 'string' ? item.commit.trim().toLowerCase() : ''
  const createdAt = boundedText(item.createdAt, 40)
  const policyVersion = boundedText(item.policyVersion, 40, VERSION)
  const autoevoVersion = boundedText(item.autoevoVersion, 40, VERSION)
  const outcome = boundedText(item.outcome, 40, REASON_CODE)
  const stage = item.stage
  const securityRisk = item.securityRisk
  if (!id || !repository || !COMMIT.test(commit) || !createdAt || !policyVersion || !autoevoVersion || !outcome) return null
  if (!Number.isFinite(Date.parse(createdAt))) return null
  if (item.schemaVersion !== 1) return null
  if (stage !== 'review' && stage !== 'install' && stage !== 'verification') return null
  if (securityRisk !== 'low' && securityRisk !== 'medium' && securityRisk !== 'high') return null
  if (typeof item.localModification !== 'boolean') return null
  const dshVersion = item.dshVersion === null ? null : boundedText(item.dshVersion, 40, VERSION)
  if (item.dshVersion !== null && dshVersion === null) return null
  const repairability = item.repairability
  if (repairability !== null && repairability !== 'ready' && repairability !== 'repairable' && repairability !== 'not_repairable') return null
  const evolutionValue = item.evolutionValue
  if (evolutionValue !== null && evolutionValue !== 'high' && evolutionValue !== 'medium' && evolutionValue !== 'low') return null
  return {
    schemaVersion: 1,
    id,
    createdAt,
    repository,
    commit,
    localModification: item.localModification,
    policyVersion,
    autoevoVersion,
    dshVersion,
    stage,
    outcome,
    reasonCodes: boundedReasonCodes(item.reasonCodes),
    securityRisk,
    repairability,
    evolutionValue,
  }
}

export function parseObservationBatch(raw: unknown): QualityObservation[] | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  if (body.schemaVersion !== 1) return null
  const list = Array.isArray(body.observations) ? body.observations : [body]
  if (list.length === 0 || list.length > 20) return null
  const parsed: QualityObservation[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const observation = parseObservation(Array.isArray(body.observations) ? item : body)
    if (!observation || seen.has(observation.id)) return null
    seen.add(observation.id)
    parsed.push(observation)
    if (!Array.isArray(body.observations)) break
  }
  return parsed
}

export function parseSnapshot(raw: unknown): SnapshotFile | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  if (body.schemaVersion !== 1 || !Array.isArray(body.assessments)) return null
  const updatedAt = typeof body.updatedAt === 'string' && Number.isFinite(Date.parse(body.updatedAt))
    ? body.updatedAt
    : new Date().toISOString()
  return { schemaVersion: 1, updatedAt, assessments: body.assessments as QualityAssessment[] }
}
