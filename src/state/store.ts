import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { POLICY_VERSION, type InstallationRecord, type ResolutionRecord, type ReviewRecord } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { projectInstallation } from '../installation-lifecycle.js'
import type { WorkflowRecord } from '../workflow/contracts.js'
import { ensureAutoEvoGitignore } from '../workspace-layout.js'
import { sha256 } from './hashes.js'

type RecordKind = 'resolutions' | 'reviews' | 'installations' | 'workflows'
type StoredRecord = ResolutionRecord | ReviewRecord | InstallationRecord | WorkflowRecord
type StrictRecordValidator = (record: StoredRecord) => void

const INSTALL_PHASES = new Set(['prepared', 'preflight_running', 'preflight_passed', 'destination_installing', 'completed'])
const INSTALL_STATES = new Set(['installed', 'not_installed', 'unknown'])
const INSTALL_OUTCOMES = new Set(['pending', 'verified', 'failed_absent', 'recovery_required', 'activated', 'awaiting_user_test'])
const REPLACEMENT_STATES = new Set(['prepared', 'old_present', 'new_present', 'absent', 'unknown'])
const WORKFLOW_STATUSES = new Set(['running', 'interrupted', 'completed', 'failed'])
const WORKFLOW_CURSORS = new Set([
  'await_clarification',
  'resolve_local',
  'discover_remote',
  'ensure_market',
  'await_discovery',
  'await_selection',
  'review_github',
  'review_existing',
  'await_confirmation',
  'prepare_modify',
  'await_modify_work',
  'complete_managed_work',
  'review_local',
  'install_verify',
  'prepare_create',
  'reuse_local',
  'enable_builtin',
  'stopped',
  'market_restart_required',
  'market_setup_required',
  'installed',
  'activated',
  'awaiting_user_test',
  'restart_required',
  'recovery_required',
  'create_authorized',
  'modify_authorized',
  'superseded',
])
const INTERRUPT_KINDS = new Set([
  'await_clarification',
  'await_selection',
  'await_confirmation',
  'await_modify_work',
  'await_recovery',
])

export type InstallationExclusiveCreateResult =
  | { status: 'created'; installation: InstallationRecord }
  | { status: 'existing'; installation: InstallationRecord }

export interface AdoptionClaim {
  installationId: string
  observedSpecDigest: string
  dshHome: string
  profile: string
  packageName: string
  observedSpec: string
  configuredBundle: boolean
  claimToken: string
  createdAt: string
}

export type AdoptionClaimResult =
  | { status: 'claimed'; claim: AdoptionClaim }
  | { status: 'existing'; claim: AdoptionClaim }

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

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertPrefixedId(value: unknown, prefix: string, field: string): void {
  if (typeof value !== 'string'
    || !value.startsWith(`${prefix}_`)
    || !/^[a-z]+_[a-f0-9]{16,64}$/u.test(value)) {
    throw new Error(`${field} has an invalid state id`)
  }
}

function assertOptionalPrefixedId(
  record: Record<string, unknown>,
  field: string,
  prefix: string,
): void {
  if (record[field] !== undefined) assertPrefixedId(record[field], prefix, field)
}

