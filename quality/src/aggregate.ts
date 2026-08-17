import type { QualityAssessment, QualityClass, QualityObservation } from './protocol.js'

export const MIN_INDEPENDENT_FOR_NEGATIVE = 3
export const MIN_INDEPENDENT_FOR_JUNK = 6
export const HALF_LIFE_DAYS = 30

export interface AggregateOptions {
  now?: number
  minIndependentForNegative?: number
  minIndependentForJunk?: number
  halfLifeDays?: number
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

function decay(createdAt: string, now: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now - Date.parse(createdAt)) / 86_400_000)
  return 2 ** (-ageDays / halfLifeDays)
}

function independenceKey(item: QualityObservation): string {
  return [
    item.repository.toLowerCase(),
    item.commit,
    item.policyVersion,
    item.autoevoVersion,
    item.stage,
    dayKey(item.createdAt),
  ].join('|')
}

function bucket(item: QualityObservation): 'good' | 'repairable' | 'broken' | 'junk' {
  if (item.reasonCodes.includes('spam') || item.reasonCodes.includes('junk')) return 'junk'
  if (item.stage === 'verification') {
    if (item.outcome === 'verified') return 'good'
    if (item.outcome === 'verification_failed') return 'broken'
    return 'repairable'
  }
  if (item.stage === 'install') {
    if (item.outcome === 'installed') return 'good'
    if (item.outcome === 'not_installed') return 'broken'
    return 'repairable'
  }
  if (item.outcome === 'usable' || item.repairability === 'ready') return 'good'
  if (item.outcome === 'repairable' || item.repairability === 'repairable') return 'repairable'
  if (item.outcome === 'unusable') return 'broken'
  return 'repairable'
}

function score(weights: { good: number, repairable: number, broken: number, junk: number }, key: 'good' | 'repairable'): number | null {
  const total = weights.good + weights.repairable + weights.broken + weights.junk
  return total === 0 ? null : Number((weights[key] / total).toFixed(4))
}

export function aggregateRepository(
  repository: string,
  observations: readonly QualityObservation[],
  options: AggregateOptions = {},
): QualityAssessment {
  const now = options.now ?? Date.now()
  const halfLifeDays = options.halfLifeDays ?? HALF_LIFE_DAYS
  const minNegative = options.minIndependentForNegative ?? MIN_INDEPENDENT_FOR_NEGATIVE
  const minJunk = options.minIndependentForJunk ?? MIN_INDEPENDENT_FOR_JUNK
  const weights = { good: 0, repairable: 0, broken: 0, junk: 0 }
  const independent = new Set<string>()
  const reasonCodes = new Set<string>()
  let updatedAt: string | null = null
  const seen = new Set<string>()

  for (const item of observations) {
    if (item.repository.toLowerCase() !== repository.toLowerCase()) continue
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const key = independenceKey(item)
    independent.add(key)
    const weight = decay(item.createdAt, now, halfLifeDays)
    weights[bucket(item)] += weight
    for (const code of item.reasonCodes) reasonCodes.add(code)
    if (!updatedAt || item.createdAt > updatedAt) updatedAt = item.createdAt
  }

  const independentCount = independent.size
  const total = weights.good + weights.repairable + weights.broken + weights.junk
  const usable = weights.good + weights.repairable
  let classification: QualityClass = 'unknown'
  if (independentCount === 0 || total === 0) {
    classification = 'unknown'
  } else if (weights.junk >= usable && independentCount >= minJunk && weights.good === 0) {
    classification = 'junk'
  } else if (weights.broken > usable && independentCount >= minNegative) {
    classification = 'broken'
  } else if (weights.repairable >= weights.good && weights.repairable > 0) {
    classification = 'repairable'
  } else if (weights.good > 0) {
    classification = 'good'
  }

  return {
    repository,
    classification,
    repairability: score(weights, 'repairable'),
    evolutionValue: score(weights, 'good') === null && score(weights, 'repairable') === null
      ? null
      : Number((((weights.repairable * 0.7) + (weights.good * 0.4)) / Math.max(total, 1)).toFixed(4)),
    confidence: independentCount === 0 ? null : Number(Math.min(1, independentCount / minJunk).toFixed(4)),
    observationCount: seen.size,
    reasonCodes: [...reasonCodes].sort().slice(0, 24),
    updatedAt,
  }
}

export function aggregateAll(
  observations: readonly QualityObservation[],
  options: AggregateOptions = {},
): QualityAssessment[] {
  const repositories = [...new Set(observations.map((item) => item.repository))]
    .sort((left, right) => left.localeCompare(right))
  return repositories
    .map((repository) => aggregateRepository(repository, observations, options))
    .filter((item) => item.classification !== 'unknown' || item.observationCount > 0)
}
