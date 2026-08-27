import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { InstallationRecord, ResolutionRecord, ReviewRecord } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import type { WorkflowRecord } from '../workflow/contracts.js'
import { ensureAutoEvoGitignore } from '../workspace-layout.js'
import { sha256 } from './hashes.js'

type RecordKind = 'resolutions' | 'reviews' | 'installations' | 'workflows'
type StoredRecord = ResolutionRecord | ReviewRecord | InstallationRecord | WorkflowRecord

export interface StateRecordDiagnostic {
  kind: RecordKind
  recordId?: string
  fileName: string
  code: 'invalid_json' | 'invalid_record'
  summary: string
  diagnosticHash: string
}

const KIND_PREFIX: Record<RecordKind, string> = {
  resolutions: 'resolution_',
  reviews: 'review_',
  installations: 'installation_',
  workflows: 'workflow_',
}

function assertRecordId(id: string): void {
  if (!/^[a-z]+_[a-f0-9]{16,64}$/.test(id)) {
    throw new EvolutionError('invalid_input', 'Invalid state record id', { id })
  }
}

function validateRecord(kind: RecordKind, value: unknown, expectedId?: string): StoredRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('record must be a JSON object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string') throw new Error('record id is missing')
  assertRecordId(record.id)
  if (!record.id.startsWith(KIND_PREFIX[kind])) throw new Error('record id has the wrong kind prefix')
  if (expectedId && record.id !== expectedId) throw new Error('record id mismatch')
  if (!Number.isInteger(record.schemaVersion) || Number(record.schemaVersion) < 1) {
    throw new Error('schemaVersion must be a positive integer')
  }
  if (typeof record.createdAt !== 'string' || !record.createdAt) throw new Error('createdAt is missing')
  switch (kind) {
    case 'resolutions':
      if (typeof record.requirement !== 'string') throw new Error('resolution requirement is missing')
      break
    case 'reviews':
      if (typeof record.resolutionId !== 'string') throw new Error('review resolutionId is missing')
      break
    case 'installations':
      if (typeof record.targetProfile !== 'string' || typeof record.retention !== 'string') {
        throw new Error('installation targetProfile or retention is missing')
      }
      break
    case 'workflows':
      if (typeof record.requirement !== 'string') throw new Error('workflow requirement is missing')
      break
  }
  return value as StoredRecord
}

export class StateStore {
  private readonly resolveRoot: () => string
  private readonly diagnostics = new Map<string, StateRecordDiagnostic>()

  constructor(root: string | (() => string)) {
    this.resolveRoot = typeof root === 'function' ? root : () => root
  }

  get root(): string {
    return this.resolveRoot()
  }

  trialRoot(installationId: string): string {
    assertRecordId(installationId)
    return path.join(this.root, 'trials', installationId)
  }