function validateStrictInstallationRecord(stored: StoredRecord): void {
  const record = stored as unknown as Record<string, unknown>
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) throw new Error('installation schema version is unsupported')
  if (!nonemptyString(record.dshHome)
    || !nonemptyString(record.targetProfile)
    || !nonemptyString(record.installSpec)) {
    throw new Error('installation identity fields are missing')
  }
  if (record.packageName !== null
    && (!nonemptyString(record.packageName))) {
    throw new Error('installation packageName is invalid')
  }
  if (record.retention !== 'temporary' && record.retention !== 'persistent') {
    throw new Error('installation retention is invalid')
  }
  for (const field of ['installed', 'loaded', 'verified', 'restartRequired', 'removed']) {
    if (typeof record[field] !== 'boolean') throw new Error(`installation ${field} is missing`)
  }
  if (!plainObject(record.verification)) throw new Error('installation verification is invalid')
  if (record.installPhase !== undefined && !INSTALL_PHASES.has(record.installPhase as string)) {
    throw new Error('installation phase is invalid')
  }
  if (record.installState !== undefined && !INSTALL_STATES.has(record.installState as string)) {
    throw new Error('installation state is invalid')
  }
  if (record.installOutcome !== undefined && !INSTALL_OUTCOMES.has(record.installOutcome as string)) {
    throw new Error('installation outcome is invalid')
  }
  assertOptionalPrefixedId(record, 'workflowId', 'workflow')
  assertOptionalPrefixedId(record, 'reviewId', 'review')
  assertOptionalPrefixedId(record, 'predecessorInstallationId', 'installation')
  assertOptionalPrefixedId(record, 'supersededByInstallationId', 'installation')
  if (record.artifactSha256 !== undefined
    && (typeof record.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.artifactSha256))) {
    throw new Error('installation artifact digest is invalid')
  }

  let validReplacement = false
  if (record.replacement !== undefined) {
    if (!plainObject(record.replacement)) throw new Error('installation replacement is invalid')
    const replacement = record.replacement
    if (!REPLACEMENT_STATES.has(replacement.state as string)
      || typeof replacement.oldSpecDigest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(replacement.oldSpecDigest)
      || !nonemptyString(replacement.newInstallSpec)
      || !nonemptyString(replacement.preparedAt)
      || (replacement.reconciledAt !== undefined && !nonemptyString(replacement.reconciledAt))) {
      throw new Error('installation replacement is invalid')
    }
    validReplacement = true
  }
  if (record.predecessorInstallationId !== undefined && !validReplacement) {
    throw new Error('installation predecessor is missing replacement evidence')
  }
  if (record.predecessorInstallationId !== undefined) {
    const replacement = record.replacement as Record<string, unknown>
    const committedLifecycle = record.removed === true
      ? true
      : record.installed === true && record.installState === 'installed'
    if (record.retention !== 'persistent'
      || record.installPhase !== 'completed'
      || !committedLifecycle
      || replacement.state !== 'new_present'
      || record.installSpec !== replacement.newInstallSpec) {
      throw new Error('installation predecessor is not a committed replacement edge')
    }
  }
  const projected = projectInstallation(stored as InstallationRecord)
  Object.assign(stored, projected)
}

function validateStrictWorkflowRecord(stored: StoredRecord): void {
  const record = stored as unknown as Record<string, unknown>
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2 && record.schemaVersion !== 3) {
    throw new Error('workflow schema version is unsupported')
  }
  if (!nonemptyString(record.updatedAt) || !nonemptyString(record.policyVersion)) {
    throw new Error('workflow coordination fields are missing')
  }
  if (!WORKFLOW_STATUSES.has(record.status as string)) throw new Error('workflow status is invalid')
  if (!WORKFLOW_CURSORS.has(record.cursor as string)) throw new Error('workflow cursor is invalid')
  if (!Number.isInteger(record.generation) || Number(record.generation) < 0) {
    throw new Error('workflow generation is invalid')
  }
  assertOptionalPrefixedId(record, 'supersededByWorkflowId', 'workflow')
  assertOptionalPrefixedId(record, 'recoveredFromWorkflowId', 'workflow')
  assertOptionalPrefixedId(record, 'pendingInstallationId', 'installation')
  assertOptionalPrefixedId(record, 'lastInstallationId', 'installation')
  if (record.consumedInterruptIds !== undefined) {
    if (!Array.isArray(record.consumedInterruptIds)) throw new Error('workflow consumed interrupt ids are invalid')
    for (const interruptId of record.consumedInterruptIds) {
      assertPrefixedId(interruptId, 'interrupt', 'consumedInterruptIds')
    }
  }
  if (record.interrupt !== undefined) {
    if (!plainObject(record.interrupt)) throw new Error('workflow interrupt is invalid')
    const interrupt = record.interrupt
    if (!INTERRUPT_KINDS.has(interrupt.kind as string)
      || !nonemptyString(interrupt.ownerSessionId)
      || !nonemptyString(interrupt.bootId)
      || typeof interrupt.snapshotDigest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(interrupt.snapshotDigest)
      || !Array.isArray(interrupt.options)
      || !plainObject(interrupt.facts)) {
      throw new Error('workflow interrupt is invalid')
    }
    assertPrefixedId(interrupt.interruptId, 'interrupt', 'interruptId')
    assertPrefixedId(interrupt.validAfterTurnId, 'turn', 'validAfterTurnId')
  }
  if (record.policyVersion === POLICY_VERSION
    && (record.status === 'running' || record.status === 'interrupted')
    && (!nonemptyString(record.ownerSessionId)
      || !nonemptyString(record.cwd)
      || !nonemptyString(record.requirementNormalized)
      || !nonemptyString(record.bootId))) {
    throw new Error('current unfinished workflow identity is incomplete')
  }
  Object.assign(stored, projectStoredRecord('workflows', stored))
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
      if (record.schemaVersion === 1) record.schemaVersion = 2
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
      delete record.executionLease
      break
  }
  return value as StoredRecord
}

