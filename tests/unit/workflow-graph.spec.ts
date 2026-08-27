import { describe, expect, it } from 'vitest'
import { POLICY_VERSION, type MechanicalFacts, type ResolutionRecord, type ReviewRecord } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import { reviewCandidateDigest, reviewSnapshotDigest } from '../../src/review/direct-use.js'
import { mintReviewerRequest, requirementHashFor, REVIEWER_VERSION } from '../../src/semantic-reviewer.js'
import { executeNode, interruptPayload, type NodeExecutionResult, transition } from '../../src/workflow/graph.js'
import { candidateSnapshotFor } from '../../src/workflow/candidates.js'
import type { WorkflowExec, WorkflowHost, WorkflowNodeId, WorkflowRecord } from '../../src/workflow/contracts.js'

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
    inspectedFiles: [],
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
    installSpec: `github:acme/one#${'c'.repeat(40)}`,
    mechanicalFacts: {
      fit: 'full',
      missingCapabilities: [],
      staticRisk: 'low',
      compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
      manifest: {
        kind: 'bundle',
        packageName: 'dsh-one',
        materializable: true,
        installSpec: `github:acme/one#${'c'.repeat(40)}`,
      },
      truncated: false,
      findings: [],
      evidenceHashes: [],
      semanticContextRequired: false,
    } satisfies MechanicalFacts,
  }
}