  async put(kind: RecordKind, record: StoredRecord): Promise<void> {
    validateRecord(kind, record, record.id)
    const directory = path.join(this.root, kind)
    await mkdir(directory, { recursive: true })
    if (path.basename(this.root) === '.autoevo') await ensureAutoEvoGitignore(this.root)
    const target = path.join(directory, `${record.id}.json`)
    const temporary = path.join(directory, `.${record.id}.${randomUUID()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
    this.diagnostics.delete(`${kind}/${path.basename(target)}`)
  }

  stateDiagnostics(): StateRecordDiagnostic[] {
    return [...this.diagnostics.values()].sort((left, right) =>
      `${left.kind}/${left.fileName}`.localeCompare(`${right.kind}/${right.fileName}`))
  }

  async getResolution(id: string): Promise<ResolutionRecord> {
    return this.get('resolutions', id) as Promise<ResolutionRecord>
  }

  async getReview(id: string): Promise<ReviewRecord> {
    return this.get('reviews', id) as Promise<ReviewRecord>
  }

  async getInstallation(id: string): Promise<InstallationRecord> {
    return this.get('installations', id) as Promise<InstallationRecord>
  }

  async getWorkflow(id: string): Promise<WorkflowRecord> {
    return this.get('workflows', id) as Promise<WorkflowRecord>
  }

  async listWorkflows(): Promise<WorkflowRecord[]> {
    return this.list('workflows') as Promise<WorkflowRecord[]>
  }

  async listInstallations(): Promise<InstallationRecord[]> {
    return this.list('installations') as Promise<InstallationRecord[]>
  }

  async findInstallationForWorkflow(workflowId: string): Promise<InstallationRecord | undefined> {
    assertRecordId(workflowId)
    if (!workflowId.startsWith('workflow_')) {
      throw new EvolutionError('invalid_input', 'Invalid workflow id', { workflowId })
    }
    const matches = (await this.listInstallations()).filter((record) => record.workflowId === workflowId)
    if (matches.length > 1) {
      throw new EvolutionError('invalid_input', 'Workflow installation recovery is ambiguous; inspect the linked receipts before continuing', {
        workflowId,
        installationIds: matches.map((record) => record.id),
      })
    }
    return matches[0]
  }

  async listAllReviews(): Promise<ReviewRecord[]> {
    return this.readReviews()
  }

  async listReviews(resolutionId: string): Promise<ReviewRecord[]> {
    assertRecordId(resolutionId)
    return (await this.readReviews()).filter((record) => record.resolutionId === resolutionId)
  }

  private async readReviews(): Promise<ReviewRecord[]> {
    return this.list('reviews') as Promise<ReviewRecord[]>
  }

  private recordDiagnostic(kind: RecordKind, fileName: string, error: unknown): StateRecordDiagnostic {
    const summary = error instanceof SyntaxError
      ? 'State record is not valid JSON.'
      : 'State record failed lightweight validation.'
    const diagnostic: StateRecordDiagnostic = {
      kind,
      ...(fileName.endsWith('.json') ? { recordId: fileName.slice(0, -'.json'.length) } : {}),
      fileName,
      code: error instanceof SyntaxError ? 'invalid_json' : 'invalid_record',
      summary,
      diagnosticHash: sha256(error instanceof Error ? error.message : String(error)),
    }
    this.diagnostics.set(`${kind}/${fileName}`, diagnostic)
    return diagnostic
  }

  private async list(kind: RecordKind): Promise<StoredRecord[]> {
    const directory = path.join(this.root, kind)
    for (const key of this.diagnostics.keys()) {
      if (key.startsWith(`${kind}/`)) this.diagnostics.delete(key)
    }
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: StoredRecord[] = []
    const expected = new RegExp(`^${KIND_PREFIX[kind]}[a-f0-9]{16,64}\\.json$`, 'u')
    for (const entry of entries.sort()) {
      if (!expected.test(entry)) continue
      const key = `${kind}/${entry}`
      try {
        const body = await readFile(path.join(directory, entry), 'utf8')
        const record = validateRecord(kind, JSON.parse(body), entry.slice(0, -'.json'.length))
        this.diagnostics.delete(key)
        records.push(record)
      } catch (error) {
        this.recordDiagnostic(kind, entry, error)
      }
    }
    return records
  }

  private async get(kind: RecordKind, id: string): Promise<StoredRecord> {
    assertRecordId(id)
    try {
      const body = await readFile(path.join(this.root, kind, `${id}.json`), 'utf8')
      const record = validateRecord(kind, JSON.parse(body), id)
      this.diagnostics.delete(`${kind}/${id}.json`)
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new EvolutionError('not_found', `Unknown ${kind.slice(0, -1)} id`, { id })
      }
      const diagnostic = this.recordDiagnostic(kind, `${id}.json`, error)
      throw new EvolutionError('invalid_input', `Corrupt ${kind.slice(0, -1)} state record`, {
        id,
        diagnosticHash: diagnostic.diagnosticHash,
      })
    }
  }
}
