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

    const task = _testing.modificationTask(record, selected)
    expect(task).toContain(`original capability requirement: ${record.requirement}`)
    expect(task).toContain('Authenticated user modification instruction: 在这个上改：支持勾选多段指定对话，再拼成一张长截图。先不要装。')
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
  record.installSpec = `github:${repository}#${commit}`
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
  it('reviews a third candidate only when the first two have no directly usable result', () => {
    const usable = candidateReview('acme/one', 'use', '1')
    const repairable = candidateReview('acme/two', 'modify', '2')
    const skipped = candidateReview('acme/three', 'skip', '3')
    expect(_testing.shouldReviewAdaptiveThird('adaptive', [usable, repairable])).toBe(false)
    expect(_testing.shouldReviewAdaptiveThird('adaptive', [repairable, skipped])).toBe(true)
    expect(_testing.shouldReviewAdaptiveThird('fixed', [usable])).toBe(true)
  })
})
