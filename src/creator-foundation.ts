import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { EvolutionError } from './errors.js'
import { hashObject, sha256 } from './state/hashes.js'

export const CREATOR_PRESET_ID = 'cordis' as const
export const CREATOR_FOUNDATION_CONTRACT_VERSION = 1 as const
export const MAX_CREATOR_RECORDS = 4 as const

export const OFFICIAL_CREATOR_SKILLS = [
  'cordis-plugin-development',
  'editing-cordis-compositions',
] as const

export const REQUIRED_INSPECT_TOOLS = [
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
] as const

export const CORDIS_MUTATION_TOOL_NAMES = [
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
  'cordis_mount',
  'cordis_unmount',
] as const

export const CODE_PRESET_ID = 'code' as const

const FILE_READ_ALIASES = [
  'read',
  'fs_read',
  'file_read',
  'search',
  'fs_search',
  'grep',
  'glob',
  'list_dir',
] as const
const FILE_WRITE_ALIASES = ['write', 'edit', 'fs_write', 'fs_edit', 'file_write', 'file_edit'] as const
const SHELL_ALIASES = ['pwsh', 'bash', 'shell', 'terminal'] as const
const SKILL_ALIASES = ['skill'] as const
const TODO_ALIASES = ['todo_write', 'todo_read', 'todo'] as const

export type CreatorOperation = 'create' | 'modify' | 'correct'
export type CreatorStatus = 'verified' | 'unavailable'

export interface CreatorWorkOrder {
  operation: CreatorOperation
  requirement: string
  baselineReview?: { reviewId: string }
  blockers: ReadonlyArray<{ key: string; kind: string; summary: string }>
  allowedScope: { cwd: string }
  acceptanceTargets: readonly string[]
}

export interface CreatorFoundationReceipt {
  contractVersion: typeof CREATOR_FOUNDATION_CONTRACT_VERSION
  presetId: typeof CREATOR_PRESET_ID
  compositionSha256: string
  requiredToolCatalogDigest: string
  childSessionId: string
}

export interface CreatorRecord {
  operation: CreatorOperation
  status: CreatorStatus
  createdAt: string
  receipt?: CreatorFoundationReceipt
}

export interface CreatorCatalog {
  tools: string[]
  skills: string[]
}

export interface CreatorFoundationPreflight {
  presetId: typeof CREATOR_PRESET_ID
  compositionSha256: string
  requiredToolCatalogDigest: string
  standingScope: unknown
  catalog: CreatorCatalog
}

export interface CreatorFoundation {
  preflight(input?: { signal?: AbortSignal; parentCtx?: unknown }): Promise<CreatorFoundationPreflight>
}

interface AgentPresetRosterItem {
  id: string
  broken?: boolean | string
  path?: string
  trust?: string
}

interface AgentPresetsLike {
  list?(): Promise<readonly AgentPresetRosterItem[] | { presets?: readonly AgentPresetRosterItem[] }>
  read?(id: string): Promise<string>
  resolve?(id: string): Promise<AgentPresetRosterItem | undefined>
  standingKeyFor?(id: string): Promise<unknown>
  mount?(agentCtx: unknown, id?: string): Promise<{ id: string }>
  composedPreset?(agentCtx: unknown): string | undefined
}

interface ToolsLike {
  schemas?(scope?: unknown): ReadonlyArray<{ name?: string } | string>
  get?(name: string, scope?: unknown): unknown
}

