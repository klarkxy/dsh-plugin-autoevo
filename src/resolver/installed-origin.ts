import type { EvolutionTarget, EvolutionTargetKind, InstallationRecord } from '../contracts.js'
import { hashObject } from '../state/hashes.js'

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}'
const REPO = '[A-Za-z0-9._-]+'
const SHA = '[a-f0-9]{40}'
const EXACT_GITHUB = new RegExp(`^github:(${OWNER})/(${REPO})#(${SHA})$`, 'u')

export function dependencySpecDigest(spec: string): string {
  return hashObject({ spec })
}

export function parseExactGithubDependency(spec: string): { repository: string; commit: string } | undefined {
  const match = EXACT_GITHUB.exec(spec.trim())
  if (!match) return undefined
  return { repository: `${match[1]}/${match[2]}`, commit: match[3]! }
}

export function evolutionTargetFromExactGithub(input: {
  kind: EvolutionTargetKind
  packageName: string
  profile: string
  dependencySpec: string
  installation?: Pick<InstallationRecord, 'id' | 'reviewId' | 'removed'>
  reviewId?: string
}): EvolutionTarget | undefined {
  const parsed = parseExactGithubDependency(input.dependencySpec)
  if (!parsed) return undefined
  const reviewId = input.reviewId ?? input.installation?.reviewId
  return {
    kind: input.kind,
    repository: parsed.repository,
    commit: parsed.commit,
    packageName: input.packageName,
    profile: input.profile,
    dependencySpec: input.dependencySpec,
    specDigest: dependencySpecDigest(input.dependencySpec),
    ...(input.installation?.id ? { installationId: input.installation.id } : {}),
    ...(reviewId ? { reviewId } : {}),
  }
}

export function evolutionTargetFromProfile(input: {
  packageName: string
  profile: string
  dependencySpec: string
}): EvolutionTarget | undefined {
  const parsed = parseExactGithubDependency(input.dependencySpec)
  if (!parsed) return undefined
  return evolutionTargetFromExactGithub({
    kind: 'github_exact',
    packageName: input.packageName,
    profile: input.profile,
    dependencySpec: input.dependencySpec,
  })
}
