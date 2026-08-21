import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CallId } from '@deepseek-ai/dsh-llm'
import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
  type JsonSchemaNode,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import {
  classifyRuntimeSurface,
  type ReviewRecord,
  type RuntimeSurfaceFacts,
  type VerificationEvidence,
  type VerificationLayerKind,
  type VerificationStatus,
} from './contracts.js'
import { hashObject } from './state/hashes.js'

const HOST_OVERLAY_ID_PREFIX = 'autoevo-host-verification-'

/** OS/runtime keys a verification child may inherit. Credentials are never listed. */
export const VERIFICATION_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'TMP',
  'TEMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
] as const

export interface HostExecutableFixture {
  tool: string
  arguments: Record<string, unknown>
}

export interface HostFixtureDecision {
  tool: string
  available: boolean
  executable: boolean
  safe: boolean
  hostValidated: boolean
  reason: string
}

export interface HostLayerSelection {
  layer: VerificationLayerKind
  reason: string
  fixtures: HostExecutableFixture[]
  fixtureDigest: string
  expectedTools: string[]
}

export interface HostDriverConfig {
  receiptPath: string
  expectedTools: readonly string[]
  layer: VerificationLayerKind
  packageName: string
  fixtureDigest: string
  fixturesJson?: string
  requestExit?: (code: number) => void
}

export interface HostVerificationRunResult {
  layer: VerificationLayerKind
  status: VerificationStatus
  sourceMatched: boolean
  expectedTools: string[]
  calledTools: string[]
  resultTools: string[]
  failedTools: string[]
  executedCount: number
  reason: string
  exitCode: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isPlainJson(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isPlainJson)
  const rec = record(value)
  if (!rec) return false
  return Object.values(rec).every(isPlainJson)
}

/** Exact candidate namespace. Broad `dsh.fixtures` / `dsh.bundle.fixtures` are ignored. */
export function declaredVerificationFixtures(dsh: Record<string, unknown> | undefined): Record<string, unknown> {
  const autoevo = record(dsh?.autoevo)
  const verification = record(autoevo?.verification)
  return record(verification?.fixtures) ?? {}
}

export function declaredVerificationFixturesFromPackage(pkg: unknown): Record<string, unknown> {
  const rec = record(pkg)
  return declaredVerificationFixtures(record(rec?.dsh))
}

/**
 * JSON arguments for Host execution. Candidate `safe:true` is never read as
 * safety evidence and never becomes executable arguments by itself.
 */
export function extractFixtureArguments(value: unknown): Record<string, unknown> | undefined {
  const rec = record(value)
  if (!rec) return undefined
  const args = record(rec.arguments)
  if (!args || !isPlainJson(args)) return undefined
  return args
}

/** Candidate risk/approval/safe flags are never Host attestation. Kept as an explicit untrusted probe. */
export function inspectLoadedToolSafety(tool: object): { safe: boolean; reason: string } {
  void tool
  return {
    safe: false,
    reason: 'loaded tool self-declared risk, approval, or package safe flags are not Host attestation',
  }
}

export function argumentsMatchToolSchema(parameters: unknown, args: Record<string, unknown>): boolean {
  try {
    assertSupportedJsonSchema(parameters)
  } catch {
    return false
  }
  return validateJsonSchemaValue(parameters as JsonSchemaNode, args, 'arguments').length === 0
}

function emptyFacts(review: Pick<ReviewRecord, 'manifest' | 'runtimeSurface'>): RuntimeSurfaceFacts {
  const surface = review.runtimeSurface
  const expectedTools = [...(surface?.expectedTools ?? review.manifest.expectedTools)]
  if (surface) {
    return {
      ...(surface.clientPlatform ? { clientPlatform: surface.clientPlatform } : {}),
      ...(surface.expectedRoute ? { expectedRoute: surface.expectedRoute } : {}),
      llmDependency: surface.llmDependency,
      llmRegistered: surface.llmRegistered,
      credentialsDependency: surface.credentialsDependency,
      credentialsRegistered: surface.credentialsRegistered,
      networkSignal: surface.networkSignal,
      environmentSignal: surface.environmentSignal,
      processSignal: surface.processSignal,
      skillOnly: surface.skillOnly,
      unsafeTools: surface.unsafeTools,
      expectedTools,
      toolFixtures: surface.toolFixtures.map((item) => ({ ...item })),
      ...(surface.kind ? { kind: surface.kind } : {}),
      ...(surface.truncated !== undefined ? { truncated: surface.truncated } : {}),
    }
  }
  return {
    llmDependency: false,
    llmRegistered: Boolean(review.manifest.expectedRoute),
    credentialsDependency: false,
    credentialsRegistered: false,
    networkSignal: false,
    environmentSignal: false,
    processSignal: false,
    skillOnly: review.manifest.kind === 'skill',
    unsafeTools: false,
    expectedTools,
    toolFixtures: expectedTools.map((tool) => ({ tool, available: false, safe: false, hostValidated: false })),
    kind: review.manifest.kind,
  }
}

