import {
  DEFAULT_REQUEST_INTENT,
  type LocalCapabilityCandidate,
  type RequestIntent,
  type RequestOperation,
  type RequiredSurface,
} from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { evolutionTargetFromProfile } from './installed-origin.js'

const OPERATIONS = new Set<RequestOperation>(['discover_or_reuse', 'reuse_existing', 'evolve_existing'])
const SURFACES = new Set<RequiredSurface>(['any', 'native_dsh_plugin'])
const INTENT_KEYS = new Set(['operation', 'required_surface', 'requiredSurface', 'target_name', 'targetName'])

export function intentIdentity(intent: RequestIntent): string {
  return [
    intent.operation,
    intent.requiredSurface,
    intent.targetName?.toLowerCase() ?? '',
  ].join('\0')
}

export function parseRequestIntent(value: unknown): RequestIntent {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EvolutionError('invalid_input', 'capability_workflow requires structured intent')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!INTENT_KEYS.has(key)) {
      throw new EvolutionError('invalid_input', 'intent does not accept Host-owned or unknown fields', { key })
    }
  }
  const operation = record.operation
  const requiredSurface = record.required_surface ?? record.requiredSurface
  const targetName = record.target_name ?? record.targetName
  if (typeof operation !== 'string' || !OPERATIONS.has(operation as RequestOperation)) {
    throw new EvolutionError('invalid_input', 'intent.operation must be discover_or_reuse, reuse_existing, or evolve_existing')
  }
  if (typeof requiredSurface !== 'string' || !SURFACES.has(requiredSurface as RequiredSurface)) {
    throw new EvolutionError('invalid_input', 'intent.required_surface must be any or native_dsh_plugin')
  }
  if (targetName !== undefined) {
    if (typeof targetName !== 'string' || !targetName.trim() || targetName.trim().length > 214) {
      throw new EvolutionError('invalid_input', 'intent.target_name must be 1 to 214 characters')
    }
  }
  return {
    operation: operation as RequestOperation,
    requiredSurface: requiredSurface as RequiredSurface,
    ...(typeof targetName === 'string' ? { targetName: targetName.trim() } : {}),
  }
}

export function surfaceSatisfiesIntent(
  candidate: Pick<LocalCapabilityCandidate, 'kind'>,
  intent: RequestIntent,
): boolean {
  if (intent.requiredSurface === 'any') return true
  return candidate.kind === 'plugin'
}

function isNamedTarget(candidate: Pick<LocalCapabilityCandidate, 'name' | 'profileEvidence'>, intent: RequestIntent): boolean {
  if (!intent.targetName) return true
  const wanted = intent.targetName.toLowerCase()
  return candidate.name.toLowerCase() === wanted
    || candidate.profileEvidence?.packageName.toLowerCase() === wanted
}

export function applyIntentToCandidate(
  candidate: LocalCapabilityCandidate,
  intent: RequestIntent = DEFAULT_REQUEST_INTENT,
): LocalCapabilityCandidate {
  const semanticFit = candidate.semanticFit ?? candidate.fit ?? 'none'
  const surfaceMatch = surfaceSatisfiesIntent(candidate, intent)
  const named = isNamedTarget(candidate, intent)
  let requestFit = semanticFit
  if (!surfaceMatch || !named) requestFit = 'none'
  else if (intent.operation === 'evolve_existing' && candidate.availability === 'installed_in_profile' && requestFit === 'full') {
    requestFit = 'partial'
  }
  const reuseEligible = surfaceMatch && named && semanticFit === 'full'
  const evolutionTarget = candidate.profileEvidence && named && intent.operation !== 'reuse_existing'
    ? evolutionTargetFromProfile({
        packageName: candidate.profileEvidence.packageName,
        profile: candidate.profileEvidence.profile,
        dependencySpec: candidate.profileEvidence.dependencySpec,
      })
    : candidate.evolutionTarget
  return {
    ...candidate,
    semanticFit,
    fit: requestFit,
    surfaceMatch,
    reuseEligible,
    ...(evolutionTarget ? { evolutionTarget } : {}),
  }
}

export function suppressesRemoteDiscovery(candidates: readonly LocalCapabilityCandidate[]): boolean {
  return candidates.some((candidate) => candidate.fit === 'full' && candidate.surfaceMatch !== false)
}