function withApprovedVerdict(record: ReviewRecord, workflow: WorkflowRecord): ReviewRecord {
  const snapshotDigest = reviewSnapshotDigest(record)
  const candidateDigest = reviewCandidateDigest(record, workflow)
  const request = mintReviewerRequest({
    workflowId: workflow.id,
    review: record,
    snapshotDigest,
    candidateDigest,
    createdAt: '2026-08-17T00:00:02.000Z',
  })
  const completed = { ...request, status: 'completed' as const, completedAt: '2026-08-17T00:00:03.000Z' }
  return {
    ...record,
    reviewerRequestId: completed.id,
    reviewerRequest: completed,
    reviewerVerdict: {
      requestId: completed.id,
      reviewId: record.id,
      requirementHash: requirementHashFor(record.requirement),
      snapshotDigest,
      candidateDigest,
      reviewerSessionId: 'reviewer-session',
      reviewerVersion: REVIEWER_VERSION,
      decision: 'approved',
      evidence: [],
      conditions: [],
      semanticCoverage: record.fit,
      createdAt: '2026-08-17T00:00:03.000Z',
    },
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
      digest: 'f'.repeat(64),
    }],
    pendingRepositories: ['acme/one'],
    lineageTipReviewId: review().id,
    lastReviewId: review().id,
    pendingPath: 'C:/workspace/plugin',
    pendingInstall: { targetProfile: 'web', retention: 'persistent' },
  }
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
    installReviewed: options.installReviewed,
    ...(options.getInstallation ? { getInstallation: options.getInstallation } : {}),
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
  it('keeps create-new blocked when marketplace setup fails before discovery', async () => {
    const current = resolution()
    const host = {
      async ensureMarket() {
        return {
          resolution: current,
          market: { status: 'blocked', reason: 'approval denied or install failed' },
        }
      },
    } as unknown as WorkflowHost
    const result = await runNode('ensure_market', { host, resolution: current })
    expect(result).toMatchObject({ kind: 'done', node: 'market_setup_required' })
  })

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
    const confirmationReview = withApprovedVerdict(review(), confirmationWorkflow)
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
    const confirmationReview = withApprovedVerdict(review(), confirmationWorkflow)
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

  it('auto-seals a completed empty discovery into the existing selection gate', async () => {
    const current = resolution()
    current.remoteCandidates = []
    const host = {
      async discoverRemote() {
        return current
      },
    } as unknown as WorkflowHost
    const result = await runNode('discover_remote', { host, resolution: current })
    expect(result).toMatchObject({ kind: 'next', node: 'await_selection', resolution: current })
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

  it('turns a discovery error into a diagnosable retry checkpoint', async () => {
    const current = resolution()
    current.remoteCandidates = []
    current.remoteDiscoveryComplete = false
    const record = workflow('discover_remote')
    const host = {
      async discoverRemote() {
        throw new EvolutionError('github_unavailable', 'temporary discovery failure')
      },
    } as unknown as WorkflowHost
    const result = await runNode('discover_remote', { host, resolution: current, workflow: record })
    expect(result).toMatchObject({ kind: 'next', node: 'await_selection' })
    expect(record.lastFailure).toMatchObject({
      stage: 'discovery',
      code: 'github_unavailable',
      retryable: true,
    })
  })

  it('clears a prior discovery failure after a successful retry', async () => {
    const current = resolution()
    current.remoteCandidates = []
    current.remoteDiscoveryComplete = false
    const record = workflow('discover_remote')
    record.lastFailure = {
      stage: 'discovery',
      code: 'github_unavailable',
      message: 'synthetic discovery outage',
      retryable: true,
    }
    const host = {
      async discoverRemote() {
        return { ...current, remoteDiscoveryComplete: true }
      },
    } as unknown as WorkflowHost
    const result = await runNode('discover_remote', { host, resolution: current, workflow: record })
    expect(result).toMatchObject({ kind: 'next', node: 'await_selection' })
    expect(record.lastFailure).toBeUndefined()
  })

  it('allows updated remote evidence to reappear after the earlier snapshot was rejected', () => {
    const first = resolution()
    const rejectedId = candidateSnapshotFor(first)[0]!.id
    const updated = {
      ...first,
      remoteCandidates: [{
        ...first.remoteCandidates[0]!,
        updatedAt: '2026-08-26T00:00:00.000Z',
      }],
    }
    const refreshed = candidateSnapshotFor(updated, new Set([rejectedId]))
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0]?.id).not.toBe(rejectedId)
  })

  it('reviews the selected GitHub repository then parks on confirmation', async () => {
    const current = resolution()
    const inspected = review()
    const host = {
      async reviewGithub(_resolution: ResolutionRecord, repository: string) {
        expect(repository).toBe('acme/one')
        return { resolution: { ...current, authorization: { state: 'confirmation_required', resolutionId: current.id, reason: 'reviewed' } }, review: inspected }
      },
    } as unknown as WorkflowHost
    const result = await runNode('review_github', { host, resolution: current })
    expect(result).toMatchObject({ kind: 'next', node: 'await_confirmation', review: { id: inspected.id } })
  })

  it('does not offer create-new while remote discovery is incomplete', () => {
    const current = resolution()
    current.remoteDiscoveryComplete = false
    current.remoteCandidates = []
    const record = workflow('await_confirmation')
    record.candidateSnapshot = []
    const confirmation = interruptPayload('await_confirmation', current, [], {
      workflow: record,
    })
    expect(confirmation.options.map((item) => item.id)).toEqual(['search_more', 'stop'])
  })

  it('scopes mixed-batch actions to eligible candidate IDs', () => {
    const current = resolution()
    current.remoteCandidates.push({
      repository: 'acme/two', name: 'two', description: '', stars: 0, updatedAt: null, topics: [],
    })
    const record = workflow('await_confirmation')
    record.candidateSnapshot!.push({
      id: `candidate_${'2'.repeat(24)}`,
      index: 2,
      kind: 'remote',
      name: 'two',
      identity: 'acme/two',
      repository: 'acme/two',
      digest: '2'.repeat(64),
    })
    record.reviewedCandidateIds = record.candidateSnapshot!.map((item) => item.id)
    const eligible = withApprovedVerdict(review(), record)
    const rejected = review()
    rejected.id = `review_${'2'.repeat(64)}`
    rejected.sourceSnapshot = {
      kind: 'github',
      repository: 'acme/two',
      requestedRef: 'main',
      commit: '2'.repeat(40),
      defaultBranch: 'main',
    }
    rejected.recommendation = 'skip'
    rejected.securityRisk = 'high'
    rejected.installSpec = null
    if (rejected.mechanicalFacts) {
      rejected.mechanicalFacts = {
        ...rejected.mechanicalFacts,
        staticRisk: 'high',
        manifest: { ...rejected.mechanicalFacts.manifest, materializable: false, installSpec: null },
        directUseHostBoundary: 'not_materializable',
      }
    }
    record.reviewIdsByCandidate = {
      [record.candidateSnapshot![0]!.id]: eligible.id,
      [record.candidateSnapshot![1]!.id]: rejected.id,
    }
    const confirmation = interruptPayload('await_confirmation', current, [eligible, rejected], {
      workflow: record,
      installProfiles: ['web'],
    })
    expect(confirmation.options.find((item) => item.id === 'use_this')?.candidateIds)
      .toEqual([record.candidateSnapshot![0]!.id])
    expect(confirmation.options.find((item) => item.id === 'modify_this')?.candidateIds)
      .toEqual([record.candidateSnapshot![0]!.id, record.candidateSnapshot![1]!.id])
  })

  it('keeps an all-failed review batch retryable at confirmation', async () => {
    const current = resolution()
    const host = {
      async reviewGithubBatch() {
        return {
          resolution: current,
          reviews: [],
          failures: [{ repository: 'acme/one', code: 'command_failed', message: 'timed out' }],
        }
      },
    } as unknown as WorkflowHost
    const result = await runNode('review_github', { host, resolution: current })
    expect(result).toMatchObject({
      kind: 'next',
      node: 'await_confirmation',
      reviews: [],
      reviewFailures: [{ repository: 'acme/one', code: 'command_failed' }],
    })
  })

  it('derives local re-review from the lineage tip', async () => {
    const current = resolution()
    current.authorization = { state: 'modify_review', resolutionId: current.id, reason: 'improve' }
    const local = review()
    local.id = `review_${'e'.repeat(64)}`
    local.sourceSnapshot = {
      kind: 'local',
      path: 'C:/workspace/plugin',
      baseReviewId: review().id,
      baseCommit: 'c'.repeat(40),
      statusHash: 'f'.repeat(64),
    }
    const host = {
      async reviewLocal(_resolution: ResolutionRecord, checkout: string, baseReviewId: string) {
        expect(checkout).toBe('C:/workspace/plugin')
        expect(baseReviewId).toBe(review().id)
        return { resolution: current, review: local }
      },
    } as unknown as WorkflowHost
    const result = await runNode('review_local', { host, resolution: current })
    expect(result).toMatchObject({ kind: 'next', node: 'await_confirmation', review: { id: local.id } })
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

  it.each([
    ['receipt identifier', { id: `installation_${'e'.repeat(24)}` }],
    ['workflow', { workflowId: `workflow_${'e'.repeat(24)}` }],
    ['review', { reviewId: `review_${'e'.repeat(64)}` }],
    ['target profile', { targetProfile: 'desktop' }],
    ['retention', { retention: 'temporary' }],
    ['install specification', { installSpec: `github:acme/two#${'e'.repeat(40)}` }],
  ])('rejects a pending installation receipt with a mismatched %s binding', async (_binding, mismatch) => {
    const current = resolution()
    const record = workflow('install_verify')
    const installationId = `installation_${'f'.repeat(24)}`
    record.pendingInstallationId = installationId
    const inspected = review()
    const host = installVerifyHost({
      async installReviewed() {
        throw new Error('must not install when a receipt is present')
      },
      async getInstallation() {
        return {
          id: installationId,
          workflowId: record.id,
          reviewId: inspected.id,
          targetProfile: record.pendingInstall!.targetProfile,
          retention: record.pendingInstall!.retention,
          installSpec: inspected.installSpec,
          ...mismatch,
        }
      },
    })

    await expect(runNode('install_verify', { host, resolution: current, workflow: record }))
      .rejects.toMatchObject({
        code: 'invalid_input',
        message: 'Pending installation receipt is not bound to the current workflow, review, and install target',
      })
  })

  it('accepts a managed-local receipt after materialization changes its install spec', async () => {
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
        return {
          id: installationId,
          workflowId: record.id,
          reviewId: inspected.id,
          targetProfile: record.pendingInstall!.targetProfile,
          retention: record.pendingInstall!.retention,
          installSpec: 'file:C:/workspace/install-artifacts/owned.tgz',
          installed: false,
          verification: { reason: 'installation was interrupted after materialization' },
        }
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

  it.each([
    ['verified', true, true, 'done', 'installed'],
    ['activated', true, false, 'done', 'activated'],
    ['awaiting_user_test', true, false, 'done', 'awaiting_user_test'],
    ['failed_absent', false, false, 'next', 'await_confirmation'],
    ['recovery_required', false, false, 'done', 'recovery_required'],
    ['pending', false, false, 'done', 'recovery_required'],
  ] as const)('routes install outcome %s without misreporting success', async (
    installOutcome,
    installed,
    verified,
    kind,
    node,
  ) => {
    const current = resolution()
    const host = installVerifyHost({
      async installReviewed() {
        return {
          id: `installation_${'a'.repeat(24)}`,
          installOutcome,
          installed,
          verified,
          verification: { reason: installOutcome },
        }
      },
    })
    const result = await runNode('install_verify', { host, resolution: current })
    expect(result).toMatchObject({ kind, node, installation: { installOutcome } })
    if (installOutcome === 'verified') {
      expect(result.node).not.toBe('activated')
      expect(result.node).not.toBe('awaiting_user_test')
    }
    if (installOutcome === 'activated' || installOutcome === 'awaiting_user_test') {
      expect(result.node).not.toBe('installed')
      expect(result.node).not.toBe('recovery_required')
    }
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
      const result = await runNode('install_verify', { host, resolution: current })
      expect(result).toMatchObject({ kind: 'done', node: 'recovery_required' })
    }
  })

  it('routes failed, blocked_precondition, and uncertain verification onto explicit failure closure', async () => {
    const current = resolution()
    for (const status of ['failed', 'blocked_precondition', 'uncertain'] as const) {
      const record = workflow('install_verify')
      const host = installVerifyHost({
        async installReviewed() {
          return {
            id: `installation_${'a'.repeat(24)}`,
            installOutcome: 'recovery_required',
            installed: false,
            verified: false,
            verification: { reason: status, status, layer: 'tool_roundtrip' },
          }
        },
      })
      const result = await runNode('install_verify', { host, resolution: current, workflow: record })
      expect(result).toMatchObject({ kind: 'done', node: 'recovery_required' })
      expect(record.lastFailure).toMatchObject({
        stage: 'verification',
        code: status,
        retryable: false,
      })
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

  it('hides use_this and modify_this after the same failure evidence is closed', () => {
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
    confirmationWorkflow.modificationOutcome = {
      contractVersion: 1,
      policyVersion: POLICY_VERSION,
      baselineReviewId: review().id,
      baselineRuntimeVersion: '0.1.0-rc.6',
      maxAttempts: 2,
      automaticCorrectionUsed: true,
      status: 'unresolved',
      attempts: [{
        attempt: 1,
        childSessionId: 'child-1',
        commit: 'a'.repeat(40),
        changedFiles: [],
        changedFilesTruncated: false,
        postReviewId: review().id,
        completionMarkerObserved: true,
        checks: { source: 'unknown', status: 'unknown', summary: 'unknown' },
      }],
      resolvedBlockers: [],
      unresolvedBlockers: [],
      introducedBlockers: [{ key: 'new', kind: 'security_finding', summary: 'new block' }],
    }
    const confirmationReview = withApprovedVerdict(review(), confirmationWorkflow)
    const confirmation = interruptPayload('await_confirmation', resolution(), [confirmationReview], {
      workflow: confirmationWorkflow,
      installProfiles: ['web'],
    })
    expect(confirmation.options.map((item) => item.id)).toEqual([
      'search_more',
      'create_new',
      'stop',
    ])
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
      async prepareModify() {
        throw new EvolutionError('command_failed', 'explicit source recovery is required', { recoveryRequired: true })
      },
    })
    const result = await runNode('prepare_modify', { host, resolution: current, workflow: record })
    expect(result).toMatchObject({ kind: 'done', node: 'recovery_required' })
  })

  it('requests restart only after a verified install reports incomplete hot-load', async () => {
    const current = resolution()
    const host = installVerifyHost({
      async installReviewed() {
        return {
          id: `installation_${'c'.repeat(24)}`,
          installOutcome: 'verified',
          installed: true,
          verified: true,
          restartRequired: true,
          verification: { reason: 'verified; client restart needed' },
        }
      },
    })
    const result = await runNode('install_verify', { host, resolution: current })
    expect(result).toMatchObject({ kind: 'done', node: 'restart_required' })
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
        return {
          id,
          workflowId: record.id,
          installPhase: 'completed',
          installed: true,
          restartRequired: false,
        }
      },
    } as unknown as WorkflowHost

    const result = await runNode('enable_builtin', { host, resolution: current, workflow: record })

    expect(result).toMatchObject({
      kind: 'done',
      node: 'installed',
      installation: { id: installationId, restartRequired: false },
    })
  })

  it('uses the returned built-in receipt restart flag for a newly completed no-write enablement', async () => {
    const current = resolution()
    const installationId = `installation_${'b'.repeat(24)}`
    const host = {
      async enableBuiltin() {
        return {
          id: installationId,
          installPhase: 'completed',
          installed: true,
          restartRequired: false,
        }
      },
    } as unknown as WorkflowHost

    const result = await runNode('enable_builtin', { host, resolution: current })

    expect(result).toMatchObject({
      kind: 'done',
      node: 'installed',
      installation: { id: installationId, restartRequired: false },
    })
  })

  it('authorizes create-new without a scratch grant node', async () => {
    const current = resolution()
    const result = await runNode('prepare_create', { host: {} as WorkflowHost, resolution: current })
    expect(result).toMatchObject({ kind: 'done', node: 'create_authorized' })
  })

  it('keeps search_more outside the authorization transition table', () => {
    expect(() => transition('await_selection', 'search_more')).toThrow(/cannot resume/i)
    expect(() => transition('await_confirmation', 'search_more')).toThrow(/cannot resume/i)
  })
})
