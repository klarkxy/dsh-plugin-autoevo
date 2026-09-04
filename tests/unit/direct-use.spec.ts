import { describe, expect, it } from 'vitest'
import { testResolution } from '../helpers/records.js'
import { POLICY_VERSION, type ResolutionRecord, type ReviewRecord } from '../../src/contracts.js'
import {
  assertDirectUseAllowed,
  hostDirectUseBoundary,
  isDirectlyUsableReview,
  isManagedModificationEligibleReview,
  reviewCandidateDigest,
} from '../../src/review/direct-use.js'
import { evaluatePluginContent, requiresSemanticContext } from '../../src/review/review.js'
import { reviewIdentity } from '../../src/lifecycle/decide.js'
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
    inspectedFiles: [{ path: 'package.json', sha256: 'e'.repeat(64), bytes: 8 }],
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
    installSpec: 'file:C:/workspace/review-artifacts/review-one/package/dsh-one.tgz',
    artifact: {
      sha256: 'f'.repeat(64),
      bytes: 8,
      entryCount: 1,
      ownedRoot: 'C:/workspace/review-artifacts/review-one',
    },
    ...overrides,
  }
}

function confirmationIds(review: ReviewRecord, workflow: WorkflowRecord): string[] {
  return optionsFor('await_confirmation', resolution(), [review], workflow, ['web']).map((item) => item.id)
}

describe('direct use eligibility', () => {
  it('binds sibling packages in one repository to their own candidate digest', () => {
    const review = githubReview({ sourceSnapshot: {
      kind: 'github', repository: 'acme/collection', requestedRef: COMMIT,
      commit: COMMIT, defaultBranch: 'main', packagePath: 'packages/one',
    } })
    const workflow = workflowFor(review)
    workflow.candidateSnapshot = [
      { id: 'candidate_one', index: 1, kind: 'remote', name: 'one', identity: 'one', repository: 'acme/collection', commit: COMMIT, packagePath: 'packages/one', digest: '1'.repeat(64) },
      { id: 'candidate_two', index: 2, kind: 'remote', name: 'two', identity: 'two', repository: 'acme/collection', commit: COMMIT, packagePath: 'packages/two', digest: '2'.repeat(64) },
    ]
    expect(reviewCandidateDigest(review, workflow)).toBe('1'.repeat(64))
  })

  it('lets a low-risk full compatible review expose use_this', () => {
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
      expect(() => assertDirectUseAllowed(review)).not.toThrow()
    }
  })

  it('keeps explicit incompatibility advisory and offers both use and modify', () => {
    const review = githubReview({
      compatibility: { status: 'incompatible', reason: 'peer excludes runtime', runtimeVersion: '0.1.0-rc.7' },
      recommendation: 'modify',
    })
    const workflow = workflowFor(review)
    expect(hostDirectUseBoundary(review)).toBeUndefined()
    expect(isDirectlyUsableReview(review, workflow)).toBe(true)
    expect(confirmationIds(review, workflow)).toEqual(expect.arrayContaining(['use_this', 'modify_this', 'stop']))
    expect(() => assertDirectUseAllowed(review)).not.toThrow()
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
      expect(() => assertDirectUseAllowed(review)).toThrow(/cannot authorize installation|does not authorize installation/i)
    }
  })

  it('default-denies semantically corrupt effect-authority review fields', () => {
    const opaque = githubReview() as unknown as Record<string, unknown>
    opaque.sourceSnapshot = {
      ...(opaque.sourceSnapshot as Record<string, unknown>),
      kind: 'opaque',
    }
    const stringFalse = githubReview({
      mechanicalFacts: {
        fit: 'full',
        missingCapabilities: [],
        staticRisk: 'low',
        compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: null },
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
      },
    }) as unknown as Record<string, unknown>
    stringFalse.mechanicalFacts = {
      ...(stringFalse.mechanicalFacts as Record<string, unknown>),
      manifest: {
        ...((stringFalse.mechanicalFacts as Record<string, unknown>).manifest as Record<string, unknown>),
        materializable: 'false',
      },
    }
    const unsupportedSchema = { ...githubReview(), schemaVersion: 2 } as unknown as ReviewRecord

    for (const corrupt of [opaque, stringFalse, unsupportedSchema] as unknown as ReviewRecord[]) {
      const workflow = workflowFor(corrupt)
      expect(isDirectlyUsableReview(corrupt, workflow)).toBe(false)
      expect(isManagedModificationEligibleReview(corrupt)).toBe(false)
      expect(confirmationIds(corrupt, workflow)).not.toEqual(expect.arrayContaining(['use_this', 'modify_this']))
      expect(() => assertDirectUseAllowed(corrupt)).toThrow(/does not authorize installation/i)
    }
    expect(() => reviewIdentity(opaque as unknown as ReviewRecord)).toThrow(/source identity is malformed/i)
  })

  it('offers managed modification only from a complete current-policy baseline', () => {
    const complete = githubReview({ recommendation: 'modify', installSpec: null })
    const truncated = githubReview({
      recommendation: 'modify',
      installSpec: null,
      findings: [{ code: 'review_truncated', severity: 'warning', source: 'repository', detail: 'limit' }],
    })
    expect(isManagedModificationEligibleReview(complete)).toBe(true)
    expect(confirmationIds(complete, workflowFor(complete))).toContain('modify_this')
    expect(isManagedModificationEligibleReview(truncated)).toBe(false)
    expect(confirmationIds(truncated, workflowFor(truncated))).not.toContain('modify_this')
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
    record.installSpec = 'file:C:/workspace/review-artifacts/process/package/dsh-one.tgz'
    record.artifact = { sha256: 'f'.repeat(64), bytes: 100, entryCount: record.inspectedFiles.length, ownedRoot: 'C:/workspace/review-artifacts/process' }
    expect(record.findings.map((item) => item.code)).toEqual(expect.arrayContaining(['process_execution']))
    expect(record.findings.some((item) => item.code === 'prompt_injection')).toBe(false)
    expect(record.securityRisk).toBe('medium')
    expect(hostDirectUseBoundary(record)).toBeUndefined()
    expect(() => assertDirectUseAllowed(record)).not.toThrow()

    const workflow = workflowFor(record)
    expect(confirmationIds(record, workflow)).toContain('use_this')
  })

  it('marks credential-access findings as requiring semantic context', () => {
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
    expect(requiresSemanticContext(record)).toBe(true)
  })
})
