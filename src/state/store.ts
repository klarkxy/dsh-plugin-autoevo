import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { InstallationRecord, ResolutionRecord, ReviewRecord } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import type { WorkflowRecord } from '../workflow/contracts.js'
import { ensureAutoEvoGitignore } from '../workspace-layout.js'

type RecordKind = 'resolutions' | 'reviews' | 'installations' | 'workflows'
type StoredRecord = ResolutionRecord | ReviewRecord | InstallationRecord | WorkflowRecord

function assertRecordId(id: string): void {
  if (!/^[a-z]+_[a-f0-9]{16,64}$/.test(id)) {
    throw new EvolutionError('invalid_input', 'Invalid state record id', { id })
  }
}

export class StateStore {
  private readonly resolveRoot: () => string

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
    assertRecordId(record.id)
    const directory = path.join(this.root, kind)
    await mkdir(directory, { recursive: true })
    if (path.basename(this.root) === '.autoevo') await ensureAutoEvoGitignore(this.root)
    const target = path.join(directory, `${record.id}.json`)
    const temporary = path.join(directory, `.${record.id}.${randomUUID()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
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
    const directory = path.join(this.root, 'workflows')
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const workflows: WorkflowRecord[] = []
    for (const entry of entries.sort()) {
      if (!/^workflow_[a-f0-9]{16,64}\.json$/u.test(entry)) continue
      const record = JSON.parse(await readFile(path.join(directory, entry), 'utf8')) as WorkflowRecord
      workflows.push(record)
    }
    return workflows
  }

  async listInstallations(): Promise<InstallationRecord[]> {
    const directory = path.join(this.root, 'installations')
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const installations: InstallationRecord[] = []
    for (const entry of entries.sort()) {
      if (!/^installation_[a-f0-9]{16,64}\.json$/u.test(entry)) continue
      const record = JSON.parse(await readFile(path.join(directory, entry), 'utf8')) as InstallationRecord
      installations.push(record)
    }
    return installations
  }

  async listAllReviews(): Promise<ReviewRecord[]> {
    return this.readReviews()
  }

  async listReviews(resolutionId: string): Promise<ReviewRecord[]> {
    assertRecordId(resolutionId)
    return (await this.readReviews()).filter((record) => record.resolutionId === resolutionId)
  }

  private async readReviews(): Promise<ReviewRecord[]> {
    const directory = path.join(this.root, 'reviews')
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const reviews: ReviewRecord[] = []
    for (const entry of entries.sort()) {
      if (!/^review_[a-f0-9]{16,64}\.json$/u.test(entry)) continue
      reviews.push(JSON.parse(await readFile(path.join(directory, entry), 'utf8')) as ReviewRecord)
    }
    return reviews
  }

  private async get(kind: RecordKind, id: string): Promise<StoredRecord> {
    assertRecordId(id)
    try {
      const body = await readFile(path.join(this.root, kind, `${id}.json`), 'utf8')
      const record = JSON.parse(body) as StoredRecord
      if (record.id !== id) throw new Error('record id mismatch')
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new EvolutionError('not_found', `Unknown ${kind.slice(0, -1)} id`, { id })
      }
      throw error
    }
  }
}
