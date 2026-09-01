import type {
  InstallationRecord,
  LocalCapabilityCandidate,
  RequestIntent,
  ReviewRecord,
} from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { deriveInstallationLineage, installationIdentity } from '../installation-lineage.js'
import {
  dependencySpecDigest,
  evolutionTargetFromExactGithub,
  parseExactGithubDependency,
} from './installed-origin.js'

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}'
const REPO = '[A-Za-z0-9._-]+'
const GITHUB_REPO = new RegExp(`(?:github:)?(${OWNER})\\/(${REPO})`, 'giu')

export function githubRepositoriesInText(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(GITHUB_REPO)) {
    found.add(`${match[1]}/${match[2]}`.toLowerCase())
  }
  return [...found]
}

function exactToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9@/._-])${escaped}(?=$|[^A-Za-z0-9@/._-])`, 'iu').test(text)
}

function packageAliases(packageName: string, repository: string): string[] {
  const repoName = repository.split('/')[1] ?? repository
  const aliases = new Set<string>([
    packageName,
    repository,
    repoName,
    packageName.replace(/^dsh-plugin-/u, ''),
    repoName.replace(/^dsh-plugin-/u, ''),
  ])
  return [...aliases].filter((item) => item.length > 0)
}

export function knownSourceMatchesRequest(
  requirement: string,
  intent: RequestIntent,
  repository: string,
  packageName: string,
): boolean {
  const wanted = intent.targetName?.trim().toLowerCase()
  const aliases = packageAliases(packageName, repository).map((item) => item.toLowerCase())
  if (wanted && aliases.includes(wanted)) return true
  if (githubRepositoriesInText(requirement).includes(repository.toLowerCase())) return true
  return aliases.some((alias) => exactToken(requirement, alias))
}

function newer(left: string, right: string): boolean {
  return left.localeCompare(right) > 0
}

function matchesInstallationTarget(
  record: InstallationRecord,
  packageName: string,
  profile?: string,
  dshHome?: string,
): boolean {
  const targetIdentity = installationIdentity({
    dshHome: dshHome ?? record.dshHome,
    targetProfile: profile ?? record.targetProfile,
    packageName,
  })
  return installationIdentity(record) === targetIdentity
}

export function walkReviewLineage(
  base: ReviewRecord,
  reviews: readonly ReviewRecord[],
  mode: 'strict' | 'best-effort' = 'best-effort',
): ReviewRecord | undefined {
  const byId = new Map(reviews.map((item) => [item.id, item] as const))
  if (!byId.has(base.id)) byId.set(base.id, base)
  const seen = new Set<string>()
  const resolutionId = base.resolutionId
  const packageName = base.manifest.packageName
  const sourcePath = base.sourceSnapshot.kind === 'local' ? base.sourceSnapshot.path : undefined
  const baseCommit = base.sourceSnapshot.kind === 'local' ? base.sourceSnapshot.baseCommit : undefined
  let current = base
  while (current.sourceSnapshot.kind === 'local') {
    if (seen.has(current.id)) {
      if (mode === 'strict') throw new EvolutionError('invalid_input', 'baseReviewId lineage is cyclic')
      return undefined
    }
    seen.add(current.id)
    if (mode === 'best-effort'
      && (current.resolutionId !== resolutionId
        || current.sourceSnapshot.path !== sourcePath
        || current.sourceSnapshot.baseCommit !== baseCommit
        || current.manifest.packageName !== packageName)) {
      return undefined
    }
    const parent = byId.get(current.sourceSnapshot.baseReviewId)
    if (!parent) {
      if (mode === 'strict') {
        throw new EvolutionError('invalid_input', 'baseReviewId must belong to a GitHub review lineage on the same resolution')
      }
      return undefined
    }
    current = parent
  }
  if (current.sourceSnapshot.kind !== 'github') {
    if (mode === 'strict') {
      throw new EvolutionError('invalid_input', 'baseReviewId must belong to a GitHub review lineage on the same resolution')
    }
    return undefined
  }
  if (mode === 'best-effort'
    && (current.resolutionId !== resolutionId
      || (current.manifest.packageName && packageName && current.manifest.packageName !== packageName))) {
    return undefined
  }
  return current
}

export function lineageRootReview(base: ReviewRecord, reviews: readonly ReviewRecord[]): ReviewRecord {
  return walkReviewLineage(base, reviews, 'strict')!
}

export function managedSnapshotRootReview(
  review: ReviewRecord,
  byId: ReadonlyMap<string, ReviewRecord>,
): ReviewRecord | undefined {
  return walkReviewLineage(review, [...byId.values()], 'best-effort')
}

function sourceIdFromLocalPath(candidate: string): string | undefined {
  const segments = candidate.split(/[\\/]+/u).filter(Boolean)
  const sourceId = segments.at(-1)
  return sourceId && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u.test(sourceId)
    ? sourceId
    : undefined
}

function managedSnapshotCandidate(input: {
  requirement: string
  intent: RequestIntent
  reviews: readonly ReviewRecord[]
  installations: readonly InstallationRecord[]
  profile: string
  dshHome?: string
  newestExactInstallation?: InstallationRecord
  managedReviewIds: ReadonlySet<string>
}): LocalCapabilityCandidate | undefined {
  const byId = new Map(input.reviews.map((item) => [item.id, item]))
  const localReviews = [...input.reviews]
    .filter((item) => item.sourceSnapshot.kind === 'local' && item.installSpec)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))

  for (const review of localReviews) {
    if (review.sourceSnapshot.kind !== 'local' || !review.installSpec) continue
    if (!input.managedReviewIds.has(review.id)) continue
    const root = managedSnapshotRootReview(review, byId)
    const githubRoot = root?.sourceSnapshot.kind === 'github' ? root : undefined
    const githubSource = githubRoot?.sourceSnapshot.kind === 'github' ? githubRoot.sourceSnapshot : undefined
    if (githubSource && review.sourceSnapshot.baseCommit.toLowerCase() !== githubSource.commit.toLowerCase()) continue
    const packageName = review.manifest.packageName
      ?? githubRoot?.manifest.packageName
      ?? githubSource?.repository.split('/')[1]
    if (!packageName) continue
    if (githubRoot?.manifest.packageName && review.manifest.packageName
      && githubRoot.manifest.packageName !== review.manifest.packageName) continue
    const repository = githubSource?.repository ?? `autoevo-local/${packageName}`
    if (!knownSourceMatchesRequest(
      input.requirement,
      input.intent,
      repository,
      packageName,
    )) continue

    const relatedInstall = [...input.installations]
      .filter((item) => item.reviewId === review.id || item.installSpec === review.installSpec)
      .filter((item) => matchesInstallationTarget(
        item,
        packageName,
        input.profile,
        input.dshHome,
      ))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
    const localEventAt = relatedInstall && newer(relatedInstall.createdAt, review.createdAt)
      ? relatedInstall.createdAt
      : review.createdAt
    if (input.newestExactInstallation && newer(input.newestExactInstallation.createdAt, localEventAt)) continue

    const sourceId = sourceIdFromLocalPath(review.sourceSnapshot.path)
    if (!sourceId) continue
    const failed = relatedInstall?.installOutcome === 'failed_absent'
    return knownSourceCandidate(packageName, repository, {
      kind: githubRoot ? (failed ? 'failed_install' : 'reviewed_snapshot') : 'managed_local',
      repository,
      commit: githubSource?.commit ?? review.sourceSnapshot.baseCommit,
      packageName,
      profile: input.profile,
      dependencySpec: review.installSpec,
      specDigest: dependencySpecDigest(review.installSpec),
      reviewId: review.id,
      sourceId,
      ...(relatedInstall?.id ? { installationId: relatedInstall.id } : {}),
    }, Boolean(failed), true, !githubRoot)
  }
  return undefined
}

export function lineageCandidateFromRecords(input: {
  requirement: string
  intent: RequestIntent
  reviews: readonly ReviewRecord[]
  installations: readonly InstallationRecord[]
  profile?: string
  dshHome?: string
  /** Review ids already validated against live Host-managed source receipts. */
  managedReviewIds?: readonly string[]
}): LocalCapabilityCandidate | undefined {
  if (input.intent.operation === 'reuse_existing') return undefined
  const profile = input.profile?.trim()
  const reviews = [...input.reviews]
    .filter((item) => item.sourceSnapshot.kind === 'github' && item.installSpec)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const installations = [...input.installations]
    .filter((item) => parseExactGithubDependency(item.installSpec))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))

  let bestReview: ReviewRecord | undefined
  for (const review of reviews) {
    if (review.sourceSnapshot.kind !== 'github') continue
    const packageName = review.manifest.packageName ?? review.sourceSnapshot.repository.split('/')[1] ?? review.sourceSnapshot.repository
    if (!knownSourceMatchesRequest(input.requirement, input.intent, review.sourceSnapshot.repository, packageName)) continue
    bestReview = review
    break
  }

  let bestInstall: InstallationRecord | undefined
  for (const installation of installations) {
    const parsed = parseExactGithubDependency(installation.installSpec)
    if (!parsed) continue
    const packageName = installation.packageName ?? parsed.repository.split('/')[1] ?? parsed.repository
    if ((profile || input.dshHome)
      && !matchesInstallationTarget(installation, packageName, profile, input.dshHome)) continue
    if (!knownSourceMatchesRequest(input.requirement, input.intent, parsed.repository, packageName)) continue
    bestInstall = installation
    break
  }
  const installationLineage = deriveInstallationLineage(input.installations)
  const bestEligibleLeaves = bestInstall
    ? installationLineage.eligibleLeavesFor(bestInstall)
    : []
  const bestInstallIsEligible = Boolean(bestInstall
    && bestEligibleLeaves.some((item) => item.id === bestInstall!.id))
  const ambiguousBestInstall = bestInstallIsEligible && bestEligibleLeaves.length > 1
  const liveBestInstall = bestInstallIsEligible && bestEligibleLeaves.length === 1
  if (ambiguousBestInstall) return undefined

  const managedSnapshot = managedSnapshotCandidate({
    requirement: input.requirement,
    intent: input.intent,
    reviews: input.reviews,
    installations: input.installations,
    profile: profile ?? 'web',
    ...(input.dshHome ? { dshHome: input.dshHome } : {}),
    managedReviewIds: new Set(input.managedReviewIds ?? []),
    ...(bestInstall ? { newestExactInstallation: bestInstall } : {}),
  })
  if (managedSnapshot) return managedSnapshot

  if (!bestReview && !bestInstall) return undefined

  const failedInstall = bestInstall?.installOutcome === 'failed_absent'
  const reviewKeepsFailedSpec = Boolean(failedInstall
    && bestReview?.installSpec
    && bestReview.installSpec === bestInstall?.installSpec)
  if (bestInstall && (!bestReview
    || newer(bestInstall.createdAt, bestReview.createdAt)
    || bestInstall.reviewId === bestReview.id
    || reviewKeepsFailedSpec)) {
    const parsed = parseExactGithubDependency(bestInstall.installSpec)
    if (!parsed) throw new EvolutionError('invalid_input', 'Known-source installation lost its exact GitHub specification')
    const failed = bestInstall.installOutcome === 'failed_absent'
    if (liveBestInstall) return undefined
    const packageName = bestInstall.packageName ?? parsed.repository.split('/')[1] ?? parsed.repository
    const target = evolutionTargetFromExactGithub({
      kind: failed ? 'failed_install' : 'reviewed_snapshot',
      packageName,
      profile: bestInstall.targetProfile,
      dependencySpec: bestInstall.installSpec,
      installation: bestInstall,
      ...(bestInstall.reviewId ? { reviewId: bestInstall.reviewId } : {}),
    })
    if (!target) return undefined
    return knownSourceCandidate(packageName, parsed.repository, target, failed)
  }

  if (!bestReview || bestReview.sourceSnapshot.kind !== 'github' || !bestReview.installSpec) return undefined
  const packageName = bestReview.manifest.packageName
    ?? bestReview.sourceSnapshot.repository.split('/')[1]
    ?? bestReview.sourceSnapshot.repository
  const target = evolutionTargetFromExactGithub({
    kind: 'reviewed_snapshot',
    packageName,
    profile: profile ?? 'web',
    dependencySpec: bestReview.installSpec,
    reviewId: bestReview.id,
  })
  if (!target) return undefined
  return knownSourceCandidate(packageName, bestReview.sourceSnapshot.repository, target, false)
}

function knownSourceCandidate(
  packageName: string,
  repository: string,
  target: NonNullable<LocalCapabilityCandidate['evolutionTarget']>,
  failed: boolean,
  managedSnapshot = false,
  managedLocal = false,
): LocalCapabilityCandidate {
  return {
    kind: 'plugin',
    name: packageName,
    description: failed
      ? managedSnapshot
        ? `A Host-managed repair of ${repository} exists, but its latest installation failed; Host can re-review the frozen repaired source`
        : `Previously reviewed ${repository} failed to activate; Host can review that frozen source again`
      : managedLocal
        ? `Completed Host-managed local capability ${packageName}; Host can re-review and continue editing it`
        : managedSnapshot
        ? `Completed Host-managed repair of ${repository}; Host can re-review and freeze it for this workflow`
        : `Previously reviewed ${repository} exact commit`,
    availability: 'known_source',
    confidence: 0.99,
    semanticFit: 'full',
    fit: 'partial',
    surfaceMatch: true,
    reuseEligible: false,
    matchedFacets: ['known_source'],
    missingFacets: [],
    evolutionTarget: target,
  }
}

export function mergeLineageCandidate(
  candidates: readonly LocalCapabilityCandidate[],
  lineage: LocalCapabilityCandidate | undefined,
): LocalCapabilityCandidate[] {
  if (!lineage?.evolutionTarget) return [...candidates]
  const target = lineage.evolutionTarget
  const existingIndex = candidates.findIndex((item) => item.kind === 'plugin'
    && (item.evolutionTarget?.repository.toLowerCase() === target.repository.toLowerCase()
      || item.profileEvidence?.packageName === target.packageName
      || item.name === target.packageName))
  if (existingIndex >= 0) {
    const existing = candidates[existingIndex]!
    if (existing.evolutionTarget
      && (existing.evolutionTarget.kind === 'github_exact' || existing.evolutionTarget.kind === 'owned_chain')) {
      return [...candidates]
    }
    const next = [...candidates]
    next[existingIndex] = {
      ...existing,
      evolutionTarget: existing.evolutionTarget ?? target,
      ...(existing.availability === 'installed_in_profile' ? {} : {
        availability: 'known_source' as const,
        reuseEligible: false,
        fit: existing.fit === 'none' ? 'none' : 'partial',
      }),
    }
    return next
  }
  return [lineage, ...candidates]
}

export function shouldSkipRemoteDiscovery(
  candidates: readonly LocalCapabilityCandidate[],
  intent: RequestIntent,
): boolean {
  if (candidates.some((item) => item.fit === 'full' && item.surfaceMatch !== false)) return true
  const known = candidates.some((item) => item.evolutionTarget)
  if (!known) return false
  if (intent.operation === 'evolve_existing') return true
  return candidates.some((item) => item.evolutionTarget?.kind === 'failed_install'
    || item.evolutionTarget?.kind === 'reviewed_snapshot')
}

export function isFailedSameSpecification(
  target: LocalCapabilityCandidate['evolutionTarget'] | undefined,
  installSpec: string | null | undefined,
): boolean {
  return Boolean(target
    && target.kind === 'failed_install'
    && installSpec
    && installSpec === target.dependencySpec)
}
