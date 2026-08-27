import { satisfies, valid, validRange } from 'semver'
import type { ResolutionRecord, ReviewRecord } from './contracts.js'
import { createCreatorWorkOrder, type CreatorWorkOrder } from './creator-foundation.js'
import { hostDirectUseBoundary } from './review/index.js'
import { hashObject } from './state/hashes.js'
import type {
  ModificationAttemptEvidence,
  ModificationBlocker,
  ModificationOutcome,
} from './workflow/contracts.js'

const MAX_BLOCKER_SUMMARY = 500

function boundedReviewText(value: string, limit = MAX_BLOCKER_SUMMARY): string {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

export function modificationBlockers(review: ReviewRecord): ModificationBlocker[] {
  const blockers = new Map<string, ModificationBlocker>()
  if (review.compatibility.status === 'incompatible') {
    const runtime = review.compatibility.runtimeVersion && valid(review.compatibility.runtimeVersion)
    const incompatiblePeers = runtime
      ? Object.entries(review.manifest.peerDependencies)
        .filter(([name, range]) => name.startsWith('@deepseek-ai/dsh-')
          && (!validRange(range) || !satisfies(runtime, range, { includePrerelease: true })))
      : []
    if (incompatiblePeers.length > 0) {
      for (const [name, range] of incompatiblePeers) {
        const key = `compatibility:${hashObject({ name, runtime }).slice(0, 24)}`
        blockers.set(key, {
          key,
          kind: 'compatibility',
          summary: boundedReviewText(`${name} peer range ${range} excludes active runtime ${runtime}.`),
        })
      }
    } else {
      const summary = boundedReviewText(review.compatibility.reason)
      const key = `compatibility:${hashObject({ summary, runtime: review.compatibility.runtimeVersion }).slice(0, 24)}`
      blockers.set(key, { key, kind: 'compatibility', summary })
    }
  }
  for (const capability of review.missingCapabilities) {
    const summary = boundedReviewText(capability)
    const key = `missing:${hashObject(summary).slice(0, 16)}`
    blockers.set(key, { key, kind: 'missing_capability', summary })
  }
  for (const finding of review.findings.filter((item) => item.severity === 'block')) {
    const source = boundedReviewText(finding.source, 200)
    const identityEvidence = finding.evidenceHash ?? boundedReviewText(finding.detail, 300)
    const key = `finding:${hashObject({ code: finding.code, source, identityEvidence }).slice(0, 24)}`
    blockers.set(key, {
      key,
      kind: 'security_finding',
      summary: boundedReviewText(`${finding.code} at ${finding.source}: ${finding.detail}`),
    })
  }
  const boundary = hostDirectUseBoundary(review)
  if (boundary === 'not_materializable') {
    blockers.set(`host_boundary:${boundary}`, {
      key: `host_boundary:${boundary}`,
      kind: 'host_boundary',
      summary: 'The reviewed source cannot yet be materialized as an installable DSH bundle.',
    })
  }
  return [...blockers.values()]
}

function blockerStillPresent(blocker: ModificationBlocker, review: ReviewRecord): boolean {
  return modificationBlockers(review).some((current) => current.key === blocker.key)
}

export function modificationDelta(baseline: readonly ModificationBlocker[], review: ReviewRecord): {
  resolved: ModificationBlocker[]
  unresolved: ModificationBlocker[]
  introduced: ModificationBlocker[]
} {
  const baselineKeys = new Set(baseline.map((item) => item.key))
  return {
    resolved: baseline.filter((item) => !blockerStillPresent(item, review)),
    unresolved: baseline.filter((item) => blockerStillPresent(item, review)),
    introduced: modificationBlockers(review).filter((item) => !baselineKeys.has(item.key)),
  }
}

export function modificationAcceptance(input: {
  baselineReview: ReviewRecord
  baselineBlockers: readonly ModificationBlocker[]
  postReview: ReviewRecord
  meaningfulInstruction: boolean
  attempt: number
}): ReturnType<typeof modificationDelta> & {
  evaluatorStable: boolean
  status: ModificationOutcome['status']
  canCorrect: boolean
} {
  const delta = modificationDelta(input.baselineBlockers, input.postReview)
  const evaluatorStable = input.postReview.policyVersion === input.baselineReview.policyVersion
    && input.postReview.compatibility.runtimeVersion === input.baselineReview.compatibility.runtimeVersion
  const status: ModificationOutcome['status'] = !evaluatorStable
    ? 'indeterminate'
    : delta.unresolved.length > 0 || delta.introduced.length > 0
      ? 'unresolved'
      : input.meaningfulInstruction ? 'indeterminate' : 'resolved'
  return {
    ...delta,
    evaluatorStable,
    status,
    canCorrect: input.attempt === 1
      && evaluatorStable
      && delta.unresolved.length > 0
      && delta.introduced.length === 0,
  }
}

const TOOLCHAIN_TOKEN = String.raw`vitest|\btsc\b|typescript|typecheck|test runner|dev toolchain|\btoolchain\b`
const TOOLCHAIN_MISSING = String.raw`unavailable|not (?:found|installed|present|available)|is not recognized|command not found|ENOENT|未安装|不可用|找不到|缺失`
const TEST_FAILURE = String.raw`(?:tests?|test run).{0,60}(?:failed|failure)|测试.{0,40}失败`
const CLAUSE_BREAKS = new Set(['.', ';', '\n', '。', '；'])

function reportsUnavailableLocalToolchain(report: string): boolean {
  return new RegExp(String.raw`(?:${TOOLCHAIN_TOKEN}).{0,80}(?:${TOOLCHAIN_MISSING})`, 'iu').test(report)
    || new RegExp(String.raw`(?:${TOOLCHAIN_MISSING}).{0,80}(?:${TOOLCHAIN_TOKEN})`, 'iu').test(report)
    || /(?:cannot find|can't find|could not find) (?:module|package) ['"`]?(?:vitest|typescript|tsc)\b/iu.test(report)
    || /本地(?:开发)?(?:测试)?工具链?.{0,24}(?:不可用|未安装|缺失)/iu.test(report)
}

function clauseContaining(text: string, start: number, end: number): string {
  let from = 0
  for (let i = start - 1; i >= 0; i--) {
    if (CLAUSE_BREAKS.has(text[i]!)) {
      from = i + 1
      break
    }
  }
  let to = text.length
  for (let i = end; i < text.length; i++) {
    if (CLAUSE_BREAKS.has(text[i]!)) {
      to = i
      break
    }
  }
  return text.slice(from, to)
}

function reportsGenuineTestFailure(report: string): boolean {
  // Tight assertion evidence is independent of a missing sibling tool such as tsc.
  if (/\bAssertionError\b|\b\d+ failing assertions?\b|\bexpected \d+ to (?:be|equal) \d+\b/iu.test(report)) return true
  for (const match of report.matchAll(new RegExp(TEST_FAILURE, 'giu'))) {
    const start = match.index
    const clause = clauseContaining(report, start, start + match[0].length)
    // "npm test failed because vitest is not recognized" stays unavailable; unexplained test failures do not.
    if (!reportsUnavailableLocalToolchain(clause)) return true
  }
  return false
}

export function childCheckEvidence(taskResult: string): ModificationAttemptEvidence['checks'] {
  const report = taskResult.replace(/\s*AUTOEVO_CHILD_COMPLETED\s*$/u, '')
  if (reportsGenuineTestFailure(report)) {
    return {
      source: 'child_reported',
      status: 'failed',
      summary: 'The managed child reported that tests failed; Host did not independently observe the command result.',
    }
  }
  // Command failures caused only by missing local tools are not assertion failures.
  if (reportsUnavailableLocalToolchain(report)) {
    return {
      source: 'child_reported',
      status: 'unavailable',
      summary: 'Checks could not run because the local toolchain was unavailable; the plugin is not verified. The managed child reported missing local test tools; Host did not independently observe the command result.',
    }
  }
  if (/skipped (?:the )?(?:test|tests|test run)|tests? (?:were )?not run|未运行测试|跳过测试/iu.test(report)) {
    return { source: 'child_reported', status: 'skipped', summary: 'The managed child reported that tests were skipped.' }
  }
  if (/(?:tests?|test run).{0,60}(?:passed|successful)|测试.{0,40}通过/iu.test(report)) {
    return { source: 'child_reported', status: 'passed', summary: 'The managed child reported that tests passed; Host did not independently observe the command result.' }
  }
  if (new RegExp(TEST_FAILURE, 'iu').test(report)) {
    return { source: 'child_reported', status: 'failed', summary: 'The managed child reported that tests failed; Host did not independently observe the command result.' }
  }
  return { source: 'unknown', status: 'unknown', summary: 'Host did not independently observe a test command result.' }
}

export function authenticatedModificationInstruction(resolution: ResolutionRecord, review: ReviewRecord): string | undefined {
  return [...(resolution.decisions ?? [])].reverse().find((item) => item.phase === 'gate2'
    && item.action === 'modify_this'
    && item.reviewId === review.id)?.userMessage?.trim()
}

export function hasMeaningfulModificationInstruction(instruction: string | undefined): instruction is string {
  if (!instruction) return false
  const normalized = instruction.normalize('NFKC').trim().toLowerCase()
  return !new Set(['modify_this', 'modify', '在这个上改', '修改这个', '改这个', '先改进已审查候选']).has(normalized)
}

export function modificationWorkOrder(
  resolution: ResolutionRecord,
  review: ReviewRecord,
  cwd: string,
  blockers = modificationBlockers(review),
  focusedCorrection = false,
  lineageKind?: import('./contracts.js').EvolutionTargetKind,
): CreatorWorkOrder {
  const userInstruction = authenticatedModificationInstruction(resolution, review)
  const repairFiber = lineageKind === 'failed_install'
    || resolution.intent?.evolveReason === 'repair'
    || /fiber was not present after loader settle/iu.test(resolution.reasons.join('\n'))
    || /loader|wrapping fiber|包装/iu.test(resolution.requirement)
  const effectiveBlockers = repairFiber
    ? blockers.filter((item) => item.kind !== 'missing_capability')
    : blockers
  return createCreatorWorkOrder({
    operation: focusedCorrection ? 'correct' : 'modify',
    requirement: resolution.requirement,
    cwd,
    blockers: effectiveBlockers,
    baselineReviewId: review.id,
    acceptanceTargets: [
      focusedCorrection
        ? 'Investigate why the remaining Host-observed blockers persist'
        : 'Host re-review must no longer report the baseline blockers',
      'Host re-review must not introduce a new blocking target',
      'Preserve package identity and choose the implementation path without expanding scope',
      ...(repairFiber
        ? ['Host re-review and later install must produce a Loader-visible wrapping Fiber; do not reinstall the failed specification unchanged']
        : []),
      ...(userInstruction ? [`Apply the authenticated user modification instruction: ${userInstruction}`] : []),
    ],
  })
}
