import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { POLICY_VERSION, type InstallationRecord, type ResolutionRecord, type ReviewRecord } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import { CapabilityEvolutionService, _testing } from '../../src/service.js'
import { hashObject } from '../../src/state/hashes.js'
import { modificationAttemptsExhausted, type WorkflowExec, type WorkflowPendingInstall, type WorkflowRecord } from '../../src/workflow/contracts.js'

function review(requestedRef: string): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: 'v2-2026-08-15',
    createdAt: '2026-08-15T00:00:00.000Z',
    resolutionId: `resolution_${'b'.repeat(24)}`,
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github', repository: 'acme/calculator', requestedRef, commit: 'c'.repeat(40), defaultBranch: 'main',
    },
    inspectedFiles: [{ path: 'package.json', blobId: 'd'.repeat(40), sha256: 'e'.repeat(64), bytes: 10 }],
    manifest: { kind: 'bundle', scripts: [], dependencies: [], peerDependencies: {}, expectedTools: ['calculator'] },
    fit: 'full', confidence: 0.8, securityRisk: 'low', maintained: true, license: 'MIT',
    compatibility: { status: 'compatible', reason: 'test', runtimeVersion: '0.1.0-rc.6' }, missingCapabilities: [], findings: [], recommendation: 'use',
    installSpec: `github:acme/calculator#${'c'.repeat(40)}`,
  }
}

describe('review revalidation identity', () => {
  it('binds GitHub content to the exact commit without treating ref labels as content drift', () => {
    expect(hashObject(_testing.materialReviewFacts(review('main'))))
      .toBe(hashObject(_testing.materialReviewFacts(review('c'.repeat(40)))))
  })

  it('invalidates the material identity when an inspected blob changes', () => {
    const changed = review('main')
    changed.inspectedFiles = [{ ...changed.inspectedFiles[0]!, sha256: 'f'.repeat(64) }]
    expect(hashObject(_testing.materialReviewFacts(review('main'))))
      .not.toBe(hashObject(_testing.materialReviewFacts(changed)))
  })
})
describe('profile mutation serialization', () => {
  it('runs same-profile mutations one at a time inside the process', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = _testing.serializeProfileMutation('C:/dsh-home', 'web', async () => {
      order.push('first:start')
      await firstGate
      order.push('first:end')
    })
    await Promise.resolve()
    const second = _testing.serializeProfileMutation('C:/dsh-home', 'web', async () => {
      order.push('second:start')
      order.push('second:end')
    })
    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('forwards the Agent-selected Host-sealed recovery plan into InstallInput', async () => {
    const currentReview = review('main')
    currentReview.policyVersion = POLICY_VERSION
    currentReview.manifest = {
      ...currentReview.manifest,
      kind: 'bundle',
      packageName: 'dsh-tool-calculator',
    }
    currentReview.installSpec = 'file:C:/state/review-artifacts/recovery/package/reviewed.tgz'
    currentReview.artifact = {
      sha256: 'f'.repeat(64),
      bytes: 10,
      entryCount: currentReview.inspectedFiles.length,
      ownedRoot: 'C:/state/review-artifacts/recovery',
    }
    const grant = {
      id: `recovery_${'f'.repeat(24)}`,
      operation: 'retry_install' as const,
      strategy: 'minimum_release_age_exception' as const,
      sourceInstallationId: `installation_${'b'.repeat(24)}`,
      diagnosticHash: 'c'.repeat(64),
      exactPackages: ['ds-harness-remote@0.3.35'],
      effectScope: 'single_install_command' as const,
    }
    const install = vi.fn(async (..._args: unknown[]) => ({ id: `installation_${'d'.repeat(24)}` } as InstallationRecord))
    const service = {
      config: { dshHome: 'C:/dsh' },
      store: { root: 'C:/state' },
      sources: { receiptForManagedPath: vi.fn() },
      installer: { install },
    } as unknown as CapabilityEvolutionService
    const pending: WorkflowPendingInstall = {
      targetProfile: 'web',
      retention: 'persistent',
      recoveryPlan: grant,
    }
    const workflow = {
      id: `workflow_${'e'.repeat(24)}`,
      lastInstallationId: grant.sourceInstallationId,
    } as WorkflowRecord
    const exec = {
      callId: 'call-1',
      agent: { session: { header: { cwd: 'C:/workspace' } } },
    } as unknown as WorkflowExec

    await CapabilityEvolutionService.prototype.installReviewed.call(
      service,
      currentReview,
      pending,
      exec,
      workflow,
    )

    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]?.[0]).toMatchObject({ recoveryPlan: grant })
    expect(install.mock.calls[0]?.[2]).toMatchObject({ recoveryPlan: grant })
  })
})

