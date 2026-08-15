import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { InstallationRecord, ResolutionRecord, ReviewRecord } from '../contracts.js'
import { EvolutionError } from '../errors.js'

type RecordKind = 'resolutions' | 'reviews' | 'installations'
type StoredRecord = ResolutionRecord | ReviewRecord | InstallationRecord

function assertRecordId(id: string): void {
  if (!/^[a-z]+_[a-f0-9]{16,64}$/.test(id)) {
    throw new EvolutionError('invalid_input', 'Invalid state record id', { id })
  }
}

export class StateStore {
  constructor(readonly root: string) {}

  trialRoot(installationId: string): string {
    assertRecordId(installationId)
    return path.join(this.root, 'trials', installationId)
  }

  async put(kind: RecordKind, record: StoredRecord): Promise<void> {
    assertRecordId(record.id)
    const directory = path.join(this.root, kind)
    await mkdir(directory, { recursive: true })
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

