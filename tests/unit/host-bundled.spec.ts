import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import type { ResolutionRecord } from '../../src/contracts.js'
import { POLICY_VERSION } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import type { CommandRunner } from '../../src/process/runner.js'
import {
  listBundledOptInPackages,
  resolveBundledDshRoot,
  resolveHostBundledCapabilities,
} from '../../src/resolver/host-bundled.js'
import { matchConfidence, resolveLocalCapabilities } from '../../src/resolver/local.js'
import { candidateSnapshotFor } from '../../src/workflow/candidates.js'
import { CapabilityEvolutionService } from '../../src/service.js'
import { StateStore } from '../../src/state/store.js'
import { optionsFor } from '../../src/workflow/contracts.js'
import type { WorkflowExec, WorkflowRecord } from '../../src/workflow/contracts.js'

const temporary = trackTempDirs()

const BUNDLED_REQUIREMENT = 'provide orbit clock elapsed time context'

async function seedBundledRoot(root: string): Promise<void> {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }))
  const scopeDir = path.join(root, 'node_modules', '@deepseek-ai')
  const seed = async (dir: string, manifest: Record<string, unknown>) => {
    await mkdir(path.join(scopeDir, dir), { recursive: true })
    await writeFile(path.join(scopeDir, dir, 'package.json'), JSON.stringify(manifest))
  }
  await seed('dsh-orbit-context', {
    name: '@deepseek-ai/dsh-orbit-context',
    version: '0.1.1-rc.2',
    description: 'Opt-in orbit clock elapsed time context',
  })
  await seed('dsh-pane-context', {
    name: '@deepseek-ai/dsh-pane-context',
    version: '0.1.1-rc.2',
    description: 'Opt-in pane location context',
  })
  await seed('dsh-agent-loop', {
    name: '@deepseek-ai/dsh-agent-loop',
    version: '0.1.1-rc.2',
    description: 'Agent loop internals',
  })
}

async function seedDshHome(root: string, bundledRoot: string): Promise<string> {
  const link = path.join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(path.dirname(link), { recursive: true })
  await mkdir(path.join(bundledRoot, 'lib'), { recursive: true })
  // Tests run on Windows where directory symlinks need privileges; copy the
  // manifest anchors instead of linking — resolution only reads package.json.
  await mkdir(link, { recursive: true })
  await writeFile(path.join(link, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }))
  return link
}

function emptyContext(): Context {
  return {
    tools: { schemas: () => [] },
    systemPrompt: { assemble: async () => ({ tools: [] }) },
    skills: { list: async () => [] },
  } as unknown as Context
}