describe('built-in target profile resolution', () => {
  it.each(['return', 'reject'] as const)(
    'preserves exact cancellation when the profile owner read aborts then %s',
    async (mode) => {
      const controller = new AbortController()
      const reason = new Error(`profile owner ${mode} cancelled`)
      const currentProfileOwner = vi.fn(async () => {
        controller.abort(reason)
        if (mode === 'reject') throw new Error('ordinary profile owner failure')
        return 'web'
      })
      const service = { currentProfileOwner } as unknown as CapabilityEvolutionService
      const execution = { signal: controller.signal } as WorkflowExec

      await expect(CapabilityEvolutionService.prototype.enableTargetProfile.call(service, execution))
        .rejects.toBe(reason)
      expect(currentProfileOwner).toHaveBeenCalledTimes(1)
    },
  )

  it('does not disguise an ordinary profile owner failure as a missing active profile', async () => {
    const failure = new Error('profile owner unavailable')
    const service = {
      currentProfileOwner: vi.fn(async () => { throw failure }),
    } as unknown as CapabilityEvolutionService

    await expect(CapabilityEvolutionService.prototype.enableTargetProfile.call(service, {} as WorkflowExec))
      .rejects.toBe(failure)
  })
})

describe('bootstrap optional installation history', () => {
  function managedReviews(): ReviewRecord[] {
    const root = review('main')
    root.manifest = { ...root.manifest, packageName: 'dsh-plugin-calculator' }
    const local: ReviewRecord = {
      ...root,
      id: `review_${'f'.repeat(64)}`,
      createdAt: '2026-08-15T01:00:00.000Z',
      sourceSnapshot: {
        kind: 'local',
        path: 'C:/managed/calculator',
        baseReviewId: root.id,
        baseCommit: root.sourceSnapshot.kind === 'github' ? root.sourceSnapshot.commit : 'c'.repeat(40),
        statusHash: 'f'.repeat(64),
      },
      installSpec: 'file:C:/state/review-artifacts/calculator.tgz',
    }
    return [root, local]
  }

  function bootstrapHarness(validateCompletedSnapshot: () => Promise<unknown>): {
    service: CapabilityEvolutionService
    put: ReturnType<typeof vi.fn>
  } {
    const put = vi.fn(async () => undefined)
    const service = {
      ctx: {
        tools: { schemas: vi.fn(() => []) },
        systemPrompt: { assemble: vi.fn(async () => ({ tools: [] })) },
        skills: { list: vi.fn(async () => []) },
        get: vi.fn(() => undefined),
      },
      config: { dshHome: 'C:/missing-dsh-home', dshCommand: 'dsh' },
      runner: { resolveExecutable: vi.fn(async () => undefined) },
      store: {
        listAllReviews: vi.fn(async () => managedReviews()),
        listInstallationsStrict: vi.fn(async () => []),
        put,
      },
      sources: { validateCompletedSnapshot: vi.fn(validateCompletedSnapshot) },
      currentProfileOwner: vi.fn(async () => 'web'),
    } as unknown as CapabilityEvolutionService
    return { service, put }
  }

  it('preserves an authoritative local profile candidate when strict history cannot be read', async () => {
    const dshHome = await mkdtemp(path.join(tmpdir(), 'autoevo-service-history-'))
    try {
      const profileRoot = path.join(dshHome, 'profiles', 'web')
      await mkdir(profileRoot, { recursive: true })
      await writeFile(path.join(profileRoot, 'package.json'), JSON.stringify({
        dependencies: {
          'dsh-plugin-record-sync': `github:anonymous-lab/dsh-plugin-record-sync#${'a'.repeat(40)}`,
        },
      }))
      const put = vi.fn(async () => undefined)
      const listInstallationsStrict = vi.fn(async () => {
        throw new EvolutionError('command_failed', 'installation history unavailable')
      })
      const service = {
        ctx: {
          tools: { schemas: vi.fn(() => []) },
          systemPrompt: { assemble: vi.fn(async () => ({ tools: [] })) },
          skills: { list: vi.fn(async () => []) },
          get: vi.fn(() => undefined),
        },
        config: { dshHome, dshCommand: 'dsh' },
        runner: { resolveExecutable: vi.fn(async () => undefined) },
        store: {
          listAllReviews: vi.fn(async () => []),
          listInstallationsStrict,
          put,
        },
        sources: { validateCompletedSnapshot: vi.fn() },
        currentProfileOwner: vi.fn(async () => 'web'),
      } as unknown as CapabilityEvolutionService
      const exec = {
        callId: 'bootstrap-call',
        agent: { session: { header: { cwd: dshHome } } },
      } as unknown as WorkflowExec

      const result = await CapabilityEvolutionService.prototype.bootstrapResolution.call(
        service,
        'repair dsh-plugin-record-sync',
        exec,
      )

      expect(listInstallationsStrict).toHaveBeenCalledTimes(1)
      expect(result.localCandidates).toEqual([expect.objectContaining({
        kind: 'plugin',
        name: 'dsh-plugin-record-sync',
        availability: 'installed_in_profile',
        profileEvidence: expect.objectContaining({
          profile: 'web',
          dependencySpec: `github:anonymous-lab/dsh-plugin-record-sync#${'a'.repeat(40)}`,
        }),
      })])
      expect(put).toHaveBeenCalledTimes(1)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('rethrows the exact abort when optional managed snapshot validation races an ordinary error', async () => {
    const controller = new AbortController()
    const reason = new Error('managed snapshot validation cancelled')
    const { service, put } = bootstrapHarness(async () => {
      controller.abort(reason)
      throw new Error('ordinary validation failure')
    })
    const exec = {
      callId: 'bootstrap-abort',
      agent: { session: { header: { cwd: process.cwd() } } },
      signal: controller.signal,
    } as unknown as WorkflowExec

    await expect(CapabilityEvolutionService.prototype.bootstrapResolution.call(
      service,
      'calculator',
      exec,
    )).rejects.toBe(reason)
    expect(put).not.toHaveBeenCalled()
  })

  it('keeps ordinary managed snapshot validation failure optional', async () => {
    const { service, put } = bootstrapHarness(async () => {
      throw new Error('ordinary validation failure')
    })
    const exec = {
      callId: 'bootstrap-optional-validation',
      agent: { session: { header: { cwd: process.cwd() } } },
    } as unknown as WorkflowExec

    await expect(CapabilityEvolutionService.prototype.bootstrapResolution.call(
      service,
      'calculator',
      exec,
    )).resolves.toMatchObject({ requirement: 'calculator' })
    expect(put).toHaveBeenCalledTimes(1)
  })
})

describe('built-in enablement failure journal', () => {
  function provisional(wrote: boolean): InstallationRecord {
    return {
      schemaVersion: 1,
      id: `installation_${'f'.repeat(24)}`,
      createdAt: '2026-08-27T00:00:00.000Z',
      workflowId: `workflow_${'a'.repeat(24)}`,
      targetProfile: 'web',
      retention: 'persistent',
      dshHome: 'C:/dsh',
      packageName: '@deepseek-ai/dsh-time-context',
      installSpec: `builtin:0.1.1-rc.2:time-context:${wrote ? '1' : '0'}`,
      installPhase: 'prepared',
      installState: 'unknown',
      installOutcome: 'pending',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: false,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'prepared',
      },
    }
  }

  it('prioritizes an abort that races the initial built-in receipt read over an ordinary read error', async () => {
    const controller = new AbortController()
    const reason = new Error('initial receipt read aborted')
    const read = vi.fn(async () => {
      controller.abort(reason)
      throw new Error('ordinary receipt read error')
    })

    await expect(_testing.initialBuiltinReceipt(
      { getInstallation: read },
      `installation_${'a'.repeat(24)}`,
      controller.signal,
    )).rejects.toBe(reason)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('settles a denied pre-write approval as failed_absent with no ownership claim', () => {
    const result = _testing.failedBuiltinEnablement(
      provisional(false),
      new EvolutionError('approval_required', 'The profile change was denied.', { outcome: 'denied' }),
      false,
    )

    expect(result).toMatchObject({
      installSpec: 'builtin:0.1.1-rc.2:time-context:0',
      installPhase: 'completed',
      installState: 'not_installed',
      installOutcome: 'failed_absent',
      installed: false,
      removed: true,
      installFailure: { code: 'approval_required', retryable: true },
    })
  })

  it('fails closed when a write-ahead receipt cannot reconcile the exact row', () => {
    const result = _testing.failedBuiltinEnablement(
      provisional(true),
      new EvolutionError('command_failed', 'The profile state is unreadable.'),
      undefined,
    )

    expect(result).toMatchObject({
      installSpec: 'builtin:0.1.1-rc.2:time-context:1',
      installPhase: 'completed',
      installState: 'unknown',
      installOutcome: 'recovery_required',
      installed: false,
      removed: false,
      installFailure: { code: 'command_failed', retryable: false },
    })
  })

  it('drops a write-ahead ownership claim when reconciliation proves the row absent', () => {
    const result = _testing.failedBuiltinEnablement(
      provisional(true),
      new EvolutionError('command_failed', 'The profile write failed.'),
      false,
    )

    expect(result).toMatchObject({
      installSpec: 'builtin:0.1.1-rc.2:time-context:0',
      installOutcome: 'failed_absent',
      removed: true,
    })
  })

  it('reconciles the hard-crash window after write-ahead and before profile write', () => {
    const absent = _testing.reconcileBuiltinWriteAhead(provisional(true), false)
    expect(absent).toMatchObject({
      kind: 'continue',
      record: {
        installSpec: 'builtin:0.1.1-rc.2:time-context:0',
        installPhase: 'prepared',
        installOutcome: 'pending',
        removed: false,
      },
    })

    const present = _testing.reconcileBuiltinWriteAhead(provisional(true), true)
    expect(present).toMatchObject({
      kind: 'continue',
      record: { installSpec: 'builtin:0.1.1-rc.2:time-context:1' },
    })

    const unreadable = _testing.reconcileBuiltinWriteAhead(provisional(true), undefined)
    expect(unreadable).toMatchObject({
      kind: 'recovery',
      record: { installOutcome: 'recovery_required', removed: false },
    })
  })

  it('resets a reused no-effect receipt before a fresh approved attempt', () => {
    const prior = _testing.failedBuiltinEnablement(
      provisional(false),
      new EvolutionError('approval_required', 'The profile change was denied.', { outcome: 'denied' }),
      false,
    )
    const result = _testing.reconcileBuiltinWriteAhead(prior, false)
    expect(result).toMatchObject({
      kind: 'continue',
      record: {
        installPhase: 'prepared',
        installOutcome: 'pending',
        removed: false,
      },
    })
    expect(result.record.installFailure).toBeUndefined()
  })
})

describe('managed modification instruction', () => {
  it('relays the authenticated Host user turn instead of only the original requirement', () => {
    const record = resolution()
    const selected = candidateReview('acme/one', 'use', '1')
    record.decisions = [{
      id: `decision_${'c'.repeat(24)}`,
      phase: 'gate2',
      action: 'modify_this',
      selectedRepositories: ['acme/one'],
      reviewId: selected.id,
      reviewIdentity: '1'.repeat(40),
      userMessage: '在这个上改：支持勾选多段指定对话，再拼成一张长截图。先不要装。',
      createdAt: '2026-08-18T00:00:00.000Z',
    }]

    const order = _testing.modificationWorkOrder(record, selected, 'C:/managed/plugin')
    expect(order.requirement).toBe(record.requirement)
    expect(order.acceptanceTargets.join(' ')).toContain('Apply the authenticated user modification instruction: 在这个上改：支持勾选多段指定对话，再拼成一张长截图。先不要装。')
  })

  it('passes bounded Host review blockers without prescribing an implementation path', () => {
    const record = resolution()
    const selected = candidateReview('acme/one', 'modify', '1')
    selected.compatibility = {
      status: 'incompatible',
      reason: 'Declared peers exclude runtime 0.1.0-rc.6.',
      runtimeVersion: '0.1.0-rc.6',
    }
    selected.missingCapabilities = ['multi-part capture']
    selected.findings = [{
      code: 'unsafe_script',
      severity: 'block',
      source: 'package.json',
      detail: 'install script is present',
    }]
    const order = _testing.modificationWorkOrder(record, selected, 'C:/managed/plugin')
    expect(order.blockers.map((item) => item.summary).join(' ')).toContain('Declared peers exclude runtime 0.1.0-rc.6.')
    expect(order.blockers.map((item) => item.summary).join(' ')).toContain('multi-part capture')
    expect(order.blockers.map((item) => item.summary).join(' ')).toContain('unsafe_script at package.json: install script is present')
    expect(order.acceptanceTargets.join(' ')).toContain('choose the implementation path')
    expect(order.acceptanceTargets.join(' ')).toContain('Materializing declared dependencies with pnpm install --ignore-scripts')
    expect(order.acceptanceTargets.join(' ')).toContain('pnpm add/update/remove/dlx, npx, and publishing remain denied')
    expect(JSON.stringify(order)).not.toContain('edit package.json')
  })

  it('adds a Loader Fiber acceptance target for failed-install repair', () => {
    const record = resolution()
    record.intent = { operation: 'evolve_existing', requiredSurface: 'native_dsh_plugin', evolveReason: 'repair' }
    record.requirement = '补上能被 Loader 认到的包装 Fiber'
    const selected = candidateReview('example-org/dsh-orbit-search', 'use', '1')
    selected.missingCapabilities = ['an unrelated capability inferred from repair prose']
    selected.findings = [{
      code: 'bundle_patch_no_activation',
      severity: 'block',
      source: 'cordis.patch.yml',
      detail: 'The bundle patch does not insert a Loader Fiber.',
    }]
    const order = _testing.modificationWorkOrder(
      record,
      selected,
      'C:/managed/plugin',
      undefined,
      false,
      'failed_install',
    )
    expect(order.acceptanceTargets.join(' ')).toMatch(/Loader-visible wrapping Fiber/i)
    expect(order.acceptanceTargets.join(' ')).toMatch(/do not reinstall the failed specification/i)
    expect(order.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'security_finding', summary: expect.stringContaining('bundle_patch_no_activation') }),
      expect.objectContaining({ kind: 'host_boundary' }),
    ]))
    expect(order.blockers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'missing_capability' }),
    ]))
  })

  it('keeps semantic capability blockers for ordinary modification work', () => {
    const record = resolution()
    const selected = candidateReview('example-org/dsh-neutral-tool', 'modify', '1')
    selected.missingCapabilities = ['a user-requested output mode']
    const order = _testing.modificationWorkOrder(record, selected, 'C:/managed/plugin')
    expect(order.blockers).toEqual([
      expect.objectContaining({ kind: 'missing_capability', summary: 'a user-requested output mode' }),
    ])
  })

  it('compares stable baseline blockers and separates resolved, unresolved, and introduced targets', () => {
    const baseline = candidateReview('acme/one', 'modify', '1')
    baseline.compatibility = { status: 'incompatible', reason: 'peer mismatch', runtimeVersion: '0.1.0-rc.6' }
    baseline.missingCapabilities = ['capture']
    const targets = _testing.modificationBlockers(baseline)
    const post = structuredClone(baseline)
    post.compatibility = { status: 'compatible', reason: 'peer match', runtimeVersion: '0.1.0-rc.6' }
    post.findings = [{ code: 'new_block', severity: 'block', source: 'lib/index.js', detail: 'new blocker' }]
    const delta = _testing.modificationDelta(targets, post)
    expect(delta.resolved.map((item) => item.kind)).toEqual(['compatibility'])
    expect(delta.unresolved.map((item) => item.kind)).toEqual(['missing_capability'])
    expect(delta.introduced).toEqual([
      expect.objectContaining({ kind: 'security_finding', summary: expect.stringContaining('new_block') }),
    ])
  })

  it('allows one correction only for persisting original blockers and stops on scope expansion or evaluator drift', () => {
    const baseline = candidateReview('acme/one', 'modify', '1')
    baseline.compatibility = { status: 'incompatible', reason: 'peer mismatch', runtimeVersion: '0.1.0-rc.6' }
    const blockers = _testing.modificationBlockers(baseline)
    const persisting = structuredClone(baseline)
    expect(_testing.modificationAcceptance({
      baselineReview: baseline,
      baselineBlockers: blockers,
      postReview: persisting,
      meaningfulInstruction: false,
      attempt: 1,
    })).toMatchObject({ status: 'unresolved', canCorrect: true })

    persisting.findings = [{ code: 'new_block', severity: 'block', source: 'src/index.ts', detail: 'new blocker' }]
    expect(_testing.modificationAcceptance({
      baselineReview: baseline,
      baselineBlockers: blockers,
      postReview: persisting,
      meaningfulInstruction: false,
      attempt: 1,
    })).toMatchObject({ status: 'unresolved', canCorrect: false, introduced: [expect.objectContaining({ kind: 'security_finding' })] })

    const drifted = structuredClone(baseline)
    drifted.compatibility.runtimeVersion = '0.1.0-rc.7'
    expect(_testing.modificationAcceptance({
      baselineReview: baseline,
      baselineBlockers: blockers,
      postReview: drifted,
      meaningfulInstruction: false,
      attempt: 1,
    })).toMatchObject({ status: 'indeterminate', canCorrect: false })

    const resolved = structuredClone(baseline)
    resolved.compatibility = { status: 'compatible', reason: 'peer range accepted', runtimeVersion: '0.1.0-rc.6' }
    expect(_testing.modificationAcceptance({
      baselineReview: baseline,
      baselineBlockers: blockers,
      postReview: resolved,
      meaningfulInstruction: true,
      attempt: 1,
    })).toMatchObject({ status: 'indeterminate', canCorrect: false, unresolved: [], introduced: [] })
  })

  it('classifies Host-observed shell checks over child prose', () => {
    expect(_testing.childCheckEvidence('Tests passed.\nAUTOEVO_CHILD_COMPLETED', [{
      command: 'pnpm test',
      exitCode: 0,
      matchesAcceptance: true,
    }])).toMatchObject({
      source: 'host_observed',
      status: 'passed',
      summary: expect.stringMatching(/Host observed pnpm test exit 0/i),
    })
    expect(_testing.childCheckEvidence('Tests passed.\nAUTOEVO_CHILD_COMPLETED', [{
      command: 'pnpm test',
      exitCode: 1,
      matchesAcceptance: true,
    }])).toMatchObject({
      source: 'host_observed',
      status: 'failed',
      summary: expect.stringMatching(/Host observed pnpm test exit 1/i),
    })
    expect(_testing.childCheckEvidence('Tests passed.\nAUTOEVO_CHILD_COMPLETED', [{
      command: 'git status',
      exitCode: 0,
      matchesAcceptance: false,
    }])).toMatchObject({
      source: 'child_reported',
      status: 'passed',
      hostObservedChecks: [{ command: 'git status', exitCode: 0, matchesAcceptance: false }],
    })
  })
})

