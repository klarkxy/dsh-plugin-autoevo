import { describe, expect, it } from 'vitest'
import type { ReviewRecord } from '../../src/contracts.js'
import { _testing } from '../../src/service.js'
import { hashObject } from '../../src/state/hashes.js'

function review(requestedRef: string): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: 'v1-2026-08-15',
    createdAt: '2026-08-15T00:00:00.000Z',
    resolutionId: `resolution_${'b'.repeat(24)}`,
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github', repository: 'acme/calculator', requestedRef, commit: 'c'.repeat(40), defaultBranch: 'main',
    },
    inspectedFiles: [{ path: 'package.json', blobId: 'd'.repeat(40), sha256: 'e'.repeat(64), bytes: 10 }],
    manifest: { kind: 'bundle', scripts: [], dependencies: [], peerDependencies: {}, expectedTools: ['calculator'] },
    fit: 'full', confidence: 0.8, securityRisk: 'low', maintained: true, license: 'MIT',
    compatibility: { status: 'compatible', reason: 'test' }, missingCapabilities: [], findings: [], recommendation: 'use',
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
    const queries = _testing.githubQueries('calculator with scientific notation')
    expect(queries[0]).toContain('topic:dsh-plugin')
    expect(queries).toContain('scientific notation dsh')
    expect(queries.length).toBeLessThanOrEqual(5)
  })
})