export function decideHostFixtures(input: {
  expectedTools: readonly string[]
  declared: Record<string, unknown>
}): HostFixtureDecision[] {
  return input.expectedTools.map((tool) => {
    if (!Object.hasOwn(input.declared, tool)) {
      return {
        tool, available: false, executable: false, safe: false, hostValidated: false,
        reason: 'no namespaced fixture declaration',
      }
    }
    const declared = input.declared[tool]
    const args = extractFixtureArguments(declared)
    if (!args) {
      return {
        tool, available: true, executable: false, safe: false, hostValidated: false,
        reason: 'declared fixture is not Host-executable JSON arguments',
      }
    }
    return {
      tool, available: true, executable: true, safe: false, hostValidated: false,
      reason: 'JSON arguments declared; safety is Host-derived at load time',
    }
  })
}

export function fixtureDigestFor(fixtures: readonly HostExecutableFixture[]): string {
  return hashObject(fixtures.map((item) => ({ tool: item.tool, arguments: item.arguments })))
}

function hostAttestedFixtures(facts: RuntimeSurfaceFacts, expectedTools: readonly string[]): boolean {
  return expectedTools.every((tool) => facts.toolFixtures.some((item) => (
    item.tool === tool && item.available === true && item.safe === true && item.hostValidated === true
  )))
}

/**
 * Install-time layer selection. Risk signals only downgrade. Plugin-declared
 * `safe:true` / `risk:'safe'` cannot mint tool_roundtrip. Authorization comes
 * only from frozen Host-attested review fixtures plus namespaced JSON arguments.
 */
export function selectInstallVerificationLayer(input: {
  review: Pick<ReviewRecord, 'manifest' | 'runtimeSurface'>
  declaredFixtures: Record<string, unknown>
}): HostLayerSelection {
  const facts = emptyFacts(input.review)
  const expectedTools = [...facts.expectedTools]
  const classified = classifyRuntimeSurface(facts)
  if (classified === 'manual_runtime') {
    const riskOnly = classifyRuntimeSurface({
      ...facts,
      expectedTools: [],
      toolFixtures: [],
      unsafeTools: false,
    })
    return {
      layer: 'manual_runtime',
      reason: riskOnly === 'manual_runtime'
        ? 'Frozen runtime-surface risk requires a user test; Host will not spawn automatic verification.'
        : 'Frozen runtime-surface lacks Host-attested safe fixtures; plugin self-declared safety cannot mint tool_roundtrip.',
      fixtures: [],
      fixtureDigest: fixtureDigestFor([]),
      expectedTools,
    }
  }
  if (classified === 'bundle_activation') {
    return {
      layer: 'bundle_activation',
      reason: 'No expected tools; Host will load the exact reviewed bundle without an Agent turn.',
      fixtures: [],
      fixtureDigest: fixtureDigestFor([]),
      expectedTools,
    }
  }
  if (!hostAttestedFixtures(facts, expectedTools)) {
    return {
      layer: 'manual_runtime',
      reason: 'Frozen runtime-surface lacks Host-attested safe fixtures; plugin self-declared safety cannot mint tool_roundtrip.',
      fixtures: [],
      fixtureDigest: fixtureDigestFor([]),
      expectedTools,
    }
  }
  const decisions = decideHostFixtures({ expectedTools, declared: input.declaredFixtures })
  const executable = decisions.filter((item) => item.executable)
  const fixtures: HostExecutableFixture[] = executable.map((item) => ({
    tool: item.tool,
    arguments: extractFixtureArguments(input.declaredFixtures[item.tool]) ?? {},
  }))
  if (!expectedTools.every((tool) => executable.some((item) => item.tool === tool))) {
    return {
      layer: 'manual_runtime',
      reason: 'Host-attested review cannot execute without namespaced JSON fixture arguments for every expected tool.',
      fixtures: [],
      fixtureDigest: fixtureDigestFor([]),
      expectedTools,
    }
  }
  return {
    layer: 'tool_roundtrip',
    reason: 'Host-attested fixtures and namespaced JSON arguments cover every expected tool.',
    fixtures,
    fixtureDigest: fixtureDigestFor(fixtures),
    expectedTools,
  }
}

