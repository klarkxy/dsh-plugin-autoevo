import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { POLICY_VERSION, type InstallationRecord } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import { StateStore } from '../../src/state/store.js'
import { sha256 } from '../../src/state/hashes.js'
import type { WorkflowRecord } from '../../src/workflow/contracts.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'

const temporary = trackTempDirs()

function installation(id: string, workflowId = `workflow_${'b'.repeat(24)}`): InstallationRecord {
  return {
    schemaVersion: 2,
    id,
    createdAt: '2026-08-26T00:00:00.000Z',
    workflowId,
    targetProfile: 'web',
    retention: 'persistent',
    dshHome: 'C:/dsh-home',
    packageName: 'dsh-tool-calculator',
    installSpec: `github:acme/calculator#${'c'.repeat(40)}`,
    installOutcome: 'pending',
    installed: false,
    loaded: false,
    verified: false,
    restartRequired: false,
    removed: false,
    verification: {
      attempted: false,
      expectedTools: ['calculator'],
      calledTools: [],
      resultTools: [],
      failedTools: [],
      sessionFiles: [],
      taskResultObserved: false,
      reason: 'provisional',
    },
  }
}

function adoptionClaimInput(installationId: string, observedSpec = `github:acme/calculator#${'c'.repeat(40)}`) {
  return {
    installationId,
    dshHome: 'C:/dsh-home',
    profile: 'web',
    packageName: 'dsh-tool-calculator',
    observedSpec,
    configuredBundle: false,
  }
}

type AppendOnlyWriter = (target: string, body: string) => Promise<void>
type TemporaryWriter = (temporary: string, body: string) => Promise<void>
type TemporaryRenamer = (temporary: string, target: string) => Promise<void>
type TemporaryRemover = (temporary: string) => Promise<void>

function replaceAppendOnlyWriter(store: StateStore, writer: AppendOnlyWriter): void {
  (store as unknown as { writeAppendOnly: AppendOnlyWriter }).writeAppendOnly = writer
}

function putSeam(store: StateStore): {
  writeTemporary: TemporaryWriter
  renameTemporary: TemporaryRenamer
  removeTemporary: TemporaryRemover
} {
  return store as unknown as {
    writeTemporary: TemporaryWriter
    renameTemporary: TemporaryRenamer
    removeTemporary: TemporaryRemover
  }
}

async function temporaryFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.endsWith('.tmp'))
}

function validRecoveryWorkflow(root: string): WorkflowRecord {
  const workflowId = `workflow_${'c'.repeat(24)}`
  const interruptId = `interrupt_${'d'.repeat(24)}`
  return {
    schemaVersion: 2,
    id: workflowId,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:01.000Z',
    requirement: 'calculator',
    requirementNormalized: 'calculator',
    cwd: root,
    ownerSessionId: 'session-recovery',
    bootId: 'boot_recovery',
    status: 'interrupted',
    cursor: 'recovery_required',
    generation: 8,
    consumedInterruptIds: [interruptId],
    lastFailure: {
      stage: 'workflow',
      code: 'service_restart_incomplete',
      message: 'recovery required',
      retryable: false,
    },
    interrupt: {
      kind: 'await_recovery',
      interruptId: `interrupt_${'1'.repeat(24)}`,
      ownerSessionId: 'session-recovery',
      bootId: 'boot_recovery',
      validAfterTurnId: `turn_${'e'.repeat(24)}`,
      snapshotDigest: 'f'.repeat(64),
      options: [],
      facts: {},
    },
  }
}

