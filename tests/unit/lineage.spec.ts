import { describe, expect, it } from 'vitest'
import {
  POLICY_VERSION,
  type InstallationRecord,
  type LocalCapabilityCandidate,
  type ResolutionRecord,
  type ReviewRecord,
} from '../../src/contracts.js'
import { applyIntentToCandidate } from '../../src/resolver/intent.js'
import { dependencySpecDigest } from '../../src/resolver/installed-origin.js'
import {
  githubRepositoriesInText,
  isFailedSameSpecification,
  lineageCandidateFromRecords,
  mergeLineageCandidate,
  shouldSkipRemoteDiscovery,
} from '../../src/resolver/lineage.js'
import { candidateSnapshotFor } from '../../src/workflow/candidates.js'

const COMMIT = 'df098f16752eb0a53d52d0d931c64ab7236bf1d9'
const SPEC = `github:anonymous-lab/dsh-plugin-record-sync#${COMMIT}`

function review(): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-23T04:21:32.000Z',
    resolutionId: `resolution_${'b'.repeat(24)}`,
    requirement: '检查 record-sync 相关功能为什么不能用',
    sourceSnapshot: {
      kind: 'github',
      repository: 'anonymous-lab/dsh-plugin-record-sync',
      requestedRef: 'HEAD',
      commit: COMMIT,
      defaultBranch: 'main',
    },
    inspectedFiles: [{ path: 'package.json', sha256: 'c'.repeat(64), bytes: 10 }],
    manifest: {
      kind: 'bundle',
      scripts: [],
      dependencies: [],
      peerDependencies: {},
      expectedTools: [],
      packageName: 'dsh-plugin-record-sync',
    },
    fit: 'full',
    confidence: 0.8,
    securityRisk: 'low',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'unknown', reason: 'none', runtimeVersion: '0.1.1-rc.1' },
    missingCapabilities: [],
    findings: [],
    recommendation: 'use',
    installSpec: SPEC,
  }
}

function installation(): InstallationRecord {
  return {
    schemaVersion: 1,
    id: `installation_${'d'.repeat(24)}`,
    createdAt: '2026-08-23T04:30:09.340Z',
    reviewId: `review_${'a'.repeat(64)}`,
    workflowId: `workflow_${'e'.repeat(24)}`,
    targetProfile: 'web',
    retention: 'persistent',
    dshHome: 'C:/Users/27837/.dsh',
    packageName: 'dsh-plugin-record-sync',
    installSpec: SPEC,
    installState: 'not_installed',
    installOutcome: 'failed_absent',
    installed: false,
    loaded: false,
    verified: false,
    restartRequired: false,
    removed: true,
    verification: {
      attempted: true,
      expectedTools: [],
      calledTools: [],
      resultTools: [],
      failedTools: [],
      sessionFiles: [],
      taskResultObserved: false,
      layer: 'bundle_activation',
      status: 'failed',
      reason: 'Reviewed package Fiber was not present after Loader settle.',
    },
  }
}

function liveInstallation(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    ...installation(),
    id: `installation_${'6'.repeat(24)}`,
    installPhase: 'completed',
    installState: 'installed',
    installOutcome: 'verified',
    installed: true,
    loaded: true,
    verified: true,
    removed: false,
    verification: {
      ...installation().verification,
      status: 'passed',
      sourceMatched: true,
      reason: 'verified installed source',
    },
    ...overrides,
  }
}

function committedChild(
  parent: InstallationRecord,
  id: string,
  installSpec: string,
): InstallationRecord {
  return liveInstallation({
    id,
    createdAt: '2026-08-23T06:00:00.000Z',
    installSpec,
    predecessorInstallationId: parent.id,
    replacement: {
      state: 'new_present',
      oldSpecDigest: dependencySpecDigest(parent.installSpec),
      newInstallSpec: installSpec,
      preparedAt: '2026-08-23T05:59:00.000Z',
    },
  })
}