const exec = { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>

describe('host-bundled opt-in capabilities', () => {
  it('matches a synthetic requirement against a bundled package by capability text', () => {
    const confidence = matchConfidence(
      BUNDLED_REQUIREMENT,
      '@deepseek-ai/dsh-orbit-context',
      'Opt-in orbit clock elapsed time context',
    )
    expect(confidence).toBeGreaterThanOrEqual(0.62)
  })

  it('enumerates only opt-in described packages with a stripped mount id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bundled-list-'))
    temporary.push(root)
    await seedBundledRoot(root)

    const packages = await listBundledOptInPackages(root)

    expect(packages.map((entry) => entry.packageName)).toEqual([
      '@deepseek-ai/dsh-orbit-context',
      '@deepseek-ai/dsh-pane-context',
    ])
    expect(packages[0]).toMatchObject({ mountId: 'orbit-context', version: '0.1.1-rc.2' })
  })

  it('locates the dsh package root through the healed profile fallback link', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bundled-root-'))
    temporary.push(root)
    const bundledRoot = path.join(root, 'cli')
    const dshHome = path.join(root, 'dsh-home')
    await mkdir(bundledRoot, { recursive: true })
    await seedBundledRoot(bundledRoot)
    await seedDshHome(dshHome, bundledRoot)

    const previous = process.env.DSH_PACKAGE_ROOT
    delete process.env.DSH_PACKAGE_ROOT
    try {
      await expect(resolveBundledDshRoot({
        dshHome,
        config: { dshCommand: 'dsh' },
      })).resolves.toBe(path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh'))
      await expect(resolveBundledDshRoot({
        dshHome: path.join(root, 'missing-home'),
        config: { dshCommand: 'dsh' },
      })).resolves.toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.DSH_PACKAGE_ROOT
      else process.env.DSH_PACKAGE_ROOT = previous
    }
  })

  it('rethrows the exact cancellation reason from executable resolution', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel bundled dsh resolution')

    let failure: unknown
    try {
      await resolveBundledDshRoot({
        dshHome: path.join(os.tmpdir(), 'missing-dsh-home'),
        config: { dshCommand: 'dsh' },
        runner: {
          async resolveExecutable(_command, signal) {
            expect(signal).toBe(controller.signal)
            controller.abort(reason)
            throw reason
          },
        },
        signal: controller.signal,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(reason)
  })

  it('does not continue bootstrap local resolution after bundled-root cancellation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bundled-bootstrap-cancel-'))
    temporary.push(root)
    const controller = new AbortController()
    const reason = new Error('cancel bootstrap bundled lookup')
    let localSchemaReads = 0
    const context = {
      tools: { schemas: () => { localSchemaReads += 1; return [] } },
      systemPrompt: { assemble: async () => ({ tools: [] }) },
      skills: { list: async () => [] },
    } as unknown as Context
    const runner: CommandRunner = {
      async run() { throw new Error('command execution is not expected') },
      async resolveExecutable(_command, signal) {
        expect(signal).toBe(controller.signal)
        controller.abort(reason)
        throw reason
      },
    }
    const service = new CapabilityEvolutionService(
      context,
      testRuntimeConfig(root),
      runner,
      new StateStore(root),
      new CreationGuard({ isEvolutionMode: () => true }),
    )

    let failure: unknown
    try {
      await service.bootstrapResolution(
        'orbit clock context',
        { signal: controller.signal } as WorkflowExec,
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(reason)
    expect(localSchemaReads).toBe(0)
  })

  it('does not rewrite enableBuiltin cancellation as bundled-root unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bundled-enable-cancel-'))
    temporary.push(root)
    const controller = new AbortController()
    const reason = new Error('cancel enable bundled lookup')
    const runner: CommandRunner = {
      async run() { throw new Error('command execution is not expected') },
      async resolveExecutable(_command, signal) {
        expect(signal).toBe(controller.signal)
        controller.abort(reason)
        throw reason
      },
    }
    const store = new StateStore(root)
    const service = new CapabilityEvolutionService(
      emptyContext(),
      testRuntimeConfig(root),
      runner,
      store,
      new CreationGuard({ isEvolutionMode: () => true }),
    )
    const candidateId = `candidate_${'a'.repeat(24)}`
    const workflow = {
      id: `workflow_${'b'.repeat(24)}`,
      candidateSnapshot: [{
        id: candidateId,
        index: 1,
        kind: 'local',
        name: '@deepseek-ai/dsh-orbit-context',
        identity: '@deepseek-ai/dsh-orbit-context',
        digest: 'c'.repeat(64),
        availability: 'host_bundled',
        hostBundled: {
          packageName: '@deepseek-ai/dsh-orbit-context',
          version: '0.1.1-rc.2',
          mountId: 'orbit-context',
        },
      }],
      selectionReceipt: {
        id: 'selection_cancel',
        phase: 'gate2',
        kind: 'enable_builtin',
        candidateIds: [candidateId],
        candidateDigests: { [candidateId]: 'c'.repeat(64) },
        snapshotDigest: 'd'.repeat(64),
      },
      actionCommitment: {
        selectionReceiptId: 'selection_cancel',
        snapshotDigest: 'd'.repeat(64),
        requestedAction: 'enable_builtin',
        candidateId,
        candidateDigest: 'c'.repeat(64),
        targetProfile: 'web',
        endpoint: {
          kind: 'host_bundled_enable',
          packageName: '@deepseek-ai/dsh-orbit-context',
          version: '0.1.1-rc.2',
          mountId: 'orbit-context',
          targetProfile: 'web',
        },
      },
    } as unknown as WorkflowRecord

    let failure: unknown
    try {
      await service.enableBuiltin(workflow, { signal: controller.signal } as WorkflowExec)
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(reason)
    await expect(store.listInstallations()).resolves.toEqual([])
  })

  it('offers unmounted opt-in packages as host_bundled candidates and skips mounted ones', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bundled-candidates-'))
    temporary.push(root)
    const bundledRoot = path.join(root, 'cli')
    const dshHome = path.join(root, 'dsh-home')
    await mkdir(bundledRoot, { recursive: true })
    await seedBundledRoot(bundledRoot)

    const candidates = await resolveHostBundledCapabilities({
      dshPackageRoot: bundledRoot,
      dshHome,
      activeProfile: 'web',
      requirement: BUNDLED_REQUIREMENT,
      match: matchConfidence,
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      kind: 'plugin',
      name: '@deepseek-ai/dsh-orbit-context',
      availability: 'host_bundled',
      hostBundled: { packageName: '@deepseek-ai/dsh-orbit-context', version: '0.1.1-rc.2', mountId: 'orbit-context' },
    })

    const profileRoot = path.join(dshHome, 'profiles', 'web')
    await mkdir(profileRoot, { recursive: true })
    await writeFile(path.join(profileRoot, 'cordis.patch.yml'), "- insert:\n    - id: orbit-context\n      name: '@deepseek-ai/dsh-orbit-context'\n")
    const mounted = await resolveHostBundledCapabilities({
      dshPackageRoot: bundledRoot,
      dshHome,
      activeProfile: 'web',
      requirement: BUNDLED_REQUIREMENT,
      match: matchConfidence,
    })
    expect(mounted).toEqual([])
  })

  it('merges into local resolution as a full-fit, non-reusable candidate that suppresses remote discovery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-bundled-local-'))
    temporary.push(root)
    const bundledRoot = path.join(root, 'cli')
    const dshHome = path.join(root, 'dsh-home')
    await mkdir(bundledRoot, { recursive: true })
    await seedBundledRoot(bundledRoot)
    await mkdir(path.join(dshHome, 'profiles', 'web'), { recursive: true })

    const result = await resolveLocalCapabilities(emptyContext(), BUNDLED_REQUIREMENT, exec, {
      dshHome,
      activeProfile: 'web',
      dshPackageRoot: bundledRoot,
    })

    const candidate = result.candidates.find((item) => item.availability === 'host_bundled')
    expect(candidate).toMatchObject({ fit: 'full', surfaceMatch: true, reuseEligible: false })
    expect(result.shouldDiscoverRemote).toBe(false)
  })

  it('presents enable_builtin at the selection gate for host-bundled snapshot candidates', async () => {
    const id = `resolution_${'c'.repeat(24)}`
    const resolution: ResolutionRecord = {
      schemaVersion: 2,
      id,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-25T00:00:00.000Z',
      requirement: BUNDLED_REQUIREMENT,
      cwd: 'C:/workspace',
      decision: 'use_local',
      localCandidates: [{
        kind: 'plugin',
        name: '@deepseek-ai/dsh-orbit-context',
        description: 'Opt-in orbit clock elapsed time context',
        availability: 'host_bundled',
        confidence: 0.92,
        fit: 'full',
        reuseEligible: false,
        hostBundled: { packageName: '@deepseek-ai/dsh-orbit-context', version: '0.1.1-rc.2', mountId: 'orbit-context' },
      }],
      remoteCandidates: [],
      remoteDiscoveryComplete: true,
      queries: [],
      reasons: [],
    }
    const snapshot = candidateSnapshotFor(resolution)
    expect(snapshot[0]?.hostBundled).toEqual({
      packageName: '@deepseek-ai/dsh-orbit-context',
      version: '0.1.1-rc.2',
      mountId: 'orbit-context',
    })

    const options = optionsFor('await_selection', resolution, [], { candidateSnapshot: snapshot } as WorkflowRecord)
    const enable = options.find((option) => option.id === 'enable_builtin')
    expect(enable?.candidateIds).toEqual([snapshot[0]!.id])
    expect(options.find((option) => option.id === 'reuse_local')).toBeUndefined()
  })

  it('does not offer reuse when a local candidate has no executable endpoint', () => {
    const id = `resolution_${'d'.repeat(24)}`
    const resolution = {
      schemaVersion: 2,
      id,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-25T00:00:00.000Z',
      requirement: 'format structured records',
      cwd: 'C:/workspace',
      decision: 'use_local',
      localCandidates: [],
      remoteCandidates: [],
      remoteDiscoveryComplete: true,
      queries: [],
      reasons: [],
    } satisfies ResolutionRecord
    const workflow = {
      candidateSnapshot: [{
        id: `candidate_${'e'.repeat(24)}`,
        index: 1,
        kind: 'local',
        name: 'managed-source',
        identity: 'managed-source',
        digest: 'f'.repeat(64),
        localKind: 'plugin',
        fit: 'full',
        reuseEligible: true,
      }],
    } as WorkflowRecord

    const options = optionsFor('await_selection', resolution, [], workflow)
    expect(options.find((option) => option.id === 'reuse_local')).toBeUndefined()
  })
})
