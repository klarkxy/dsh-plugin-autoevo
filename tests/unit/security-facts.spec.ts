import { describe, expect, it } from 'vitest'
import type { ResolutionRecord, ReviewRecord } from '../../src/contracts.js'
import { evaluatePluginContent, needsSemanticReviewer } from '../../src/review/review.js'
import { confirmationFacts, securityFindingFacts } from '../../src/workflow/contracts.js'

describe('security finding presentation', () => {
  const duplicateProcessFindings = [
    {
      code: 'process_execution',
      severity: 'block' as const,
      source: 'src/bin.ts',
      detail: 'invokes an imported process execution API',
      evidenceHash: 'a'.repeat(64),
    },
    {
      code: 'process_execution',
      severity: 'block' as const,
      source: 'lib/bin.js',
      detail: 'invokes an imported process execution API',
      evidenceHash: 'b'.repeat(64),
    },
  ]

  it('groups duplicate source/build observations without weakening severity', () => {
    expect(securityFindingFacts(duplicateProcessFindings)).toEqual([{
      code: 'process_execution',
      severity: 'block',
      detail: 'invokes an imported process execution API',
      sources: ['lib/bin.js', 'src/bin.ts'],
      evidenceHashes: ['a'.repeat(64), 'b'.repeat(64)],
      evidenceKind: 'static_review',
      observed: true,
      notEstablished: ['command target', 'purpose', 'necessity', 'runtime execution', 'callback server behavior'],
    }])
  })

  it('tells the Agent that detector output does not establish semantic purpose', () => {
    const review = {
      id: `review_${'a'.repeat(64)}`,
      fit: 'full',
      securityRisk: 'high',
      recommendation: 'modify',
      missingCapabilities: [],
      findings: duplicateProcessFindings,
      sourceSnapshot: { kind: 'github', repository: 'anonymous-lab/dsh-plugin-alpha', requestedRef: 'HEAD', commit: 'a'.repeat(40), defaultBranch: 'main' },
      compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
      installSpec: null,
      license: 'Apache-2.0',
    } as unknown as ReviewRecord
    const facts = confirmationFacts({
      localCandidates: [],
      remoteCandidates: [],
      selectedRepositories: ['anonymous-lab/dsh-plugin-alpha'],
    } as unknown as ResolutionRecord, [review])
    expect(facts.findings).toEqual(securityFindingFacts(duplicateProcessFindings).slice(0, 1))
    expect(facts.findingDetails).toEqual(securityFindingFacts(duplicateProcessFindings))
    expect(facts.canInstall).toBe(false)
    expect(facts.securityInterpretationRule).toMatch(/static review observations only/i)
    expect(facts.securityInterpretationRule).toMatch(/Never invent a justification/i)
  })

  it('only requires a semantic reviewer for executable eval or injection findings', () => {
    const spawn = {
      fit: 'full' as const,
      securityRisk: 'medium' as const,
      compatibility: { status: 'compatible' as const, reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
      findings: [{ code: 'process_execution', severity: 'warning' as const, source: 'src/bin.ts', detail: 'spawn' }],
    }
    const none = {
      fit: 'none' as const,
      securityRisk: 'low' as const,
      compatibility: { status: 'compatible' as const, reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
      findings: [],
    }
    const unknown = {
      fit: 'full' as const,
      securityRisk: 'low' as const,
      compatibility: { status: 'unknown' as const, reason: 'no runtime', runtimeVersion: null },
      findings: [],
    }
    const evalHit = {
      fit: 'full' as const,
      securityRisk: 'high' as const,
      compatibility: { status: 'compatible' as const, reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
      findings: [{ code: 'dynamic_evaluation', severity: 'block' as const, source: 'src/index.ts', detail: 'eval' }],
    }
    expect(needsSemanticReviewer(spawn)).toBe(false)
    expect(needsSemanticReviewer(none)).toBe(false)
    expect(needsSemanticReviewer(unknown)).toBe(false)
    expect(needsSemanticReviewer(evalHit)).toBe(true)
  })

  it('does not require a semantic reviewer for low, full, compatible facts', () => {
    expect(needsSemanticReviewer({
      fit: 'full',
      securityRisk: 'low',
      compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
      findings: [],
    })).toBe(false)
  })

  it('keeps incompatible materializable facts advisory', () => {
    const record = evaluatePluginContent({
      resolutionId: 'resolution_0123456789abcdef',
      runtimeVersion: '0.1.0-rc.7',
      requirement: 'calculator',
      sourceSnapshot: {
        kind: 'github',
        repository: 'acme/calculator',
        requestedRef: 'main',
        commit: 'a'.repeat(40),
        defaultBranch: 'main',
      },
      files: [
        { path: 'package.json', content: Buffer.from(JSON.stringify({
          name: '@acme/calculator',
          license: 'MIT',
          dsh: { bundle: { patch: './cordis.patch.yml', tools: ['calculator'] } },
          peerDependencies: { '@deepseek-ai/dsh-tools': '=0.1.0-rc.6' },
        })) },
        { path: 'cordis.patch.yml', content: Buffer.from('- insert:\n    - id: calculator\n      name: calculator\n') },
      ],
    })
    expect(record.compatibility.status).toBe('incompatible')
    expect(record.installSpec).toBe(`github:acme/calculator#${'a'.repeat(40)}`)
    expect(record.mechanicalFacts?.directUseHostBoundary).toBeUndefined()
    expect(needsSemanticReviewer(record)).toBe(false)
  })
})
