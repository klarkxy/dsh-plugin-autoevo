import { describe, expect, it } from 'vitest'
import { POLICY_VERSION, type InstallationRecord, type MechanicalFacts, type ResolutionRecord, type ReviewRecord } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import { executeNode, interruptPayload, type NodeExecutionResult, transition } from '../../src/workflow/graph.js'
import { candidateSnapshotFor } from '../../src/workflow/candidates.js'
import { retryableInstallContext, retryablePreVerificationReviewId, type WorkflowExec, type WorkflowHost, type WorkflowNodeId, type WorkflowRecord } from '../../src/workflow/contracts.js'

function resolution(): ResolutionRecord {
  const id = `resolution_${'b'.repeat(24)}`
  return {
    schemaVersion: 2,
    id,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-17T00:00:00.000Z',
    requirement: 'calculator',
    cwd: 'C:/workspace',
    decision: 'inspect_remote',
    localCandidates: [],
    remoteCandidates: [
      { repository: 'acme/one', name: 'one', description: '', stars: 1, updatedAt: null, topics: [] },
    ],
    remoteDiscoveryComplete: true,
    authorization: { state: 'selection_required', resolutionId: id, reason: 'wait' },
    selectedRepositories: ['acme/one'],
    queries: [],
    reasons: [],
  }
}

function review(): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-17T00:00:00.000Z',
    resolutionId: resolution().id,
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github',
      repository: 'acme/one',
      requestedRef: 'main',
      commit: 'c'.repeat(40),
      defaultBranch: 'main',
    },
    inspectedFiles: [{ path: 'package.json', sha256: 'e'.repeat(64), bytes: 8 }],
    manifest: { kind: 'bundle', packageName: 'dsh-one', scripts: [], dependencies: [], peerDependencies: {}, expectedTools: [] },
    fit: 'full',
    confidence: 0.8,
    securityRisk: 'low',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
    missingCapabilities: [],
    findings: [],
    recommendation: 'use',
    installSpec: 'file:C:/workspace/review-artifacts/review-one/package/dsh-one.tgz',
    artifact: {
      sha256: 'f'.repeat(64),
      bytes: 8,
      entryCount: 1,
      ownedRoot: 'C:/workspace/review-artifacts/review-one',
    },
    mechanicalFacts: {
      fit: 'full',
      missingCapabilities: [],
      staticRisk: 'low',
      compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
      manifest: {
        kind: 'bundle',
        packageName: 'dsh-one',
        materializable: true,
        installSpec: 'file:C:/workspace/review-artifacts/review-one/package/dsh-one.tgz',
      },
      truncated: false,
      findings: [],
      evidenceHashes: [],
      semanticContextRequired: false,
    } satisfies MechanicalFacts,
  }
}

