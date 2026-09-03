import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import type { RuntimeConfig } from '../config.js'
import type {
  ActivatedFiber,
  VerificationEvidence,
  VerificationLayerKind,
  VerificationStatus,
} from '../contracts.js'
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
import { commandResultFailure, type CommandResult, type CommandRunner } from '../process/runner.js'
import { sha256 } from '../state/hashes.js'
import { resolveStateRoot } from '../workspace-layout.js'
import { activationTargetsFromPatch } from './bundle-activation.js'

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

interface ProfileStoreIdentity {
  storeDir: string
  fingerprint: string
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

export class DshLauncher {
  constructor(
    private readonly runner: CommandRunner,
    private readonly config: RuntimeConfig,
  ) {}

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

  /** Read the store that owns the profile's existing node_modules tree once. */
  private async existingProfileStore(dshHome: string, profile: string): Promise<ProfileStoreIdentity | undefined> {
    const modulesManifest = path.join(dshHome, 'profiles', profile, 'node_modules', '.modules.yaml')
    try {
      const value: unknown = parse(await readFile(modulesManifest, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
      const storeDir = (value as { storeDir?: unknown }).storeDir
      if (typeof storeDir !== 'string' || !path.isAbsolute(storeDir)) return undefined
      const resolved = path.resolve(storeDir)
      const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved
      return { storeDir: resolved, fingerprint: sha256(normalized) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      // A stale or malformed pnpm metadata file should still be diagnosed by
      // the actual install command instead of preventing DSH from running it.
      return undefined
    }
  }

  async profileStoreFingerprint(dshHome: string, profile: string): Promise<string | undefined> {
    return (await this.existingProfileStore(dshHome, profile))?.fingerprint
  }

  async install(
    dshHome: string,
    profile: string,
    spec: string,
    cwd: string,
    signal?: AbortSignal,
    options?: {
      forwardCredentials?: boolean
      minimumReleaseAgeExcludes?: string[]
      expectedProfileStoreFingerprint?: string
    },
  ): Promise<CommandResult> {
    await mkdir(dshHome, { recursive: true })
    const profileStore = await this.existingProfileStore(dshHome, profile)
    if (options?.expectedProfileStoreFingerprint
      && profileStore?.fingerprint !== options.expectedProfileStoreFingerprint) {
      throw new EvolutionError('review_expired', 'The target profile pnpm store changed after the recovery plan was sealed')
    }
    const storeArgs = profileStore ? [`--config.store-dir=${profileStore.storeDir}`] : []
    const minimumReleaseAgeExcludes = [...new Set(options?.minimumReleaseAgeExcludes ?? [])].sort()
    if (minimumReleaseAgeExcludes.length > 8 || minimumReleaseAgeExcludes.some((item) => !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/iu.test(item))) {
      throw new EvolutionError('invalid_input', 'Host release-age exclusions must be exact package versions')
    }
    const releaseAgeArgs = minimumReleaseAgeExcludes
      .map((item) => `--config.minimum-release-age-exclude=${item}`)
    const request = {
      argv: this.argv('plugin', '--profile', profile, 'add', '--save-exact', spec, '--config.ignore-scripts=true', ...storeArgs, ...releaseAgeArgs),
      cwd,
      env: this.childEnv(dshHome, options?.forwardCredentials !== false),
      timeoutMs: Math.max(this.config.commandTimeoutMs, 120_000),
      allowFailure: true as const,
    }
    const result = await this.runner.run(signal ? { ...request, signal } : request)
    if (result.exitCode !== 0) throw commandResultFailure(this.config.dshCommand, result)
    return result
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

  /** Compose the profile tree without booting it; fails loudly on unresolvable mount rows. */
  async dumpConfig(
    dshHome: string,
    profile: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const request = {
      argv: this.argv('--profile', profile, '--dump-config'),
      cwd,
      env: this.childEnv(dshHome, false),
      timeoutMs: Math.max(this.config.commandTimeoutMs, 120_000),
      allowFailure: true as const,
    }
    return this.runner.run(signal ? { ...request, signal } : request)
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

  async profileDependencySpec(
    dshHome: string,
    profile: string,
    packageName: string,
  ): Promise<string | undefined> {
    const safePackageName = assertSafePackageName(packageName)
    try {
      const body = await readFile(path.join(dshHome, 'profiles', profile, 'package.json'), 'utf8')
      const manifest: unknown = JSON.parse(body)
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined
      const dependencies = (manifest as { dependencies?: unknown }).dependencies
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return undefined
      const spec = (dependencies as Record<string, unknown>)[safePackageName]
      return typeof spec === 'string' ? spec : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
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
  async readInstalledActivationTargets(
    dshHome: string,
    profile: string,
    packageName: string,
  ): Promise<ActivatedFiber[]> {
    const safePackageName = assertSafePackageName(packageName)
    const packageRoot = path.join(dshHome, 'profiles', profile, 'node_modules', ...safePackageName.split('/'))
    try {
      const manifest: unknown = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
      const dsh = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
        ? (manifest as { dsh?: unknown }).dsh
        : undefined
      const bundle = dsh && typeof dsh === 'object' && !Array.isArray(dsh)
        ? (dsh as { bundle?: unknown }).bundle
        : undefined
      const patchSpec = bundle && typeof bundle === 'object' && !Array.isArray(bundle)
        ? (bundle as { patch?: unknown }).patch
        : undefined
      if (typeof patchSpec !== 'string' || !patchSpec || path.isAbsolute(patchSpec)
        || patchSpec.split(/[\\/]/u).includes('..')) return []
      const value: unknown = parse(await readFile(path.resolve(packageRoot, patchSpec), 'utf8'))
      return activationTargetsFromPatch(value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async verifyHost(input: {
    dshHome: string
    profile: string
    cwd: string
    layer: Exclude<VerificationLayerKind, 'manual_runtime'>
    packageName: string
    expectedTools: readonly string[]
    fixtures: readonly HostExecutableFixture[]
    fixtureDigest: string
    activatedFibers?: readonly ActivatedFiber[]
    signal?: AbortSignal
  }): Promise<VerificationEvidence> {
    const verificationRoot = path.join(resolveStateRoot(this.config), 'verifications', randomUUID())
    const receiptPath = path.join(verificationRoot, 'host-verification.jsonl')
    const overlayPath = path.join(verificationRoot, 'host-driver.cordis.yml')
    await mkdir(verificationRoot, { recursive: true })
    const observerUrl = new URL('./verification-observer.js', import.meta.url).href
    let activatedFibers = [...(input.activatedFibers ?? [])]
    if (activatedFibers.length === 0) {
      try {
        activatedFibers = await this.readInstalledActivationTargets(input.dshHome, input.profile, input.packageName)
      } catch {
        activatedFibers = []
      }
    }
    const overlay = hostVerificationOverlay({
      receiptPath,
      expectedTools: input.expectedTools,
      layer: input.layer,
      packageName: input.packageName,
      fixtureDigest: input.fixtureDigest,
      fixtures: input.fixtures,
      observerUrl,
      activatedFibers,
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

export const _testing = { readReceipt, hostLayerSuccess }
