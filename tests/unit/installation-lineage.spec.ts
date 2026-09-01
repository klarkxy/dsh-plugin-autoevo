import { describe, expect, it } from 'vitest'
import type { InstallationRecord } from '../../src/contracts.js'
import { deriveInstallationLineage, installationIdentity } from '../../src/installation-lineage.js'
import { dependencySpecDigest } from '../../src/resolver/installed-origin.js'

const SPEC_A = `github:acme/calculator#${'a'.repeat(40)}`
const SPEC_B = `github:acme/calculator#${'b'.repeat(40)}`

function record(id: string, overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    schemaVersion: 1,
    id: `installation_${id.repeat(24)}`,
    createdAt: `2026-08-0${id}T00:00:00.000Z`,
    targetProfile: 'web',
    retention: 'persistent',
    dshHome: '/state/dsh-home',
    packageName: 'dsh-tool-calculator',
    installSpec: SPEC_A,
    installPhase: 'completed',
    installState: 'installed',
    installOutcome: 'verified',
    installed: true,
    loaded: true,
    verified: true,
    restartRequired: false,
    removed: false,
    verification: {
      attempted: true,
      expectedTools: [],
      calledTools: [],
      resultTools: [],
      failedTools: [],
      sessionFiles: [],
      taskResultObserved: true,
      reason: 'verified',
    },
    ...overrides,
  }
}

function child(id: string, parent: InstallationRecord, installSpec = SPEC_B, overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return record(id, {
    createdAt: `2026-08-0${id}T00:00:00.000Z`,
    installSpec,
    predecessorInstallationId: parent.id,
    replacement: {
      state: 'new_present',
      oldSpecDigest: dependencySpecDigest(parent.installSpec),
      newInstallSpec: installSpec,
      preparedAt: `2026-08-0${id}T00:00:00.000Z`,
      reconciledAt: `2026-08-0${id}T00:01:00.000Z`,
    },
    ...overrides,
  })
}

describe('derived installation lineage', () => {
  it('normalizes package identity and Windows profile casing defensively', () => {
    const first = record('1', { packageName: 'DSH-TOOL-CALCULATOR', targetProfile: 'Web' })
    const second = record('2', { packageName: 'dsh-tool-calculator', targetProfile: 'web' })
    if (process.platform === 'win32') {
      expect(installationIdentity(first)).toBe(installationIdentity(second))
    } else {
      expect(installationIdentity(first)).not.toBe(installationIdentity(second))
    }
  })

  it.each([
    ['missing', undefined],
    ['wrong', `installation_${'9'.repeat(24)}`],
  ])('uses the canonical child edge when the parent forward link is %s', (_label, forward) => {
    const parent = record('1', { ...(forward ? { supersededByInstallationId: forward } : {}) })
    const next = child('2', parent)
    const graph = deriveInstallationLineage([next, parent])

    expect(graph.parentByChild.get(next.id)?.id).toBe(parent.id)
    expect(graph.uniqueChild(parent.id)?.id).toBe(next.id)
    expect(graph.ordered.map((item) => item.id)).toEqual([parent.id, next.id])
  })

  it.each([
    ['cross home', { dshHome: '/other/home' }],
    ['cross profile', { targetProfile: 'desktop' }],
    ['cross package', { packageName: 'dsh-tool-other' }],
    ['temporary child', { retention: 'temporary' as const }],
    ['incomplete child', { installPhase: 'destination_installing' as const }],
    ['uncommitted child', { installed: false }],
    ['wrong new spec', { replacement: {
      state: 'new_present' as const,
      oldSpecDigest: dependencySpecDigest(SPEC_A),
      newInstallSpec: SPEC_A,
      preparedAt: '2026-08-02T00:00:00.000Z',
      reconciledAt: '2026-08-02T00:01:00.000Z',
    } }],
    ['wrong old digest', { replacement: {
      state: 'new_present' as const,
      oldSpecDigest: dependencySpecDigest(SPEC_B),
      newInstallSpec: SPEC_B,
      preparedAt: '2026-08-02T00:00:00.000Z',
      reconciledAt: '2026-08-02T00:01:00.000Z',
    } }],
  ])('rejects a non-authoritative edge: %s', (_label, overrides) => {
    const parent = record('1')
    const next = child('2', parent, SPEC_B, overrides)
    expect(deriveInstallationLineage([parent, next]).parentByChild.has(next.id)).toBe(false)
  })

  it('rejects self edges and every edge in a cycle', () => {
    const first = record('1')
    const second = child('2', first)
    const cyclicFirst = child('1', second, SPEC_A)
    const self = child('3', record('3'))
    const graph = deriveInstallationLineage([cyclicFirst, second, self])

    expect(graph.parentByChild.size).toBe(0)
    expect(graph.cycleRecordIds).toEqual(new Set([cyclicFirst.id, second.id]))
  })

  it('retains all branches in stable topological order', () => {
    const parent = record('1')
    const later = child('3', parent, `github:acme/calculator#${'c'.repeat(40)}`)
    const earlier = child('2', parent, SPEC_B)
    const graph = deriveInstallationLineage([later, parent, earlier])

    expect(graph.childrenByParent.get(parent.id)?.map((item) => item.id)).toEqual([earlier.id, later.id])
    expect(graph.ordered.map((item) => item.id)).toEqual([parent.id, earlier.id, later.id])
    expect(graph.uniqueChild(parent.id)).toBeUndefined()
  })

  it('keeps a removed committed child as historical supersession while excluding it from live leaves', () => {
    const parent = record('1')
    const removed = child('2', parent, SPEC_B, {
      installState: 'not_installed',
      installed: false,
      loaded: false,
      verified: false,
      removed: true,
    })
    const graph = deriveInstallationLineage([parent, removed])

    expect(graph.uniqueChild(parent.id)?.id).toBe(removed.id)
    expect(graph.eligibleLeavesFor(parent)).toEqual([])
    expect(graph.uniqueLiveLeaf(parent, SPEC_A)).toEqual({ status: 'none' })
  })

  it('returns a unique exact live leaf and fails closed on same-spec branches', () => {
    const parent = record('1')
    const first = child('2', parent, SPEC_B)
    const second = child('3', parent, SPEC_A)
    const graph = deriveInstallationLineage([parent, first, second])

    expect(graph.uniqueLiveLeaf(parent, SPEC_B)).toMatchObject({ status: 'unique', record: { id: first.id } })

    const sameSpec = child('3', parent, SPEC_B)
    const ambiguous = deriveInstallationLineage([parent, first, sameSpec]).uniqueLiveLeaf(parent, SPEC_B)
    expect(ambiguous).toMatchObject({ status: 'ambiguous' })
    if (ambiguous.status === 'ambiguous') {
      expect(ambiguous.records.map((item) => item.id)).toEqual([first.id, sameSpec.id])
    }
  })

  it('treats adopted and legacy roots as eligible without synthesizing an edge', () => {
    const adopted = record('1', { origin: 'adopted' })
    const legacy = record('2')
    delete legacy.installPhase
    delete legacy.installState
    const adoptedGraph = deriveInstallationLineage([adopted])
    const legacyGraph = deriveInstallationLineage([legacy])

    expect(adoptedGraph.parentByChild.size).toBe(0)
    expect(legacyGraph.parentByChild.size).toBe(0)
    expect(adoptedGraph.uniqueLiveLeaf(adopted, SPEC_A)).toMatchObject({ status: 'unique', record: { id: adopted.id } })
    expect(legacyGraph.uniqueLiveLeaf(legacy, SPEC_A)).toMatchObject({ status: 'unique', record: { id: legacy.id } })
  })
})
