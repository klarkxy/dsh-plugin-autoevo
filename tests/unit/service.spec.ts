import { describe, expect, it } from 'vitest'
import { POLICY_VERSION, type ResolutionRecord, type ReviewRecord } from '../../src/contracts.js'
import { _testing } from '../../src/service.js'
import { hashObject } from '../../src/state/hashes.js'

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
    remoteCandidateSource: 'dsh-find-plugin',
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
  record.id = `review_${suffix.repeat(64)}`
  record.resolutionId = resolution().id
  record.policyVersion = POLICY_VERSION
  record.sourceSnapshot = {
    kind: 'github', repository, requestedRef: 'main', commit: suffix.repeat(40), defaultBranch: 'main',
  }
  record.recommendation = recommendation
  record.fit = recommendation === 'use' ? 'full' : recommendation === 'modify' ? 'partial' : 'none'
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
    expect(_testing.waitingAuthorization(id, 'inspect_remote', true, 'marketplace-setup').state).toBe('market_required')
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
    const added = _testing.addExplicitCandidate(record, 'toolazytoname/dsh-plugin-grok')
    expect(added.candidate.repository).toBe('toolazytoname/dsh-plugin-grok')
    expect(added.resolution.remoteCandidates.map((item) => item.repository)).toEqual(['toolazytoname/dsh-plugin-grok'])
    expect(added.resolution.authorization?.state).toBe('selection_required')
    expect(() => _testing.addExplicitCandidate(record, 'awesome-dsh-plugin/dsh-find-plugin')).toThrow(/marketplace infrastructure/)
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