function managedRepairReview(): ReviewRecord {
  return {
    ...review(),
    id: `review_${'f'.repeat(64)}`,
    createdAt: '2026-08-23T05:30:00.000Z',
    sourceSnapshot: {
      kind: 'local',
      path: 'C:/Users/test/.dsh/autoevo/sources/anonymous-lab_dsh-plugin-record-sync',
      baseReviewId: review().id,
      baseCommit: COMMIT,
      statusHash: 'e'.repeat(64),
    },
    installSpec: 'file:C:/Users/test/.dsh/autoevo/review-artifacts/repaired.tgz',
  }
}

describe('known-source lineage', () => {
  const historicalTarget: NonNullable<LocalCapabilityCandidate['evolutionTarget']> = {
    kind: 'failed_install',
    repository: 'anonymous-lab/dsh-plugin-record-sync',
    commit: COMMIT,
    packageName: 'dsh-plugin-record-sync',
    profile: 'web',
    dependencySpec: SPEC,
    specDigest: 'f'.repeat(64),
  }

  function installedProfileCandidate(dependencySpec: string): LocalCapabilityCandidate {
    return {
      kind: 'plugin',
      name: 'dsh-plugin-record-sync',
      description: 'installed profile plugin',
      availability: 'installed_in_profile',
      confidence: 0.99,
      semanticFit: 'full',
      fit: 'partial',
      evolutionTarget: historicalTarget,
      profileEvidence: {
        source: 'host_profile_manifest',
        profile: 'web',
        packageName: 'dsh-plugin-record-sync',
        dependencySpec,
        configuredBundle: false,
      },
    }
  }

  const evolveIntent = {
    operation: 'evolve_existing' as const,
    requiredSurface: 'native_dsh_plugin' as const,
    targetName: 'dsh-plugin-record-sync',
    evolveReason: 'repair' as const,
  }

  it.each([
    'file:[local-reference]',
    '[remote-reference]',
    '^1.2.3',
    'workspace:*',
  ])('clears inherited lineage when authoritative profile evidence is not exact: %s', (dependencySpec) => {
    const applied = applyIntentToCandidate(installedProfileCandidate(dependencySpec), evolveIntent)

    expect(applied.evolutionTarget).toBeUndefined()
  })

  it('replaces inherited lineage with the exact current profile target', () => {
    const applied = applyIntentToCandidate(installedProfileCandidate(SPEC), evolveIntent)

    expect(applied.evolutionTarget).toMatchObject({
      kind: 'github_exact',
      repository: 'anonymous-lab/dsh-plugin-record-sync',
      commit: COMMIT,
      dependencySpec: SPEC,
    })
  })

  it('preserves historical lineage only when no authoritative profile evidence exists', () => {
    const candidate = installedProfileCandidate(SPEC)
    delete candidate.profileEvidence

    expect(applyIntentToCandidate(candidate, evolveIntent).evolutionTarget).toEqual(historicalTarget)
  })

  it('omits a cleared opaque target from the frozen candidate snapshot', () => {
    const candidate = applyIntentToCandidate(installedProfileCandidate('file:[local-reference]'), evolveIntent)
    const resolution: ResolutionRecord = {
      schemaVersion: 2,
      id: `resolution_${'7'.repeat(24)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-31T00:00:00.000Z',
      requirement: 'repair record sync',
      cwd: process.cwd(),
      decision: 'none',
      localCandidates: [candidate],
      remoteCandidates: [],
      remoteDiscoveryComplete: false,
      authorization: { state: 'selection_required', resolutionId: `resolution_${'7'.repeat(24)}`, reason: 'wait' },
      queries: [],
      reasons: [],
      intent: evolveIntent,
    }

    expect(candidateSnapshotFor(resolution)[0]?.evolutionTarget).toBeUndefined()
  })

  it('extracts github owner/repo mentions from a requirement', () => {
    expect(githubRepositoriesInText('改进 anonymous-lab/dsh-plugin-record-sync 这份已审查的 DSH 插件')).toEqual([
      'anonymous-lab/dsh-plugin-record-sync',
    ])
  })

  it('rebuilds a failed_absent GitHub install as a known_source candidate', () => {
    const candidate = lineageCandidateFromRecords({
      requirement: '改进 anonymous-lab/dsh-plugin-record-sync 这份已审查的 DSH 插件：补上能被 Loader 认到的包装 Fiber。不要原样重装上次失败的那份。',
      intent: {
        operation: 'evolve_existing',
        requiredSurface: 'native_dsh_plugin',
        targetName: 'record-sync',
        evolveReason: 'repair',
      },
      reviews: [review()],
      installations: [installation()],
      profile: 'web',
    })
    expect(candidate).toEqual(expect.objectContaining({
      kind: 'plugin',
      name: 'dsh-plugin-record-sync',
      availability: 'known_source',
      reuseEligible: false,
      fit: 'partial',
      evolutionTarget: expect.objectContaining({
        kind: 'failed_install',
        repository: 'anonymous-lab/dsh-plugin-record-sync',
        commit: COMMIT,
        dependencySpec: SPEC,
      }),
    }))
    expect(isFailedSameSpecification(candidate?.evolutionTarget, SPEC)).toBe(true)
  })

  it('keeps a failed specification failed after a newer read-only re-review of the same spec', () => {
    const newerReview: ReviewRecord = {
      ...review(),
      id: `review_${'f'.repeat(64)}`,
      createdAt: '2026-08-23T05:00:00.000Z',
    }
    const candidate = lineageCandidateFromRecords({
      requirement: '修复 record-sync 上次未激活的插件',
      intent: {
        operation: 'evolve_existing',
        requiredSurface: 'native_dsh_plugin',
        targetName: 'record-sync',
        evolveReason: 'repair',
      },
      reviews: [newerReview],
      installations: [installation()],
      profile: 'web',
    })
    expect(candidate?.evolutionTarget).toMatchObject({
      kind: 'failed_install',
      dependencySpec: SPEC,
    })
    expect(isFailedSameSpecification(candidate?.evolutionTarget, newerReview.installSpec)).toBe(true)
  })

  it('prefers a later Host-managed repair snapshot over the earlier failed GitHub specification', () => {
    const repaired = managedRepairReview()
    const laterReadOnlyReview: ReviewRecord = {
      ...review(),
      id: `review_${'1'.repeat(64)}`,
      createdAt: '2026-08-24T05:00:00.000Z',
    }
    const candidate = lineageCandidateFromRecords({
      requirement: '继续修复上次安装失败的 record-sync，沿用已经完成的托管修改',
      intent: {
        operation: 'evolve_existing',
        requiredSurface: 'native_dsh_plugin',
        targetName: 'record-sync',
        evolveReason: 'repair',
      },
      reviews: [review(), repaired, laterReadOnlyReview],
      installations: [installation()],
      profile: 'web',
      managedReviewIds: [repaired.id],
    })
    expect(candidate?.evolutionTarget).toMatchObject({
      kind: 'reviewed_snapshot',
      repository: 'anonymous-lab/dsh-plugin-record-sync',
      commit: COMMIT,
      dependencySpec: repaired.installSpec,
      reviewId: repaired.id,
      sourceId: 'anonymous-lab_dsh-plugin-record-sync',
    })
    expect(candidate?.description).toMatch(/Host-managed repair/i)
  })

  it('does not elevate an unrooted local file review into a known-source candidate', () => {
    const repaired = managedRepairReview()
    if (repaired.sourceSnapshot.kind !== 'local') throw new Error('fixture must be local')
    const unrooted: ReviewRecord = {
      ...repaired,
      sourceSnapshot: {
        ...repaired.sourceSnapshot,
        baseReviewId: `review_${'9'.repeat(64)}`,
      },
    }
    const candidate = lineageCandidateFromRecords({
      requirement: '修复 record-sync',
      intent: { operation: 'evolve_existing', requiredSurface: 'native_dsh_plugin' },
      reviews: [unrooted],
      installations: [],
      profile: 'web',
    })
    expect(candidate).toBeUndefined()
  })

  it('reclaims a Host-validated capability created locally by AutoEvo', () => {
    const created: ReviewRecord = {
      ...managedRepairReview(),
      id: `review_${'2'.repeat(64)}`,
      sourceSnapshot: {
        kind: 'local',
        path: 'C:/workspace/.autoevo/sources/create_localcapability',
        baseReviewId: `review_${'3'.repeat(64)}`,
        baseCommit: COMMIT,
        statusHash: '4'.repeat(64),
      },
      manifest: {
        ...managedRepairReview().manifest,
        packageName: 'dsh-plugin-record-sync',
      },
      installSpec: 'file:C:/state/review-artifacts/record-sync.tgz',
    }
    const installed: InstallationRecord = {
      ...installation(),
      id: `installation_${'5'.repeat(24)}`,
      reviewId: created.id,
      installSpec: created.installSpec!,
      installState: 'installed',
      installOutcome: 'awaiting_user_test',
      installed: true,
      removed: false,
    }
    const candidate = lineageCandidateFromRecords({
      requirement: '修复当前 dsh-plugin-record-sync 的加载配置',
      intent: { operation: 'evolve_existing', requiredSurface: 'native_dsh_plugin', targetName: 'dsh-plugin-record-sync', evolveReason: 'repair' },
      reviews: [created],
      installations: [installed],
      profile: 'web',
      managedReviewIds: [created.id],
    })
    expect(candidate).toEqual(expect.objectContaining({
      availability: 'known_source',
      reuseEligible: false,
      evolutionTarget: expect.objectContaining({
        kind: 'managed_local',
        packageName: 'dsh-plugin-record-sync',
        reviewId: created.id,
        sourceId: 'create_localcapability',
      }),
    }))
  })

  it('keeps a repaired snapshot failed when its own later installation failed', () => {
    const repaired = managedRepairReview()
    const failedRepair: InstallationRecord = {
      ...installation(),
      id: `installation_${'2'.repeat(24)}`,
      reviewId: repaired.id,
      installSpec: repaired.installSpec!,
      createdAt: '2026-08-23T06:00:00.000Z',
    }
    const candidate = lineageCandidateFromRecords({
      requirement: '修复 record-sync',
      intent: { operation: 'evolve_existing', requiredSurface: 'native_dsh_plugin' },
      reviews: [review(), repaired],
      installations: [installation(), failedRepair],
      profile: 'web',
      managedReviewIds: [repaired.id],
    })
    expect(candidate?.evolutionTarget).toMatchObject({
      kind: 'failed_install',
      dependencySpec: repaired.installSpec,
      installationId: failedRepair.id,
    })
    expect(isFailedSameSpecification(candidate?.evolutionTarget, repaired.installSpec)).toBe(true)
  })

  it('treats an intentionally removed successful install as a reviewed snapshot, not a failure', () => {
    const removedSuccess: InstallationRecord = {
      ...installation(),
      createdAt: '2026-08-23T06:00:00.000Z',
      installState: 'installed',
      installOutcome: 'verified',
      installed: true,
      loaded: true,
      verified: true,
      removed: true,
      verification: {
        ...installation().verification,
        status: 'passed',
        sourceMatched: true,
        reason: 'verified before explicit removal',
      },
    }
    const candidate = lineageCandidateFromRecords({
      requirement: '重新安装 record-sync 插件',
      intent: {
        operation: 'evolve_existing',
        requiredSurface: 'native_dsh_plugin',
        targetName: 'record-sync',
        evolveReason: 'upgrade',
      },
      reviews: [review()],
      installations: [removedSuccess],
      profile: 'web',
    })
    expect(candidate?.evolutionTarget).toMatchObject({
      kind: 'reviewed_snapshot',
      dependencySpec: SPEC,
    })
    expect(isFailedSameSpecification(candidate?.evolutionTarget, SPEC)).toBe(false)
  })

  it.each([undefined, `installation_${'9'.repeat(24)}`, `installation_${'6'.repeat(24)}`])(
    'suppresses the sole eligible live receipt regardless of its raw forward link: %s',
    (supersededByInstallationId) => {
      const live = liveInstallation({
        ...(supersededByInstallationId ? { supersededByInstallationId } : {}),
      })

      expect(lineageCandidateFromRecords({
        requirement: 'repair record-sync',
        intent: {
          operation: 'evolve_existing',
          requiredSurface: 'native_dsh_plugin',
          targetName: 'record-sync',
          evolveReason: 'repair',
        },
        reviews: [review()],
        installations: [live],
        profile: 'web',
      })).toBeUndefined()
    },
  )

  it('keeps a parent with a committed canonical child as historical despite a wrong raw forward link', () => {
    const parent = liveInstallation({
      supersededByInstallationId: `installation_${'9'.repeat(24)}`,
    })
    const child = committedChild(
      parent,
      `installation_${'7'.repeat(24)}`,
      'file:C:/state/review-artifacts/repaired.tgz',
    )

    const candidate = lineageCandidateFromRecords({
      requirement: 'repair record-sync',
      intent: {
        operation: 'evolve_existing',
        requiredSurface: 'native_dsh_plugin',
        targetName: 'record-sync',
        evolveReason: 'repair',
      },
      reviews: [review()],
      installations: [parent, child],
      profile: 'web',
    })

    expect(candidate?.evolutionTarget).toMatchObject({
      kind: 'reviewed_snapshot',
      installationId: parent.id,
      dependencySpec: SPEC,
    })
  })

  it('omits receipt-derived lineage when the best relevant receipt is one of multiple eligible leaves', () => {
    const older = liveInstallation({
      id: `installation_${'6'.repeat(24)}`,
      createdAt: '2026-08-23T05:00:00.000Z',
    })
    const newer = liveInstallation({
      id: `installation_${'7'.repeat(24)}`,
      createdAt: '2026-08-23T06:00:00.000Z',
    })

    expect(lineageCandidateFromRecords({
      requirement: 'repair record-sync',
      intent: {
        operation: 'evolve_existing',
        requiredSurface: 'native_dsh_plugin',
        targetName: 'record-sync',
        evolveReason: 'repair',
      },
      reviews: [],
      installations: [older, newer],
      profile: 'web',
    })).toBeUndefined()
  })

  it('normalizes the configured identity casing while excluding a newer foreign-home receipt', () => {
    const configuredHome = installation().dshHome
    const local = liveInstallation({
      id: `installation_${'6'.repeat(24)}`,
      createdAt: '2026-08-23T05:00:00.000Z',
      dshHome: process.platform === 'win32' ? configuredHome.toUpperCase() : configuredHome,
      targetProfile: process.platform === 'win32' ? 'WEB' : 'web',
      packageName: 'DSH-PLUGIN-RECORD-SYNC',
    })
    const foreign = liveInstallation({
      id: `installation_${'7'.repeat(24)}`,
      createdAt: '2026-08-23T06:00:00.000Z',
      dshHome: 'C:/foreign/.dsh',
      installState: 'not_installed',
      installOutcome: 'failed_absent',
      installed: false,
      loaded: false,
      verified: false,
    })

    expect(lineageCandidateFromRecords({
      requirement: 'repair record-sync',
      intent: { operation: 'evolve_existing', requiredSurface: 'native_dsh_plugin' },
      reviews: [review()],
      installations: [local, foreign],
      profile: 'web',
      dshHome: configuredHome,
    })).toBeUndefined()
  })

  it('excludes a foreign home even when no active profile was resolved', () => {
    const configuredHome = installation().dshHome
    const local = {
      ...installation(),
      id: `installation_${'6'.repeat(24)}`,
      createdAt: '2026-08-23T05:00:00.000Z',
    }
    const foreign = liveInstallation({
      id: `installation_${'7'.repeat(24)}`,
      createdAt: '2026-08-23T06:00:00.000Z',
      dshHome: 'C:/foreign/.dsh',
    })

    expect(lineageCandidateFromRecords({
      requirement: 'repair record-sync',
      intent: { operation: 'evolve_existing', requiredSurface: 'native_dsh_plugin' },
      reviews: [],
      installations: [local, foreign],
      dshHome: configuredHome,
    })?.evolutionTarget).toMatchObject({
      kind: 'failed_install',
      installationId: local.id,
    })
  })

  it('does not bind a managed snapshot to a same-profile failure from another configured home', () => {
    const repaired = managedRepairReview()
    const foreignFailure: InstallationRecord = {
      ...installation(),
      id: `installation_${'7'.repeat(24)}`,
      createdAt: '2026-08-23T06:00:00.000Z',
      reviewId: repaired.id,
      dshHome: 'C:/foreign/.dsh',
      installSpec: repaired.installSpec!,
    }

    expect(lineageCandidateFromRecords({
      requirement: 'repair record-sync',
      intent: { operation: 'evolve_existing', requiredSurface: 'native_dsh_plugin' },
      reviews: [review(), repaired],
      installations: [foreignFailure],
      profile: 'web',
      dshHome: installation().dshHome,
      managedReviewIds: [repaired.id],
    })?.evolutionTarget).toMatchObject({
      kind: 'reviewed_snapshot',
      reviewId: repaired.id,
    })
  })

  it('matches a record-sync diagnosis request to the failed plugin, not a same-named skill', () => {
    const candidate = lineageCandidateFromRecords({
      requirement: '检查 record-sync 相关功能为什么不能用，是否需要重新安装成插件形式',
      intent: { operation: 'discover_or_reuse', requiredSurface: 'native_dsh_plugin' },
      reviews: [review()],
      installations: [installation()],
      profile: 'web',
    })
    expect(candidate?.evolutionTarget?.kind).toBe('failed_install')
    const merged = mergeLineageCandidate([{
      kind: 'skill',
      name: 'record-sync',
      description: 'Record Sync skill',
      availability: 'available',
      confidence: 0.99,
      fit: 'none',
      surfaceMatch: false,
      reuseEligible: false,
    }], candidate)
    expect(merged.map((item) => item.kind)).toEqual(['plugin', 'skill'])
    expect(shouldSkipRemoteDiscovery(merged, {
      operation: 'discover_or_reuse',
      requiredSurface: 'native_dsh_plugin',
    })).toBe(true)
  })

  it('does not skip marketplace search when no Host lineage exists', () => {
    expect(shouldSkipRemoteDiscovery([{
      kind: 'skill',
      name: 'record-sync',
      description: 'Record Sync skill',
      availability: 'available',
      confidence: 0.99,
      fit: 'none',
      surfaceMatch: false,
      reuseEligible: false,
    }], { operation: 'discover_or_reuse', requiredSurface: 'native_dsh_plugin' })).toBe(false)
  })

  it('prefers a live installed evolution target over a failed receipt for the same package', () => {
    const live = {
      kind: 'plugin' as const,
      name: 'dsh-plugin-record-sync',
      description: 'live',
      availability: 'installed_in_profile' as const,
      confidence: 0.99,
      fit: 'partial' as const,
      evolutionTarget: {
        kind: 'github_exact' as const,
        repository: 'anonymous-lab/dsh-plugin-record-sync',
        commit: COMMIT,
        packageName: 'dsh-plugin-record-sync',
        profile: 'web',
        dependencySpec: SPEC,
        specDigest: 'f'.repeat(64),
      },
    }
    const failed = lineageCandidateFromRecords({
      requirement: 'record-sync',
      intent: { operation: 'evolve_existing', requiredSurface: 'native_dsh_plugin' },
      reviews: [review()],
      installations: [installation()],
      profile: 'web',
    })
    expect(mergeLineageCandidate([live], failed)[0]?.evolutionTarget?.kind).toBe('github_exact')
  })
})