interface SkillsLike {
  list?(options?: { scope?: unknown; cwd?: string; signal?: AbortSignal }): Promise<
    | ReadonlyArray<{ name?: string }>
    | { skills?: ReadonlyArray<{ name?: string }> }
  >
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function creatorUnavailable(message: string, details: Record<string, unknown> = {}): EvolutionError {
  return new EvolutionError('command_failed', message, {
    reason: 'creator_foundation_unavailable',
    ...details,
  })
}

function rejectCodePreset(actual: string | undefined): void {
  if (actual === CODE_PRESET_ID) {
    throw creatorUnavailable('Managed construction requires the official Creator cordis preset; the code preset is not permitted and there is no fallback', {
      actual,
      expected: CREATOR_PRESET_ID,
    })
  }
}

export function normalizeComposition(text: string): string {
  return text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
}

export function compositionSha256(text: string): string {
  return sha256(normalizeComposition(text))
}

function toolAliases(name: string): string[] {
  const normalized = name.trim().toLowerCase()
  return [normalized, normalized.replace(/^dsh[_-]/u, ''), normalized.replace(/[_-]/gu, '')]
}

function catalogNameSet(names: readonly string[]): Set<string> {
  return new Set(names.flatMap((name) => toolAliases(name)))
}

function catalogHas(actual: ReadonlySet<string>, aliases: readonly string[]): boolean {
  const wanted = catalogNameSet(aliases)
  for (const name of actual) {
    if (toolAliases(name).some((alias) => wanted.has(alias))) return true
  }
  return false
}

function platformShellName(platform = process.platform): 'pwsh' | 'bash' {
  return platform === 'win32' ? 'pwsh' : 'bash'
}

export function requiredCreatorCatalog(platform = process.platform): CreatorCatalog {
  return {
    tools: [
      'read',
      'write',
      platformShellName(platform),
      'skill',
      'todo_write',
      ...REQUIRED_INSPECT_TOOLS,
    ],
    skills: [...OFFICIAL_CREATOR_SKILLS],
  }
}

export function requiredToolCatalogDigest(catalog: CreatorCatalog = requiredCreatorCatalog()): string {
  return hashObject({
    tools: [...catalog.tools].sort((left, right) => left.localeCompare(right)),
    skills: [...catalog.skills].sort((left, right) => left.localeCompare(right)),
  })
}

export function creatorAgentFacts(
  records: readonly CreatorRecord[] | undefined,
): { status: CreatorStatus } | undefined {
  const latest = records?.at(-1)
  if (!latest) return undefined
  return { status: latest.status }
}

export function appendCreatorRecord(
  records: readonly CreatorRecord[] | undefined,
  record: CreatorRecord,
): CreatorRecord[] {
  return [...(records ?? []), record].slice(-MAX_CREATOR_RECORDS)
}

export function createCreatorWorkOrder(input: {
  operation: CreatorOperation
  requirement: string
  cwd: string
  blockers?: CreatorWorkOrder['blockers']
  baselineReviewId?: string
  acceptanceTargets?: readonly string[]
}): CreatorWorkOrder {
  const requirement = input.requirement.normalize('NFKC').trim()
  const cwd = path.resolve(input.cwd)
  const acceptanceTargets = input.acceptanceTargets ?? defaultAcceptanceTargets(input.operation)
  return {
    operation: input.operation,
    requirement,
    ...(input.baselineReviewId ? { baselineReview: { reviewId: input.baselineReviewId } } : {}),
    blockers: [...(input.blockers ?? [])],
    allowedScope: { cwd },
    acceptanceTargets: [...acceptanceTargets],
  }
}

function defaultAcceptanceTargets(operation: CreatorOperation): readonly string[] {
  if (operation === 'create') {
    return [
      'Host local re-review must produce an installable managed snapshot',
      'Do not install, publish, or claim success from the child session',
    ]
  }
  if (operation === 'correct') {
    return [
      'Investigate why the remaining Host-observed blockers persist',
      'Do not expand scope or introduce a new blocking target',
    ]
  }
  return [
    'Host re-review must no longer report the baseline blockers',
    'Host re-review must not introduce a new blocking target',
  ]
}

export function assertCreatorReceipt(
  receipt: CreatorFoundationReceipt | undefined,
  preflight: CreatorFoundationPreflight,
): CreatorFoundationReceipt {
  if (!receipt) {
    throw creatorUnavailable('Managed child did not return a verified Creator foundation receipt')
  }
  rejectCodePreset(receipt.presetId)
  if (receipt.contractVersion !== CREATOR_FOUNDATION_CONTRACT_VERSION) {
    throw creatorUnavailable('Managed child Creator foundation receipt contractVersion mismatch', {
      expected: CREATOR_FOUNDATION_CONTRACT_VERSION,
      actual: receipt.contractVersion,
    })
  }
  assertNotCodePresetId(receipt.presetId)
  if (receipt.compositionSha256 !== preflight.compositionSha256) {
    throw creatorUnavailable('Managed child composition SHA-256 does not match Creator preflight')
  }
  if (receipt.requiredToolCatalogDigest !== preflight.requiredToolCatalogDigest) {
    throw creatorUnavailable('Managed child required tool catalog digest does not match Creator preflight')
  }
  if (typeof receipt.childSessionId !== 'string' || receipt.childSessionId.trim().length === 0) {
    throw creatorUnavailable('Managed child Creator foundation receipt is missing the child session identity')
  }
  return receipt
}

export function mintCreatorReceipt(
  preflight: CreatorFoundationPreflight,
  childSessionId: string,
): CreatorFoundationReceipt {
  return {
    contractVersion: CREATOR_FOUNDATION_CONTRACT_VERSION,
    presetId: CREATOR_PRESET_ID,
    compositionSha256: preflight.compositionSha256,
    requiredToolCatalogDigest: preflight.requiredToolCatalogDigest,
    childSessionId: String(childSessionId),
  }
}

function serviceFrom(ctx: unknown, name: string): unknown {
  if (!isRecord(ctx)) return undefined
  if (typeof ctx.get === 'function') {
    try {
      const value = (ctx.get as (key: string) => unknown)(name)
      if (value !== undefined) return value
    } catch {
      // Fall through to an own-property lookup on the same context.
    }
  }
  return ctx[name]
}

function assertNotCodePresetId(id: string): void {
  rejectCodePreset(id)
  if (id !== CREATOR_PRESET_ID) {
    throw creatorUnavailable('Managed construction requires the official Creator cordis preset; no other preset and no fallback is permitted', {
      actual: id,
      expected: CREATOR_PRESET_ID,
    })
  }
}

async function rosterItems(agentPresets: AgentPresetsLike): Promise<readonly AgentPresetRosterItem[] | undefined> {
  if (typeof agentPresets.list !== 'function') return undefined
  const listed = await agentPresets.list()
  if (Array.isArray(listed)) return listed
  if (isRecord(listed) && Array.isArray(listed.presets)) return listed.presets as AgentPresetRosterItem[]
  return []
}

function compositionLooksMountable(text: string): boolean {
  const body = normalizeComposition(text).trim()
  if (body.length === 0) return false
  if (!/^- id:/mu.test(body)) return false
  if (!/@deepseek-ai\/dsh-tool-cordis|\bid:\s*tool-cordis\b/u.test(body)) return false
  if (!/@deepseek-ai\/dsh-tool-skill|\bid:\s*tool-skill\b/u.test(body)) return false
  if (!/@deepseek-ai\/dsh-tool-todo|\bid:\s*tool-todo\b/u.test(body)) return false
  if (!/@deepseek-ai\/dsh-tool-fs|\bid:\s*tool-fs\b/u.test(body)) return false
  return true
}

function collectSchemaNames(tools: ToolsLike | undefined, scope: unknown): string[] {
  if (!tools || typeof tools.schemas !== 'function') return []
  let schemas: ReturnType<NonNullable<ToolsLike['schemas']>>
  try {
    schemas = tools.schemas(scope)
  } catch {
    return []
  }
  if (!Array.isArray(schemas)) return []
  return schemas.map((item) => {
    if (typeof item === 'string') return item
    if (isRecord(item) && typeof item.name === 'string') return item.name
    return ''
  }).filter((name) => name.length > 0)
}

function probeToolNames(tools: ToolsLike | undefined, names: readonly string[], scope: unknown): string[] {
  if (!tools || typeof tools.get !== 'function') return []
  const found: string[] = []
  for (const name of names) {
    try {
      const hit = tools.get(name, scope)
      if (hit) found.push(name)
    } catch {
      // Missing scoped tools stay absent; never substitute the global catalog.
    }
  }
  return found
}

async function collectSkillNames(skills: SkillsLike | undefined, scope: unknown, signal?: AbortSignal): Promise<string[]> {
  if (!skills || typeof skills.list !== 'function') return []
  const listed = await skills.list({
    scope,
    ...(signal ? { signal } : {}),
  })
  const entries = Array.isArray(listed)
    ? listed
    : isRecord(listed) && Array.isArray(listed.skills)
      ? listed.skills
      : []
  return entries
    .map((item) => (isRecord(item) && typeof item.name === 'string' ? item.name : ''))
    .filter((name) => name.length > 0)
}

export function assertRequiredCreatorCatalog(
  catalog: CreatorCatalog,
  platform = process.platform,
): void {
  const actualTools = catalogNameSet(catalog.tools)
  const actualSkills = new Set(catalog.skills)
  const missing: string[] = []
  if (!catalogHas(actualTools, FILE_READ_ALIASES)) missing.push('repository file read tools')
  if (!catalogHas(actualTools, FILE_WRITE_ALIASES)) missing.push('repository file write tools')
  const shell = platformShellName(platform)
  if (!catalogHas(actualTools, [shell])) missing.push(`platform shell (${shell})`)
  if (!catalogHas(actualTools, SKILL_ALIASES)) missing.push('skill')
  if (!catalogHas(actualTools, TODO_ALIASES)) missing.push('todo')
  for (const inspect of REQUIRED_INSPECT_TOOLS) {
    if (!catalogHas(actualTools, [inspect])) missing.push(inspect)
  }
  for (const skill of OFFICIAL_CREATOR_SKILLS) {
    if (!actualSkills.has(skill)) missing.push(skill)
  }
  if (missing.length > 0) {
    throw creatorUnavailable('Official Creator cordis catalog is missing required tools or skills', {
      missing,
    })
  }
}

export async function collectCreatorCatalog(
  ctx: unknown,
  scope: unknown,
  signal?: AbortSignal,
): Promise<CreatorCatalog> {
  const tools = serviceFrom(ctx, 'tools') as ToolsLike | undefined
  const skills = serviceFrom(ctx, 'skills') as SkillsLike | undefined
  if (!tools && !skills) {
    throw creatorUnavailable('Official Creator cordis standing scope did not expose a tool or skill catalog')
  }
  const required = requiredCreatorCatalog()
  const fromSchemas = collectSchemaNames(tools, scope)
  const probed = probeToolNames(tools, [
    ...required.tools,
    ...FILE_READ_ALIASES,
    ...FILE_WRITE_ALIASES,
    ...SHELL_ALIASES,
    ...TODO_ALIASES,
    ...SKILL_ALIASES,
    ...REQUIRED_INSPECT_TOOLS,
  ], scope)
  const skillNames = await collectSkillNames(skills, scope, signal)
  return {
    tools: [...new Set([...fromSchemas, ...probed])],
    skills: [...new Set(skillNames)],
  }
}

export async function assertChildCreatorCatalog(
  agentCtx: unknown,
  childScope: unknown,
  preflight: CreatorFoundationPreflight,
  composedPreset: string | undefined,
  mountedComposition: string,
): Promise<CreatorCatalog> {
  rejectCodePreset(composedPreset)
  if (composedPreset !== CREATOR_PRESET_ID) {
    throw creatorUnavailable('Managed child did not compose the official Creator cordis preset; code and fallback presets are not permitted', {
      actual: composedPreset,
      expected: CREATOR_PRESET_ID,
    })
  }
  if (compositionSha256(mountedComposition) !== preflight.compositionSha256) {
    throw creatorUnavailable('Managed child mounted Creator composition does not match the preflight SHA-256')
  }
  const catalog = await collectCreatorCatalog(agentCtx, childScope)
  assertRequiredCreatorCatalog(catalog)
  const digest = requiredToolCatalogDigest(requiredCreatorCatalog())
  if (digest !== preflight.requiredToolCatalogDigest) {
    throw creatorUnavailable('Managed child required tool catalog digest does not match Creator preflight')
  }
  return catalog
}

export async function preflightCreatorFoundation(
  ctx: Context,
  input: { signal?: AbortSignal; parentCtx?: unknown } = {},
): Promise<CreatorFoundationPreflight> {
  const agentPresets = serviceFrom(ctx, 'agentPresets') as AgentPresetsLike | undefined
  if (!agentPresets) {
    throw creatorUnavailable('DSH agent preset service is required to resolve the official Creator cordis preset')
  }

  const missingRuntime = ['agents', 'sandbox', 'sandboxPolicy', 'fs', 'tools', 'skills']
    .filter((name) => serviceFrom(ctx, name) === undefined)
  if (input.parentCtx && serviceFrom(input.parentCtx, 'agents') === undefined) {
    missingRuntime.push('parent agents')
  }
  if (missingRuntime.length > 0) {
    throw creatorUnavailable('Managed Creator child runtime prerequisites are unavailable', {
      missing: missingRuntime,
    })
  }

  const roster = await rosterItems(agentPresets)
  if (roster) {
    const entry = roster.find((item) => item.id === CREATOR_PRESET_ID)
    const codeEntry = roster.find((item) => item.id === CODE_PRESET_ID)
    if (!entry) {
      throw creatorUnavailable('Official Creator cordis preset is missing from the DSH agent preset roster', {
        sawCodePreset: Boolean(codeEntry),
      })
    }
    if (entry.broken) {
      throw creatorUnavailable('Official Creator cordis preset composition is broken and cannot be mounted')
    }
  }

  if (typeof agentPresets.resolve !== 'function') {
    throw creatorUnavailable('DSH agent preset service cannot resolve the official Creator cordis preset')
  }
  let resolved: AgentPresetRosterItem | undefined
  try {
    resolved = await agentPresets.resolve(CREATOR_PRESET_ID)
  } catch (error) {
    throw creatorUnavailable('Official Creator cordis preset could not be resolved', {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  if (!resolved || resolved.id !== CREATOR_PRESET_ID || resolved.trust !== 'system') {
    throw creatorUnavailable('Resolved cordis preset is not the official system Creator preset')
  }
  if (resolved.broken) {
    throw creatorUnavailable('Resolved official Creator cordis preset is broken and cannot be mounted')
  }

  if (typeof agentPresets.read !== 'function') {
    throw creatorUnavailable('DSH agent preset service cannot read the official Creator cordis composition')
  }
  let composition: string
  try {
    composition = await agentPresets.read(CREATOR_PRESET_ID)
  } catch (error) {
    throw creatorUnavailable('Official Creator cordis composition could not be read', {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  if (typeof composition !== 'string' || !compositionLooksMountable(composition)) {
    throw creatorUnavailable('Official Creator cordis composition is missing, empty, or not a mountable Creator composition')
  }

  if (typeof agentPresets.standingKeyFor !== 'function') {
    throw creatorUnavailable('Official Creator cordis preset cannot be mount-validated; standing scope is unavailable')
  }
  let standingScope: unknown
  try {
    standingScope = await agentPresets.standingKeyFor(CREATOR_PRESET_ID)
  } catch (error) {
    throw creatorUnavailable('Official Creator cordis composition is unmountable', {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  if (standingScope === undefined || standingScope === null || standingScope === false) {
    throw creatorUnavailable('Official Creator cordis preset standing scope was not obtained')
  }

  const catalog = await collectCreatorCatalog(ctx, standingScope, input.signal)
  assertRequiredCreatorCatalog(catalog)
  const digest = requiredToolCatalogDigest(requiredCreatorCatalog())

  return {
    presetId: CREATOR_PRESET_ID,
    compositionSha256: compositionSha256(composition),
    requiredToolCatalogDigest: digest,
    standingScope,
    catalog,
  }
}

export function createCreatorFoundation(ctx: Context): CreatorFoundation {
  return {
    preflight(input) {
      return preflightCreatorFoundation(ctx, input)
    },
  }
}

export function formatCreatorWorkOrder(workOrder: CreatorWorkOrder): string {
  return JSON.stringify({
    operation: workOrder.operation,
    requirement: workOrder.requirement,
    ...(workOrder.baselineReview ? { baselineReview: workOrder.baselineReview } : {}),
    blockers: workOrder.blockers,
    allowedScope: { cwd: workOrder.allowedScope.cwd },
    acceptanceTargets: workOrder.acceptanceTargets,
  })
}

export function assertWorkOrderScope(workOrder: CreatorWorkOrder, cwd: string): void {
  if (path.resolve(workOrder.allowedScope.cwd) !== path.resolve(cwd)) {
    throw creatorUnavailable('Creator work order allowed scope does not match the managed repository')
  }
}

const TESTING_CORDIS_COMPOSITION = [
  '- id: tool-fs',
  "  name: '@deepseek-ai/dsh-tool-fs'",
  '- id: tool-todo',
  "  name: '@deepseek-ai/dsh-tool-todo'",
  '- id: tool-skill',
  "  name: '@deepseek-ai/dsh-tool-skill'",
  '- id: tool-cordis',
  "  name: '@deepseek-ai/dsh-tool-cordis'",
  '',
].join('\n')

export function testingCreatorPreflight(): CreatorFoundationPreflight {
  const required = requiredCreatorCatalog()
  return {
    presetId: CREATOR_PRESET_ID,
    compositionSha256: compositionSha256(TESTING_CORDIS_COMPOSITION),
    requiredToolCatalogDigest: requiredToolCatalogDigest(required),
    standingScope: 'standing-cordis',
    catalog: {
      tools: [...required.tools],
      skills: [...required.skills],
    },
  }
}

export function testingCreatorWorkOrder(cwd: string, operation: CreatorOperation = 'create'): CreatorWorkOrder {
  return createCreatorWorkOrder({ operation, requirement: 'provide a hello tool', cwd })
}

export function testingCreatorFoundation(preflight: CreatorFoundationPreflight = testingCreatorPreflight()): CreatorFoundation {
  return {
    async preflight() {
      return preflight
    },
  }
}

export const _testing = {
  CODE_PRESET_ID,
  FILE_READ_ALIASES,
  FILE_WRITE_ALIASES,
  SHELL_ALIASES,
  SKILL_ALIASES,
  TODO_ALIASES,
  compositionLooksMountable,
  catalogHas,
  catalogNameSet,
  platformShellName,
  rejectCodePreset,
  assertNotCodePresetId,
  TESTING_CORDIS_COMPOSITION,
}
