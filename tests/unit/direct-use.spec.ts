import { describe, expect, it } from 'vitest'
import { testResolution } from '../helpers/records.js'
import { POLICY_VERSION, type ResolutionRecord, type ReviewRecord, type ReviewerVerdictDecision } from '../../src/contracts.js'
import {
  assertDirectUseAllowed,
  hostDirectUseBoundary,
  isDirectlyUsableReview,
  reviewCandidateDigest,
  reviewSnapshotDigest,
} from '../../src/review/direct-use.js'
import { evaluatePluginContent, needsSemanticReviewer } from '../../src/review/review.js'
import { mintReviewerRequest, requirementHashFor, REVIEWER_VERSION } from '../../src/semantic-reviewer.js'
import { _testing as serviceTesting } from '../../src/service.js'
import { optionsFor, type WorkflowRecord } from '../../src/workflow/contracts.js'

const COMMIT = 'c'.repeat(40)
const loaderPatch = '- insert:\n    - id: calculator\n      name: calculator\n'

function resolution(): ResolutionRecord {
  return testResolution()
}

function workflowFor(review: ReviewRecord): WorkflowRecord {
  const candidateId = `candidate_${'e'.repeat(24)}`
  return {
    schemaVersion: 2,
    id: `workflow_${'d'.repeat(24)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    requirement: review.requirement,
    status: 'interrupted',
    cursor: 'await_confirmation',
    generation: 1,
    candidateSnapshot: review.sourceSnapshot.kind === 'github'
      ? [{
          id: candidateId,
          index: 1,
          kind: 'remote',
          name: 'one',
          identity: review.sourceSnapshot.repository,
          repository: review.sourceSnapshot.repository,
          digest: 'f'.repeat(64),
        }]
      : [],
    reviewedCandidateIds: [candidateId],
    reviewIdsByCandidate: { [candidateId]: review.id },
    lastReviewId: review.id,
  }
}

function githubReview(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-19T00:00:00.000Z',
    resolutionId: resolution().id,
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github',
      repository: 'acme/one',
      requestedRef: 'main',
      commit: COMMIT,
      defaultBranch: 'main',
    },
    inspectedFiles: [],
    manifest: {
      kind: 'bundle',
      packageName: 'dsh-one',
      scripts: [],
      dependencies: [],
      peerDependencies: {},
      expectedTools: ['calculator'],
    },
    fit: 'full',
    confidence: 0.8,
    securityRisk: 'low',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
    missingCapabilities: [],
    findings: [],
    recommendation: 'use',
    installSpec: `github:acme/one#${COMMIT}`,
    ...overrides,
  }
}

function bindVerdict(
  review: ReviewRecord,
  decision: ReviewerVerdictDecision,
  workflow?: WorkflowRecord,
  overrides: Partial<ReviewRecord['reviewerVerdict']> = {},
): ReviewRecord {
  const snapshotDigest = reviewSnapshotDigest(review)
  const candidateDigest = reviewCandidateDigest(review, workflow)
  const request = mintReviewerRequest({
    workflowId: workflow?.id ?? `workflow_${'d'.repeat(24)}`,
    review,
    snapshotDigest,
    candidateDigest,
    createdAt: '2026-08-19T00:00:02.000Z',
  })
  const completed = { ...request, status: 'completed' as const, completedAt: '2026-08-19T00:00:03.000Z' }
  return {
    ...review,
    reviewerRequestId: completed.id,
    reviewerRequest: completed,
    reviewerVerdict: {
      requestId: completed.id,
      reviewId: review.id,
      requirementHash: requirementHashFor(review.requirement),
      snapshotDigest,
      candidateDigest,
      reviewerSessionId: 'reviewer-session',
      reviewerVersion: REVIEWER_VERSION,
      decision,
      evidence: [],
      conditions: [],
      semanticCoverage: 'partial',
      createdAt: '2026-08-19T00:00:03.000Z',
      ...overrides,
    },
  }
}

function confirmationIds(review: ReviewRecord, workflow: WorkflowRecord): string[] {
  return optionsFor('await_confirmation', resolution(), [review], workflow, ['web']).map((item) => item.id)
}

