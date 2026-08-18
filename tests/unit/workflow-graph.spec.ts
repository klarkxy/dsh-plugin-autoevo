import { describe, expect, it } from 'vitest'
import { POLICY_VERSION, type ResolutionRecord, type ReviewRecord } from '../../src/contracts.js'
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
    manifest: { kind: 'bundle', scripts: [], dependencies: [], peerDependencies: {}, expectedTools: [] },
    fit: 'full',
    confidence: 0.8,
    securityRisk: 'low',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
    missingCapabilities: [],
    findings: [],
    recommendation: 'use',
    installSpec: 'github:acme/one',
  }
}

function workflow(cursor: WorkflowRecord['cursor']): WorkflowRecord {
  return {
    schemaVersion: 1,
    id: `workflow_${'d'.repeat(24)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    requirement: 'calculator',
    resolutionId: resolution().id,
    status: 'running',
    cursor,
    generation: 1,
    pendingRepositories: ['acme/one'],
    lineageTipReviewId: review().id,
    lastReviewId: review().id,
    pendingPath: 'C:/workspace/plugin',
    pendingInstall: { targetProfile: 'web', retention: 'persistent' },
  }
}

describe('workflow graph transitions', () => {
  it('routes selection and confirmation options onto the declared nodes', () => {
    expect(transition('await_selection', 'inspect')).toBe('review_github')
    expect(transition('await_selection', 'search_more')).toBe('discover_remote')
    expect(transition('await_selection', 'create_new')).toBe('prepare_create')
    expect(transition('await_confirmation', 'use_this')).toBe('install_verify')
    expect(transition('await_confirmation', 'modify_this')).toBe('prepare_modify')
    expect(transition('await_confirmation', 'inspect')).toBe('review_github')
    expect(transition('await_modify_work', 'stop')).toBe('stopped')
    expect(() => transition('await_selection', 'use_this')).toThrow(/cannot resume/i)
  })

  it('builds interrupt options from the current facts', () => {
    const selection = interruptPayload('await_selection', resolution())
    expect(selection.options.map((item) => item.id)).toEqual([
      'inspect',
      'search_more',
      'create_new',
      'stop',
    ])
    const confirmation = interruptPayload('await_confirmation', resolution(), review())
    expect(confirmation.options.map((item) => item.id)).toContain('use_this')
    expect(confirmation.options.map((item) => item.id)).toContain('modify_this')
    const modify = interruptPayload('await_modify_work', resolution(), review())
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

  it('loops search_more back through remote discovery', async () => {
    expect(transition('await_selection', 'search_more')).toBe('discover_remote')
    expect(transition('await_confirmation', 'search_more')).toBe('discover_remote')
  })
})
