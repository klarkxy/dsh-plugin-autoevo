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

  it('treats a same-code blocker at a new source as newly introduced', () => {
    const baseline = candidateReview('acme/one', 'modify', '1')
    baseline.findings = [{ code: 'unsafe_script', severity: 'block', source: 'src/a.ts', detail: 'unsafe call' }]
    const post = structuredClone(baseline)
    post.findings = [{ code: 'unsafe_script', severity: 'block', source: 'src/b.ts', detail: 'unsafe call' }]
    const result = _testing.modificationAcceptance({
      baselineReview: baseline,
      baselineBlockers: _testing.modificationBlockers(baseline),
      postReview: post,
      meaningfulInstruction: false,
      attempt: 1,
    })
    expect(result).toMatchObject({
      canCorrect: false,
      resolved: [expect.objectContaining({ kind: 'security_finding' })],
      unresolved: [],
      introduced: [expect.objectContaining({ kind: 'security_finding' })],
    })
  })

  it('does not allow a third automatic modification after the existing two-attempt bound', () => {
    const attempt = {
      attempt: 1,
      childSessionId: 'child',
      commit: 'a'.repeat(40),
      changedFiles: ['src/index.ts'],
      changedFilesTruncated: false,
      postReviewId: 'review-after',
      completionMarkerObserved: true,
      checks: { source: 'host_observed' as const, status: 'failed' as const, summary: 'unresolved' },
    }
    expect(modificationAttemptsExhausted({
      contractVersion: 1,
      policyVersion: POLICY_VERSION,
      baselineReviewId: 'review-before',
      baselineRuntimeVersion: '0.1.0-rc.6',
      maxAttempts: 2,
      automaticCorrectionUsed: true,
      status: 'unresolved',
      attempts: [attempt, { ...attempt, attempt: 2 }],
      resolvedBlockers: [],
      unresolvedBlockers: [{ key: 'compat', kind: 'compatibility', summary: 'still incompatible' }],
      introducedBlockers: [],
    })).toBe(true)
    expect(modificationAttemptsExhausted({
      contractVersion: 1,
      policyVersion: POLICY_VERSION,
      baselineReviewId: 'review-before',
      baselineRuntimeVersion: '0.1.0-rc.6',
      maxAttempts: 2,
      automaticCorrectionUsed: false,
      status: 'unresolved',
      attempts: [attempt],
      resolvedBlockers: [],
      unresolvedBlockers: [],
      introducedBlockers: [{ key: 'new', kind: 'security_finding', summary: 'new block' }],
    })).toBe(true)
    expect(modificationAttemptsExhausted({
      contractVersion: 1,
      policyVersion: POLICY_VERSION,
      baselineReviewId: 'review-before',
      baselineRuntimeVersion: '0.1.0-rc.6',
      maxAttempts: 2,
      automaticCorrectionUsed: false,
      status: 'resolved',
      attempts: [attempt],
      resolvedBlockers: [],
      unresolvedBlockers: [],
      introducedBlockers: [],
    })).toBe(false)
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

describe('resolution authorization state', () => {
  it('maps unfinished discovery to waiting states and never mints scratch without a decision', () => {
    const id = resolution().id
    expect(_testing.waitingAuthorization(id, 'use_local', true).state).toBe('selection_required')
    expect(_testing.waitingAuthorization(id, 'inspect_remote', true).state).toBe('selection_required')
    expect(_testing.waitingAuthorization(id, 'inspect_remote', true, 'marketplace-setup').state).toBe('selection_required')
    expect(_testing.waitingAuthorization(id, 'inspect_remote', true, 'github').state).toBe('selection_required')
    expect(_testing.waitingAuthorization(id, 'none', true).state).toBe('selection_required')
    expect(_testing.waitingAuthorization(id, 'none', false).state).toBe('selection_required')
  })

  it('fails closed for legacy resolutions', () => {
    expect(_testing.authorizationForResolution(resolution(1), []).state).toBe('selection_required')
  })

  it('does not turn skip or empty review lists into scratch', () => {
    expect(_testing.authorizationForResolution(resolution(), [candidateReview('acme/one', 'skip', '3')]).state)
      .toBe('selection_required')
    expect(_testing.authorizationForResolution(resolution(), [
      candidateReview('acme/one', 'skip', '4'),
      candidateReview('acme/two', 'skip', '5'),
    ]).state).toBe('selection_required')
  })

  it('adds an explicit GitHub plugin only as a candidate, not as a review grant', () => {
    const record = resolution()
    record.decision = 'none'
    record.remoteCandidates = []
    delete record.remoteCandidateSource
    record.authorization = {
      state: 'selection_required',
      resolutionId: record.id,
      reason: 'no candidates',
    }
    const added = _testing.addExplicitCandidate(record, 'example-org/dsh-nebula-relay')
    expect(added.candidate.repository).toBe('example-org/dsh-nebula-relay')
    expect(added.resolution.remoteCandidates.map((item) => item.repository)).toEqual(['example-org/dsh-nebula-relay'])
    expect(added.resolution.authorization?.state).toBe('selection_required')
    const second = _testing.addExplicitCandidate(added.resolution, 'example-org/dsh-orbit-index')
    expect(second.candidate.repository).toBe('example-org/dsh-orbit-index')
    expect(second.resolution.remoteCandidates.map((item) => item.repository)).toEqual([
      'example-org/dsh-nebula-relay',
      'example-org/dsh-orbit-index',
    ])
  })

  it('pins exact repositories and fresh search results ahead of a saturated old pool', () => {
    const old = Array.from({ length: 20 }, (_, index) => ({
      repository: `old-org/plugin-${index}`,
      name: `plugin-${index}`,
      description: 'old result',
      stars: 1,
      updatedAt: null,
      topics: ['dsh-plugin'],
      matchedQueries: ['old query'],
    }))
    const fresh = [{
      repository: 'fresh-org/new-result',
      name: 'new-result',
      description: 'fresh result',
      stars: 2,
      updatedAt: '2026-08-28T00:00:00Z',
      topics: ['dsh-plugin'],
      matchedQueries: ['fresh query'],
    }]
    const merged = _testing.mergeRemoteCandidatePool(
      old,
      fresh,
      ['PerryLink/dsh-auto-review'],
      20,
    )

    expect(merged).toHaveLength(20)
    expect(merged[0]).toMatchObject({ repository: 'PerryLink/dsh-auto-review', explicit: true })
    expect(merged[1]).toMatchObject({ repository: 'fresh-org/new-result', matchedQueries: ['fresh query'] })
    expect(merged.some((item) => item.repository === 'old-org/plugin-19')).toBe(false)
  })

  it('merges query evidence and newer metadata without moving an exact repository', () => {
    const merged = _testing.mergeRemoteCandidatePool([
      {
        repository: 'PerryLink/dsh-auto-review', name: 'dsh-auto-review', description: 'old', stars: 1,
        updatedAt: null, topics: ['dsh-plugin'], matchedQueries: ['auto approval'],
      },
    ], [
      {
        repository: 'PerryLink/dsh-auto-review', name: 'dsh-auto-review', description: 'new', stars: 112,
        updatedAt: '2026-08-26T20:21:54Z', topics: ['dsh-plugin', 'auto-review'], matchedQueries: ['auto-review'],
      },
    ], ['PerryLink/dsh-auto-review'], 105)

    expect(merged).toEqual([expect.objectContaining({
      repository: 'PerryLink/dsh-auto-review', explicit: true, description: 'new', stars: 112,
      matchedQueries: expect.arrayContaining(['auto approval', 'auto-review']),
    })])
  })

  it('keeps a historical exact repository pinned through a later saturated search round', () => {
    const repository = 'PerryLink/dsh-auto-review'
    const historical = _testing.mergeRemoteCandidatePool([], [{
      repository, name: 'dsh-auto-review', description: 'exact', stars: 112,
      updatedAt: null, topics: ['dsh-plugin'],
    }], [repository], 105)
    const nextRound = Array.from({ length: 105 }, (_, index) => ({
      repository: `fresh-org/plugin-${index}`, name: `plugin-${index}`, description: 'fresh', stars: index,
      updatedAt: null, topics: ['dsh-plugin'],
    }))

    const merged = _testing.mergeRemoteCandidatePool(historical, nextRound, [], 105)

    expect(merged).toHaveLength(105)
    expect(merged[0]).toMatchObject({ repository, explicit: true })
    expect(merged.filter((candidate) => candidate.repository.startsWith('fresh-org/'))).toHaveLength(104)
  })

  it('mints action grants only from a recorded human decision', () => {
    const record = resolution()
    record.decisions = [{
      id: `decision_${'a'.repeat(24)}`,
      phase: 'gate1',
      action: 'create_new',
      selectedRepositories: [],
      createdAt: '2026-08-17T00:00:00.000Z',
    }]
    expect(_testing.authorizationForResolution(record, []).state).toBe('selection_required')
    record.decisions = [{
      ...record.decisions[0]!,
      phase: 'gate2',
    }]
    expect(_testing.authorizationForResolution(record, []).state).toBe('create_authorized')

    record.decisions = [{
      id: `decision_${'b'.repeat(24)}`,
      phase: 'gate2',
      action: 'use_this',
      selectedRepositories: ['acme/one'],
      reviewId: candidateReview('acme/one', 'use', '1').id,
      reviewIdentity: '1'.repeat(40),
      createdAt: '2026-08-17T00:00:00.000Z',
    }]
    expect(_testing.authorizationForResolution(record, [candidateReview('acme/one', 'use', '1')]).state)
      .toBe('use_review')
  })

  it('keeps marketplace setup required until discovery can finish', () => {
    const record = resolution()
    record.remoteCandidateSource = 'marketplace-setup'
    record.remoteCandidates = []
    record.authorization = {
      state: 'market_required',
      resolutionId: record.id,
      reason: 'install marketplace',
    }
    expect(_testing.authorizationForResolution(record, []).state).toBe('market_required')
  })
})

describe('adaptive review budget', () => {
  it('does not expand the adaptive budget based only on advisory recommendations', () => {
    const usable = candidateReview('acme/one', 'use', '1')
    const repairable = candidateReview('acme/two', 'modify', '2')
    const skipped = candidateReview('acme/three', 'skip', '3')
    expect(_testing.shouldReviewAdaptiveThird('adaptive', [usable, repairable])).toBe(false)
    expect(_testing.shouldReviewAdaptiveThird('adaptive', [skipped, candidateReview('acme/four', 'skip', '4')])).toBe(false)
    expect(_testing.shouldReviewAdaptiveThird('fixed', [usable])).toBe(true)
  })
})