function projectStoredRecord(kind: RecordKind, record: StoredRecord): StoredRecord {
  if (kind === 'workflows') {
    const workflow = record as unknown as Record<string, unknown>
    if (workflow.schemaVersion === 1 || workflow.schemaVersion === 2) workflow.schemaVersion = 3
    return record
  }
  if (kind === 'installations' && typeof (record as InstallationRecord).installed === 'boolean') {
    return projectInstallation(record as InstallationRecord)
  }
  return record
}

function assertAdoptionClaimInput(input: Omit<AdoptionClaim, 'observedSpecDigest' | 'claimToken' | 'createdAt'>): void {
  assertRecordId(input.installationId)
  if (!input.installationId.startsWith('installation_')
    || !input.dshHome
    || !input.profile
    || !input.packageName
    || !input.observedSpec
    || typeof input.configuredBundle !== 'boolean') {
    throw new EvolutionError('invalid_input', 'Invalid adoption claim identity')
  }
}

function validateAdoptionClaim(
  value: unknown,
  expected: Omit<AdoptionClaim, 'observedSpecDigest' | 'claimToken' | 'createdAt'>,
): AdoptionClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('adoption claim must be a JSON object')
  const claim = value as Record<string, unknown>
  const digest = sha256(expected.observedSpec)
  if (claim.installationId !== expected.installationId
    || claim.observedSpecDigest !== digest
    || claim.dshHome !== expected.dshHome
    || claim.profile !== expected.profile
    || claim.packageName !== expected.packageName
    || claim.observedSpec !== expected.observedSpec
    || claim.configuredBundle !== expected.configuredBundle
    || typeof claim.claimToken !== 'string'
    || !claim.claimToken
    || typeof claim.createdAt !== 'string'
    || !claim.createdAt) {
    throw new Error('adoption claim identity mismatch')
  }
  return claim as unknown as AdoptionClaim
}

