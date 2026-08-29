import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { valid } from 'semver'
import type { RuntimeConfig } from './config.js'
import type { ResolutionRecord, ReviewMode, ReviewRecord } from './contracts.js'
import { EvolutionError } from './errors.js'
import type { DshLauncher } from './lifecycle/launcher.js'
import type { CommandRunner } from './process/runner.js'
import {
  isDirectlyUsableReview,
  reviewLocalPlugin,
} from './review/index.js'
import type { SourceManager } from './source-manager.js'
import { hashObject, sha256 } from './state/hashes.js'
import type { StateStore } from './state/store.js'
import type { WorkflowExec, WorkflowRecord } from './workflow/contracts.js'
import { resolveStateRoot } from './workspace-layout.js'
import { waitingConfirmation, withNextStep } from './service-resolution.js'

export interface ReviewOrchestrationDeps {
  runner: CommandRunner
  config: RuntimeConfig
  launcher: DshLauncher
  store: StateStore
  sources: SourceManager
}

export function lineageRootReview(base: ReviewRecord, reviews: readonly ReviewRecord[]): ReviewRecord {
  const byId = new Map(reviews.map((item) => [item.id, item]))
  byId.set(base.id, base)
  const seen = new Set<string>()
  let current = base
  while (current.sourceSnapshot.kind === 'local') {
    if (seen.has(current.id)) {
      throw new EvolutionError('invalid_input', 'baseReviewId lineage is cyclic')
    }
    seen.add(current.id)
    const parent = byId.get(current.sourceSnapshot.baseReviewId)
    if (!parent) {
      throw new EvolutionError('invalid_input', 'baseReviewId must belong to a GitHub review lineage on the same resolution')
    }
    current = parent
  }
  return current
}

export function materialReviewFacts(review: ReviewRecord): unknown {
  const sourceIdentity = review.sourceSnapshot.kind === 'github'
    ? {
        kind: 'github' as const,
        repository: review.sourceSnapshot.repository,
        commit: review.sourceSnapshot.commit,
      }
    : review.sourceSnapshot
  return {
    policyVersion: review.policyVersion,
    requirement: review.requirement,
    sourceIdentity,
    inspectedFiles: review.inspectedFiles,
    artifact: review.artifact,
    manifest: review.manifest,
    compatibility: review.compatibility,
  }
}

export function shouldReviewAdaptiveThird(
  mode: ReviewMode,
  reviews: ReviewRecord[],
  workflow?: WorkflowRecord,
): boolean {
  return mode === 'fixed' || !reviews.some((item) => isDirectlyUsableReview(item, workflow))
}

export async function dshRuntimeVersion(
  deps: Pick<ReviewOrchestrationDeps, 'runner' | 'config'>,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await deps.runner.run({
      argv: [deps.config.dshCommand, ...deps.config.dshCommandArgs, '--version'],
      cwd,
      allowFailure: true,
      timeoutMs: deps.config.commandTimeoutMs,
      ...(signal ? { signal } : {}),
    })
    if (result.exitCode !== 0) return undefined
    const candidate = result.stdout.trim().split(/\s+/u)[0]
    return candidate ? valid(candidate) ?? undefined : undefined
  } catch {
    return undefined
  }
}

export async function reviewAndFreezeManagedSource(
  deps: ReviewOrchestrationDeps,
  input: {
    resolution: ResolutionRecord
    sourceId: string
    path: string
    baseReviewId: string
    lineageRootCommit: string
    workflowId: string
    exec: WorkflowExec
  },
): Promise<{ resolution: ResolutionRecord; review: ReviewRecord }> {
  const runtimeVersion = await dshRuntimeVersion(deps, input.resolution.cwd, input.exec.signal)
  const artifactRoot = path.join(resolveStateRoot(deps.config, input.resolution.cwd), 'review-artifacts', `review-${randomUUID()}`)
  const local = await reviewLocalPlugin({
    runner: deps.runner,
    config: deps.config,
    // The receipt has already bound this exact managed path. Its parent is
    // the narrowest valid review root and preserves legacy stateDir sources.
    workspaceRoot: path.dirname(input.path),
    path: input.path,
    baseReviewId: input.baseReviewId,
    lineageRootCommit: input.lineageRootCommit,
    resolutionId: input.resolution.id,
    requirement: input.resolution.requirement,
    artifactRoot,
    ...(runtimeVersion ? { runtimeVersion } : {}),
  })
  const review = local.record
  if (!review.artifact) throw new EvolutionError('review_rejected', 'Managed review did not produce a frozen package artifact')
  await deps.store.put('reviews', review)
  await deps.sources.recordReviewedArtifact({
    sourceId: input.sourceId,
    workflowId: input.workflowId,
    reviewId: review.id,
    artifactHash: review.artifact.sha256,
  })
  const waiting = withNextStep(waitingConfirmation(input.resolution, review))
  await deps.store.put('resolutions', waiting)
  return { resolution: waiting, review }
}

export async function revalidateReview(
  _deps: Pick<ReviewOrchestrationDeps, 'runner' | 'config' | 'store' | 'sources'>,
  review: ReviewRecord,
  _signal?: AbortSignal,
): Promise<boolean> {
  if (review.artifact && review.installSpec?.startsWith('file:')) {
    const artifactPath = path.resolve(review.installSpec.slice('file:'.length))
    const ownedRoot = path.resolve(review.artifact.ownedRoot)
    const relative = path.relative(ownedRoot, artifactPath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false
    const current = await readFile(artifactPath).catch(() => undefined)
    return Boolean(current && sha256(current) === review.artifact.sha256)
  }
  // Historical source-only reviews remain readable, but are not current
  // installation authority. A fresh formal review creates a frozen artifact.
  return false
}