describe('StateStore lightweight validation', () => {
  it('cleans its unique temporary record after a write rejection without replacing the original error', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-put-write-'))
    temporary.push(root)
    const store = new StateStore(root)
    const failure = new Error('temporary write rejected after landing')
    putSeam(store).writeTemporary = async (temporaryPath, body) => {
      await writeFile(temporaryPath, body, { encoding: 'utf8', flag: 'wx' })
      throw failure
    }
    const record = installation(`installation_${'a'.repeat(24)}`)

    await expect(store.put('installations', record)).rejects.toBe(failure)
    const directory = path.join(root, 'installations')
    await expect(temporaryFiles(directory)).resolves.toEqual([])
    await expect(readFile(path.join(directory, `${record.id}.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts a record when rename landed its exact body before rejecting and cleans the temporary file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-put-rename-landed-'))
    temporary.push(root)
    const store = new StateStore(root)
    const seam = putSeam(store)
    const rename = seam.renameTemporary.bind(store)
    const failure = new Error('rename rejected after landing')
    seam.renameTemporary = async (temporaryPath, target) => {
      await rename(temporaryPath, target)
      throw failure
    }
    const record = installation(`installation_${'b'.repeat(24)}`)

    await expect(store.put('installations', record)).resolves.toBeUndefined()
    const directory = path.join(root, 'installations')
    await expect(readFile(path.join(directory, `${record.id}.json`), 'utf8'))
      .resolves.toBe(`${JSON.stringify(record, null, 2)}\n`)
    await expect(temporaryFiles(directory)).resolves.toEqual([])
  })

  it('preserves a replacement target and the original rename error while cleaning only its temporary file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-put-rename-replacement-'))
    temporary.push(root)
    const store = new StateStore(root)
    const failure = new Error('rename rejected after replacement')
    const replacement = '{"replacement":true}\n'
    putSeam(store).renameTemporary = async (_temporaryPath, target) => {
      await writeFile(target, replacement, 'utf8')
      throw failure
    }
    const record = installation(`installation_${'c'.repeat(24)}`)

    await expect(store.put('installations', record)).rejects.toBe(failure)
    const directory = path.join(root, 'installations')
    await expect(readFile(path.join(directory, `${record.id}.json`), 'utf8')).resolves.toBe(replacement)
    await expect(temporaryFiles(directory)).resolves.toEqual([])
  })

  it('does not let a temporary cleanup failure replace the primary write error', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-put-cleanup-'))
    temporary.push(root)
    const store = new StateStore(root)
    const failure = new Error('primary write rejection')
    const cleanupFailure = new Error('temporary cleanup rejection')
    const seam = putSeam(store)
    seam.writeTemporary = async (temporaryPath, body) => {
      await writeFile(temporaryPath, body, { encoding: 'utf8', flag: 'wx' })
      throw failure
    }
    seam.removeTemporary = async () => { throw cleanupFailure }

    await expect(store.put('installations', installation(`installation_${'d'.repeat(24)}`))).rejects.toBe(failure)
  })

  it('creates one append-only installation receipt across competing stores', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-install-exclusive-'))
    temporary.push(root)
    const record = installation(`installation_${'e'.repeat(24)}`)
    const results = await Promise.all([
      new StateStore(root).createInstallationExclusive(record),
      new StateStore(root).createInstallationExclusive(record),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['created', 'existing'])
    expect(results.every((result) => result.installation.id === record.id)).toBe(true)
    await expect(new StateStore(root).getInstallation(record.id)).resolves.toEqual(record)
    await expect(temporaryFiles(path.join(root, 'installations'))).resolves.toEqual([])
  })

  it('accepts an exclusive installation whose exact body landed before the writer rejected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-install-landed-'))
    temporary.push(root)
    const store = new StateStore(root)
    const failure = new Error('installation writer rejected after landing')
    replaceAppendOnlyWriter(store, async (target, body) => {
      await writeFile(target, body, { encoding: 'utf8', flag: 'wx' })
      throw failure
    })
    const record = installation(`installation_${'f'.repeat(24)}`)

    await expect(store.createInstallationExclusive(record)).resolves.toEqual({
      status: 'created',
      installation: record,
    })
  })

  it('keeps a corrupt exclusive installation receipt fail-closed without overwriting it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-install-corrupt-'))
    temporary.push(root)
    const record = installation(`installation_${'1'.repeat(24)}`)
    const directory = path.join(root, 'installations')
    const target = path.join(directory, `${record.id}.json`)
    await mkdir(directory, { recursive: true })
    await writeFile(target, '{broken-json\n', 'utf8')

    await expect(new StateStore(root).createInstallationExclusive(record)).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(readFile(target, 'utf8')).resolves.toBe('{broken-json\n')
  })

  it('persists one append-only adoption claim for the same source generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-adoption-claim-'))
    temporary.push(root)
    const input = adoptionClaimInput(`installation_${'2'.repeat(24)}`)
    const results = await Promise.all([
      new StateStore(root).claimAdoption(input),
      new StateStore(root).claimAdoption(input),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['claimed', 'existing'])
    expect(results[0].claim).toEqual(results[1].claim)
    await expect(readdir(path.join(root, 'adoption-claims'))).resolves.toHaveLength(1)
  })

  it('keeps separate append-only claims for different observed spec generations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-adoption-generations-'))
    temporary.push(root)
    const installationId = `installation_${'3'.repeat(24)}`
    const results = await Promise.all([
      new StateStore(root).claimAdoption(adoptionClaimInput(installationId, `github:acme/calculator#${'3'.repeat(40)}`)),
      new StateStore(root).claimAdoption(adoptionClaimInput(installationId, `github:acme/calculator#${'4'.repeat(40)}`)),
    ])

    expect(results.map((result) => result.status)).toEqual(['claimed', 'claimed'])
    await expect(readdir(path.join(root, 'adoption-claims'))).resolves.toHaveLength(2)
  })

  it('accepts an adoption claim whose exact body landed before the writer rejected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-adoption-landed-'))
    temporary.push(root)
    const store = new StateStore(root)
    const failure = new Error('adoption writer rejected after landing')
    replaceAppendOnlyWriter(store, async (target, body) => {
      await writeFile(target, body, { encoding: 'utf8', flag: 'wx' })
      throw failure
    })
    const input = adoptionClaimInput(`installation_${'4'.repeat(24)}`)

    await expect(store.claimAdoption(input)).resolves.toMatchObject({ status: 'claimed', claim: input })
  })

  it('keeps a corrupt adoption claim fail-closed without replacing it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-adoption-corrupt-'))
    temporary.push(root)
    const input = adoptionClaimInput(`installation_${'5'.repeat(24)}`)
    const directory = path.join(root, 'adoption-claims')
    const target = path.join(directory, `${input.installationId}.${sha256(input.observedSpec)}.json`)
    await mkdir(directory, { recursive: true })
    await writeFile(target, '{broken-adoption\n', 'utf8')

    await expect(new StateStore(root).claimAdoption(input)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(readFile(target, 'utf8')).resolves.toBe('{broken-adoption\n')
  })

  it('diagnoses one corrupt receipt without poisoning unrelated installation reads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-validation-'))
    temporary.push(root)
    const store = new StateStore(root)
    const good = installation(`installation_${'a'.repeat(24)}`)
    await store.put('installations', good)
    const badId = `installation_${'d'.repeat(24)}`
    const directory = path.join(root, 'installations')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, `${badId}.json`), '{ not-json', 'utf8')

    await expect(store.listInstallations()).resolves.toEqual([good])
    await expect(store.listInstallationsStrict()).rejects.toMatchObject({
      code: 'invalid_input',
      details: {
        diagnosticCount: 1,
        diagnosticHashes: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
      },
    })
    await expect(store.getInstallation(good.id)).resolves.toEqual(good)
    await expect(store.getInstallation(badId)).rejects.toMatchObject({
      code: 'invalid_input',
      details: { id: badId, diagnosticHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    })
  })

  it('propagates a record read failure instead of reporting it as a corrupt record', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-read-failure-'))
    temporary.push(root)
    const store = new StateStore(root)
    const id = `installation_${'e'.repeat(24)}`
    // A directory at the record path is unreadable (EISDIR), not absent and not corrupt JSON.
    await mkdir(path.join(root, 'installations', `${id}.json`), { recursive: true })

    const failure = await store.getInstallation(id).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'EISDIR' })
    expect(failure).not.toBeInstanceOf(EvolutionError)
    await expect(store.getInstallation(`installation_${'f'.repeat(24)}`)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('collects invalid installation diagnostics locally for a strict pass without exposing record contents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-strict-validation-'))
    temporary.push(root)
    const store = new StateStore(root)
    const good = installation(`installation_${'a'.repeat(24)}`)
    await store.put('installations', good)
    const badId = `installation_${'b'.repeat(24)}`
    const secret = 'file:C:/private/secret-plugin.tgz'
    const directory = path.join(root, 'installations')
    await writeFile(path.join(directory, `${badId}.json`), JSON.stringify({
      schemaVersion: 1,
      id: badId,
      installSpec: secret,
    }), 'utf8')

    await expect(store.listInstallations()).resolves.toEqual([good])
    const failure = await store.listInstallationsStrict().then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({
      code: 'invalid_input',
      details: { diagnosticCount: 1 },
    })
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(JSON.stringify(failure)).not.toContain(root)
  })

  it('keeps a semantically malformed basic installation tolerant until a strict read diagnoses it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-semantic-installation-'))
    temporary.push(root)
    const store = new StateStore(root)
    const badId = `installation_${'7'.repeat(24)}`
    const secret = 'file:C:/private/semantic-secret.tgz'
    const malformed = {
      schemaVersion: 1,
      id: badId,
      createdAt: '2026-08-31T00:00:00.000Z',
      targetProfile: 'web',
      retention: 'persistent',
      dshHome: 'C:/dsh-home',
      packageName: 'dsh-tool-secret',
      installSpec: secret,
    }
    await mkdir(path.join(root, 'installations'), { recursive: true })
    await writeFile(path.join(root, 'installations', `${badId}.json`), JSON.stringify(malformed), 'utf8')

    await expect(store.listInstallations()).resolves.toEqual([malformed])
    const failure = await store.listInstallationsStrict().then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({
      code: 'invalid_input',
      details: { diagnosticCount: 1, diagnosticHashes: [expect.stringMatching(/^[a-f0-9]{64}$/u)] },
    })
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(JSON.stringify(failure)).not.toContain(root)
  })

  it('rejects a field-valid installation whose failed_absent outcome still claims a live install', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-lifecycle-tuple-'))
    temporary.push(root)
    const store = new StateStore(root)
    const bad = {
      ...installation(`installation_${'6'.repeat(24)}`),
      installPhase: 'completed' as const,
      installState: 'installed' as const,
      installOutcome: 'failed_absent' as const,
      installed: true,
    }
    await mkdir(path.join(root, 'installations'), { recursive: true })
    await writeFile(path.join(root, 'installations', `${bad.id}.json`), `${JSON.stringify(bad)}\n`, 'utf8')

    await expect(store.listInstallations()).resolves.toEqual([bad])
    await expect(store.listInstallationsStrict()).rejects.toMatchObject({
      code: 'invalid_input',
      details: { diagnosticCount: 1 },
    })
  })

  it('keeps a semantically malformed basic workflow tolerant until a strict read diagnoses it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-semantic-workflow-'))
    temporary.push(root)
    const store = new StateStore(root)
    const badId = `workflow_${'7'.repeat(24)}`
    const secret = 'semantic-workflow-secret'
    const malformed = {
      schemaVersion: 3,
      id: badId,
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
      policyVersion: POLICY_VERSION,
      requirement: 'calculator',
      requirementNormalized: 'calculator',
      cwd: root,
      ownerSessionId: 'session-semantic',
      bootId: 'boot_semantic',
      status: 'running',
      cursor: 'await_discovery',
      generation: -1,
      privatePayload: secret,
    }
    await mkdir(path.join(root, 'workflows'), { recursive: true })
    await writeFile(path.join(root, 'workflows', `${badId}.json`), JSON.stringify(malformed), 'utf8')

    await expect(store.listWorkflows()).resolves.toEqual([malformed])
    const failure = await store.listWorkflowsStrict().then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({
      code: 'invalid_input',
      details: { diagnosticCount: 1, diagnosticHashes: [expect.stringMatching(/^[a-f0-9]{64}$/u)] },
    })
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(JSON.stringify(failure)).not.toContain(root)
  })

  it.each(['missing-phase', 'missing-state', 'non-new-present'] as const)(
    'rejects a predecessor child whose committed replacement edge has %s',
    async (variant) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `autoevo-state-semantic-edge-${variant}-`))
      temporary.push(root)
      const store = new StateStore(root)
      const parent = installation(`installation_${'3'.repeat(24)}`)
      await store.put('installations', parent)
      const child: Record<string, unknown> = {
        ...installation(`installation_${'4'.repeat(24)}`),
        createdAt: '2026-08-31T00:00:01.000Z',
        installPhase: 'completed',
        installState: 'installed',
        installOutcome: 'verified',
        installed: true,
        predecessorInstallationId: parent.id,
        replacement: {
          state: 'new_present',
          oldSpecDigest: sha256(parent.installSpec),
          newInstallSpec: parent.installSpec,
          preparedAt: '2026-08-31T00:00:00.000Z',
          reconciledAt: '2026-08-31T00:00:01.000Z',
        },
      }
      if (variant === 'missing-phase') delete child.installPhase
      if (variant === 'missing-state') delete child.installState
      if (variant === 'non-new-present') {
        (child.replacement as Record<string, unknown>).state = 'old_present'
      }
      await writeFile(
        path.join(root, 'installations', `${child.id as string}.json`),
        JSON.stringify(child),
        'utf8',
      )

      await expect(store.listInstallations()).resolves.toEqual([parent, child])
      await expect(store.listInstallationsStrict()).rejects.toMatchObject({
        code: 'invalid_input',
        details: { diagnosticCount: 1 },
      })
    },
  )

  it.each(['installation', 'workflow'] as const)(
    'keeps an unknown positive %s schema tolerant but rejects it for strict coordination',
    async (kind) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `autoevo-state-schema-${kind}-`))
      temporary.push(root)
      const store = new StateStore(root)
      const record = kind === 'installation'
        ? { ...installation(`installation_${'5'.repeat(24)}`), schemaVersion: 4 }
        : { ...validRecoveryWorkflow(root), schemaVersion: 4 }
      const directory = kind === 'installation' ? 'installations' : 'workflows'
      await mkdir(path.join(root, directory), { recursive: true })
      await writeFile(path.join(root, directory, `${record.id}.json`), JSON.stringify(record), 'utf8')

      if (kind === 'installation') {
        await expect(store.listInstallations()).resolves.toEqual([record])
        await expect(store.listInstallationsStrict()).rejects.toMatchObject({
          code: 'invalid_input',
          details: { diagnosticCount: 1 },
        })
      } else {
        await expect(store.listWorkflows()).resolves.toEqual([record])
        await expect(store.listWorkflowsStrict()).rejects.toMatchObject({
          code: 'invalid_input',
          details: { diagnosticCount: 1 },
        })
      }
    },
  )

  it('recovers exactly one workflow-linked provisional receipt and rejects ambiguity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-recovery-'))
    temporary.push(root)
    const store = new StateStore(root)
    const workflowId = `workflow_${'e'.repeat(24)}`
    const first = installation(`installation_${'1'.repeat(24)}`, workflowId)
    await store.put('installations', first)
    await expect(store.findInstallationForWorkflow(workflowId)).resolves.toEqual(first)

    await store.put('installations', installation(`installation_${'2'.repeat(24)}`, workflowId))
    await expect(store.findInstallationForWorkflow(workflowId)).rejects.toThrow(/ambiguous/u)
  })

  it('rejects workflow installation recovery when an unrelated receipt is corrupt while tolerant listing still works', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-recovery-strict-'))
    temporary.push(root)
    const store = new StateStore(root)
    const workflowId = `workflow_${'e'.repeat(24)}`
    const good = installation(`installation_${'1'.repeat(24)}`, workflowId)
    await store.put('installations', good)
    const badId = `installation_${'2'.repeat(24)}`
    const secret = 'file:C:/private/unrelated-secret.tgz'
    const directory = path.join(root, 'installations')
    await writeFile(path.join(directory, `${badId}.json`), JSON.stringify({
      schemaVersion: 1,
      id: badId,
      createdAt: '2026-08-31T00:00:00.000Z',
      privateInstallSpec: secret,
    }), 'utf8')

    await expect(store.listInstallations()).resolves.toEqual([good])
    const failure = await store.findInstallationForWorkflow(workflowId)
      .then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({
      code: 'invalid_input',
      details: { diagnosticCount: 1 },
    })
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(JSON.stringify(failure)).not.toContain(root)
  })

  it('projects a disk v1 installation without outcome from installed flags', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-v1-install-'))
    temporary.push(root)
    const store = new StateStore(root)
    const id = `installation_${'a'.repeat(24)}`
    const raw = {
      schemaVersion: 1,
      id,
      createdAt: '2026-08-26T00:00:00.000Z',
      targetProfile: 'web',
      retention: 'persistent',
      dshHome: 'C:/dsh-home',
      packageName: 'dsh-tool-calculator',
      installSpec: `github:acme/calculator#${'c'.repeat(40)}`,
      installPhase: 'completed',
      installState: 'installed',
      installed: true,
      loaded: true,
      verified: true,
      restartRequired: false,
      removed: false,
      verification: { attempted: true, expectedTools: ['calculator'], calledTools: ['calculator'], resultTools: ['calculator'], failedTools: [], sessionFiles: [], taskResultObserved: false, reason: 'legacy' },
    }
    await mkdir(path.join(root, 'installations'), { recursive: true })
    await writeFile(path.join(root, 'installations', `${id}.json`), `${JSON.stringify(raw)}\n`, 'utf8')
    const record = await store.getInstallation(id)
    expect(record.schemaVersion).toBe(2)
    expect(record.installOutcome).toBe('verified')
    expect(record.installed).toBe(true)
    expect(record.verified).toBe(true)
  })

  it('strips executionLease from historical workflow JSON on read', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-state-lease-strip-'))
    temporary.push(root)
    const store = new StateStore(root)
    const workflow = validRecoveryWorkflow(root)
    const raw = {
      ...workflow,
      schemaVersion: 2,
      executionLease: {
        id: `lease_${'a'.repeat(24)}`,
        commitmentId: `commitment_${'b'.repeat(24)}`,
      },
    }
    await mkdir(path.join(root, 'workflows'), { recursive: true })
    await writeFile(path.join(root, 'workflows', `${workflow.id}.json`), `${JSON.stringify(raw)}\n`, 'utf8')
    const record = await store.getWorkflow(workflow.id)
    expect(record.schemaVersion).toBe(3)
    expect(record).not.toHaveProperty('executionLease')
  })
})
