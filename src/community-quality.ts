import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { RuntimeConfig } from './config.js'
import {
  POLICY_VERSION,
  type CommunityQualityAssessment,
  type CommunityQualityClass,
  type CommunityQualityScreening,
  type InstallationRecord,
  type RemotePluginCandidate,
  type ReviewRecord,
  type SecurityRisk,
} from './contracts.js'

const AUTOEVO_VERSION = createRequire(import.meta.url)('../package.json').version as string
const MAX_RESPONSE_BYTES = 1_048_576
const QUALITY_CLASSES = new Set<CommunityQualityClass>(['good', 'repairable', 'broken', 'junk', 'unknown'])
const REASON_CODE = /^[a-z0-9][a-z0-9._-]{0,79}$/u

export interface CommunityQualitySource {
  repository: string
  commit: string
  localModification: boolean
}

export interface CommunityQualityResult {
  candidates: RemotePluginCandidate[]
  screening?: CommunityQualityScreening
}

interface QualityObservationPayload {
  schemaVersion: 1
  id: string
  createdAt: string
  repository: string
  commit: string
  localModification: boolean
  policyVersion: string
  autoevoVersion: string
  dshVersion: string | null
  stage: 'review' | 'install' | 'verification'
  outcome: string
  reasonCodes: string[]
  securityRisk: SecurityRisk
  repairability: 'ready' | 'repairable' | 'not_repairable' | null
  evolutionValue: 'high' | 'medium' | 'low' | null
}

interface StoredQualityObservation extends QualityObservationPayload {
  delivery: {
    status: 'pending' | 'sent'
    attemptedAt?: string
    sentAt?: string
  }
}

interface QualityResponseItem {
  repository?: unknown
  classification?: unknown
  repairability?: unknown
  evolutionValue?: unknown
  confidence?: unknown
  observationCount?: unknown
  reasonCodes?: unknown
  updatedAt?: unknown
}

interface QualityResponse {
  assessments?: unknown
}

interface StoredSnapshot {
  fetchedAt: string
  assessments: Array<CommunityQualityAssessment & { repository: string }>
}

type FetchLike = typeof globalThis.fetch

function serviceUrl(base: string, relative: string): string {
  return new URL(relative, `${base}/`).toString()
}

function boundedReasonCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.normalize('NFKC').trim().toLowerCase())
    .filter((item) => REASON_CODE.test(item)))]
    .sort()
    .slice(0, 24)
}

function boundedScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}

function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : 0
}

function utcDay(value: number | string): string {
  const time = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(time)) return ''
  return new Date(time).toISOString().slice(0, 10)
}

function boundedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) return null
  return value
}

function assessmentFromResponse(raw: unknown, requested: ReadonlySet<string>): { repository: string, assessment: CommunityQualityAssessment } | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as QualityResponseItem
  if (typeof item.repository !== 'string') return null
  const repository = item.repository.normalize('NFKC').trim()
  if (!requested.has(repository.toLowerCase())) return null
  if (typeof item.classification !== 'string' || !QUALITY_CLASSES.has(item.classification as CommunityQualityClass)) return null
  return {
    repository,
    assessment: {
      classification: item.classification as CommunityQualityClass,
      repairability: boundedScore(item.repairability),
      evolutionValue: boundedScore(item.evolutionValue),
      confidence: boundedScore(item.confidence),
      observationCount: boundedCount(item.observationCount),
      reasonCodes: boundedReasonCodes(item.reasonCodes),
      updatedAt: boundedTimestamp(item.updatedAt),
    },
  }
}

function observationReasonCodes(review: ReviewRecord): string[] {
  return boundedReasonCodes([
    `fit_${review.fit}`,
    `compatibility_${review.compatibility.status}`,
    `recommendation_${review.recommendation}`,
    `maintained_${review.maintained ? 'yes' : 'no'}`,
    ...review.findings.map((finding) => finding.code),
  ])
}

