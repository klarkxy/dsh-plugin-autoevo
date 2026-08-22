import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeConfig } from '../config.js'
import type { ReviewRecord, VerificationEvidence, VerificationLayerKind, VerificationStatus } from '../contracts.js'
import {
  declaredVerificationFixturesFromPackage,
  hostLayerSuccess,
  hostVerificationOverlay,
  sanitizeHostVerificationEvidence,
  verificationChildEnv,
  type HostExecutableFixture,
} from '../host-verification-driver.js'
import { EvolutionError } from '../errors.js'
import { assertSafePackageName } from '../package-name.js'
import type { CommandResult, CommandRunner } from '../process/runner.js'
import { sha256 } from '../state/hashes.js'
import { materializeLocalPackage, type MaterializedLocalPackage } from './snapshot.js'

interface SessionFile {
  path: string
  modifiedAt: number
}

interface ReceiptEvidence {
  calledTools: string[]
  resultTools: string[]
  failedTools: string[]
  taskResultObserved: boolean
  taskResultSha256?: string
  taskResultMatchedExpectation?: boolean
  observedProvider?: string
  observedModel?: string
  observerEventCount: number
  layer?: VerificationLayerKind
  status?: VerificationStatus
  sourceMatched?: boolean
  executedCount?: number
  completeReason?: string
}

/** Host mechanical verification truth. Substring expectation is never used here. */
export function hostMechanicalSuccess(input: {
  sourceMatched: boolean
  verification: Pick<VerificationEvidence, 'attempted' | 'exitCode' | 'expectedTools' | 'calledTools' | 'resultTools' | 'failedTools' | 'taskResultObserved' | 'routeMatchedExpectation'>
}): boolean {
  const evidence = input.verification
  if (!input.sourceMatched || !evidence.attempted || evidence.exitCode !== 0 || !evidence.taskResultObserved) {
    return false
  }
  if (evidence.routeMatchedExpectation === false) return false
  const expected = evidence.expectedTools
  if (expected.length === 0) return true
  return expected.every((name) => evidence.calledTools.includes(name)
    && evidence.resultTools.includes(name)
    && !evidence.failedTools.includes(name))
}

async function collectSessionFiles(root: string): Promise<SessionFile[]> {
  const result: SessionFile[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile() && (entry.name.endsWith('.jsonl.zstd') || entry.name.endsWith('.jsonl'))) {
        const facts = await stat(target)
        result.push({ path: target, modifiedAt: facts.mtimeMs })
      }
    }
  }
  await visit(root)
  return result
}

