import { describe, expect, it } from 'vitest'
import type { ResolutionRecord, ReviewRecord } from '../../src/contracts.js'
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

})
