import { describe, expect, it } from 'vitest'
import { POLICY_VERSION, type ResolutionRecord, type ReviewRecord } from '../../src/contracts.js'
import { githubQueries } from '../../src/discovery/remote.js'
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

describe('GitHub query plan', () => {
  it('uses one dsh-plugin topic query and bounded capability queries', () => {
    const queries = githubQueries('calculator with scientific notation')
    expect(queries[0]).toContain('topic:dsh-plugin')
    expect(queries).toContain('scientific notation dsh')
    expect(queries.length).toBeLessThanOrEqual(5)
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
      ? { authorization: { state: 'review_required' as const, resolutionId: id, reason: 'review candidates' } }
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

describe('resolution authorization state', () => {
  it('maps initial resolution outcomes and fails closed on incomplete discovery', () => {
    const id = resolution().id
    expect(_testing.initialAuthorization(id, 'use_local', true).state).toBe('reuse_required')
    expect(_testing.initialAuthorization(id, 'inspect_remote', true).state).toBe('review_required')
    expect(_testing.initialAuthorization(id, 'inspect_remote', true, 'marketplace-setup').state).toBe('market_required')
    expect(_testing.initialAuthorization(id, 'none', true).state).toBe('scratch_ready')
    expect(_testing.initialAuthorization(id, 'none', false).state).toBe('review_required')
  })

  it('fails closed for legacy resolutions', () => {
    expect(_testing.authorizationForResolution(resolution(1), []).state).toBe('review_required')
  })

  it('prioritizes reuse and modify over incomplete reviews', () => {
    expect(_testing.authorizationForResolution(resolution(), [candidateReview('acme/one', 'use', '1')]).state)
      .toBe('reuse_required')
    expect(_testing.authorizationForResolution(resolution(), [candidateReview('acme/one', 'modify', '2')]).state)
      .toBe('modify_required')
  })

  it('keeps review required while any candidate is unreviewed', () => {
    expect(_testing.authorizationForResolution(resolution(), [candidateReview('acme/one', 'skip', '3')]).state)
      .toBe('review_required')
  })

  it('adopts an explicit GitHub plugin so review can run instead of scratch', () => {
    const record = resolution()
    record.decision = 'none'
    record.remoteCandidates = []
    delete record.remoteCandidateSource
    record.authorization = {
      state: 'scratch_ready',
      resolutionId: record.id,
      reason: 'no candidates',
    }
    const adopted = _testing.adoptGithubCandidate(record, 'toolazytoname/dsh-plugin-grok')
    expect(adopted.candidate.repository).toBe('toolazytoname/dsh-plugin-grok')
    expect(adopted.resolution.decision).toBe('inspect_remote')
    expect(adopted.resolution.authorization?.state).toBe('review_required')
    expect(adopted.resolution.remoteCandidates.map((item) => item.repository)).toEqual(['toolazytoname/dsh-plugin-grok'])
    expect(() => _testing.adoptGithubCandidate(record, 'awesome-dsh-plugin/dsh-find-plugin')).toThrow(/marketplace infrastructure/)
  })

  it('authorizes scratch only after every candidate is rejected', () => {
    expect(_testing.authorizationForResolution(resolution(), [
      candidateReview('acme/one', 'skip', '4'),
      candidateReview('acme/two', 'skip', '5'),
    ]).state).toBe('scratch_ready')
  })

  it('keeps marketplace setup required until the user installs or declines it', () => {
    const record = resolution()
    record.remoteCandidateSource = 'marketplace-setup'
    record.remoteCandidates = [{
      repository: 'awesome-dsh-plugin/dsh-find-plugin',
      name: 'dsh-find-plugin',
      description: 'marketplace',
      stars: 0,
      updatedAt: null,
      topics: ['dsh-plugin'],
    }]
    record.authorization = {
      state: 'market_required',
      resolutionId: record.id,
      reason: 'install marketplace',
    }
    expect(_testing.authorizationForResolution(record, []).state).toBe('market_required')
    expect(_testing.authorizationForResolution(record, [
      candidateReview('awesome-dsh-plugin/dsh-find-plugin', 'use', '6'),
    ]).state).toBe('reuse_required')
    expect(_testing.authorizationForResolution(record, [
      candidateReview('awesome-dsh-plugin/dsh-find-plugin', 'skip', '7'),
    ]).state).toBe('scratch_ready')
  })
})
