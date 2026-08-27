import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InstallationRecord } from '../../src/contracts.js'
import { StateStore } from '../../src/state/store.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'

const temporary = trackTempDirs()

function installation(id: string, workflowId = `workflow_${'b'.repeat(24)}`): InstallationRecord {
  return {
    schemaVersion: 1,
    id,
    createdAt: '2026-08-26T00:00:00.000Z',
    workflowId,
    targetProfile: 'web',
    retention: 'persistent',
    dshHome: 'C:/dsh-home',
    packageName: 'dsh-tool-calculator',
    installSpec: `github:acme/calculator#${'c'.repeat(40)}`,
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

describe('StateStore lightweight validation', () => {
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
    expect(store.stateDiagnostics()).toEqual([
      expect.objectContaining({
        kind: 'installations',
        recordId: badId,
        code: 'invalid_json',
        diagnosticHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ])
    await expect(store.getInstallation(good.id)).resolves.toEqual(good)
    await expect(store.getInstallation(badId)).rejects.toMatchObject({
      code: 'invalid_input',
      details: { id: badId, diagnosticHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    })
  })

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
})