function redactReason(reason: string): string {
  return reason.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 400)
}

/** Installation receipt: layer/status, source match, tool names, counts, stable diagnostics. */
export function sanitizeHostVerificationEvidence(input: {
  attempted: boolean
  layer: VerificationLayerKind
  status: VerificationStatus
  reason: string
  expectedTools: readonly string[]
  calledTools?: readonly string[]
  resultTools?: readonly string[]
  failedTools?: readonly string[]
  exitCode?: number | null
  sourceMatched?: boolean
  fixtureDigest?: string
  launchEvidence?: VerificationEvidence['launchEvidence']
}): VerificationEvidence {
  const evidence: VerificationEvidence = {
    attempted: input.attempted,
    expectedTools: [...input.expectedTools].sort(),
    calledTools: [...(input.calledTools ?? [])].sort(),
    resultTools: [...(input.resultTools ?? [])].sort(),
    failedTools: [...(input.failedTools ?? [])].sort(),
    sessionFiles: [],
    taskResultObserved: false,
    layer: input.layer,
    status: input.status,
    reason: redactReason(input.reason),
  }
  if (input.exitCode !== undefined) evidence.exitCode = input.exitCode
  if (input.sourceMatched !== undefined) evidence.sourceMatched = input.sourceMatched
  if (input.fixtureDigest) evidence.fixtureDigest = input.fixtureDigest
  if (input.launchEvidence) {
    evidence.launchEvidence = {
      attempted: input.launchEvidence.attempted,
      processOutcome: input.launchEvidence.processOutcome,
      observerEventCount: input.launchEvidence.observerEventCount,
      ...(input.launchEvidence.exitCode !== undefined ? { exitCode: input.launchEvidence.exitCode } : {}),
      ...(input.launchEvidence.signal !== undefined ? { signal: input.launchEvidence.signal } : {}),
      ...(input.launchEvidence.failureClass ? { failureClass: input.launchEvidence.failureClass } : {}),
      ...(input.launchEvidence.diagnosticHash ? { diagnosticHash: input.launchEvidence.diagnosticHash } : {}),
    }
  }
  return evidence
}

export function hostLayerSuccess(input: {
  sourceMatched: boolean
  layer: VerificationLayerKind
  verification: Pick<VerificationEvidence, 'attempted' | 'exitCode' | 'expectedTools' | 'calledTools' | 'resultTools' | 'failedTools' | 'layer' | 'status'>
}): boolean {
  const evidence = input.verification
  if (!input.sourceMatched || evidence.layer !== input.layer || evidence.status !== 'passed') return false
  if (input.layer === 'bundle_activation') {
    return evidence.attempted === true && evidence.exitCode === 0
  }
  if (input.layer === 'tool_roundtrip') {
    const expected = evidence.expectedTools
    return expected.length > 0
      && evidence.attempted === true
      && evidence.exitCode === 0
      && expected.every((name) => evidence.calledTools.includes(name)
        && evidence.resultTools.includes(name)
        && !evidence.failedTools.includes(name))
  }
  return false
}

