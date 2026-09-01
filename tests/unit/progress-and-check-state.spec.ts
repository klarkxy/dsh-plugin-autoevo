import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { testResolution } from '../helpers/records.js'
import { rememberRequirementLanguage, _testing as i18nTesting } from '../../src/i18n.js'
import { POLICY_VERSION, type ResolutionRecord, type ReviewRecord } from '../../src/contracts.js'
import { AUTOEVO_AUTONOMY_CONTRACT } from '../../src/evolution-mode.js'
import { isDirectlyUsableReview } from '../../src/review/direct-use.js'
import { _testing as serviceTesting } from '../../src/service.js'
import type { CapabilityEvolutionService } from '../../src/service.js'
import { createTools, _testing as toolsTesting } from '../../src/tools.js'
import {
  confirmationFacts,
  optionsFor,
  type ModificationCheckEvidence,
  type WorkflowRecord,
} from '../../src/workflow/contracts.js'

const COMMIT = 'c'.repeat(40)
const WORKFLOW_ID = 'workflow_9c79a3d3f76bb689ceec218f'
const INTERRUPT_ID = 'interrupt_fcce9d43-99f0-4a0b-a015-6fc4fd519bf2'
const CANDIDATE_ID = 'candidate_secret_repo_identity'
const INSTALLATION_ID = 'installation_secret_receipt'

afterEach(() => {
  i18nTesting.clearLanguageCache()
})

function tool(name: string) {
  const found = createTools({} as CapabilityEvolutionService).find((item) => item.name === name)
  expect(found?.presentCall).toEqual(expect.any(Function))
  return found!
}

function presented(name: string, args: Record<string, unknown>) {
  const view = tool(name).presentCall!(args)
  expect(view).toEqual(expect.objectContaining({ card: 'generic', title: expect.any(String) }))
  return view!
}

function githubReview(): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-21T18:20:00.000Z',
    resolutionId: `resolution_${'b'.repeat(24)}`,
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
    installSpec: 'file:C:/workspace/review-artifacts/progress/package/dsh-one.tgz',
    artifact: { sha256: 'f'.repeat(64), bytes: 8, entryCount: 1, ownedRoot: 'C:/workspace/review-artifacts/progress' },
  }
}

function resolution(): ResolutionRecord {
  return testResolution({ createdAt: '2026-08-21T18:20:00.000Z' })
}