function reviewOutcome(review: ReviewRecord): Pick<QualityObservationPayload, 'outcome' | 'repairability' | 'evolutionValue'> {
  if (review.recommendation === 'use') return { outcome: 'usable', repairability: 'ready', evolutionValue: 'medium' }
  if (review.recommendation === 'modify') return { outcome: 'repairable', repairability: 'repairable', evolutionValue: 'high' }
  return { outcome: 'unusable', repairability: 'not_repairable', evolutionValue: 'low' }
}

function verificationReasonCodes(record: InstallationRecord): string[] {
  const evidence = record.verification
  return boundedReasonCodes([
    evidence.attempted ? 'attempted' : 'not_attempted',
    evidence.exitCode !== undefined && evidence.exitCode !== 0 ? 'exit_nonzero' : 'exit_ok',
    evidence.expectedTools.some((tool) => !evidence.calledTools.includes(tool)) ? 'missing_tool_call' : 'tool_calls_observed',
    evidence.failedTools.length > 0 ? 'tool_result_failed' : 'no_tool_result_failure',
    evidence.taskResultObserved ? 'final_answer_observed' : 'final_answer_missing',
    evidence.taskResultMatchedExpectation === false ? 'expectation_mismatch' : 'expectation_ok_or_unused',
  ])
}