async function readReceipt(receiptPath: string): Promise<ReceiptEvidence> {
  let body: string
  try {
    body = await readFile(receiptPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { calledTools: [], resultTools: [], failedTools: [], taskResultObserved: false, observerEventCount: 0 }
    }
    throw error
  }

  const calls = new Map<string, string>()
  const latestCall = new Map<string, string>()
  const outcomes = new Map<string, boolean>()
  const called = new Set<string>()
  const successful = new Set<string>()
  const hostFailed = new Set<string>()
  let taskResultSha256: string | undefined
  let taskResultMatchedExpectation: boolean | undefined
  let observedProvider: string | undefined
  let observedModel: string | undefined
  let observerEventCount = 0
  let layer: VerificationLayerKind | undefined
  let status: VerificationStatus | undefined
  let sourceMatched: boolean | undefined
  let executedCount: number | undefined
  let completeReason: string | undefined
  for (const line of body.split(/\r?\n/u)) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    const event = value as Record<string, unknown>
    if (event.kind === 'host/complete') {
      observerEventCount += 1
      if (event.layer === 'bundle_activation' || event.layer === 'tool_roundtrip' || event.layer === 'manual_runtime') {
        layer = event.layer
      }
      if (
        event.status === 'passed'
        || event.status === 'pending_user_test'
        || event.status === 'blocked_precondition'
        || event.status === 'failed'
        || event.status === 'uncertain'
      ) {
        status = event.status
      }
      if (typeof event.sourceMatched === 'boolean') sourceMatched = event.sourceMatched
      if (typeof event.executedCount === 'number' && Number.isFinite(event.executedCount)) {
        executedCount = event.executedCount
      }
      if (typeof event.reason === 'string' && event.reason) completeReason = event.reason
      if (Array.isArray(event.calledTools)) {
        for (const name of event.calledTools) if (typeof name === 'string') called.add(name)
      }
      if (Array.isArray(event.resultTools)) {
        for (const name of event.resultTools) if (typeof name === 'string') successful.add(name)
      }
      if (Array.isArray(event.failedTools)) {
        for (const name of event.failedTools) if (typeof name === 'string') hostFailed.add(name)
      }
      continue
    }
    if (event.kind === 'task/result' && typeof event.resultSha256 === 'string' && /^[a-f0-9]{64}$/u.test(event.resultSha256)) {
      observerEventCount += 1
      taskResultSha256 = event.resultSha256
      taskResultMatchedExpectation = typeof event.matchedExpectation === 'boolean' ? event.matchedExpectation : undefined
      if (typeof event.provider === 'string' && event.provider.length > 0) observedProvider = event.provider
      if (typeof event.model === 'string' && event.model.length > 0) observedModel = event.model
      continue
    }
    if (typeof event.callId !== 'string' || typeof event.name !== 'string') continue
    if (event.kind === 'tool/call') {
      observerEventCount += 1
      calls.set(event.callId, event.name)
      latestCall.set(event.name, event.callId)
      called.add(event.name)
      continue
    }
    if (event.kind !== 'tool/result' || calls.get(event.callId) !== event.name) continue
    observerEventCount += 1
    if (event.isError === false) successful.add(event.name)
    if (typeof event.isError === 'boolean') outcomes.set(event.callId, !event.isError)
  }
  const callFailed = [...latestCall]
    .filter(([, callId]) => outcomes.get(callId) !== true)
    .map(([name]) => name)
  const failedTools = [...new Set([...callFailed, ...hostFailed])].sort()
  return {
    calledTools: [...called].sort(),
    resultTools: [...successful].sort(),
    // Call order, rather than asynchronous result-arrival order, determines
    // the final attempt. A latest call without a successful result also fails.
    failedTools,
    taskResultObserved: Boolean(taskResultSha256),
    observerEventCount,
    ...(taskResultSha256 ? { taskResultSha256 } : {}),
    ...(taskResultMatchedExpectation !== undefined ? { taskResultMatchedExpectation } : {}),
    ...(observedProvider ? { observedProvider } : {}),
    ...(observedModel ? { observedModel } : {}),
    ...(layer ? { layer } : {}),
    ...(status ? { status } : {}),
    ...(sourceMatched !== undefined ? { sourceMatched } : {}),
    ...(executedCount !== undefined ? { executedCount } : {}),
    ...(completeReason ? { completeReason } : {}),
  }
}

function verificationOverlay(
  receiptPath: string,
  expectedTools: readonly string[],
  expectedText?: string,
  expectedRoute?: { provider: string; model?: string },
): unknown[] {
  // tsdown bundles lifecycle code into lib/index.js while emitting the observer
  // as a sibling entry, so this URL must stay relative to that bundled artifact.
  const observerUrl = new URL('./verification-observer.js', import.meta.url).href
  return [{
    insert: [{
      id: `autoevo-verification-${randomUUID()}`,
      name: observerUrl,
      config: {
        receiptPath,
        expectedTools: [...expectedTools],
        ...(expectedText ? { expectedText } : {}),
        ...(expectedRoute ? {
          expectedProvider: expectedRoute.provider,
          ...(expectedRoute.model ? { expectedModel: expectedRoute.model } : {}),
        } : {}),
      },
    }],
  }]
}

export class DshLauncher {
  constructor(
    private readonly runner: CommandRunner,
    private readonly config: RuntimeConfig,
  ) {}

  materializeLocal(
    review: ReviewRecord,
    artifactRoot: string,
    signal?: AbortSignal,
  ): Promise<MaterializedLocalPackage> {
    return materializeLocalPackage({
      review,
      artifactRoot,
      config: this.config,
      runner: this.runner,
      ...(signal ? { signal } : {}),
    })
  }

