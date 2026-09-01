import path from 'node:path'
import type { InstallationRecord } from './contracts.js'
import { dependencySpecDigest } from './resolver/installed-origin.js'

export function normalizedInstallationHome(dshHome: string): string {
  const normalized = path.resolve(dshHome).normalize('NFKC')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function installationIdentity(record: Pick<InstallationRecord, 'dshHome' | 'targetProfile' | 'packageName'>): string | undefined {
  if (!record.packageName) return undefined
  const normalizedProfile = record.targetProfile.normalize('NFKC')
  return [
    normalizedInstallationHome(record.dshHome),
    process.platform === 'win32' ? normalizedProfile.toLowerCase() : normalizedProfile,
    record.packageName.normalize('NFKC').toLowerCase(),
  ].join('\0')
}

function stableRecordOrder(left: InstallationRecord, right: InstallationRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

function isCommittedReplacement(child: InstallationRecord, parent: InstallationRecord): boolean {
  const committedLifecycle = child.removed
    ? true
    : child.installed && child.installState === 'installed'
  return child.id !== parent.id
    && installationIdentity(child) !== undefined
    && installationIdentity(child) === installationIdentity(parent)
    && child.retention === 'persistent'
    && parent.retention === 'persistent'
    && child.installPhase === 'completed'
    && parent.installPhase === 'completed'
    && committedLifecycle
    && child.replacement?.state === 'new_present'
    && child.installSpec === child.replacement.newInstallSpec
    && dependencySpecDigest(parent.installSpec) === child.replacement.oldSpecDigest
}

function isEligibleLeaf(record: InstallationRecord, childrenByParent: ReadonlyMap<string, readonly InstallationRecord[]>): boolean {
  return Boolean(installationIdentity(record))
    && record.retention === 'persistent'
    && record.installed
    && (record.installState === undefined || record.installState === 'installed')
    && (record.installPhase === undefined || record.installPhase === 'completed')
    && !record.removed
    && (childrenByParent.get(record.id)?.length ?? 0) === 0
}

export type UniqueLiveLeaf =
  | { status: 'none' }
  | { status: 'unique'; record: InstallationRecord }
  | { status: 'ambiguous'; records: InstallationRecord[] }

export interface DerivedInstallationLineage {
  ordered: InstallationRecord[]
  parentByChild: ReadonlyMap<string, InstallationRecord>
  childrenByParent: ReadonlyMap<string, readonly InstallationRecord[]>
  cycleRecordIds: ReadonlySet<string>
  eligibleLeavesFor(record: InstallationRecord): InstallationRecord[]
  uniqueChild(parentId: string): InstallationRecord | undefined
  isAncestor(ancestorId: string, descendantId: string): boolean
  uniqueLiveLeaf(record: InstallationRecord, liveSpec: string | undefined): UniqueLiveLeaf
}

/**
 * Derive installation lineage exclusively from committed child receipts.
 * Parent forward links are audit-only and never affect this graph.
 */
export function deriveInstallationLineage(records: readonly InstallationRecord[]): DerivedInstallationLineage {
  const stableRecords = [...records].sort(stableRecordOrder)
  const byId = new Map(stableRecords.map((record) => [record.id, record]))
  const candidateParentByChild = new Map<string, InstallationRecord>()
  for (const child of stableRecords) {
    const parent = child.predecessorInstallationId
      ? byId.get(child.predecessorInstallationId)
      : undefined
    if (parent && isCommittedReplacement(child, parent)) candidateParentByChild.set(child.id, parent)
  }

  const cycleRecordIds = new Set<string>()
  const completed = new Set<string>()
  for (const start of candidateParentByChild.keys()) {
    if (completed.has(start)) continue
    const pathIds: string[] = []
    const position = new Map<string, number>()
    let current: string | undefined = start
    while (current && candidateParentByChild.has(current) && !completed.has(current)) {
      const existing = position.get(current)
      if (existing !== undefined) {
        for (const id of pathIds.slice(existing)) cycleRecordIds.add(id)
        break
      }
      position.set(current, pathIds.length)
      pathIds.push(current)
      current = candidateParentByChild.get(current)?.id
    }
    for (const id of pathIds) completed.add(id)
  }

  const parentByChild = new Map<string, InstallationRecord>()
  const childrenByParent = new Map<string, InstallationRecord[]>()
  for (const [childId, parent] of candidateParentByChild) {
    if (cycleRecordIds.has(childId)) continue
    const child = byId.get(childId)!
    parentByChild.set(childId, parent)
    const children = childrenByParent.get(parent.id) ?? []
    children.push(child)
    childrenByParent.set(parent.id, children)
  }
  for (const children of childrenByParent.values()) children.sort(stableRecordOrder)

  const ordered: InstallationRecord[] = []
  const seen = new Set<string>()
  const visit = (record: InstallationRecord): void => {
    if (seen.has(record.id)) return
    seen.add(record.id)
    ordered.push(record)
    for (const child of childrenByParent.get(record.id) ?? []) visit(child)
  }
  for (const root of stableRecords.filter((record) => !parentByChild.has(record.id))) visit(root)
  for (const record of stableRecords) visit(record)

  const eligibleLeavesFor = (record: InstallationRecord): InstallationRecord[] => {
    const identity = installationIdentity(record)
    if (!identity) return []
    return stableRecords.filter((candidate) => installationIdentity(candidate) === identity
      && isEligibleLeaf(candidate, childrenByParent))
  }

  return {
    ordered,
    parentByChild,
    childrenByParent,
    cycleRecordIds,
    eligibleLeavesFor,
    uniqueChild(parentId) {
      const children = childrenByParent.get(parentId) ?? []
      return children.length === 1 ? children[0] : undefined
    },
    isAncestor(ancestorId, descendantId) {
      if (ancestorId === descendantId) return false
      const seenParents = new Set<string>()
      let current = parentByChild.get(descendantId)
      while (current && !seenParents.has(current.id)) {
        if (current.id === ancestorId) return true
        seenParents.add(current.id)
        current = parentByChild.get(current.id)
      }
      return false
    },
    uniqueLiveLeaf(record, liveSpec) {
      if (liveSpec === undefined) return { status: 'none' }
      const matches = eligibleLeavesFor(record).filter((candidate) => candidate.installSpec === liveSpec)
      if (matches.length === 0) return { status: 'none' }
      if (matches.length === 1) return { status: 'unique', record: matches[0]! }
      return { status: 'ambiguous', records: matches }
    },
  }
}