function resolution(schemaVersion: 1 | 2 = 2): ResolutionRecord {
  const id = `resolution_${'b'.repeat(24)}`
  return {
    schemaVersion,
    id,
    policyVersion: schemaVersion === 2 ? POLICY_VERSION : 'v2-2026-08-15',
    createdAt: '2026-08-16T00:00:00.000Z',
    requirement: 'calculator',
    cwd: 'C:/workspace',
    decision: 'inspect_remote',
    localCandidates: [],
    remoteCandidates: [
      { repository: 'acme/one', name: 'one', description: '', stars: 1, updatedAt: null, topics: [] },
      { repository: 'acme/two', name: 'two', description: '', stars: 1, updatedAt: null, topics: [] },
    ],
    remoteCandidateSource: 'github',
    remoteDiscoveryComplete: true,
    ...(schemaVersion === 2
      ? { authorization: { state: 'selection_required' as const, resolutionId: id, reason: 'review candidates' } }
      : {}),
    queries: [],
    reasons: [],
  }
}

function candidateReview(repository: string, recommendation: ReviewRecord['recommendation'], suffix: string): ReviewRecord {
  const record = review('main')
  const commit = suffix.repeat(40)
  const packageName = `dsh-${repository.slice(repository.indexOf('/') + 1)}`
  record.id = `review_${suffix.repeat(64)}`
  record.resolutionId = resolution().id
  record.policyVersion = POLICY_VERSION
  record.sourceSnapshot = {
    kind: 'github', repository, requestedRef: 'main', commit, defaultBranch: 'main',
  }
  record.recommendation = recommendation
  record.fit = recommendation === 'use' ? 'full' : recommendation === 'modify' ? 'partial' : 'none'
  record.manifest = { ...record.manifest, packageName }
  record.installSpec = `file:C:/workspace/review-artifacts/${suffix}/package/${packageName}.tgz`
  record.artifact = {
    sha256: suffix.repeat(64),
    bytes: 10,
    entryCount: record.inspectedFiles.length,
    ownedRoot: `C:/workspace/review-artifacts/${suffix}`,
  }
  return record
}