function workflow(cursor: WorkflowRecord['cursor']): WorkflowRecord {
  return {
    schemaVersion: 2,
    id: `workflow_${'d'.repeat(24)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    requirement: 'calculator',
    resolutionId: resolution().id,
    status: 'running',
    cursor,
    generation: 1,
    candidateSnapshot: [{
      id: `candidate_${'e'.repeat(24)}`,
      index: 1,
      kind: 'remote',
      name: 'one',
      identity: 'acme/one',
      repository: 'acme/one',
      commit: 'c'.repeat(40),
      digest: 'f'.repeat(64),
    }],
    reviewQueue: [`candidate_${'e'.repeat(24)}`],
    pendingRepositories: ['acme/one'],
    lineageTipReviewId: review().id,
    lastReviewId: review().id,
    pendingPath: 'C:/workspace/plugin',
    pendingInstall: { targetProfile: 'web', retention: 'persistent' },
  }
}

function installationFixture(overrides: Record<string, unknown> = {}): InstallationRecord {
  const installed = overrides.installed === true
  return {
    schemaVersion: 1,
    id: `installation_${'a'.repeat(24)}`,
    createdAt: '2026-08-17T00:00:00.000Z',
    reviewId: review().id,
    workflowId: workflow('install_verify').id,
    targetProfile: 'web',
    retention: 'persistent',
    dshHome: 'C:/dsh',
    packageName: 'dsh-one',
    installSpec: review().installSpec!,
    installPhase: 'completed',
    installState: installed ? 'installed' : 'not_installed',
    installOutcome: 'recovery_required',
    installed,
    loaded: false,
    verified: false,
    restartRequired: false,
    removed: false,
    verification: { reason: 'test installation fixture' },
    ...overrides,
  } as InstallationRecord
}

async function runNode(
  node: WorkflowNodeId,
  options: { host: WorkflowHost; resolution: ResolutionRecord; exec?: WorkflowExec; workflow?: WorkflowRecord },
): Promise<NodeExecutionResult> {
  return executeNode(node, {
    host: options.host,
    workflow: options.workflow ?? workflow(node),
    exec: options.exec ?? {},
    resolution: options.resolution,
  })
}

function installVerifyHost(options: {
  installReviewed: () => Promise<unknown>
  getInstallation?: (id: string) => Promise<unknown>
}): WorkflowHost {
  return {
    async latestReview() { return review() },
    async installReviewed() {
      return installationFixture(await options.installReviewed() as Record<string, unknown>)
    },
    ...(options.getInstallation ? {
      async getInstallation(id: string) {
        return installationFixture(await options.getInstallation!(id) as Record<string, unknown>)
      },
    } : {}),
  } as unknown as WorkflowHost
}

function prepareModifyHost(options: {
  prepareModify: () => Promise<unknown>
  latestReview?: (resolutionId: string, reviewId?: string) => Promise<ReviewRecord>
  getResolution?: () => Promise<ResolutionRecord>
}): WorkflowHost {
  return {
    latestReview: options.latestReview ?? (async () => review()),
    prepareModify: options.prepareModify,
    ...(options.getResolution ? { getResolution: options.getResolution } : {}),
  } as unknown as WorkflowHost
}

describe('workflow graph transitions', () => {
  it('routes selection and confirmation options onto the declared nodes', () => {
    expect(transition('await_confirmation', 'use_this')).toBe('install_verify')
    expect(transition('await_confirmation', 'modify_this')).toBe('prepare_modify')
    expect(transition('await_modify_work', 'stop')).toBe('stopped')
    expect(transition('await_modify_work', 'finish_managed_work')).toBe('complete_managed_work')
    expect(() => transition('await_selection', 'review_candidates')).toThrow(/cannot resume/i)
    expect(() => transition('await_selection', 'use_this')).toThrow(/cannot resume/i)
  })

  it('builds interrupt options from the current facts', () => {
    const selectionWorkflow = workflow('await_selection')
    const selection = interruptPayload('await_selection', resolution(), [], { workflow: selectionWorkflow })
    expect(selection.options.map((item) => item.id)).toEqual([
      'review_candidates',
      'search_more',
      'stop',
    ])
    const confirmationWorkflow = workflow('await_confirmation')
    confirmationWorkflow.reviewedCandidateIds = [confirmationWorkflow.candidateSnapshot![0]!.id]
    confirmationWorkflow.reviewIdsByCandidate = {
      [confirmationWorkflow.candidateSnapshot![0]!.id]: review().id,
    }
    const confirmationReview = review()
    const confirmation = interruptPayload('await_confirmation', resolution(), [confirmationReview], {
      workflow: confirmationWorkflow,
      installProfiles: ['web'],
    })
    expect(confirmation.options.map((item) => item.id)).toEqual([
      'use_this',
      'search_more',
      'modify_this',
      'create_new',
      'stop',
    ])
    expect(confirmation.options.find((item) => item.id === 'use_this')?.placement).toBe('primary')
    expect(confirmation.options.find((item) => item.id === 'search_more')?.placement).toBe('primary')
    expect(confirmation.options.find((item) => item.id === 'modify_this')?.placement).toBe('advanced')
    expect(confirmation.options.find((item) => item.id === 'create_new')?.placement).toBe('advanced')
    expect(confirmation.options.find((item) => item.id === 'stop')?.placement).toBe('recovery')
    expect(confirmation.options.find((item) => item.id === 'use_this')?.candidateIds)
      .toEqual([confirmationWorkflow.candidateSnapshot![0]!.id])
    const modify = interruptPayload('await_modify_work', resolution(), [review()], { workflow: workflow('await_modify_work') })
    expect(modify.facts).toMatchObject({ reviewId: review().id, repository: 'acme/one' })
  })

  it('hides managed actions at confirmation when the preset cannot run managed work', () => {
    const confirmationWorkflow = workflow('await_confirmation')
    confirmationWorkflow.reviewedCandidateIds = [confirmationWorkflow.candidateSnapshot![0]!.id]
    confirmationWorkflow.reviewIdsByCandidate = {
      [confirmationWorkflow.candidateSnapshot![0]!.id]: review().id,
    }
    const confirmationReview = review()
    const confirmation = interruptPayload('await_confirmation', resolution(), [confirmationReview], {
      workflow: confirmationWorkflow,
      installProfiles: ['web'],
      managedActionsAvailable: false,
    })
    expect(confirmation.options.map((item) => item.id)).toEqual([
      'use_this',
      'search_more',
      'stop',
    ])
    const available = interruptPayload('await_confirmation', resolution(), [confirmationReview], {
      workflow: confirmationWorkflow,
      installProfiles: ['web'],
      managedActionsAvailable: true,
    })
    expect(available.options.map((item) => item.id)).toEqual([
      'use_this',
      'search_more',
      'modify_this',
      'create_new',
      'stop',
    ])
  })
})

describe('workflow graph nodes', () => {
  it('uses the model baseline query plan only before the first recorded remote attempt', async () => {
    const inputs: Array<{ queries?: string[] } | undefined> = []
    const host = {
      async discoverRemote(current: ResolutionRecord, _exec: WorkflowExec, input?: { queries?: string[] }) {
        inputs.push(input)
        return current
      },
    } as unknown as WorkflowHost
    const record = workflow('discover_remote')
    record.discoveryQueries = ['auto review']
    const first = resolution()
    first.queries = []
    const later = { ...resolution(), queries: ['auto review'] }

    await runNode('discover_remote', { host, resolution: first, workflow: record })
    await runNode('discover_remote', { host, resolution: later, workflow: record })

    expect(inputs).toEqual([{ queries: ['auto review'] }, {}])
  })

  it('returns control to autonomous discovery before the model seals a shortlist', async () => {
    const current = resolution()
    const host = {
      async discoverRemote() {
        return current
      },
    } as unknown as WorkflowHost
    const result = await runNode('discover_remote', { host, resolution: current })
    expect(result).toMatchObject({ kind: 'next', node: 'await_discovery', resolution: current })
  })

  it('keeps incomplete discovery retryable and excludes creation from its selection gate', async () => {
    const current = resolution()
    current.remoteCandidates = []
    current.remoteDiscoveryComplete = false
    const record = workflow('await_selection')
    record.candidateSnapshot = []
    const selection = interruptPayload('await_selection', current, [], { workflow: record })
    expect(selection.options.map((item) => item.id)).toEqual(['search_more', 'stop'])
  })

  it('reviews the selected GitHub repository then parks on confirmation', async () => {
    const current = resolution()
    const inspected = review()
    const host = {
      async reviewGithubBatch(_resolution: ResolutionRecord, candidateIds: string[]) {
        expect(candidateIds).toEqual([`candidate_${'e'.repeat(24)}`])
        return {
          resolution: { ...current, authorization: { state: 'confirmation_required' as const, resolutionId: current.id, reason: 'reviewed' } },
          reviews: [inspected],
          failures: [],
        }
      },
    } as unknown as WorkflowHost
    const result = await runNode('review_github', { host, resolution: current })
    expect(result).toMatchObject({ kind: 'next', node: 'await_confirmation', review: { id: inspected.id } })
  })

  it('returns to confirmation when install fails for a non-input reason', async () => {
    const current = resolution()
    const inspected = review()
    const host = installVerifyHost({
      async installReviewed() {
        throw new Error('verify failed')
      },
    })
    const record = workflow('install_verify')
    const result = await runNode('install_verify', { host, resolution: current, workflow: record })
    expect(result).toMatchObject({ kind: 'next', node: 'await_confirmation', review: { id: inspected.id } })
    expect(record.lastFailure).toEqual({
      stage: 'install',
      code: 'command_failed',
      message: 'verify failed',
      retryable: false,
    })
  })

  it('binds a preserved installation receipt and parks at recovery when final receipt persistence fails', async () => {
    const current = resolution()
    const record = workflow('install_verify')
    const installationId = `installation_${'f'.repeat(24)}`
    const diagnosticHash = '9'.repeat(64)
    const host = installVerifyHost({
      async installReviewed() {
        throw new EvolutionError('command_failed', 'final receipt persistence failed', {
          recoveryRequired: true,
          installationId,
          diagnosticHash,
        })
      },
      async getInstallation(id: string) {
        expect(id).toBe(installationId)
        return { id, workflowId: record.id }
      },
    })

    const result = await runNode('install_verify', { host, resolution: current, workflow: record })

    expect(result).toMatchObject({
      kind: 'done',
      node: 'recovery_required',
      installation: { id: installationId, workflowId: record.id },
    })
    expect(record.lastFailure).toEqual({
      stage: 'install',
      code: 'command_failed',
      message: 'final receipt persistence failed',
      retryable: false,
      diagnosticHash,
    })
  })

  it('preserves cancellation identity and the prior failure without projecting a new install failure', async () => {
    const current = resolution()
    const controller = new AbortController()
    const reason = new Error('cancel install graph node')
    const record = workflow('install_verify')
    record.lastFailure = {
      stage: 'install',
      code: 'prior_failure',
      message: 'keep this failure',
      retryable: true,
    }
    const priorFailure = record.lastFailure
    const host = installVerifyHost({
      async installReviewed() {
        controller.abort(reason)
        throw reason
      },
    })

    await expect(runNode('install_verify', {
      host,
      resolution: current,
      workflow: record,
      exec: { signal: controller.signal },
    })).rejects.toBe(reason)
    expect(record.lastFailure).toBe(priorFailure)
  })

  it('returns a persisted repository-only review target to preview instead of guessing a package path', async () => {
    const current = resolution()
    const legacy = workflow('review_github')
    delete legacy.candidateSnapshot![0]!.commit
    const host = {} as unknown as WorkflowHost
    const result = await runNode('review_github', { host, resolution: current, workflow: legacy })
    expect(result).toMatchObject({ kind: 'next', node: 'await_discovery' })
    expect(legacy.candidateSnapshot).toBeUndefined()
    expect(legacy.lastFailure).toMatchObject({ code: 'review_target_upgrade_required', retryable: true })
  })

  it('accepts a managed-local receipt only when it retains the reviewed frozen install spec', async () => {
    const current = resolution()
    const record = workflow('install_verify')
    const installationId = `installation_${'f'.repeat(24)}`
    record.pendingInstallationId = installationId
    const inspected = review()
    inspected.sourceSnapshot = {
      kind: 'local',
      path: 'C:/workspace/managed-plugin',
      baseReviewId: `review_${'b'.repeat(64)}`,
      baseCommit: 'c'.repeat(40),
      statusHash: 'd'.repeat(64),
    }
    inspected.installSpec = 'file:C:/workspace/review-artifacts/reviewed.tgz'
    const host = {
      async latestReview() { return inspected },
      async getInstallation() {
        return installationFixture({
          id: installationId,
          workflowId: record.id,
          reviewId: inspected.id,
          targetProfile: record.pendingInstall!.targetProfile,
          retention: record.pendingInstall!.retention,
          installSpec: inspected.installSpec,
          installed: false,
          verification: { reason: 'installation was interrupted after materialization' },
        })
      },
      async installReviewed() {
        throw new Error('must not reinstall a recovered receipt')
      },
    } as unknown as WorkflowHost

    const result = await runNode('install_verify', { host, resolution: current, workflow: record })

    expect(result).toMatchObject({
      kind: 'done',
      node: 'recovery_required',
      installation: { id: installationId, reviewId: inspected.id },
    })
  })

  it('rejects a contradictory failed_absent receipt without offering another install attempt', async () => {
    let installs = 0
    const host = installVerifyHost({
      async installReviewed() {
        installs += 1
        return installationFixture({
          installOutcome: 'failed_absent',
          installState: 'installed',
          installed: true,
        })
      },
    })

    await expect(runNode('install_verify', { host, resolution: resolution() }))
      .rejects.toMatchObject({
        code: 'invalid_input',
        message: expect.stringContaining('contradictory'),
      })
    expect(installs).toBe(1)
  })

  it('does not treat malformed activated or awaiting_user_test receipts as verified', async () => {
    const current = resolution()
    for (const installOutcome of ['activated', 'awaiting_user_test'] as const) {
      const host = installVerifyHost({
        async installReviewed() {
          return {
            id: `installation_${'a'.repeat(24)}`,
            installOutcome,
            installed: true,
            verified: true,
            verification: { reason: installOutcome, status: 'passed' },
          }
        },
      })
      await expect(runNode('install_verify', { host, resolution: current }))
        .rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('does not re-execute install or verify for the same review, source, layer, and fixture digest', async () => {
    const current = resolution()
    const record = workflow('install_verify')
    let installs = 0
    const installation = {
      id: `installation_${'a'.repeat(24)}`,
      workflowId: record.id,
      installOutcome: 'failed_absent' as const,
      installed: false,
      verified: false,
      removed: true,
      verification: {
        attempted: true,
        expectedTools: [],
        calledTools: [],
        resultTools: [],
        failedTools: [],
        sessionFiles: [],
        taskResultObserved: false,
        reason: 'failed',
        status: 'failed' as const,
        layer: 'tool_roundtrip',
        fixtureDigest: 'ab'.repeat(32),
      },
    }
    const host = installVerifyHost({
      async installReviewed() {
        installs += 1
        return installation
      },
      async getInstallation() { return installation },
    })
    const first = await runNode('install_verify', { host, resolution: current, workflow: record })
    expect(first).toMatchObject({ kind: 'next', node: 'await_confirmation' })
    expect(installs).toBe(1)
    record.lastInstallationId = installation.id
    const second = await runNode('install_verify', { host, resolution: current, workflow: record })
    expect(installs).toBe(1)
    expect(second).toMatchObject({ kind: 'next', node: 'await_confirmation' })
    expect(record.lastFailure).toMatchObject({
      code: 'verification_already_attempted',
      retryable: false,
    })
  })

  it('does not start another managed child after modification attempts are exhausted', async () => {
    const current = resolution()
    const inspected = review()
    const record = workflow('prepare_modify')
    record.modificationOutcome = {
      contractVersion: 1,
      policyVersion: POLICY_VERSION,
      baselineReviewId: inspected.id,
      baselineRuntimeVersion: '0.1.0-rc.6',
      maxAttempts: 2,
      automaticCorrectionUsed: true,
      status: 'unresolved',
      attempts: [
        {
          attempt: 1,
          childSessionId: 'child-1',
          commit: 'a'.repeat(40),
          changedFiles: ['src/index.ts'],
          changedFilesTruncated: false,
          postReviewId: inspected.id,
          completionMarkerObserved: true,
          checks: { source: 'host_observed', status: 'failed', summary: 'still incompatible' },
        },
        {
          attempt: 2,
          childSessionId: 'child-2',
          commit: 'b'.repeat(40),
          changedFiles: ['src/index.ts'],
          changedFilesTruncated: false,
          postReviewId: inspected.id,
          completionMarkerObserved: true,
          checks: { source: 'host_observed', status: 'failed', summary: 'still incompatible' },
        },
      ],
      resolvedBlockers: [],
      unresolvedBlockers: [{ key: 'compat', kind: 'compatibility', summary: 'peer still excludes runtime' }],
      introducedBlockers: [],
    }
    let prepareCalls = 0
    const host = prepareModifyHost({
      async prepareModify() {
        prepareCalls += 1
        throw new Error('must not start another child')
      },
    })
    const result = await runNode('prepare_modify', { host, resolution: current, workflow: record })
    expect(prepareCalls).toBe(0)
    expect(result).toMatchObject({ kind: 'next', node: 'await_confirmation', review: { id: inspected.id } })
    expect(record.lastFailure).toMatchObject({
      code: 'modify_attempts_exhausted',
      retryable: false,
    })
  })

  it('parks cancelled managed work at recovery_required after the Host checkpoints edits', async () => {
    const current = resolution()
    const inspected = review()
    const preserved = { ...inspected, id: `review_${'e'.repeat(64)}` }
    const preservedResolution = { ...current, reasons: [...current.reasons, 'checkpointed review persisted'] }
    const controller = new AbortController()
    controller.abort()
    const record = workflow('prepare_modify')
    const host = prepareModifyHost({
      async latestReview(_resolutionId: string, reviewId?: string) {
        return reviewId === preserved.id ? preserved : inspected
      },
      async getResolution() { return preservedResolution },
      async prepareModify() {
        record.lastReviewId = preserved.id
        record.lineageTipReviewId = preserved.id
        throw new EvolutionError('command_failed', 'cancelled and checkpointed', {
          cancelled: true,
          recoveryRequired: true,
          headCommit: 'd'.repeat(40),
        })
      },
    })
    const result = await runNode('prepare_modify', {
      host,
      resolution: current,
      exec: { signal: controller.signal },
      workflow: record,
    })
    expect(result).toMatchObject({
      kind: 'done',
      node: 'recovery_required',
      resolution: { reasons: expect.arrayContaining(['checkpointed review persisted']) },
      review: { id: preserved.id },
    })
    expect(record.lastFailure).toEqual({
      stage: 'managed_child',
      code: 'command_failed',
      message: 'cancelled and checkpointed',
      retryable: false,
    })
  })

  it('keeps a managed modification retryable after a child failure', async () => {
    const current = resolution()
    const inspected = review()
    const preserved = { ...inspected, id: `review_${'f'.repeat(64)}` }
    const preservedResolution = { ...current, reasons: [...current.reasons, 'first modification review persisted'] }
    const record = workflow('prepare_modify')
    const host = prepareModifyHost({
      async latestReview(_resolutionId: string, reviewId?: string) {
        return reviewId === preserved.id ? preserved : inspected
      },
      async getResolution() { return preservedResolution },
      async prepareModify() {
        record.lastReviewId = preserved.id
        record.lineageTipReviewId = preserved.id
        throw new Error('child failed after checkpoint')
      },
    })
    const result = await runNode('prepare_modify', { host, resolution: current, workflow: record })
    expect(result).toMatchObject({
      kind: 'next',
      node: 'await_confirmation',
      resolution: { reasons: expect.arrayContaining(['first modification review persisted']) },
      review: { id: preserved.id },
    })
    expect(record.lastFailure).toEqual({
      stage: 'managed_child',
      code: 'command_failed',
      message: 'child failed after checkpoint',
      retryable: false,
    })
  })

  it('terminates in explicit recovery when failed child edits cannot be checkpointed safely', async () => {
    const current = resolution()
    const record = workflow('prepare_modify')
    const host = prepareModifyHost({
      async getResolution() { return current },
      async prepareModify() {
        throw new EvolutionError('command_failed', 'explicit source recovery is required', { recoveryRequired: true })
      },
    })
    const result = await runNode('prepare_modify', { host, resolution: current, workflow: record })
    expect(result).toMatchObject({ kind: 'done', node: 'recovery_required' })
  })

  it('repairs retry options for persisted pre-verification install failures', () => {
    const confirmationWorkflow = workflow('await_confirmation')
    confirmationWorkflow.reviewedCandidateIds = [confirmationWorkflow.candidateSnapshot![0]!.id]
    confirmationWorkflow.reviewIdsByCandidate = {
      [confirmationWorkflow.candidateSnapshot![0]!.id]: review().id,
    }
    confirmationWorkflow.consumedVerificationAttempts = [{
      reviewId: review().id,
      sourceIdentity: `github:acme/one#${'c'.repeat(40)}`,
      layer: 'unspecified',
    }]
    confirmationWorkflow.lastFailure = {
      stage: 'install',
      code: 'command_failed',
      message: 'pnpm failed before verification',
      retryable: true,
    }
    const approved = review()

    const confirmation = interruptPayload('await_confirmation', resolution(), [approved], {
      workflow: confirmationWorkflow,
      installProfiles: ['web'],
      lastFailure: confirmationWorkflow.lastFailure,
      retryableInstall: { reviewId: approved.id },
    })

    expect(confirmation.options.map((item) => item.id)).toContain('use_this')
    expect(confirmation.facts).toMatchObject({ verificationAlreadyAttempted: false })
  })

  it('offers only the receipt-bound exact release-age exception for the failed candidate', () => {
    const record = workflow('await_confirmation')
    record.status = 'interrupted'
    const approved = review()
    const candidateId = record.candidateSnapshot![0]!.id
    record.reviewedCandidateIds = [candidateId]
    record.reviewIdsByCandidate = { [candidateId]: approved.id }
    const installation: InstallationRecord = {
      schemaVersion: 1,
      id: `installation_${'d'.repeat(24)}`,
      createdAt: '2026-08-28T00:00:00.000Z',
      workflowId: record.id,
      reviewId: approved.id,
      targetProfile: 'web',
      retention: 'persistent',
      dshHome: 'C:/dsh',
      packageName: 'dsh-one',
      installSpec: approved.installSpec!,
      installState: 'not_installed',
      installOutcome: 'failed_absent',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: false, expectedTools: [], calledTools: [], resultTools: [], failedTools: [],
        sessionFiles: [], taskResultObserved: false, reason: 'install failed',
      },
      installFailure: {
        stage: 'install', code: 'command_failed', message: 'pnpm failed', retryable: true,
        diagnosticHash: 'e'.repeat(64),
        recovery: {
          kind: 'minimum_release_age', owner: 'pnpm', code: 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
          policyKey: 'minimumReleaseAge', scope: 'host_profile', exceptionEligible: true,
          entries: [
            { packageName: 'ds-harness-remote', version: '0.3.35', reason: 'published recently' },
            { packageName: '@deepseek-ai/dsh-file-viewer', version: '0.2.5', reason: 'published recently' },
          ],
        },
      },
    }
    record.lastInstallationId = installation.id
    record.lastFailure = { stage: 'install', code: 'command_failed', message: 'pnpm failed', retryable: true }
    const context = retryableInstallContext(record, installation)
    expect(context?.recoveryPlans).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^recovery_[a-f0-9]{24}$/u),
      operation: 'retry_install', strategy: 'minimum_release_age_exception', sourceInstallationId: installation.id,
      diagnosticHash: 'e'.repeat(64),
      exactPackages: ['@deepseek-ai/dsh-file-viewer@0.2.5', 'ds-harness-remote@0.3.35'],
      effectScope: 'single_install_command',
    })])

    const confirmation = interruptPayload('await_confirmation', resolution(), [approved], {
      workflow: record, installProfiles: ['web'], retryableInstall: context!,
    })
    expect(confirmation.options.find((item) => item.id === 'use_this')).toBeUndefined()
    expect(confirmation.options.find((item) => item.id === 'apply_recovery')?.candidateIds)
      .toEqual([candidateId])
    expect(confirmation.options.find((item) => item.id === 'apply_recovery')?.recoveryIds)
      .toEqual([context?.recoveryPlans?.[0]?.id])
    expect(confirmation.facts).toMatchObject({
      recoveryOptions: [{
        sourceInstallationId: installation.id,
        exactPackages: ['@deepseek-ai/dsh-file-viewer@0.2.5', 'ds-harness-remote@0.3.35'],
      }],
    })
  })

  it('offers a sealed pause-and-fix retry for a confirmed-absent profile store mismatch', () => {
    const record = workflow('await_confirmation')
    record.status = 'interrupted'
    const approved = review()
    const candidateId = record.candidateSnapshot![0]!.id
    record.reviewedCandidateIds = [candidateId]
    record.reviewIdsByCandidate = { [candidateId]: approved.id }
    const installation: InstallationRecord = {
      schemaVersion: 1,
      id: `installation_${'e'.repeat(24)}`,
      createdAt: '2026-08-28T00:00:00.000Z',
      workflowId: record.id,
      reviewId: approved.id,
      targetProfile: 'web',
      retention: 'persistent',
      dshHome: 'C:/dsh',
      packageName: 'dsh-one',
      installSpec: approved.installSpec!,
      installState: 'not_installed',
      installOutcome: 'failed_absent',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
      removed: false,
      verification: {
        attempted: false, expectedTools: [], calledTools: [], resultTools: [], failedTools: [],
        sessionFiles: [], taskResultObserved: false, reason: 'install failed',
      },
      installFailure: {
        stage: 'install', code: 'command_failed', message: 'pnpm failed', retryable: true,
        diagnosticHash: 'f'.repeat(64),
        recovery: {
          kind: 'profile_store_mismatch', owner: 'pnpm', code: 'ERR_PNPM_UNEXPECTED_STORE',
          profileStoreFingerprint: 'a'.repeat(64), scope: 'host_profile', reuseEligible: true,
        },
      },
    }
    record.lastInstallationId = installation.id
    record.lastFailure = { stage: 'install', code: 'command_failed', message: 'pnpm failed', retryable: true }
    const context = retryableInstallContext(record, installation)

    expect(context?.recoveryPlans).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^recovery_[a-f0-9]{24}$/u),
      operation: 'retry_install',
      strategy: 'profile_store_reuse',
      sourceInstallationId: installation.id,
      diagnosticHash: 'f'.repeat(64),
      profileStoreFingerprint: 'a'.repeat(64),
      effectScope: 'single_install_command',
    })])
    const confirmation = interruptPayload('await_confirmation', resolution(), [approved], {
      workflow: record, installProfiles: ['web'], retryableInstall: context!,
    })
    expect(confirmation.options.find((item) => item.id === 'use_this')).toBeUndefined()
    expect(confirmation.options.find((item) => item.id === 'apply_recovery')).toMatchObject({
      candidateIds: [candidateId],
      recoveryIds: [context?.recoveryPlans?.[0]?.id],
    })
    expect(confirmation.facts).toMatchObject({
      recoveryOptions: [{ strategy: 'profile_store_reuse', sourceInstallationId: installation.id }],
    })

    const exhaustedInstallation: InstallationRecord = {
      ...installation,
      id: `installation_${'1'.repeat(24)}`,
      recoveryAttempt: {
        id: context!.recoveryPlans![0]!.id,
        strategy: 'profile_store_reuse',
        sourceInstallationId: installation.id,
      },
    }
    record.lastInstallationId = exhaustedInstallation.id
    const exhausted = retryableInstallContext(record, exhaustedInstallation)
    const afterRepeatedFailure = interruptPayload('await_confirmation', resolution(), [approved], {
      workflow: record, installProfiles: ['web'], retryableInstall: exhausted!,
    })
    expect(exhausted).toMatchObject({ reviewId: approved.id, recoveryExhausted: true })
    expect(afterRepeatedFailure.options.map((item) => item.id)).not.toContain('apply_recovery')
    expect(afterRepeatedFailure.options.map((item) => item.id)).not.toContain('use_this')
  })

  it('completes built-in enablement without restart when the mount was already present', async () => {
    const current = resolution()
    const record = workflow('enable_builtin')
    const installationId = `installation_${'a'.repeat(24)}`
    record.pendingInstallationId = installationId
    const host = {
      async enableBuiltin() {
        throw new Error('must not re-enable from a completed receipt')
      },
      async getInstallation(id: string) {
        expect(id).toBe(installationId)
        return installationFixture({
          id,
          workflowId: record.id,
          installPhase: 'completed',
          installState: 'installed',
          installOutcome: 'pending',
          installed: true,
          restartRequired: false,
        })
      },
    } as unknown as WorkflowHost

    const result = await runNode('enable_builtin', { host, resolution: current, workflow: record })

    expect(result).toMatchObject({
      kind: 'done',
      node: 'installed',
      installation: { id: installationId, restartRequired: false },
    })
  })

  it('returns a denied no-effect built-in enablement to fresh confirmation', async () => {
    const current = resolution()
    const record = workflow('enable_builtin')
    const installationId = `installation_${'d'.repeat(24)}`
    record.pendingInstallationId = installationId
    const installation = installationFixture({
      id: installationId,
      workflowId: record.id,
      installPhase: 'completed',
      installState: 'not_installed',
      installOutcome: 'failed_absent',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
      removed: true,
      installFailure: {
        stage: 'install',
        code: 'approval_required',
        message: 'The profile change was denied.',
        retryable: true,
      },
    })
    const host = {
      async enableBuiltin() {
        throw new EvolutionError('approval_required', 'The profile change was denied.', { outcome: 'denied' })
      },
      async getInstallation(id: string) {
        expect(id).toBe(installationId)
        return installation
      },
    } as unknown as WorkflowHost

    const result = await runNode('enable_builtin', { host, resolution: current, workflow: record })

    expect(result).toMatchObject({
      kind: 'next',
      node: 'await_confirmation',
      installation: { id: installationId, installOutcome: 'failed_absent', removed: true },
    })
    expect(record.lastFailure).toMatchObject({ code: 'approval_required', retryable: true })
  })

  it('keeps a possibly-effectful built-in failure in explicit recovery', async () => {
    const current = resolution()
    const record = workflow('enable_builtin')
    const installationId = `installation_${'e'.repeat(24)}`
    record.pendingInstallationId = installationId
    const installation = installationFixture({
      id: installationId,
      workflowId: record.id,
      installPhase: 'completed',
      installState: 'unknown',
      installOutcome: 'recovery_required',
      installed: false,
      loaded: false,
      verified: false,
      restartRequired: false,
      removed: false,
      installFailure: {
        stage: 'install',
        code: 'command_failed',
        message: 'The exact row could not be reconciled.',
        retryable: false,
      },
    })
    const host = {
      async enableBuiltin() {
        throw new EvolutionError('command_failed', 'The exact row could not be reconciled.')
      },
      async getInstallation() {
        return installation
      },
    } as unknown as WorkflowHost

    const result = await runNode('enable_builtin', { host, resolution: current, workflow: record })

    expect(result).toMatchObject({
      kind: 'done',
      node: 'recovery_required',
      installation: { id: installationId, installOutcome: 'recovery_required', removed: false },
    })
  })

  it('authorizes create-new when prepareCreate returns no managed path', async () => {
    const current = resolution()
    const result = await runNode('prepare_create', {
      host: {
        async prepareCreate() {
          return { resolution: current }
        },
      } as unknown as WorkflowHost,
      resolution: current,
    })
    expect(result).toMatchObject({ kind: 'done', node: 'create_authorized' })
  })

  it('keeps search_more outside the authorization transition table', () => {
    expect(() => transition('await_selection', 'search_more')).toThrow(/cannot resume/i)
    expect(() => transition('await_confirmation', 'search_more')).toThrow(/cannot resume/i)
  })
})