export function verificationChildEnv(dshHome: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
  }
  for (const name of VERIFICATION_ENV_ALLOWLIST) {
    const value = parent[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

export function hostVerificationOverlay(input: {
  receiptPath: string
  expectedTools: readonly string[]
  layer: VerificationLayerKind
  packageName: string
  fixtureDigest: string
  fixtures: readonly HostExecutableFixture[]
  observerUrl: string
}): unknown[] {
  const fixtures: Record<string, Record<string, unknown>> = {}
  for (const item of input.fixtures) fixtures[item.tool] = item.arguments
  return [{
    insert: [{
      id: `${HOST_OVERLAY_ID_PREFIX}${randomUUID()}`,
      name: input.observerUrl,
      config: {
        receiptPath: input.receiptPath,
        expectedTools: [...input.expectedTools],
        layer: input.layer,
        packageName: input.packageName,
        fixtureDigest: input.fixtureDigest,
        fixturesJson: JSON.stringify(fixtures),
      },
    }],
  }]
}

function appendReceipt(receiptPath: string, event: Record<string, unknown>): void {
  appendFileSync(receiptPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' })
}

function parseFixturesJson(value: string | undefined): Record<string, Record<string, unknown>> {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    const rec = record(parsed)
    if (!rec) return {}
    const fixtures: Record<string, Record<string, unknown>> = {}
    for (const [tool, args] of Object.entries(rec)) {
      const body = record(args)
      if (body && isPlainJson(body)) fixtures[tool] = body
    }
    return fixtures
  } catch {
    return {}
  }
}

interface LoaderEntryLike {
  options?: { name?: string }
  disabled?: boolean
  fiber?: { await(): Promise<unknown>; state: number }
}

interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

function contextLoader(ctx: Context): LoaderLike | undefined {
  return (ctx as Context & { loader?: LoaderLike }).loader
}

function packageEntries(ctx: Context, packageName: string): LoaderEntryLike[] {
  const loader = contextLoader(ctx)
  if (!loader || typeof loader.entries !== 'function') return []
  const matched: LoaderEntryLike[] = []
  for (const entry of loader.entries()) {
    const name = entry.options?.name
    if (typeof name !== 'string') continue
    if (name === packageName || name.endsWith(`/${packageName}`)) matched.push(entry)
  }
  return matched
}

async function waitForLoader(ctx: Context, packageName: string): Promise<{ stable: boolean; sourceMatched: boolean; reason: string }> {
  const loader = contextLoader(ctx)
  if (!loader) return { stable: false, sourceMatched: false, reason: 'Host child has no Loader service.' }
  const own = (ctx as Context & { fiber?: { entry?: unknown } }).fiber?.entry
  for (const entry of loader.entries()) {
    if (entry === own || entry.disabled) continue
    if (entry.fiber) await entry.fiber.await()
  }
  const matched = packageEntries(ctx, packageName)
  if (matched.length === 0) {
    return { stable: false, sourceMatched: false, reason: 'Reviewed package Fiber was not present after Loader settle.' }
  }
  for (const entry of matched) {
    if (!entry.fiber) return { stable: false, sourceMatched: false, reason: 'Reviewed package entry has no Fiber.' }
    await entry.fiber.await()
    if (entry.fiber.state !== 2) {
      return { stable: false, sourceMatched: false, reason: 'Reviewed package Fiber did not become ACTIVE.' }
    }
  }
  return { stable: true, sourceMatched: true, reason: 'Host loaded the reviewed bundle and Loader/Fiber settled without an Agent turn.' }
}

class OnceMap {
  private readonly seen = new Set<string>()

  take(digest: string): boolean {
    if (this.seen.has(digest)) return false
    this.seen.add(digest)
    return true
  }
}

function loadedTool(ctx: Context, name: string): ToolDefinition | (ToolDefinition & Record<string, unknown>) | undefined {
  return ctx.tools?.get(name) as ToolDefinition | undefined
}

async function executeFixture(input: {
  ctx: Context
  tool: string
  args: Record<string, unknown>
  signal: AbortSignal
  once: OnceMap
  digest: string
}): Promise<{ called: boolean; ok: boolean; reason: string }> {
  if (!input.once.take(input.digest)) {
    return { called: false, ok: false, reason: 'Host refused to retry the same review/source/layer/fixture digest.' }
  }
  const tool = loadedTool(input.ctx, input.tool)
  if (!tool) return { called: false, ok: false, reason: 'expected tool is not registered after Loader settle' }
  if (!argumentsMatchToolSchema(tool.parameters, input.args)) {
    return { called: false, ok: false, reason: 'fixture arguments do not match the loaded tool schema' }
  }
  const result = await input.ctx.tools.execute({
    callId: `host-verify:${randomUUID()}` as CallId,
    name: input.tool,
    arguments: input.args,
    signal: input.signal,
  })
  if (result.isError) return { called: true, ok: false, reason: 'Host tool execution returned an error result.' }
  return { called: true, ok: true, reason: 'Host executed the expected tool once through ToolRuntime.execute.' }
}

export async function runHostVerification(ctx: Context, config: HostDriverConfig, signal?: AbortSignal): Promise<HostVerificationRunResult> {
  const expectedTools = [...config.expectedTools].sort()
  const once = new OnceMap()
  const calledTools: string[] = []
  const resultTools: string[] = []
  const failedTools: string[] = []
  let executedCount = 0

  if (config.layer === 'manual_runtime') {
    return {
      layer: 'manual_runtime',
      status: 'pending_user_test',
      sourceMatched: false,
      expectedTools,
      calledTools,
      resultTools,
      failedTools,
      executedCount: 0,
      reason: 'manual_runtime must not start a Host verification subprocess.',
      exitCode: 0,
    }
  }

  const loader = await waitForLoader(ctx, config.packageName)
  if (!loader.stable || !loader.sourceMatched) {
    return {
      layer: config.layer,
      status: 'failed',
      sourceMatched: false,
      expectedTools,
      calledTools,
      resultTools,
      failedTools,
      executedCount: 0,
      reason: loader.reason,
      exitCode: 1,
    }
  }

  if (config.layer === 'bundle_activation') {
    if (expectedTools.length > 0 && expectedTools.some((name) => !loadedTool(ctx, name))) {
      return {
        layer: 'bundle_activation',
        status: 'failed',
        sourceMatched: true,
        expectedTools,
        calledTools,
        resultTools,
        failedTools,
        executedCount: 0,
        reason: 'Bundle Fiber settled, but an expected tool was not registered.',
        exitCode: 1,
      }
    }
    return {
      layer: 'bundle_activation',
      status: 'passed',
      sourceMatched: true,
      expectedTools,
      calledTools,
      resultTools,
      failedTools,
      executedCount: 0,
      reason: loader.reason,
      exitCode: 0,
    }
  }

  const fixtures = parseFixturesJson(config.fixturesJson)
  for (const tool of expectedTools) {
    const args = fixtures[tool]
    if (!args) {
      return {
        layer: config.layer,
        status: 'failed',
        sourceMatched: true,
        expectedTools,
        calledTools,
        resultTools,
        failedTools,
        executedCount,
        reason: 'Parent-selected tool_roundtrip is missing namespaced fixture arguments; Host will not execute.',
        exitCode: 1,
      }
    }
    const digest = hashObject({
      layer: 'tool_roundtrip',
      fixtureDigest: config.fixtureDigest,
      tool,
      arguments: args,
    })
    const outcome = await executeFixture({
      ctx,
      tool,
      args,
      signal: signal ?? AbortSignal.timeout(30_000),
      once,
      digest,
    })
    if (!outcome.ok && !outcome.called) {
      return {
        layer: config.layer,
        status: 'failed',
        sourceMatched: true,
        expectedTools,
        calledTools,
        resultTools,
        failedTools,
        executedCount,
        reason: `${outcome.reason}; Host will not execute a missing or schema-invalid fixture.`,
        exitCode: 1,
      }
    }
    calledTools.push(tool)
    executedCount += 1
    if (outcome.ok) resultTools.push(tool)
    else failedTools.push(tool)
  }

  if (failedTools.length > 0) {
    return {
      layer: 'tool_roundtrip',
      status: 'failed',
      sourceMatched: true,
      expectedTools,
      calledTools,
      resultTools,
      failedTools,
      executedCount,
      reason: 'Host tool execution failed; the same fixture digest will not be retried.',
      exitCode: 1,
    }
  }

  return {
    layer: 'tool_roundtrip',
    status: 'passed',
    sourceMatched: true,
    expectedTools,
    calledTools,
    resultTools,
    failedTools,
    executedCount,
    reason: `Host executed ${executedCount} expected tool(s) once through ToolRuntime.execute.`,
    exitCode: 0,
  }
}

function requestExit(ctx: Context, code: number, override?: (code: number) => void): void {
  if (override) {
    override(code)
    return
  }
  const cmdline = ctx.get('cmdline') as { exit?: (code: number) => void } | undefined
  if (typeof cmdline?.exit === 'function') {
    cmdline.exit(code)
    return
  }
  process.exitCode = code
  process.exit(code)
}

export function applyHostVerification(ctx: Context, config: HostDriverConfig): void {
  if (!path.isAbsolute(config.receiptPath)) {
    throw new Error('verification receiptPath must be absolute')
  }
  mkdirSync(path.dirname(config.receiptPath), { recursive: true })
  queueMicrotask(() => {
    void (async () => {
      let result: HostVerificationRunResult
      try {
        result = await runHostVerification(ctx, config)
      } catch {
        result = {
          layer: config.layer,
          status: 'uncertain',
          sourceMatched: false,
          expectedTools: [...config.expectedTools],
          calledTools: [],
          resultTools: [],
          failedTools: [],
          executedCount: 0,
          reason: 'Host verification ended without a stable Loader/tool result; the child cause is unknown.',
          exitCode: 1,
        }
      }
      try {
        appendReceipt(config.receiptPath, {
          kind: 'host/complete',
          version: 1,
          layer: result.layer,
          status: result.status,
          sourceMatched: result.sourceMatched,
          expectedTools: result.expectedTools,
          calledTools: result.calledTools,
          resultTools: result.resultTools,
          failedTools: result.failedTools,
          executedCount: result.executedCount,
          reason: result.reason,
        })
      } catch {
        // Parent still has process-boundary launch evidence.
      }
      requestExit(ctx, result.exitCode, config.requestExit)
    })()
  })
}

export const _testing = {
  extractFixtureArguments,
  inspectLoadedToolSafety,
  argumentsMatchToolSchema,
  decideHostFixtures,
  parseFixturesJson,
  OnceMap,
}