function uploadPayload(record: StoredQualityObservation): QualityObservationPayload {
  return {
    schemaVersion: 1,
    id: record.id,
    createdAt: record.createdAt,
    repository: record.repository,
    commit: record.commit,
    localModification: record.localModification,
    policyVersion: record.policyVersion,
    autoevoVersion: record.autoevoVersion,
    dshVersion: record.dshVersion,
    stage: record.stage,
    outcome: record.outcome,
    reasonCodes: boundedReasonCodes(record.reasonCodes),
    securityRisk: record.securityRisk,
    repairability: record.repairability,
    evolutionValue: record.evolutionValue,
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return {}
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('community quality response exceeded the size limit')
      chunks.push(chunk.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  if (bytes === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export class CommunityQualityService {
  private readonly qualityRoot: string
  private readonly observationsRoot: string
  private readonly snapshotFile: string
  private snapshot: { fetchedAt: string, assessments: Map<string, CommunityQualityAssessment> } | undefined

  constructor(
    private readonly config: RuntimeConfig,
    private readonly fetcher: FetchLike = globalThis.fetch,
  ) {
    this.qualityRoot = path.join(config.stateDir, 'community-quality')
    this.observationsRoot = path.join(this.qualityRoot, 'observations')
    this.snapshotFile = path.join(this.qualityRoot, 'assessments.json')
  }

  async screen(candidates: readonly RemotePluginCandidate[], signal?: AbortSignal): Promise<CommunityQualityResult> {
    if (!this.config.communityQualityFilter) return { candidates: [...candidates] }
    if (candidates.length === 0) {
      return {
        candidates: [],
        screening: {
          enabled: true,
          complete: true,
          assessedCandidates: 0,
          filtered: [],
          reason: 'Community quality filtering was enabled; there were no candidates to assess.',
        },
      }
    }
    if (!this.config.communityQualityEndpoint) {
      return {
        candidates: [...candidates],
        screening: {
          enabled: true,
          complete: false,
          assessedCandidates: 0,
          filtered: [],
          reason: 'Community quality filtering is enabled but communityQualityEndpoint is empty; candidates were kept.',
        },
      }
    }

    const requested = new Set(candidates.map((candidate) => candidate.repository.toLowerCase()))
    try {
      const snapshot = await this.loadSnapshot(signal)
      const assessments = new Map<string, CommunityQualityAssessment>()
      const filtered: CommunityQualityScreening['filtered'] = []
      const kept: RemotePluginCandidate[] = []
      for (const candidate of candidates) {
        const assessment = snapshot.get(candidate.repository.toLowerCase())
        if (!assessment || !requested.has(candidate.repository.toLowerCase())) {
          kept.push(candidate)
          continue
        }
        assessments.set(candidate.repository.toLowerCase(), assessment)
        if (assessment.classification === 'broken' || assessment.classification === 'junk') {
          filtered.push({
            repository: candidate.repository,
            classification: assessment.classification,
            reasonCodes: assessment.reasonCodes,
          })
          continue
        }
        kept.push({ ...candidate, communityQuality: assessment })
      }
      return {
        candidates: kept,
        screening: {
          enabled: true,
          complete: true,
          assessedCandidates: assessments.size,
          filtered,
          reason: `Community quality filtering assessed ${assessments.size} candidate(s) and filtered ${filtered.length}. Unknown candidates were kept.`,
        },
      }
    } catch {
      return {
        candidates: [...candidates],
        screening: {
          enabled: true,
          complete: false,
          assessedCandidates: 0,
          filtered: [],
          reason: 'Community quality service was unavailable or returned invalid data; candidates were kept.',
        },
      }
    }
  }

  async recordReview(source: CommunityQualitySource, review: ReviewRecord): Promise<void> {
    if (!this.config.communityReports) return
    await this.persistAndSend({
      ...this.observationBase(source, review),
      stage: 'review',
      ...reviewOutcome(review),
      reasonCodes: observationReasonCodes(review),
    })
  }

  async recordInstallation(source: CommunityQualitySource, review: ReviewRecord, record: InstallationRecord): Promise<void> {
    if (!this.config.communityReports) return
    const base = this.observationBase(source, review)
    const installOutcome = record.installState === 'installed'
      ? 'installed'
      : record.installState === 'unknown'
        ? 'install_unknown'
        : 'not_installed'
    await this.persistAndSend({
      ...base,
      id: `quality_${randomUUID().replaceAll('-', '')}`,
      createdAt: new Date().toISOString(),
      stage: 'install',
      outcome: installOutcome,
      reasonCodes: boundedReasonCodes([
        `retention_${record.retention}`,
        ...(record.installFailure ? [record.installFailure.code] : []),
      ]),
      repairability: null,
      evolutionValue: null,
    })
    await this.persistAndSend({
      ...base,
      id: `quality_${randomUUID().replaceAll('-', '')}`,
      createdAt: new Date().toISOString(),
      stage: 'verification',
      outcome: record.verified ? 'verified' : record.verification.attempted ? 'verification_failed' : 'not_attempted',
      reasonCodes: verificationReasonCodes(record),
      repairability: null,
      evolutionValue: null,
    })
    await this.flushPending()
  }

  async flushPending(limit = 20): Promise<void> {
    if (!this.config.communityReports || !this.config.communityQualityEndpoint) return
    let entries: string[]
    try {
      entries = await readdir(this.observationsRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const pending: Array<{ file: string, record: StoredQualityObservation }> = []
    for (const entry of entries.filter((name) => /^quality_[a-f0-9]{32}\.json$/u.test(name)).sort()) {
      if (pending.length >= limit) break
      try {
        const file = path.join(this.observationsRoot, entry)
        const record = JSON.parse(await readFile(file, 'utf8')) as StoredQualityObservation
        if (record.delivery?.status === 'pending') pending.push({ file, record })
      } catch {
        // A corrupt local record must not block the rest of the batch.
      }
    }
    if (pending.length === 0) return
    pending.sort((left, right) => left.record.createdAt.localeCompare(right.record.createdAt) || left.record.id.localeCompare(right.record.id))
    const attemptedAt = new Date().toISOString()
    await this.requestJson('POST', 'v1/quality/observations', {
      schemaVersion: 1,
      observations: pending.map((item) => uploadPayload(item.record)),
    })
    const sentAt = new Date().toISOString()
    for (const item of pending) {
      await this.atomicWrite(item.file, {
        ...item.record,
        delivery: { status: 'sent', attemptedAt, sentAt },
      })
    }
  }

  private observationBase(source: CommunityQualitySource, review: ReviewRecord): Omit<QualityObservationPayload, 'stage' | 'outcome' | 'reasonCodes' | 'repairability' | 'evolutionValue'> {
    return {
      schemaVersion: 1,
      id: `quality_${randomUUID().replaceAll('-', '')}`,
      createdAt: new Date().toISOString(),
      repository: source.repository,
      commit: source.commit,
      localModification: source.localModification,
      policyVersion: review.policyVersion || POLICY_VERSION,
      autoevoVersion: AUTOEVO_VERSION,
      dshVersion: review.compatibility.runtimeVersion,
      securityRisk: review.securityRisk,
    }
  }

  private parseAssessments(raw: readonly unknown[]): {
    list: StoredSnapshot['assessments']
    map: Map<string, CommunityQualityAssessment>
  } {
    const list: StoredSnapshot['assessments'] = []
    const map = new Map<string, CommunityQualityAssessment>()
    for (const item of raw.slice(0, 4_000)) {
      if (!item || typeof item !== 'object') continue
      const repository = (item as QualityResponseItem).repository
      if (typeof repository !== 'string') continue
      const parsed = assessmentFromResponse({ ...item, repository }, new Set([repository.normalize('NFKC').trim().toLowerCase()]))
      if (!parsed) continue
      list.push({ repository: parsed.repository, ...parsed.assessment })
      map.set(parsed.repository.toLowerCase(), parsed.assessment)
    }
    return { list, map }
  }

  private async readStoredSnapshot(): Promise<{ fetchedAt: string, assessments: Map<string, CommunityQualityAssessment> } | undefined> {
    try {
      const stored = JSON.parse(await readFile(this.snapshotFile, 'utf8')) as Partial<StoredSnapshot>
      if (typeof stored.fetchedAt !== 'string' || !Array.isArray(stored.assessments)) return undefined
      const parsed = this.parseAssessments(stored.assessments)
      return { fetchedAt: stored.fetchedAt, assessments: parsed.map }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return undefined
    }
  }

  private async loadSnapshot(signal?: AbortSignal): Promise<Map<string, CommunityQualityAssessment>> {
    const today = utcDay(Date.now())
    if (this.snapshot && utcDay(this.snapshot.fetchedAt) === today) return this.snapshot.assessments
    const stored = await this.readStoredSnapshot()
    if (stored && utcDay(stored.fetchedAt) === today) {
      this.snapshot = stored
      return stored.assessments
    }
    try {
      const value = await this.requestJson('GET', 'v1/quality/assessments', undefined, signal) as QualityResponse
      if (!value || typeof value !== 'object' || !Array.isArray(value.assessments)) {
        throw new TypeError('invalid community quality snapshot')
      }
      const parsed = this.parseAssessments(value.assessments)
      const fetchedAt = new Date().toISOString()
      this.snapshot = { fetchedAt, assessments: parsed.map }
      await mkdir(this.qualityRoot, { recursive: true })
      await this.atomicWrite(this.snapshotFile, { fetchedAt, assessments: parsed.list } satisfies StoredSnapshot)
      return parsed.map
    } catch (error) {
      if (stored) {
        this.snapshot = stored
        return stored.assessments
      }
      throw error
    }
  }

  private async persistAndSend(payload: QualityObservationPayload): Promise<void> {
    const record: StoredQualityObservation = { ...payload, delivery: { status: 'pending' } }
    await mkdir(this.observationsRoot, { recursive: true })
    const file = path.join(this.observationsRoot, `${payload.id}.json`)
    await this.atomicWrite(file, record)
  }

  private async requestJson(
    method: 'GET' | 'POST',
    relative: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) controller.abort(signal.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('community quality request timed out')), this.config.communityQualityTimeoutMs)
    try {
      const response = await this.fetcher(serviceUrl(this.config.communityQualityEndpoint, relative), {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`community quality service returned ${response.status}`)
      if (response.status === 204) return {}
      return await readBoundedJson(response)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async atomicWrite(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, file)
  }
}

export const _testing = {
  assessmentFromResponse,
  boundedReasonCodes,
  observationReasonCodes,
  readBoundedJson,
  uploadPayload,
  verificationReasonCodes,
}