function workflowFor(review: ReviewRecord, checks: ModificationCheckEvidence): WorkflowRecord {
  return {
    schemaVersion: 2,
    id: `workflow_${'d'.repeat(24)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-21T18:20:00.000Z',
    updatedAt: '2026-08-21T18:20:00.000Z',
    requirement: review.requirement,
    status: 'interrupted',
    cursor: 'await_confirmation',
    generation: 1,
    candidateSnapshot: [{
      id: CANDIDATE_ID,
      index: 1,
      kind: 'remote',
      name: 'one',
      identity: 'acme/one',
      repository: 'acme/one',
      digest: 'f'.repeat(64),
    }],
    reviewedCandidateIds: [CANDIDATE_ID],
    reviewIdsByCandidate: { [CANDIDATE_ID]: review.id },
    lastReviewId: review.id,
    modificationOutcome: {
      contractVersion: 1,
      policyVersion: POLICY_VERSION,
      baselineReviewId: review.id,
      baselineRuntimeVersion: '0.1.0-rc.6',
      maxAttempts: 2,
      automaticCorrectionUsed: false,
      status: 'resolved',
      attempts: [{
        attempt: 1,
        childSessionId: 'child-session-secret',
        commit: COMMIT,
        changedFiles: ['src/index.ts'],
        changedFilesTruncated: false,
        postReviewId: review.id,
        completionMarkerObserved: true,
        checks,
      }],
      resolvedBlockers: [],
      unresolvedBlockers: [],
      introducedBlockers: [],
    },
  }
}

describe('child check classification', () => {
  const unavailableReport = [
    'npm test failed because vitest was unavailable',
    'npm run typecheck failed because tsc was unavailable',
    'node --check lib/index.js passed',
    'AUTOEVO_CHILD_COMPLETED',
  ].join('\n')

  it('does not classify missing vitest/tsc as a test assertion failure', () => {
    const evidence = serviceTesting.childCheckEvidence(unavailableReport)
    expect(evidence).toMatchObject({
      source: 'child_reported',
      status: 'unavailable',
    })
    expect(evidence.status).not.toBe('failed')
    expect(evidence.summary).toMatch(/could not run because the local toolchain was unavailable/i)
    expect(evidence.summary).toMatch(/plugin is not verified/i)
    expect(evidence.summary).not.toMatch(/tests failed/i)
  })

  it('classifies mixed genuine assertion failure over a missing sibling tool as failed', () => {
    const evidence = serviceTesting.childCheckEvidence(
      'Tests failed: expected 2 to be 3. Typecheck could not run because tsc is not recognized.\nAUTOEVO_CHILD_COMPLETED',
    )
    expect(evidence).toEqual({
      source: 'child_reported',
      status: 'failed',
      summary: 'The managed child reported that tests failed; Host did not independently observe the command result.',
    })
    expect(evidence.status).not.toBe('unavailable')
    expect(evidence.summary).not.toMatch(/toolchain was unavailable/i)
  })

  it('keeps command failures caused only by missing executables as unavailable', () => {
    const evidence = serviceTesting.childCheckEvidence(
      'npm test failed because vitest is not recognized; typecheck failed because tsc unavailable.\nAUTOEVO_CHILD_COMPLETED',
    )
    expect(evidence).toMatchObject({
      source: 'child_reported',
      status: 'unavailable',
    })
    expect(evidence.status).not.toBe('failed')
    expect(evidence.summary).toMatch(/could not run because the local toolchain was unavailable/i)
    expect(evidence.summary).not.toMatch(/tests failed/i)
  })

  it('keeps genuine assertion failures, pass, skipped, and unknown stable', () => {
    expect(serviceTesting.childCheckEvidence('Tests failed: expected 2 to be 3.\nAUTOEVO_CHILD_COMPLETED')).toEqual({
      source: 'child_reported',
      status: 'failed',
      summary: 'The managed child reported that tests failed; Host did not independently observe the command result.',
    })
    expect(serviceTesting.childCheckEvidence('The test run failed with 2 failing assertions.\nAUTOEVO_CHILD_COMPLETED')).toMatchObject({
      source: 'child_reported',
      status: 'failed',
    })
    expect(serviceTesting.childCheckEvidence('Tests passed.\nAUTOEVO_CHILD_COMPLETED')).toEqual({
      source: 'child_reported',
      status: 'passed',
      summary: 'The managed child reported that tests passed; Host did not independently observe the command result.',
    })
    expect(serviceTesting.childCheckEvidence('Tests were not run.\nAUTOEVO_CHILD_COMPLETED')).toEqual({
      source: 'child_reported',
      status: 'skipped',
      summary: 'The managed child reported that tests were skipped.',
    })
    expect(serviceTesting.childCheckEvidence('Implemented OAuth login and committed the change.\nAUTOEVO_CHILD_COMPLETED')).toEqual({
      source: 'unknown',
      status: 'unknown',
      summary: 'Host did not independently observe a test command result.',
    })
  })
})

describe('tool pending presentation', () => {
  it('maps long actions to sanitized generic titles', () => {
    expect(presented('capability_workflow', {
      requirement: 'secret calculator for acme/one',
      intent: { operation: 'discover_or_reuse', required_surface: 'any' },
    })).toMatchObject({
      card: 'generic',
      kind: 'search',
      title: 'Searching for reusable plugins',
    })
    expect(presented('capability_workflow_refine', { workflow_id: WORKFLOW_ID })).toMatchObject({
      card: 'generic',
      kind: 'search',
      title: 'Refining plugin discovery',
    })
    expect(presented('capability_workflow_present', {
      workflow_id: WORKFLOW_ID,
      candidate_ids: [CANDIDATE_ID],
    }).title).toMatch(/candidate shortlist/i)
    expect(presented('capability_workflow_resume', {
      workflow_id: WORKFLOW_ID,
      interrupt_id: INTERRUPT_ID,
      navigation: { kind: 'search_more' },
    }).title).toMatch(/searching for more/i)
    expect(presented('capability_workflow_resume', {
      workflow_id: WORKFLOW_ID,
      interrupt_id: INTERRUPT_ID,
      navigation: { kind: 'review_candidates', candidate_ids: [CANDIDATE_ID] },
    })).toMatchObject({
      card: 'generic',
      kind: 'read',
      title: 'Reviewing selected plugin candidates',
    })
    expect(presented('capability_workflow_resume', {
      workflow_id: WORKFLOW_ID,
      interrupt_id: INTERRUPT_ID,
      decision: { action: 'modify_this', candidate_id: CANDIDATE_ID },
    })).toMatchObject({
      card: 'generic',
      kind: 'edit',
      title: 'Running authorized managed construction',
    })
    expect(presented('capability_workflow_resume', {
      workflow_id: WORKFLOW_ID,
      interrupt_id: INTERRUPT_ID,
      decision: { action: 'create_new' },
    }).title).toMatch(/managed (construction|creation)|creating a new plugin/i)
    expect(presented('capability_workflow_resume', {
      workflow_id: WORKFLOW_ID,
      interrupt_id: INTERRUPT_ID,
      decision: { action: 'use_this', candidate_id: CANDIDATE_ID },
    }).title).toMatch(/installing and verifying/i)
    expect(presented('capability_workflow_resume', {
      workflow_id: WORKFLOW_ID,
      interrupt_id: INTERRUPT_ID,
      navigation: { kind: 'enable_builtin', candidate_ids: [CANDIDATE_ID] },
    })).toMatchObject({
      kind: 'read',
      title: 'Selecting the built-in capability for final confirmation',
    })
    expect(presented('capability_workflow_resume', {
      workflow_id: WORKFLOW_ID,
      interrupt_id: INTERRUPT_ID,
      decision: { action: 'enable_builtin', candidate_id: CANDIDATE_ID },
    })).toMatchObject({
      kind: 'execute',
      title: 'Enabling the confirmed built-in Host capability',
    })
    expect(presented('capability_workflow_diagnose', {
      workflow_id: WORKFLOW_ID,
      probes: ['managed_child'],
    }).title).toMatch(/diagnosing/i)
    expect(presented('capability_workflow_recover', {
      workflow_id: WORKFLOW_ID,
      interrupt_id: INTERRUPT_ID,
    }).title).toMatch(/cleaning up and restarting/i)
    expect(presented('capability_repair', {
      objective: 'repair the Host runtime',
    })).toMatchObject({
      card: 'generic',
      kind: 'other',
      title: 'Preparing a full-access repair request',
    })
    expect(presented('capability_repair_resume', {
      repair_id: 'repair_hidden',
    })).toMatchObject({
      card: 'generic',
      kind: 'execute',
      title: 'Running the confirmed full-access repair',
    })
    expect(presented('plugin_remove', { installation_id: INSTALLATION_ID })).toMatchObject({
      card: 'generic',
      kind: 'delete',
      title: 'Removing the selected plugin',
    })
  })

  it('exposes enable_builtin as a Gate-2 decision in the real tool schema', () => {
    const parameters = tool('capability_workflow_resume').parameters as unknown as {
      properties: { decision: { properties: { action: { enum: string[] } } } }
    }
    expect(parameters.properties.decision.properties.action.enum).toContain('enable_builtin')
  })

  it('exposes bounded search-more hints in the real tool schema', () => {
    const parameters = tool('capability_workflow_resume').parameters as unknown as {
      properties: { navigation: { properties: Record<string, unknown> } }
    }
    expect(parameters.properties.navigation.properties).toHaveProperty('queries')
    expect(parameters.properties.navigation.properties).toHaveProperty('repositories')
  })

  it('exposes model-planned baseline queries in the initial workflow schema', () => {
    const parameters = tool('capability_workflow').parameters as unknown as {
      properties: Record<string, unknown>
    }
    expect(parameters.properties).toHaveProperty('queries')
  })

  it('exposes a two-call full-access repair gate without command parameters', () => {
    const prepare = tool('capability_repair').parameters as unknown as {
      properties: Record<string, unknown>
    }
    const resume = tool('capability_repair_resume').parameters as unknown as {
      properties: Record<string, unknown>
    }
    expect(prepare.properties).toHaveProperty('objective')
    expect(prepare.properties).toHaveProperty('failure_context')
    expect(prepare.properties).not.toHaveProperty('command')
    expect(resume.properties).toEqual(expect.objectContaining({ repair_id: expect.any(Object) }))
    expect(Object.keys(resume.properties)).toEqual(['repair_id'])
  })

  it('forwards model-planned baseline queries through the initial workflow tool', async () => {
    const start = vi.fn(async () => ({
      workflow: {
        schemaVersion: 3 as const,
        id: WORKFLOW_ID,
        policyVersion: POLICY_VERSION,
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
        requirement: 'auto review',
        status: 'interrupted' as const,
        cursor: 'await_discovery' as const,
        generation: 1,
      },
      lifecycleState: 'discovering' as const,
    }))
    const definition = createTools({ start } as unknown as CapabilityEvolutionService)
      .find((item) => item.name === 'capability_workflow')!
    const run = {} as ToolRunContext

    await definition.execute({
      requirement: 'automatic approval review',
      queries: ['auto review', 'automatic approval'],
      intent: { operation: 'discover_or_reuse', required_surface: 'native_dsh_plugin' },
    }, run)

    expect(start).toHaveBeenCalledWith(
      'automatic approval review',
      run,
      { operation: 'discover_or_reuse', requiredSurface: 'native_dsh_plugin' },
      undefined,
      ['auto review', 'automatic approval'],
    )
  })

  it('forwards the tool execution context through adoption scan and claim flows', async () => {
    const scanOrphans = vi.fn(async () => ({ profile: 'web', orphans: [] }))
    const adopt = vi.fn(async () => ({ id: `installation_${'a'.repeat(24)}` }))
    const definition = createTools({ scanOrphans, adopt } as unknown as CapabilityEvolutionService)
      .find((item) => item.name === 'capability_adopt')!
    const run = { signal: new AbortController().signal } as ToolRunContext

    await definition.execute({}, run)
    await definition.execute({ package_name: 'dsh-tool-orphan' }, run)

    expect(scanOrphans).toHaveBeenCalledWith(run)
    expect(adopt).toHaveBeenCalledWith({ packageName: 'dsh-tool-orphan' }, run)
  })

  it('shows Chinese pending titles for a Chinese requirement', () => {
    expect(presented('capability_workflow', {
      requirement: '我需要一个科学计算器',
      intent: { operation: 'discover_or_reuse', required_surface: 'any' },
    })).toMatchObject({
      card: 'generic',
      kind: 'search',
      title: '正在搜索可复用插件',
    })
    rememberRequirementLanguage(WORKFLOW_ID, '我需要一个科学计算器')
    expect(presented('capability_workflow_resume', {
      workflow_id: WORKFLOW_ID,
      interrupt_id: INTERRUPT_ID,
      decision: { action: 'use_this', candidate_id: CANDIDATE_ID },
    }).title).toBe('正在安装并验证已审查的插件，可能需要几分钟')
    expect(presented('capability_workflow_resume', {
      workflow_id: WORKFLOW_ID,
      interrupt_id: INTERRUPT_ID,
      decision: { action: 'modify_this', candidate_id: CANDIDATE_ID },
    }).title).toBe('已授权，正在受管施工会话中修改')
  })

  it('never includes supplied machine IDs, paths, decision tokens, or raw args', () => {
    const args = {
      workflow_id: WORKFLOW_ID,
      interrupt_id: INTERRUPT_ID,
      decision: {
        action: 'modify_this',
        candidate_id: CANDIDATE_ID,
      },
    }
    const view = presented('capability_workflow_resume', args)
    expect(view).not.toHaveProperty('rawInput')
    expect(view).not.toHaveProperty('content')
    const blob = JSON.stringify(view)
    expect(blob).not.toContain(WORKFLOW_ID)
    expect(blob).not.toContain(INTERRUPT_ID)
    expect(blob).not.toContain(CANDIDATE_ID)
    expect(blob).not.toContain('modify_this')
    expect(blob).not.toContain('use_this')
    expect(blob).not.toContain('create_new')
    expect(blob).not.toContain('acme/one')
    expect(toolsTesting.presentCapabilityToolCall('capability_workflow_resume', args)).toEqual(view)
  })
})

describe('post-modification confirmation after unavailable checks', () => {
  it('keeps an otherwise eligible reviewed candidate installable', () => {
    const review = githubReview()
    const checks = serviceTesting.childCheckEvidence([
      'npm test failed because vitest was unavailable',
      'npm run typecheck failed because tsc was unavailable',
      'AUTOEVO_CHILD_COMPLETED',
    ].join('\n'))
    expect(checks.status).toBe('unavailable')
    const workflow = workflowFor(review, checks)
    expect(isDirectlyUsableReview(review, workflow)).toBe(true)
    const facts = confirmationFacts(resolution(), [review], workflow, { installProfiles: ['web'] })
    expect(facts.canInstall).toBe(true)
    expect(facts.modificationChecks).toMatchObject({
      source: 'child_reported',
      status: 'unavailable',
      meaning: 'Checks could not run because the local toolchain was unavailable; the plugin is not verified.',
    })
    expect(optionsFor('await_confirmation', resolution(), [review], workflow, ['web']).map((item) => item.id))
      .toContain('use_this')
  })
})

describe('autonomy contract pre-call acknowledgement', () => {
  it('requires a short natural-language acknowledgement without adding a gate', () => {
    expect(AUTOEVO_AUTONOMY_CONTRACT).toContain('Before a long authorized modify, create, or install call')
    expect(AUTOEVO_AUTONOMY_CONTRACT).toContain('one short natural-language acknowledgement')
    expect(AUTOEVO_AUTONOMY_CONTRACT).toContain('may take several minutes')
    expect(AUTOEVO_AUTONOMY_CONTRACT).toContain('this is not an extra approval gate')
    expect(AUTOEVO_AUTONOMY_CONTRACT).not.toMatch(/modify_this|create_new|use_this/u)
  })
})
