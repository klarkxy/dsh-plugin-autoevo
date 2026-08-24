import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { POLICY_VERSION } from '../../src/contracts.js'
import { PluginInstaller } from '../../src/lifecycle/install.js'
import { DshLauncher } from '../../src/lifecycle/launcher.js'
import { dependencySpecDigest } from '../../src/resolver/installed-origin.js'
import { StateStore } from '../../src/state/store.js'

const temporary: string[] = []
afterEach(async () => Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))))

function config(root: string): RuntimeConfig {
  return {
    dshHome: path.join(root, 'dsh-home'),
    stateDir: path.join(root, 'state'),
    sourceDir: path.join(root, 'state', 'sources'),
    ghCommand: 'gh',
    gitCommand: 'git',
    dshCommand: 'dsh',
    dshCommandArgs: [],
    maxCandidates: 5,
    maxFiles: 80,
    maxRepositoryBytes: 1_048_576,
    commandTimeoutMs: 30_000,
    forwardedCredentialEnv: [],
    verificationPatchPaths: [],
    evolutionPreset: false,
  }
}

describe('installed evolve replacement on an isolated profile', () => {
  it('replaces the live exact spec without generic package-remove and supersedes the predecessor receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-installed-evolve-'))
    temporary.push(root)
    const dshHome = path.join(root, 'dsh-home')
    const profileRoot = path.join(dshHome, 'profiles', 'web')
    await mkdir(path.join(profileRoot, 'node_modules', 'dsh-xai'), { recursive: true })
    const oldCommit = 'a'.repeat(40)
    const newCommit = 'b'.repeat(40)
    const oldSpec = `github:MirDie/dsh-xai#${oldCommit}`
    const newSpec = `github:MirDie/dsh-xai#${newCommit}`
    await writeFile(path.join(profileRoot, 'package.json'), `${JSON.stringify({
      dependencies: { 'dsh-xai': oldSpec },
      dsh: { profile: { bundles: ['dsh-xai'] } },
    }, null, 2)}\n`)
    const store = new StateStore(path.join(root, 'state'))
    const reviewId = `review_${'a'.repeat(64)}`
    await store.put('reviews', {
      schemaVersion: 1,
      id: reviewId,
      policyVersion: POLICY_VERSION,
      createdAt: new Date().toISOString(),
      resolutionId: `resolution_${'b'.repeat(24)}`,
      requirement: 'evolve dsh-xai',
      sourceSnapshot: {
        kind: 'github',
        repository: 'MirDie/dsh-xai',
        requestedRef: newCommit,
        commit: newCommit,
        defaultBranch: 'main',
      },
      inspectedFiles: [],
      manifest: {
        kind: 'bundle',
        packageName: 'dsh-xai',
        scripts: [],
        dependencies: [],
        peerDependencies: {},
        expectedTools: [],
      },
      fit: 'full',
      confidence: 0.9,
      securityRisk: 'low',
      maintained: true,
      license: 'MIT',
      compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
      missingCapabilities: [],
      findings: [],
      recommendation: 'use',
      installSpec: newSpec,
      runtimeSurface: {
        llmDependency: false,
        llmRegistered: false,
        credentialsDependency: false,
        credentialsRegistered: false,
        networkSignal: false,
        environmentSignal: false,
        processSignal: false,
        skillOnly: false,
        unsafeTools: false,
        expectedTools: [],
        toolFixtures: [],
        kind: 'bundle',
        verificationLayer: 'bundle_activation',
      },
    })
    const predecessorId = `installation_${'c'.repeat(24)}`
    await store.put('installations', {
      schemaVersion: 1,
      id: predecessorId,
      createdAt: new Date().toISOString(),
      reviewId: `review_${'d'.repeat(64)}`,
      targetProfile: 'web',
      retention: 'persistent',
      dshHome,
      packageName: 'dsh-xai',
      installSpec: oldSpec,
      installState: 'installed',
      installOutcome: 'awaiting_user_test',
      installed: true,
      loaded: false,
      verified: false,
      restartRequired: true,
      removed: false,
      verification: {
        attempted: false,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'predecessor',
      },
    })
    const removeCalls: string[] = []
    const real = new DshLauncher({
      async run(request) {
        if (request.argv.includes('remove')) {
          removeCalls.push(request.argv.join(' '))
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        }
        if (request.argv.includes('add')) {
          const spec = request.argv.at(-1)!
          const profile = request.argv[request.argv.indexOf('--profile') + 1]!
          const dest = path.join(request.env?.DSH_HOME ?? dshHome, 'profiles', profile, 'package.json')
          await mkdir(path.dirname(dest), { recursive: true })
          await writeFile(dest, `${JSON.stringify({
            dependencies: { 'dsh-xai': spec },
            dsh: { profile: { bundles: ['dsh-xai'] } },
          }, null, 2)}\n`)
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        }
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    }, config(root))
    const launcher = {
      install: real.install.bind(real),
      remove: real.remove.bind(real),
      profileDependencySpec: real.profileDependencySpec.bind(real),
      profileSourceMatches: real.profileSourceMatches.bind(real),
      profileTargetAbsent: real.profileTargetAbsent.bind(real),
      readInstalledVerificationFixtures: async () => ({}),
      verifyHost: async () => ({
        attempted: true,
        exitCode: 0,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        layer: 'bundle_activation',
        status: 'passed',
        sourceMatched: true,
        reason: 'Host loaded the reviewed bundle.',
      }),
    } as unknown as DshLauncher
    const installer = new PluginInstaller(
      { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context,
      config(root),
      store,
      launcher,
      async () => true,
      undefined,
      async () => ({
        evidence: { attempted: true, loaded: false, method: 'unsupported', reason: 'replacement requires restart' },
      }),
      undefined,
      'autoevo-verify',
    )
    const exec = {
      callId: 'call-1',
      agent: { session: { header: { cwd: root } } },
    } as unknown as ToolRunContext
    const result = await installer.install({
      reviewId,
      targetProfile: 'web',
      retention: 'persistent',
      replacement: {
        profile: 'web',
        packageName: 'dsh-xai',
        oldSpecDigest: dependencySpecDigest(oldSpec),
        oldDependencySpec: oldSpec,
        predecessorInstallationId: predecessorId,
      },
    }, exec)
    expect(removeCalls).toEqual([])
    expect(result.replacement?.state).toBe('new_present')
    expect(await launcher.profileDependencySpec(dshHome, 'web', 'dsh-xai')).toBe(newSpec)
    expect((await store.getInstallation(predecessorId)).supersededByInstallationId).toBe(result.id)
    expect(result.restartRequired).toBe(true)
  })
})