describe('direct use eligibility', () => {
  it('lets a low-risk full compatible review expose use_this without a reviewer verdict', () => {
    const review = githubReview()
    const workflow = workflowFor(review)
    expect(isDirectlyUsableReview(review, workflow)).toBe(true)
    expect(confirmationIds(review, workflow)[0]).toBe('use_this')
    expect(confirmationIds(review, workflow)).toEqual([
      'use_this', 'search_more', 'modify_this', 'create_new', 'stop',
    ])
  })

  it('keeps fit, compatibility uncertainty, and high-risk findings advisory for a mechanically installable review', () => {
    const partial = githubReview({
      fit: 'partial',
      recommendation: 'modify',
      missingCapabilities: ['scientific notation'],
    })
    const unknown = githubReview({
      compatibility: { status: 'unknown', reason: 'no runtime', runtimeVersion: null },
      recommendation: 'modify',
    })
    const high = githubReview({
      securityRisk: 'high',
      recommendation: 'modify',
      findings: [{ code: 'process_execution', severity: 'block', source: 'src/run.ts', detail: 'spawn' }],
    })
    const noFit = githubReview({ fit: 'none', recommendation: 'skip' })

    for (const review of [partial, unknown, high, noFit]) {
      const workflow = workflowFor(review)
      expect(hostDirectUseBoundary(review)).toBeUndefined()
      expect(isDirectlyUsableReview(review, workflow)).toBe(true)
      expect(confirmationIds(review, workflow)).toContain('use_this')
      expect(() => assertDirectUseAllowed(review, workflow)).not.toThrow()
    }
  })

  it('preserves missing, rejected, uncertain, stale, and wrong-bound semantic verdicts without turning them into Host blocks', () => {
    const base = githubReview({
      securityRisk: 'high',
      recommendation: 'modify',
      findings: [{ code: 'dynamic_evaluation', severity: 'block', source: 'src/run.ts', detail: 'eval' }],
    })
    const workflow = workflowFor(base)
    const missing = base
    const rejected = bindVerdict(base, 'rejected', workflow)
    const uncertain = bindVerdict(base, 'uncertain', workflow)
    const stale = bindVerdict(base, 'approved', workflow, { snapshotDigest: '9'.repeat(64) })
    const wrongBound = bindVerdict(base, 'approved', workflow, { reviewId: `review_${'f'.repeat(64)}` })
    const wrongRequest = bindVerdict(base, 'approved', workflow, { requestId: `reviewer_${'0'.repeat(24)}` })
    const wrongRequirement = bindVerdict(base, 'approved', workflow, { requirementHash: '8'.repeat(64) })
    const wrongCandidate = bindVerdict(base, 'approved', workflow, { candidateDigest: '7'.repeat(64) })
    const wrongVersion = bindVerdict(base, 'approved', workflow, { reviewerVersion: '0' })
    const wrongSession = bindVerdict(base, 'approved', workflow, { reviewerSessionId: '' })

    for (const review of [missing, rejected, uncertain, stale, wrongBound, wrongRequest, wrongRequirement, wrongCandidate, wrongVersion, wrongSession]) {
      expect(isDirectlyUsableReview(review, workflow)).toBe(true)
      expect(confirmationIds(review, workflow)).toContain('use_this')
      expect(() => assertDirectUseAllowed(review, workflow)).not.toThrow()
    }
  })

  it('keeps explicit incompatibility advisory and offers both use and modify', () => {
    const review = bindVerdict(githubReview({
      compatibility: { status: 'incompatible', reason: 'peer excludes runtime', runtimeVersion: '0.1.0-rc.7' },
      recommendation: 'modify',
    }), 'approved', workflowFor(githubReview()))
    const workflow = workflowFor(review)
    const bound = bindVerdict(review, 'approved', workflow)
    expect(hostDirectUseBoundary(bound)).toBeUndefined()
    expect(isDirectlyUsableReview(bound, workflow)).toBe(true)
    expect(confirmationIds(bound, workflow)).toEqual(expect.arrayContaining(['use_this', 'modify_this', 'stop']))
    expect(() => assertDirectUseAllowed(bound, workflow)).not.toThrow()
  })

  it('continues to reject mechanical policy, install-spec, and materialization failures', () => {
    const wrongPolicy = githubReview({ policyVersion: `stale-${POLICY_VERSION}` })
    const wrongInstallSpec = githubReview({ installSpec: 'github:example/tool#different' })
    const notMaterializable = githubReview({
      mechanicalFacts: {
        fit: 'full',
        missingCapabilities: [],
        staticRisk: 'low',
        compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: null },
        manifest: { kind: 'unknown', materializable: false, installSpec: null },
        truncated: false,
        findings: [],
        evidenceHashes: [],
        semanticContextRequired: false,
      },
    })

    for (const review of [wrongPolicy, wrongInstallSpec, notMaterializable]) {
      expect(isDirectlyUsableReview(review, workflowFor(review))).toBe(false)
      expect(() => assertDirectUseAllowed(review, workflowFor(review))).toThrow(/cannot authorize installation|does not authorize installation/i)
    }
  })

  it('does not treat prompt-injection regex or static high risk as mechanical install blockers', () => {
    const record = evaluatePluginContent({
      resolutionId: resolution().id,
      runtimeVersion: '0.1.0-rc.6',
      requirement: 'calculator',
      sourceSnapshot: {
        kind: 'github',
        repository: 'acme/one',
        requestedRef: 'main',
        commit: COMMIT,
        defaultBranch: 'main',
      },
      files: [
        { path: 'package.json', content: Buffer.from(JSON.stringify({
          name: 'dsh-one',
          license: 'MIT',
          dsh: { bundle: { patch: './cordis.patch.yml', tools: ['calculator'] } },
          peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
        })) },
        { path: 'cordis.patch.yml', content: Buffer.from(loaderPatch) },
        { path: 'README.md', content: Buffer.from('A calculator plugin.') },
        { path: 'src/run.ts', content: Buffer.from("import { spawn } from 'node:child_process'\nspawn('echo')") },
      ],
    })
    expect(record.findings.map((item) => item.code)).toEqual(expect.arrayContaining(['process_execution']))
    expect(record.findings.some((item) => item.code === 'prompt_injection')).toBe(false)
    expect(record.securityRisk).toBe('medium')
    expect(hostDirectUseBoundary(record)).toBeUndefined()
    expect(() => assertDirectUseAllowed(record)).not.toThrow()

    const workflow = workflowFor(record)
    expect(confirmationIds(record, workflow)).toContain('use_this')
  })

  it('gates credential-access findings behind the semantic reviewer', () => {
    const record = evaluatePluginContent({
      resolutionId: resolution().id,
      runtimeVersion: '0.1.0-rc.6',
      requirement: 'calculator',
      sourceSnapshot: {
        kind: 'github',
        repository: 'acme/one',
        requestedRef: 'main',
        commit: COMMIT,
        defaultBranch: 'main',
      },
      files: [
        { path: 'package.json', content: Buffer.from(JSON.stringify({
          name: 'dsh-one',
          license: 'MIT',
          dsh: { bundle: { patch: './cordis.patch.yml', tools: ['calculator'] } },
          peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
        })) },
        { path: 'cordis.patch.yml', content: Buffer.from(loaderPatch) },
        { path: 'src/run.ts', content: Buffer.from("const all = Object.keys(process.env)\nexport default all") },
      ],
    })
    expect(record.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'credential_access', severity: 'block' }),
    ]))
    expect(record.mechanicalFacts?.semanticContextRequired).toBe(true)
    expect(needsSemanticReviewer(record)).toBe(true)
  })

  it('does not let a reviewer verdict mint authorization, commitment, or a user decision', () => {
    const review = bindVerdict(githubReview({
      securityRisk: 'high',
      recommendation: 'modify',
    }), 'approved', workflowFor(githubReview()))
    const record = resolution()
    expect(serviceTesting.authorizationForResolution(record, [review]).state).toBe('confirmation_required')
    expect(review.reviewerVerdict).not.toHaveProperty('authorization')
    expect(review.reviewerVerdict).not.toHaveProperty('actionCommitment')
    expect(review.reviewerVerdict).not.toHaveProperty('executionLease')
    expect(review.reviewerVerdict).not.toHaveProperty('selectionReceipt')
    expect(review.reviewerVerdict).not.toHaveProperty('installSpec')
    expect(record.decisions ?? []).toEqual([])
  })
})
