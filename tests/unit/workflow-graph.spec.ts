import { describe, expect, it } from 'vitest'
import { POLICY_VERSION, type MechanicalFacts, type ResolutionRecord, type ReviewRecord } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import { reviewCandidateDigest, reviewSnapshotDigest } from '../../src/review/direct-use.js'
import { mintReviewerRequest, requirementHashFor, REVIEWER_VERSION } from '../../src/semantic-reviewer.js'
import { executeNode, interruptPayload, transition } from '../../src/workflow/graph.js'
import type { WorkflowHost, WorkflowRecord } from '../../src/workflow/contracts.js'

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
    const result = await executeNode('ensure_market', {
      host,
      workflow: workflow('ensure_market'),
      exec: {},
      resolution: current,
    })
    expect(result).toMatchObject({ kind: 'done', node: 'market_setup_required' })
  })

  it('routes selection and confirmation options onto the declared nodes', () => {
    expect(transition('await_confirmation', 'use_this')).toBe('install_verify')
    expect(transition('await_confirmation', 'modify_this')).toBe('prepare_modify')
    expect(transition('await_modify_work', 'stop')).toBe('stopped')
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
})

describe('workflow graph nodes', () => {
  it('reviews the selected GitHub repository then parks on confirmation', async () => {
    const current = resolution()
    const inspected = review()
    const host = {
      async reviewGithub(_resolution: ResolutionRecord, repository: string) {
        expect(repository).toBe('acme/one')
        return { resolution: { ...current, authorization: { state: 'confirmation_required', resolutionId: current.id, reason: 'reviewed' } }, review: inspected }
      },
    } as unknown as WorkflowHost
    const result = await executeNode('review_github', {
      host,
      workflow: workflow('review_github'),
      exec: {},
      resolution: current,
    })
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
    const result = await executeNode('review_github', {
      host,
      workflow: workflow('review_github'),
      exec: {},
      resolution: current,
    })
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
    const result = await executeNode('review_local', {
      host,
      workflow: workflow('review_local'),
      exec: {},
      resolution: current,
    })
    expect(result).toMatchObject({ kind: 'next', node: 'await_confirmation', review: { id: local.id } })
  })

  it('returns to confirmation when install fails for a non-input reason', async () => {
    const current = resolution()
    const inspected = review()
    const host = {
      async latestReview() {
        return inspected
      },
      async installReviewed() {
        throw new Error('verify failed')
      },
    } as unknown as WorkflowHost
    const record = workflow('install_verify')
    const result = await executeNode('install_verify', {
      host,
      workflow: record,
      exec: {},
      resolution: current,
    })
    expect(result).toMatchObject({ kind: 'next', node: 'await_confirmation', review: { id: inspected.id } })
    expect(record.lastFailure).toEqual({ code: 'command_failed', message: 'verify failed' })
  })

  it.each([
    ['verified', true, 'done', 'installed'],
    ['failed_absent', false, 'next', 'await_confirmation'],
    ['recovery_required', false, 'done', 'recovery_required'],
    ['pending', false, 'done', 'recovery_required'],
  ] as const)('routes install outcome %s without misreporting success', async (installOutcome, verified, kind, node) => {
    const current = resolution()
    const inspected = review()
    const host = {
      async latestReview() { return inspected },
      async installReviewed() {
        return {
          id: `installation_${'a'.repeat(24)}`,
          installOutcome,
          installed: verified,
          verified,
          verification: { reason: installOutcome },
        }
      },
    } as unknown as WorkflowHost
    const result = await executeNode('install_verify', {
      host,
      workflow: workflow('install_verify'),
      exec: {},
      resolution: current,
    })
    expect(result).toMatchObject({ kind, node, installation: { installOutcome } })
  })

  it('parks cancelled managed work at recovery_required after the Host checkpoints edits', async () => {
    const current = resolution()
    const inspected = review()
    const controller = new AbortController()
    controller.abort()
    const host = {
      async latestReview() { return inspected },
      async prepareModify() {
        throw new EvolutionError('command_failed', 'cancelled and checkpointed', {
          cancelled: true,
          recoveryRequired: true,
          headCommit: 'd'.repeat(40),
        })
      },
    } as unknown as WorkflowHost
    const record = workflow('prepare_modify')
    const result = await executeNode('prepare_modify', {
      host,
      workflow: record,
      exec: { signal: controller.signal },
      resolution: current,
    })
    expect(result).toMatchObject({ kind: 'done', node: 'recovery_required' })
    expect(record.lastFailure).toEqual({ code: 'command_failed', message: 'cancelled and checkpointed' })
  })

  it('keeps a managed modification retryable after a child failure', async () => {
    const current = resolution()
    const inspected = review()
    const record = workflow('prepare_modify')
    const host = {
      async latestReview() { return inspected },
      async prepareModify() {
        throw new Error('child failed after checkpoint')
      },
    } as unknown as WorkflowHost
    const result = await executeNode('prepare_modify', {
      host,
      workflow: record,
      exec: {},
      resolution: current,
    })
    expect(result).toMatchObject({ kind: 'next', node: 'await_confirmation', review: { id: inspected.id } })
    expect(record.lastFailure).toEqual({ code: 'command_failed', message: 'child failed after checkpoint' })
  })

  it('terminates in explicit recovery when failed child edits cannot be checkpointed safely', async () => {
    const current = resolution()
    const inspected = review()
    const record = workflow('prepare_modify')
    const host = {
      async latestReview() { return inspected },
      async prepareModify() {
        throw new EvolutionError('command_failed', 'explicit source recovery is required', { recoveryRequired: true })
      },
    } as unknown as WorkflowHost
    const result = await executeNode('prepare_modify', {
      host,
      workflow: record,
      exec: {},
      resolution: current,
    })
    expect(result).toMatchObject({ kind: 'done', node: 'recovery_required' })
  })

  it('requests restart only after a verified install reports incomplete hot-load', async () => {
    const current = resolution()
    const inspected = review()
    const host = {
      async latestReview() { return inspected },
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
    } as unknown as WorkflowHost
    const result = await executeNode('install_verify', {
      host,
      workflow: workflow('install_verify'),
      exec: {},
      resolution: current,
    })
    expect(result).toMatchObject({ kind: 'done', node: 'restart_required' })
  })

  it('authorizes create-new without a scratch grant node', async () => {
    const current = resolution()
    const result = await executeNode('prepare_create', {
      host: {} as WorkflowHost,
      workflow: workflow('prepare_create'),
      exec: {},
      resolution: current,
    })
    expect(result).toMatchObject({ kind: 'done', node: 'create_authorized' })
  })

  it('keeps search_more outside the authorization transition table', () => {
    expect(() => transition('await_selection', 'search_more')).toThrow(/cannot resume/i)
    expect(() => transition('await_confirmation', 'search_more')).toThrow(/cannot resume/i)
  })
})