export class StateStore {
  private readonly resolveRoot: () => string
  private readonly diagnostics = new Map<string, StateRecordDiagnostic>()
  private readonly strictDiagnosticKeys = new Set<string>()

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
    const stored = validateRecord(kind, record, record.id)
    const directory = path.join(this.root, kind)
    await mkdir(directory, { recursive: true })
    if (path.basename(this.root) === '.autoevo') await ensureAutoEvoGitignore(this.root)
    const target = path.join(directory, `${stored.id}.json`)
    const temporary = path.join(directory, `.${stored.id}.${randomUUID()}.tmp`)
    const body = `${JSON.stringify(stored, null, 2)}\n`
    try {
      await this.writeTemporary(temporary, body)
      try {
        await this.renameTemporary(temporary, target)
      } catch (error) {
        if (!await this.wasWrittenExactly(target, body)) throw error
      }
      this.diagnostics.delete(`${kind}/${path.basename(target)}`)
    } finally {
      await this.removeTemporary(temporary).catch(() => undefined)
    }
  }

  async createInstallationExclusive(record: InstallationRecord): Promise<InstallationExclusiveCreateResult> {
    validateRecord('installations', record, record.id)
    const directory = path.join(this.root, 'installations')
    await mkdir(directory, { recursive: true })
    if (path.basename(this.root) === '.autoevo') await ensureAutoEvoGitignore(this.root)
    const target = path.join(directory, `${record.id}.json`)
    const body = `${JSON.stringify(record, null, 2)}\n`
    try {
      await this.writeAppendOnly(target, body)
      this.diagnostics.delete(`installations/${path.basename(target)}`)
      return { status: 'created', installation: record }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (await this.wasWrittenExactly(target, body)) {
          this.diagnostics.delete(`installations/${path.basename(target)}`)
          return { status: 'created', installation: record }
        }
        throw error
      }
    }
    // The receipt pathname is the claim. A malformed or unreadable existing
    // body still owns that identity and must never be replaced.
    return { status: 'existing', installation: await this.getInstallation(record.id) }
  }

  async claimAdoption(
    input: Omit<AdoptionClaim, 'observedSpecDigest' | 'claimToken' | 'createdAt'>,
  ): Promise<AdoptionClaimResult> {
    assertAdoptionClaimInput(input)
    const directory = path.join(this.root, 'adoption-claims')
    await mkdir(directory, { recursive: true })
    if (path.basename(this.root) === '.autoevo') await ensureAutoEvoGitignore(this.root)
    const observedSpecDigest = sha256(input.observedSpec)
    const target = path.join(directory, `${input.installationId}.${observedSpecDigest}.json`)
    const claim: AdoptionClaim = {
      ...input,
      observedSpecDigest,
      claimToken: randomUUID(),
      createdAt: new Date().toISOString(),
    }
    const body = `${JSON.stringify(claim, null, 2)}\n`
    try {
      await this.writeAppendOnly(target, body)
      return { status: 'claimed', claim }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (await this.wasWrittenExactly(target, body)) return { status: 'claimed', claim }
        throw error
      }
    }
    try {
      const existing = validateAdoptionClaim(JSON.parse(await readFile(target, 'utf8')), input)
      return { status: 'existing', claim: existing }
    } catch (cause) {
      throw new EvolutionError('invalid_input', 'Corrupt or conflicting adoption claim already owns this source generation', {
        installationId: input.installationId,
        observedSpecDigest,
        diagnosticHash: sha256(cause instanceof Error ? cause.message : String(cause)),
      })
    }
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

  async listWorkflowsStrict(): Promise<WorkflowRecord[]> {
    const result = await this.listPass('workflows', validateStrictWorkflowRecord)
    if (result.diagnostics.length > 0) {
      throw new EvolutionError('invalid_input', 'Workflow state contains unreadable records; refusing a strict coordination read', {
        diagnosticCount: result.diagnostics.length,
        diagnosticHashes: result.diagnostics.slice(0, 8).map((item) => item.diagnosticHash),
      })
    }
    return result.records as WorkflowRecord[]
  }

  async listInstallations(): Promise<InstallationRecord[]> {
    return this.list('installations') as Promise<InstallationRecord[]>
  }

  async listInstallationsStrict(): Promise<InstallationRecord[]> {
    return this.listInstallationsStrictPass()
  }

  async listInstallationsStrictExcluding(excludedInstallationId: string): Promise<InstallationRecord[]> {
    assertRecordId(excludedInstallationId)
    if (!excludedInstallationId.startsWith('installation_')) {
      throw new EvolutionError('invalid_input', 'Invalid excluded installation id')
    }
    return this.listInstallationsStrictPass(excludedInstallationId)
  }

  private async listInstallationsStrictPass(excludedInstallationId?: string): Promise<InstallationRecord[]> {
    const result = await this.listPass('installations', (record) => {
      if (record.id === excludedInstallationId) return
      validateStrictInstallationRecord(record)
    })
    if (result.diagnostics.length > 0) {
      throw new EvolutionError('invalid_input', 'Installation state contains unreadable records; refusing a strict lineage read', {
        diagnosticCount: result.diagnostics.length,
        diagnosticHashes: result.diagnostics.slice(0, 8).map((item) => item.diagnosticHash),
      })
    }
    return result.records
      .filter((record) => record.id !== excludedInstallationId) as InstallationRecord[]
  }

  async findInstallationForWorkflow(workflowId: string): Promise<InstallationRecord | undefined> {
    assertRecordId(workflowId)
    if (!workflowId.startsWith('workflow_')) {
      throw new EvolutionError('invalid_input', 'Invalid workflow id', { workflowId })
    }
    const matches = (await this.listInstallationsStrict()).filter((record) => record.workflowId === workflowId)
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

  private async writeAppendOnly(target: string, body: string): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx' })
    try {
      await link(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private async writeTemporary(temporary: string, body: string): Promise<void> {
    await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx' })
  }

  private async renameTemporary(temporary: string, target: string): Promise<void> {
    await rename(temporary, target)
  }

  private async removeTemporary(temporary: string): Promise<void> {
    await rm(temporary, { force: true })
  }

  private async wasWrittenExactly(target: string, body: string): Promise<boolean> {
    try {
      return await readFile(target, 'utf8') === body
    } catch {
      return false
    }
  }

  private recordDiagnostic(
    kind: RecordKind,
    fileName: string,
    error: unknown,
    strict = false,
  ): StateRecordDiagnostic {
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
    const key = `${kind}/${fileName}`
    this.diagnostics.set(key, diagnostic)
    if (strict) this.strictDiagnosticKeys.add(key)
    return diagnostic
  }

  private async list(kind: RecordKind): Promise<StoredRecord[]> {
    return (await this.listPass(kind)).records
  }

  private async listPass(kind: RecordKind, strictValidator?: StrictRecordValidator): Promise<{
    records: StoredRecord[]
    diagnostics: StateRecordDiagnostic[]
  }> {
    const directory = path.join(this.root, kind)
    for (const key of this.diagnostics.keys()) {
      if (!key.startsWith(`${kind}/`)) continue
      if (strictValidator) {
        this.diagnostics.delete(key)
        this.strictDiagnosticKeys.delete(key)
      } else if (!this.strictDiagnosticKeys.has(key)) {
        this.diagnostics.delete(key)
      }
    }
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], diagnostics: [] }
      throw error
    }
    const records: StoredRecord[] = []
    const diagnostics: StateRecordDiagnostic[] = []
    const expected = new RegExp(`^${KIND_PREFIX[kind]}[a-f0-9]{16,64}\\.json$`, 'u')
    for (const entry of entries.sort()) {
      if (!expected.test(entry)) continue
      const key = `${kind}/${entry}`
      try {
        const body = await readFile(path.join(directory, entry), 'utf8')
        const record = validateRecord(kind, JSON.parse(body), entry.slice(0, -'.json'.length))
        strictValidator?.(record)
        if (strictValidator) {
          this.diagnostics.delete(key)
          this.strictDiagnosticKeys.delete(key)
        } else if (!this.strictDiagnosticKeys.has(key)) {
          this.diagnostics.delete(key)
        }
        records.push(record)
      } catch (error) {
        diagnostics.push(this.recordDiagnostic(kind, entry, error, Boolean(strictValidator)))
      }
    }
    // A concurrent tolerant read may clear the shared diagnostic map while
    // this pass is running. Re-publish this pass's fresh diagnostics, while
    // strictness itself remains based only on the local collection above.
    for (const diagnostic of diagnostics) {
      this.diagnostics.set(`${kind}/${diagnostic.fileName}`, diagnostic)
    }
    return { records, diagnostics }
  }

  private async get(kind: RecordKind, id: string): Promise<StoredRecord> {
    assertRecordId(id)
    try {
      const body = await readFile(path.join(this.root, kind, `${id}.json`), 'utf8')
      const record = projectStoredRecord(kind, validateRecord(kind, JSON.parse(body), id))
      const key = `${kind}/${id}.json`
      if (!this.strictDiagnosticKeys.has(key)) this.diagnostics.delete(key)
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