  private argv(...args: string[]): [string, ...string[]] {
    return [this.config.dshCommand, ...this.config.dshCommandArgs, ...args]
  }

  private childEnv(dshHome: string, forwardCredentials = true): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { DSH_HOME: dshHome }
    if (forwardCredentials) {
      for (const name of this.config.forwardedCredentialEnv) {
        const value = process.env[name]
        if (value !== undefined) env[name] = value
      }
    }
    return env
  }

  async install(
    dshHome: string,
    profile: string,
    spec: string,
    cwd: string,
    signal?: AbortSignal,
    options?: { forwardCredentials?: boolean },
  ): Promise<CommandResult> {
    await mkdir(dshHome, { recursive: true })
    const request = {
      argv: this.argv('plugin', '--profile', profile, 'add', '--save-exact', spec),
      cwd,
      env: this.childEnv(dshHome, options?.forwardCredentials !== false),
      timeoutMs: Math.max(this.config.commandTimeoutMs, 120_000),
    }
    return this.runner.run(signal ? { ...request, signal } : request)
  }

  async remove(
    dshHome: string,
    profile: string,
    packageName: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const safePackageName = assertSafePackageName(packageName)
    const request = {
      argv: this.argv('plugin', '--profile', profile, 'remove', safePackageName),
      cwd,
      env: this.childEnv(dshHome),
      timeoutMs: Math.max(this.config.commandTimeoutMs, 120_000),
    }
    return this.runner.run(signal ? { ...request, signal, allowFailure: true } : { ...request, allowFailure: true })
  }

  async hasProfileDependency(dshHome: string, profile: string, packageName: string): Promise<boolean> {
    const safePackageName = assertSafePackageName(packageName)
    try {
      const body = await readFile(path.join(dshHome, 'profiles', profile, 'package.json'), 'utf8')
      const manifest: unknown = JSON.parse(body)
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false
      const dependencies = (manifest as { dependencies?: unknown }).dependencies
      return Boolean(dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)
        && Object.hasOwn(dependencies, safePackageName))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  /** Verify that the target profile records the exact reviewed source and loads that bundle. */
  async profileSourceMatches(
    dshHome: string,
    profile: string,
    packageName: string,
    expectedSpec: string,
  ): Promise<boolean> {
    const safePackageName = assertSafePackageName(packageName)
    const body = await readFile(path.join(dshHome, 'profiles', profile, 'package.json'), 'utf8')
    const manifest: unknown = JSON.parse(body)
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false
    const record = manifest as {
      dependencies?: unknown
      dsh?: { profile?: { bundles?: unknown } }
    }
    const dependencies = record.dependencies
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return false
    if ((dependencies as Record<string, unknown>)[safePackageName] !== expectedSpec) return false
    const bundles = record.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes(safePackageName)
  }

  /** Confirm absence in both the profile manifest and its visible node_modules target. */
  async profileTargetAbsent(dshHome: string, profile: string, packageName: string): Promise<boolean> {
    const safePackageName = assertSafePackageName(packageName)
    if (await this.hasProfileDependency(dshHome, profile, safePackageName)) return false
    const packagePath = path.join(
      dshHome,
      'profiles',
      profile,
      'node_modules',
      ...safePackageName.split('/'),
    )
    try {
      await stat(packagePath)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  }

  async verify(
    dshHome: string,
    profile: string,
    cwd: string,
    task: string,
    expectedTools: readonly string[],
    expectedText?: string,
    expectedRoute?: { provider: string; model?: string },
    signal?: AbortSignal,
  ): Promise<VerificationEvidence> {
    const startedAt = Date.now()
    const before = new Set((await collectSessionFiles(dshHome)).map((file) => file.path))
    const verificationRoot = path.join(this.config.stateDir, 'verifications', randomUUID())
    const receiptPath = path.join(verificationRoot, 'tool-roundtrip.jsonl')
    const overlayPath = path.join(verificationRoot, 'observer.cordis.yml')
    await mkdir(verificationRoot, { recursive: true })
    await writeFile(
      overlayPath,
      `${JSON.stringify(verificationOverlay(receiptPath, expectedTools, expectedText, expectedRoute), null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
    await writeFile(receiptPath, `${JSON.stringify({ kind: 'host/launch', version: 1, attempted: true })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })

    const patchArgs = [...this.config.verificationPatchPaths, overlayPath]
      .flatMap((patchPath) => ['--patch', patchPath])
    const request = {
      argv: this.argv('--profile', profile, ...patchArgs, task),
      cwd,
      env: this.childEnv(dshHome),
      timeoutMs: Math.max(this.config.commandTimeoutMs, 180_000),
      allowFailure: true,
    }
    let result: CommandResult
    try {
      result = await this.runner.run(signal ? { ...request, signal } : request)
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error)
      const failureClass = signal?.aborted
        ? 'cancelled' as const
        : /timed?\s*out|TimeoutError/iu.test(detail)
          ? 'timed_out' as const
          : /spawn|launch|ENOENT|EINVAL/iu.test(detail)
            ? 'launch_error' as const
            : 'unknown' as const
      const diagnosticHash = sha256(detail)
      await appendFile(receiptPath, `\n${JSON.stringify({
        kind: 'host/process', version: 1, outcome: 'threw', failureClass, diagnosticHash,
      })}\n`, 'utf8')
      const after = await collectSessionFiles(dshHome)
      const sessionFiles = after
        .filter((file) => !before.has(file.path) || file.modifiedAt >= startedAt)
        .map((file) => file.path)
      const evidence = await readReceipt(receiptPath)
      return {
        attempted: true,
        task,
        exitCode: null,
        expectedTools: [...new Set(expectedTools)].sort(),
        calledTools: evidence.calledTools,
        resultTools: evidence.resultTools,
        failedTools: evidence.failedTools,
        sessionFiles,
        receiptPath,
        launchEvidence: {
          attempted: true,
          processOutcome: 'threw',
          observerEventCount: evidence.observerEventCount,
          failureClass,
          diagnosticHash,
        },
        taskResultObserved: evidence.taskResultObserved,
        reason: evidence.observerEventCount === 0
          ? 'The DSH child launch did not return a process result and the trusted observer recorded no events; the child cause is unknown.'
          : 'The DSH child launch did not return a process result after partial trusted observer evidence; the child cause is unknown.',
      }
    }
    await appendFile(receiptPath, `\n${JSON.stringify({
      kind: 'host/process', version: 1, outcome: 'returned', exitCode: result.exitCode, signal: result.signal,
    })}\n`, 'utf8')
    const after = await collectSessionFiles(dshHome)
    const sessionFiles = after
      .filter((file) => !before.has(file.path) || file.modifiedAt >= startedAt)
      .map((file) => file.path)
    const evidence = await readReceipt(receiptPath)
    const expected = [...new Set(expectedTools)].sort()
    const loadOnly = expected.length === 0
    const toolRoundTrip = !loadOnly
      && expected.every((name) => evidence.calledTools.includes(name)
        && evidence.resultTools.includes(name)
        && !evidence.failedTools.includes(name))
    const taskResultObserved = evidence.taskResultObserved
    const routeMatchedExpectation = !expectedRoute || (evidence.observedProvider === expectedRoute.provider
      && (!expectedRoute.model
        || evidence.observedModel === expectedRoute.model))
    const mechanical: VerificationEvidence = {
      attempted: true,
      task,
      exitCode: result.exitCode,
      expectedTools: expected,
      calledTools: evidence.calledTools,
      resultTools: evidence.resultTools,
      failedTools: evidence.failedTools,
      sessionFiles,
      receiptPath,
      launchEvidence: {
        attempted: true,
        processOutcome: 'returned',
        observerEventCount: evidence.observerEventCount,
        exitCode: result.exitCode,
        signal: result.signal,
        ...(result.exitCode !== 0 ? { diagnosticHash: sha256(`${result.exitCode}:${result.signal ?? ''}:${result.stderr}`) } : {}),
      },
      taskResultObserved,
      ...(evidence.taskResultSha256 ? { taskResultSha256: evidence.taskResultSha256 } : {}),
      ...(evidence.taskResultMatchedExpectation !== undefined
        ? { taskResultMatchedExpectation: evidence.taskResultMatchedExpectation }
        : {}),
      ...(evidence.observedProvider ? { observedProvider: evidence.observedProvider } : {}),
      ...(evidence.observedModel ? { observedModel: evidence.observedModel } : {}),
      ...(expectedRoute ? { routeMatchedExpectation } : {}),
      reason: '',
    }
    const succeeded = hostMechanicalSuccess({ sourceMatched: true, verification: mechanical })
    const diagnostic = evidence.taskResultMatchedExpectation === false
      ? ' Expected-text substring is diagnostic only and did not match.'
      : ''
    return {
      ...mechanical,
      reason: result.exitCode !== 0
        ? evidence.observerEventCount === 0
          ? `DSH child returned exit code ${result.exitCode ?? 'null'} without trusted observer events; the child cause is unknown.`
          : `DSH child returned exit code ${result.exitCode ?? 'null'} after partial trusted observer evidence; the child cause is unknown.`
        : loadOnly && !taskResultObserved
          ? 'The child exited, but the trusted observer did not see a completed-turn final answer.'
          : !routeMatchedExpectation
            ? 'The child completed, but the observed provider/model route did not match the reviewed bundle route.'
            : succeeded && loadOnly
              ? `The trusted child overlay observed a completed-turn final answer for a plugin with no expected tools.${diagnostic}`
              : !toolRoundTrip
                ? 'The child exited, but the trusted observer did not prove a successful target tool round-trip.'
                : !taskResultObserved
                  ? 'The target tool round-trip succeeded, but no completed-turn final answer was observed.'
                  : `The trusted child overlay observed a matching tool/call and successful tool/result, followed by a completed-turn final answer.${diagnostic}`,
    }
  }

  async readInstalledVerificationFixtures(
    dshHome: string,
    profile: string,
    packageName: string,
  ): Promise<Record<string, unknown>> {
    const safePackageName = assertSafePackageName(packageName)
    const packageRoot = path.join(dshHome, 'profiles', profile, 'node_modules', ...safePackageName.split('/'))
    try {
      const body = await readFile(path.join(packageRoot, 'package.json'), 'utf8')
      return declaredVerificationFixturesFromPackage(JSON.parse(body) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  /**
   * Host-owned mechanical verification. Never forwards credentials, never
   * passes a user task, and never boots an Agent turn or default model route.
   */
  async verifyHost(input: {
    dshHome: string
    profile: string
    cwd: string
    layer: Exclude<VerificationLayerKind, 'manual_runtime'>
    packageName: string
    expectedTools: readonly string[]
    fixtures: readonly HostExecutableFixture[]
    fixtureDigest: string
    signal?: AbortSignal
  }): Promise<VerificationEvidence> {
    const verificationRoot = path.join(this.config.stateDir, 'verifications', randomUUID())
    const receiptPath = path.join(verificationRoot, 'host-verification.jsonl')
    const overlayPath = path.join(verificationRoot, 'host-driver.cordis.yml')
    await mkdir(verificationRoot, { recursive: true })
    const observerUrl = new URL('./verification-observer.js', import.meta.url).href
    const overlay = hostVerificationOverlay({
      receiptPath,
      expectedTools: input.expectedTools,
      layer: input.layer,
      packageName: input.packageName,
      fixtureDigest: input.fixtureDigest,
      fixtures: input.fixtures,
      observerUrl,
    })
    await writeFile(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await writeFile(receiptPath, `${JSON.stringify({ kind: 'host/launch', version: 1, attempted: true, layer: input.layer })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })

    const patchArgs = [...this.config.verificationPatchPaths, overlayPath]
      .flatMap((patchPath) => ['--patch', patchPath])
    const request = {
      argv: this.argv('--profile', input.profile, ...patchArgs),
      cwd: input.cwd,
      env: verificationChildEnv(input.dshHome),
      timeoutMs: Math.max(this.config.commandTimeoutMs, 180_000),
      allowFailure: true,
    }
    let result: CommandResult
    try {
      result = await this.runner.run(input.signal ? { ...request, signal: input.signal } : request)
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error)
      const failureClass = input.signal?.aborted
        ? 'cancelled' as const
        : /timed?\s*out|TimeoutError/iu.test(detail)
          ? 'timed_out' as const
          : /spawn|launch|ENOENT|EINVAL/iu.test(detail)
            ? 'launch_error' as const
            : 'unknown' as const
      const diagnosticHash = sha256(detail)
      await appendFile(receiptPath, `\n${JSON.stringify({
        kind: 'host/process', version: 1, outcome: 'threw', failureClass, diagnosticHash,
      })}\n`, 'utf8')
      const evidence = await readReceipt(receiptPath)
      return sanitizeHostVerificationEvidence({
        attempted: true,
        layer: evidence.layer ?? input.layer,
        status: evidence.status ?? 'uncertain',
        reason: evidence.completeReason
          ?? (evidence.observerEventCount === 0
            ? 'The DSH child launch did not return a process result and Host recorded no events; the child cause is unknown.'
            : 'The DSH child launch did not return a process result after partial Host evidence; the child cause is unknown.'),
        expectedTools: input.expectedTools,
        calledTools: evidence.calledTools,
        resultTools: evidence.resultTools,
        failedTools: evidence.failedTools,
        exitCode: null,
        ...(evidence.sourceMatched !== undefined ? { sourceMatched: evidence.sourceMatched } : {}),
        fixtureDigest: input.fixtureDigest,
        launchEvidence: {
          attempted: true,
          processOutcome: 'threw',
          observerEventCount: evidence.observerEventCount,
          failureClass,
          diagnosticHash,
        },
      })
    }
    await appendFile(receiptPath, `\n${JSON.stringify({
      kind: 'host/process', version: 1, outcome: 'returned', exitCode: result.exitCode, signal: result.signal,
    })}\n`, 'utf8')
    const evidence = await readReceipt(receiptPath)
    const layer = evidence.layer ?? input.layer
    const status = evidence.status ?? (result.exitCode === 0 ? 'uncertain' : 'failed')
    const sanitized = sanitizeHostVerificationEvidence({
      attempted: true,
      layer,
      status,
      reason: evidence.completeReason
        ?? (result.exitCode !== 0
          ? evidence.observerEventCount === 0
            ? `DSH child returned exit code ${result.exitCode ?? 'null'} without Host events; the child cause is unknown.`
            : `DSH child returned exit code ${result.exitCode ?? 'null'} after partial Host evidence; the child cause is unknown.`
          : layer === 'bundle_activation'
            ? 'Host loaded the reviewed bundle and Loader/Fiber settled without an Agent turn.'
            : 'Host executed expected tools once through ToolRuntime.execute.'),
      expectedTools: input.expectedTools,
      calledTools: evidence.calledTools,
      resultTools: evidence.resultTools,
      failedTools: evidence.failedTools,
      exitCode: result.exitCode,
      sourceMatched: evidence.sourceMatched ?? true,
      fixtureDigest: input.fixtureDigest,
      launchEvidence: {
        attempted: true,
        processOutcome: 'returned',
        observerEventCount: evidence.observerEventCount,
        exitCode: result.exitCode,
        signal: result.signal,
        ...(result.exitCode !== 0 ? { diagnosticHash: sha256(`${result.exitCode}:${result.signal ?? ''}`) } : {}),
      },
    })
    const succeeded = hostLayerSuccess({
      sourceMatched: sanitized.sourceMatched === true,
      layer: input.layer,
      verification: sanitized,
    })
    if (succeeded && !sanitized.reason) {
      return { ...sanitized, reason: 'Host mechanical verification passed.' }
    }
    return sanitized
  }
}

export async function assertOwnedTrialPath(candidate: string, trialsRoot: string): Promise<string> {
  const resolvedRoot = await realpath(trialsRoot)
  const resolvedCandidate = await realpath(candidate)
  const relative = path.relative(resolvedRoot, resolvedCandidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new EvolutionError('unsafe_path', 'Refusing cleanup outside an owned trial directory', {
      candidate: resolvedCandidate,
    })
  }
  return resolvedCandidate
}

export const _testing = { readReceipt, verificationOverlay, hostMechanicalSuccess, hostLayerSuccess }