describe('local review lineage', () => {
  it('walks a local review back to its GitHub root and rejects a cycle', () => {
    const github = candidateReview('acme/one', 'skip', '1')
    const first: ReviewRecord = {
      ...github,
      id: `review_${'2'.repeat(64)}`,
      sourceSnapshot: {
        kind: 'local',
        path: 'C:/workspace/plugin',
        baseReviewId: github.id,
        baseCommit: github.sourceSnapshot.kind === 'github' ? github.sourceSnapshot.commit : 'c'.repeat(40),
        statusHash: 'a'.repeat(64),
      },
    }
    const second: ReviewRecord = {
      ...first,
      id: `review_${'3'.repeat(64)}`,
      sourceSnapshot: {
        kind: 'local',
        path: 'C:/workspace/plugin',
        baseReviewId: first.id,
        baseCommit: first.sourceSnapshot.kind === 'local' ? first.sourceSnapshot.baseCommit : 'c'.repeat(40),
        statusHash: 'b'.repeat(64),
      },
    }
    expect(_testing.lineageRootReview(second, [github, first, second]).id).toBe(github.id)

    const cyclic: ReviewRecord = {
      ...first,
      sourceSnapshot: {
        kind: 'local',
        path: 'C:/workspace/plugin',
        baseReviewId: first.id,
        baseCommit: 'c'.repeat(40),
        statusHash: 'c'.repeat(64),
      },
    }
    expect(() => _testing.lineageRootReview(cyclic, [cyclic])).toThrow(/cyclic/i)
  })
})
