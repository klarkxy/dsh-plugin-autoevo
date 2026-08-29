import { POLICY_VERSION, type ResolutionRecord, type ReviewRecord } from '../../src/contracts.js'

export function testResolution(overrides: Partial<ResolutionRecord> = {}): ResolutionRecord {
  const id = `resolution_${'b'.repeat(24)}`
  return {
    schemaVersion: 2,
    id,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-19T00:00:00.000Z',
    requirement: 'calculator',
    cwd: 'C:/workspace',
    decision: 'inspect_remote',
    localCandidates: [],
    remoteCandidates: [
      { repository: 'acme/one', name: 'one', description: '', stars: 1, updatedAt: null, topics: [] },
    ],
    remoteDiscoveryComplete: true,
    authorization: { state: 'confirmation_required', resolutionId: id, reason: 'wait' },
    selectedRepositories: ['acme/one'],
    queries: [],
    reasons: [],
    ...overrides,
  }
}

export function testReview(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-15T00:00:00.000Z',
    resolutionId: `resolution_${'b'.repeat(24)}`,
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github',
      repository: 'acme/calculator',
      requestedRef: 'main',
      commit: 'c'.repeat(40),
      defaultBranch: 'main',
    },
    inspectedFiles: [{ path: 'package.json', sha256: 'e'.repeat(64), bytes: 8 }],
    manifest: {
      kind: 'bundle',
      packageName: 'dsh-tool-calculator',
      bundlePatch: './cordis.patch.yml',
      scripts: [],
      dependencies: [],
      peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
      expectedTools: ['calculator'],
    },
    fit: 'full',
    confidence: 0.8,
    securityRisk: 'low',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'compatible', reason: 'test', runtimeVersion: '0.1.0-rc.6' },
    missingCapabilities: [],
    findings: [],
    recommendation: 'use',
    installSpec: 'file:C:/workspace/review-artifacts/review-default/package/dsh-tool-calculator.tgz',
    artifact: {
      sha256: 'f'.repeat(64),
      bytes: 8,
      entryCount: 1,
      ownedRoot: 'C:/workspace/review-artifacts/review-default',
    },
    ...overrides,
  }
}
