import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { satisfies, valid, validRange } from 'semver'
import type { RuntimeConfig } from '../config.js'
import {
  POLICY_VERSION,
  classifyRuntimeSurface,
  type InspectedFile,
  type ManifestFacts,
  type MechanicalFacts,
  type ReviewFinding,
  type ReviewRecord,
  type ReviewedArtifact,
  type RuntimeSurface,
  type ToolFixtureAvailability,
} from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { normalizePackagePath, withCachedGithubRepository } from '../github/git-cache.js'
import { validateGithubRepository } from '../github/discovery.js'
import { isSafePackageName } from '../package-name.js'
import type { CommandRunner } from '../process/runner.js'
import { activationTargetsFromPatch } from '../lifecycle/bundle-activation.js'
import { freezeGithubPackage, freezeLocalPackage, type FrozenPackageArtifact } from '../lifecycle/package-artifact.js'
import { resolveGitCacheRoot } from '../workspace-layout.js'
import { capabilityAnchors, normalizeSearchText } from '../resolver/keywords.js'
import { hashObject, sha256 } from '../state/hashes.js'
import { isExcludedLocalPackagePath } from './local-path-policy.js'

/** Mechanical Host hard-skip findings. Regex detectors are not in this set. */
export const HARD_SKIP_FINDING_CODES = new Set([
  'bundle_patch_path',
  'bundle_patch_missing',
  'bundle_patch_invalid',
  'bundle_patch_no_activation',
  'runtime_entrypoint_missing',
  'unsafe_package_name',
])

/** Lexical/regex observations that require a semantic reviewer, not a Host skip. */
export const SEMANTIC_CONTEXT_FINDING_CODES = new Set([
  'prompt_injection',
  'hidden_instructions',
  'data_exfiltration',
  'credential_access',
  'dynamic_evaluation',
])

interface TreeEntry {
  path?: unknown
  mode?: unknown
  type?: unknown
  sha?: unknown
  size?: unknown
}

interface GithubCommit {
  sha?: unknown
  commit?: { committer?: { date?: unknown } }
}

interface GithubRepository {
  default_branch?: unknown
}

interface GithubTree {
  tree?: unknown
  truncated?: unknown
}

export interface ContentFile {
  path: string
  content: Uint8Array
  blobId?: string
}

export interface ContentSnapshot {
  files: ContentFile[]
  truncated: boolean
}

export interface ReviewContentInput {
  id?: string
  createdAt?: string
  resolutionId: string
  requirement: string
  sourceSnapshot: ReviewRecord['sourceSnapshot']
  files: readonly ContentFile[]
  truncated?: boolean
  maintained?: boolean
  runtimeVersion?: string
  installSpec?: string
  artifact?: ReviewedArtifact
}

export interface LocalReviewResult {
  record: ReviewRecord
  /** Hash of ordered, inspected content hashes. Kept outside ReviewRecord until its shared schema grows this field. */
  contentHash: string
  /** In-process bounded snapshot for the semantic reviewer. Never persisted. */
  files: ContentFile[]
}

export interface GithubReviewEvidence {
  record: ReviewRecord
  /** In-process bounded snapshot for the semantic reviewer. Never persisted. */
  files: ContentFile[]
}

export interface GithubPluginPreview {
  repository: string
  commit: string
  defaultBranch: string
  packagePath: string
  inspectedFiles: InspectedFile[]
  truncated: boolean
  manifest: Pick<ManifestFacts, 'kind' | 'packageName' | 'packageVersion' | 'bundlePatch' | 'license'>
  packageSummary?: { description?: string; keywords?: string[] }
  readmeExcerpt?: string
}

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.tsx', '.jsx', '.json', '.yaml', '.yml'])
const LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepublish', 'prepare', 'prepack', 'postpack', 'prepublishOnly'])
const LOADER_PATCH_EXTENSIONS = new Set(['.json', '.yaml', '.yml'])

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function safeBundlePatchPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return undefined
  const relative = value.replace(/^\.\//u, '')
  const parts = relative.split('/')
  if (parts.some((part) => part === '.' || part === '..' || part === '' || part.includes(':'))) return undefined
  const normalized = path.posix.normalize(relative)
  if (!normalized || normalized === '.' || !LOADER_PATCH_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) return undefined
  return normalized
}

function loaderPatchProblem(file: ContentFile): string | undefined {
  let parsed: unknown
  try {
    const document = parseDocument(Buffer.from(file.content).toString('utf8'), {
      customTags: [{
        tag: 'tag:yaml.org,2002:js',
        resolve: (value: string) => ({ __jsExpr: value }),
      }],
    })
    if (document.errors.length > 0) return 'the declared bundle patch is not valid Loader JSON/YAML'
    parsed = document.toJS()
  } catch {
    return 'the declared bundle patch is not valid Loader JSON/YAML'
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return 'the declared bundle patch must be a non-empty patch list'
  for (const item of parsed) {
    const patch = record(item)
    if (!patch) return 'every Loader patch must be an object'
    if (Object.hasOwn(patch, 'insert')) {
      if (!Array.isArray(patch.insert) || patch.insert.length === 0
        || patch.insert.some((entry) => typeof record(entry)?.name !== 'string' || !(record(entry)?.name as string).trim())) {
        return 'Loader patch insert entries must be non-empty objects with module names'
      }
    } else if (typeof patch.id !== 'string' || !patch.id.trim()) {
      return 'non-insert Loader patches must name a target id'
    }
  }
  return undefined
}

function jsonObject(value: Uint8Array): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function safeClientPath(value: string): string | undefined {
  if (!value || value.includes('\\') || value.includes('\0')
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return undefined
  const relative = value.replace(/^\.\//u, '')
  const parts = relative.split('/')
  if (parts.some((part) => part === '.' || part === '..' || part === '' || part.includes(':'))) return undefined
  const normalized = path.posix.normalize(relative)
  if (!normalized || normalized === '.') return undefined
  return value.startsWith('./') ? `./${normalized}` : normalized
}

function safePlatformToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,31}$/i.test(value) ? value.toLowerCase() : undefined
}

/** Freeze `dsh.client` without retaining secrets or unsafe paths. */
function freezeClient(dsh: Record<string, unknown> | undefined): Pick<ManifestFacts, 'client' | 'clientPlatform'> {
  if (!dsh || !Object.hasOwn(dsh, 'client') || dsh.client === undefined || dsh.client === null || dsh.client === false) {
    return {}
  }
  const value = dsh.client
  if (value === true) return { client: 'declared', clientPlatform: 'web' }
  if (typeof value === 'string') {
    return { client: safeClientPath(value) ?? 'declared', clientPlatform: 'web' }
  }
  const rec = record(value)
  if (!rec) return { client: 'declared', clientPlatform: 'web' }
  const entry = typeof rec.entry === 'string' ? rec.entry
    : typeof rec.path === 'string' ? rec.path
      : typeof rec.main === 'string' ? rec.main
        : undefined
  return {
    client: entry ? safeClientPath(entry) ?? 'declared' : 'declared',
    clientPlatform: safePlatformToken(rec.platform) ?? 'web',
  }
}

function packageContext(files: readonly ContentFile[]): {
  pkg?: Record<string, unknown>
  dsh?: Record<string, unknown>
  bundle?: Record<string, unknown>
} {
  const packageFile = files.find((file) => file.path === 'package.json')
  const pkg = packageFile ? jsonObject(packageFile.content) : undefined
  const dsh = record(pkg?.dsh)
  const bundle = record(dsh?.bundle)
  return { ...(pkg ? { pkg } : {}), ...(dsh ? { dsh } : {}), ...(bundle ? { bundle } : {}) }
}

/** Exact candidate namespace. Broad `dsh.fixtures` / `dsh.bundle.fixtures` are ignored. */
function verificationFixtures(dsh: Record<string, unknown> | undefined): Record<string, unknown> {
  const autoevo = record(dsh?.autoevo)
  const verification = record(autoevo?.verification)
  return record(verification?.fixtures) ?? {}
}

function fixtureDeclared(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === 'string' && value) return true
  return Boolean(record(value))
}

function toolFixturesFrom(
  expectedTools: readonly string[],
  dsh: Record<string, unknown> | undefined,
): ToolFixtureAvailability[] {
  const declared = verificationFixtures(dsh)
  return expectedTools.map((tool) => ({
    tool,
    available: fixtureDeclared(declared[tool]),
    safe: false,
    hostValidated: false,
  }))
}

function looksLikeLlm(value: string): boolean {
  return /(?:^|[^a-z])llm(?:[^a-z]|$)|agent-default-model|language-model/i.test(value)
}

function looksLikeCredentials(value: string): boolean {
  return /oauth|credential|api-key|apikey/i.test(value)
}

function patchRegistrations(file: ContentFile | undefined): {
  llmRegistered: boolean
  credentialsRegistered: boolean
} {
  if (!file) return { llmRegistered: false, credentialsRegistered: false }
  let llmRegistered = false
  let credentialsRegistered = false
  const note = (value: unknown): void => {
    if (typeof value !== 'string' || !value) return
    if (looksLikeLlm(value)) llmRegistered = true
    if (looksLikeCredentials(value)) credentialsRegistered = true
  }
  try {
    const document = parseDocument(Buffer.from(file.content).toString('utf8'), {
      customTags: [{
        tag: 'tag:yaml.org,2002:js',
        resolve: (value: string) => ({ __jsExpr: value }),
      }],
    })
    if (document.errors.length > 0) return { llmRegistered, credentialsRegistered }
    const patches: unknown = document.toJS()
    if (!Array.isArray(patches)) return { llmRegistered, credentialsRegistered }
    for (const item of patches) {
      const patch = record(item)
      if (!patch) continue
      note(patch.id)
      const config = record(patch.config)
      note(config?.provider)
      const insert = Array.isArray(patch.insert) ? patch.insert : []
      for (const entry of insert) {
        const row = record(entry)
        note(row?.id)
        note(row?.name)
      }
    }
  } catch {
    return { llmRegistered, credentialsRegistered }
  }
  return { llmRegistered, credentialsRegistered }
}

function dependencyNames(pkg: Record<string, unknown> | undefined, manifest: ManifestFacts): string[] {
  return [...new Set([
    ...manifest.dependencies,
    ...Object.keys(manifest.peerDependencies),
    ...Object.keys(stringRecord(pkg?.optionalDependencies)),
  ])]
}

function findingCodes(findings: readonly ReviewFinding[]): Set<string> {
  return new Set(findings.map((item) => item.code))
}

/** Freeze static runtime facts. Plugin fixture declarations never mint safe/hostValidated. */
export function freezeRuntimeSurface(input: {
  manifest: ManifestFacts
  findings: readonly ReviewFinding[]
  files: readonly ContentFile[]
  truncated?: boolean
}): RuntimeSurface {
  const { pkg, dsh } = packageContext(input.files)
  const patchFile = input.manifest.bundlePatch
    ? input.files.find((file) => file.path === input.manifest.bundlePatch)
    : undefined
  const registrations = patchRegistrations(patchFile)
  const names = dependencyNames(pkg, input.manifest)
  const llmDependency = names.some((name) => name === '@deepseek-ai/dsh-llm' || name.startsWith('@deepseek-ai/dsh-llm/'))
  const credentialsDependency = names.some((name) => looksLikeCredentials(name))
  const codes = findingCodes(input.findings)
  const toolFixtures = toolFixturesFrom(input.manifest.expectedTools, dsh)
  const facts = {
    ...(input.manifest.clientPlatform ? { clientPlatform: input.manifest.clientPlatform } : {}),
    ...(input.manifest.expectedRoute ? { expectedRoute: input.manifest.expectedRoute } : {}),
    llmDependency,
    llmRegistered: registrations.llmRegistered || Boolean(input.manifest.expectedRoute),
    credentialsDependency,
    credentialsRegistered: registrations.credentialsRegistered,
    networkSignal: codes.has('network_access'),
    environmentSignal: codes.has('environment_access'),
    processSignal: codes.has('process_execution') || codes.has('child_process'),
    skillOnly: input.manifest.kind === 'skill',
    unsafeTools: toolFixtures.some((item) => item.available && !item.safe),
    expectedTools: [...input.manifest.expectedTools],
    toolFixtures,
    kind: input.manifest.kind,
    truncated: Boolean(input.truncated),
  }
  return { ...facts, verificationLayer: classifyRuntimeSurface(facts) }
}

function manifestFrom(files: readonly ContentFile[]): ManifestFacts {
  const { pkg, dsh, bundle } = packageContext(files)
  const hasSkill = files.some((file) => /(^|\/)skill\.md$/i.test(file.path))
  const sourceTools = files.flatMap((file) => {
    if (!SOURCE_EXTENSIONS.has(path.posix.extname(file.path).toLowerCase())) return []
    const text = Buffer.from(file.content).toString('utf8')
    const matches = text.matchAll(/defineTool\s*\(\s*\{[\s\S]{0,800}?\bname\s*:\s*['"`]([^'"`]{1,100})['"`]/g)
    return [...matches].map((match) => match[1]).filter((value): value is string => Boolean(value))
  })
  const expectedTools = [...new Set([
    ...strings(bundle?.tools),
    ...strings(dsh?.tools),
    ...strings(pkg?.tools),
    ...sourceTools,
  ])].sort()
  const scripts = Object.keys(stringRecord(pkg?.scripts)).filter((name) => LIFECYCLE_SCRIPTS.has(name)).sort()
  const dependencies = Object.keys(stringRecord(pkg?.dependencies)).sort()
  const peerDependencies = stringRecord(pkg?.peerDependencies)
  const license = typeof pkg?.license === 'string' ? pkg.license : undefined
  const bundlePatchDeclared = typeof bundle?.patch === 'string'
  const bundlePatch = safeBundlePatchPath(bundle?.patch)
  const patchFile = bundlePatch ? files.find((file) => file.path === bundlePatch) : undefined
  const expectedRoute = expectedRouteFromBundlePatch(patchFile)
  const activatedFibers = activatedFibersFromPatchFile(patchFile)
  const client = freezeClient(dsh)
  return {
    kind: bundlePatchDeclared ? 'bundle' : hasSkill ? 'skill' : pkg ? 'legacy' : 'unknown',
    ...(isSafePackageName(pkg?.name) ? { packageName: pkg.name } : {}),
    ...(typeof pkg?.version === 'string' ? { packageVersion: pkg.version } : {}),
    ...(bundlePatch ? { bundlePatch } : {}),
    ...(activatedFibers.length > 0 ? { activatedFibers } : {}),
    ...(license ? { license } : {}),
    scripts,
    dependencies,
    peerDependencies,
    expectedTools,
    ...(expectedRoute ? { expectedRoute } : {}),
    ...(client.client ? { client: client.client } : {}),
    ...(client.clientPlatform ? { clientPlatform: client.clientPlatform } : {}),
  }
}

function parseBundlePatch(file: ContentFile | undefined): unknown {
  if (!file) return undefined
  try {
    const document = parseDocument(Buffer.from(file.content).toString('utf8'), {
      customTags: [{
        tag: 'tag:yaml.org,2002:js',
        resolve: (value: string) => ({ __jsExpr: value }),
      }],
    })
    if (document.errors.length > 0) return undefined
    return document.toJS()
  } catch {
    return undefined
  }
}

function activatedFibersFromPatchFile(file: ContentFile | undefined): NonNullable<ManifestFacts['activatedFibers']> {
  return activationTargetsFromPatch(parseBundlePatch(file))
}

function expectedRouteFromBundlePatch(file: ContentFile | undefined): ManifestFacts['expectedRoute'] | undefined {
  const patches = parseBundlePatch(file)
  if (!Array.isArray(patches)) return undefined
  for (const item of patches) {
    const patch = record(item)
    if (patch?.id !== 'agent-default-model') continue
    const config = record(patch.config)
    if (typeof config?.provider !== 'string' || !config.provider) continue
    return {
      provider: config.provider,
      ...(typeof config.model === 'string' && config.model ? { model: config.model } : {}),
    }
  }
  return undefined
}

function finding(code: string, severity: ReviewFinding['severity'], source: string, detail: string, sourceHash: string): ReviewFinding {
  return { code, severity, source, detail, evidenceHash: sha256(`${sourceHash}:${code}`) }
}

function scanContent(files: readonly ContentFile[], manifest: ManifestFacts): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  const packageFile = files.find((file) => file.path === 'package.json')
  const pkg = packageFile ? jsonObject(packageFile.content) : undefined
  const scripts = stringRecord(pkg?.scripts)
  const packageHash = packageFile ? sha256(packageFile.content) : sha256('package.json absent')
  if (manifest.kind === 'bundle' && !isSafePackageName(pkg?.name)) {
    findings.push(finding('unsafe_package_name', 'block', 'package.json', 'package name is missing or unsafe for DSH package management', packageHash))
  }
  if (manifest.kind === 'bundle') {
    if (!manifest.bundlePatch) {
      findings.push(finding('bundle_patch_path', 'block', 'package.json', 'dsh.bundle.patch must be a safe relative .json/.yaml/.yml path', packageHash))
    } else {
      const patchFile = files.find((file) => file.path === manifest.bundlePatch)
      if (!patchFile) {
        findings.push(finding('bundle_patch_missing', 'block', manifest.bundlePatch, 'the declared bundle patch was not present in the inspected snapshot', packageHash))
      } else {
        const problem = loaderPatchProblem(patchFile)
        if (problem) findings.push(finding('bundle_patch_invalid', 'block', manifest.bundlePatch, problem, sha256(patchFile.content)))
        if (!problem && manifest.expectedTools.length > 0 && !manifest.activatedFibers?.length) {
          findings.push(finding(
            'bundle_patch_no_activation',
            'block',
            manifest.bundlePatch,
            'the declared tool bundle patch does not insert any runtime module, so its tools cannot be loaded after installation',
            sha256(patchFile.content),
          ))
        }
      }
    }
  }
  const declaredRuntimeEntrypoints = [pkg?.main, pkg?.types, pkg?.typings]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => safeClientPath(value)?.replace(/^\.\//u, ''))
    .filter((value): value is string => Boolean(value))
  for (const entrypoint of [...new Set(declaredRuntimeEntrypoints)]) {
    if (!files.some((file) => file.path === entrypoint)) {
      findings.push(finding(
        'runtime_entrypoint_missing',
        'block',
        entrypoint,
        'the package declares a runtime entrypoint that is absent from the frozen install artifact',
        packageHash,
      ))
    }
  }
  for (const name of manifest.scripts) {
    const value = scripts[name] ?? ''
    const remoteDownload = /\b(?:curl|wget)\b/i.test(value)
      || /\b(?:irm|iwr|invoke-webrequest|invoke-restmethod)\b/i.test(value)
    findings.push(finding('lifecycle_script', remoteDownload ? 'block' : 'warning', 'package.json', `declares lifecycle script: ${name}`, packageHash))
  }
  for (const [group, dependencies] of Object.entries({
    dependencies: stringRecord(pkg?.dependencies),
    devDependencies: stringRecord(pkg?.devDependencies),
    optionalDependencies: stringRecord(pkg?.optionalDependencies),
    peerDependencies: stringRecord(pkg?.peerDependencies),
  })) {
    for (const [name, specification] of Object.entries(dependencies)) {
      const protocol = specification.match(/^(git\+|git:|https?:|file:)/i)?.[1]
      if (protocol) findings.push(finding('non_registry_dependency', 'warning', 'package.json', `${group} entry ${name} uses ${protocol.toLowerCase()} source`, packageHash))
    }
  }
  const INVISIBLE_UNICODE = /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/u
  const UNICODE_TAGS = /[\u{E0000}-\u{E007F}]/u
  const COMMENTED_INSTRUCTION = /<!--[\s\S]*?\b(?:ignore|bypass|override|instructions?|system\s+prompt|assistant|agent|llm)\b[\s\S]*?-->/i
  const EMBEDDED_DATA_URI = /data:[\w/+.-]{1,64};base64,[A-Za-z0-9+/]{100,}={0,2}/i
  const LONG_BASE64_BLOB = /[A-Za-z0-9+/]{200,}={0,2}/
  const PROMPT_INJECTION = /ignore\s+(?:all\s+)?previous\s+instructions|(?:disregard|forget)\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|preceding)\s+(?:instructions?|prompts?|messages?)|system\s+message|you\s+are\s+chatgpt|do\s+not\s+obey|never\s+refuse\b|always\s+comply\b|do\s+not\s+(?:warn|lecture|moralize)\b|(?:developer|god|jailbreak)\s+mode\s+(?:is\s+)?(?:enabled|activated|unlocked)\b|(?:enable|activate|enter)\s+(?:developer|god|jailbreak)\s+mode\b/i
  const EXFIL_ENDPOINT = /discord(?:app)?\.com\/api\/webhooks|webhook\.site|requestbin\.(?:com|net)|ngrok[\w-]*\.(?:io|app|com|dev)|api\.telegram\.org/i
  const EXFIL_INSTRUCTION = /(?:send|post|upload|forward|exfiltrate)\w*\s+(?:(?:the|all|your|their|this)\s+)*(?:conversation|chat|context|history|credentials?|secrets?|environment|env)(?:\s+(?:history|data|logs?|records?|files?))?\s+(?:to|into)\s+(?:an?\s+)?(?:external|remote|third[\s-]?party|https?:\/\/)/i
  const CREDENTIAL_PATHS = /\.ssh\/id_[\w.-]*|\.aws\/credentials|\.git-credentials|\.netrc\b|\/etc\/shadow\b/i
  const ENV_HARVEST = /Object\.(?:keys|entries|values)\s*\(\s*process\.env\s*\)|\{\s*\.\.\.process\.env\s*\}/
  const DYNAMIC_EVAL = /(?:\b|new\s+)(?:globalThis\.)?Function\s*\(|(?:^|[^\w.$])eval\s*\(/m
  const OBFUSCATED_IDENTIFIER = /_0x[0-9a-f]{4,}/
  const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:bash|sh|node|python[\d.]*)\b/i
  const EVAL_REMOTE_FETCH = /\beval\s*\(\s*await\s+fetch\s*\(|new\s+Function\s*\(\s*await\s+fetch\s*\(/
  const TLS_DISABLED = /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|\bcurl\b[^\n]*\s-k(?:\s|$)|--insecure\b|strict-ssl\s*=\s*false/i
  const DESTRUCTIVE_OPERATION = /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/(?:\s|['"]|$)|~(?=\s|['"]|$)|\$HOME\b)|\bdel\s+\/f\s+\/s\s+\/q\b|\bgit\s+push\b[^\n]*\s--force\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f[a-z]*d[a-z]*x\b/i
  const PERSISTENCE_MECHANISM = /\bcrontab\b|~\/.(?:bashrc|zshrc|profile)\b|\/etc\/systemd\/|\blaunchctl\b|\w\.plist['"\s]|CurrentVersion\\\\Run\b|\bnohup\b|\bsetsid\b/i
  const CLOUD_METADATA = /169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200/
  for (const file of files) {
    const extension = path.posix.extname(file.path).toLowerCase()
    const executableSource = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.tsx', '.jsx']).has(extension)
    const testOnly = /(^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(file.path)
    const fileHash = sha256(file.content)
    // Review prose and source as text, but do not reinterpret arbitrary binary
    // assets as UTF-8. Binary NUL bytes and image payloads are ordinary package
    // content, not evidence of hidden model instructions.
    if (file.content.includes(0)) continue
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.content)
    } catch {
      continue
    }
    // Text-surface rules scan every file: documentation and skill files are a
    // classic carrier for hidden instructions and exfiltration lures.
    if (INVISIBLE_UNICODE.test(text)) {
      findings.push(finding('hidden_instructions', 'block', file.path, 'contains invisible or bidirectional Unicode formatting characters', fileHash))
    } else if (UNICODE_TAGS.test(text)) {
      findings.push(finding('hidden_instructions', 'block', file.path, 'contains Unicode tag block characters', fileHash))
    } else if (COMMENTED_INSTRUCTION.test(text)) {
      findings.push(finding('hidden_instructions', 'block', file.path, 'hides instruction-like text inside an HTML comment', fileHash))
    } else if (EMBEDDED_DATA_URI.test(text) || (LONG_BASE64_BLOB.test(text) && !executableSource)) {
      findings.push(finding('hidden_instructions', 'block', file.path, 'embeds an opaque encoded payload in text', fileHash))
    }
    if (PROMPT_INJECTION.test(text)) {
      findings.push(finding('prompt_injection', 'block', file.path, 'contains prompt-injection-like instruction text', fileHash))
    }
    if (EXFIL_ENDPOINT.test(text)) {
      findings.push(finding('data_exfiltration', 'block', file.path, 'references a known webhook or tunnel collection endpoint', fileHash))
    } else if (EXFIL_INSTRUCTION.test(text)) {
      findings.push(finding('data_exfiltration', 'block', file.path, 'instructs sending conversation or credential data to an external endpoint', fileHash))
    }
    if (!executableSource || testOnly || file.path.endsWith('.d.ts')) continue
    const childProcessImport = /(?:from\s*['"](?:node:)?child_process['"]|require\s*\(\s*['"](?:node:)?child_process['"]\s*\))/i.test(text)
    const processExecution = /\b(?:exec|execFile|execFileSync|spawn|spawnSync)\s*\(|\b\w+\.(?:exec|execFile|execFileSync|spawn|spawnSync)\s*\(/.test(text)
    if (childProcessImport) findings.push(finding('child_process', 'warning', file.path, 'imports child_process', fileHash))
    if (childProcessImport && processExecution) {
      findings.push(finding('process_execution', 'warning', file.path, 'invokes an imported process execution API', fileHash))
    }
    if (DYNAMIC_EVAL.test(text)) {
      findings.push(finding('dynamic_evaluation', 'block', file.path, 'uses dynamic evaluation', fileHash))
    }
    if (/\bprocess\.env\b/.test(text)) findings.push(finding('environment_access', 'warning', file.path, 'accesses process environment', fileHash))
    if (/(?:from\s*['"](?:node:)?fs(?:\/promises)?['"]|require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\))/i.test(text)) {
      findings.push(finding('filesystem_access', 'warning', file.path, 'imports filesystem APIs', fileHash))
    }
    if (/\bfetch\s*\(|\b(?:curl|wget)\b/i.test(text)) findings.push(finding('network_access', 'warning', file.path, 'accesses network APIs', fileHash))
    if (CREDENTIAL_PATHS.test(text)) {
      findings.push(finding('credential_access', 'block', file.path, 'reads credential store paths', fileHash))
    } else if (ENV_HARVEST.test(text)) {
      findings.push(finding('credential_access', 'block', file.path, 'enumerates or spreads the process environment', fileHash))
    }
    if (OBFUSCATED_IDENTIFIER.test(text)) {
      findings.push(finding('obfuscated_code', 'block', file.path, 'uses obfuscator-style hexadecimal identifiers', fileHash))
    } else if (LONG_BASE64_BLOB.test(text) && DYNAMIC_EVAL.test(text)) {
      findings.push(finding('obfuscated_code', 'block', file.path, 'combines a long encoded blob with dynamic evaluation', fileHash))
    }
    if (PIPE_TO_SHELL.test(text) || EVAL_REMOTE_FETCH.test(text)) {
      findings.push(finding('remote_code_execution', 'block', file.path, 'downloads and executes remote code', fileHash))
    }
    if (TLS_DISABLED.test(text)) {
      findings.push(finding('tls_verification_disabled', 'warning', file.path, 'disables TLS certificate verification', fileHash))
    }
    if (DESTRUCTIVE_OPERATION.test(text)) {
      findings.push(finding('destructive_operation', 'warning', file.path, 'invokes destructive filesystem or git operations', fileHash))
    }
    if (PERSISTENCE_MECHANISM.test(text)) {
      findings.push(finding('persistence_mechanism', 'warning', file.path, 'installs a persistence mechanism', fileHash))
    }
    if (CLOUD_METADATA.test(text)) {
      findings.push(finding('cloud_metadata_access', 'block', file.path, 'queries a cloud instance metadata endpoint', fileHash))
    }
  }
  return findings.sort((left, right) => left.code.localeCompare(right.code) || left.source.localeCompare(right.source))
}

function compatibility(manifest: ManifestFacts, runtimeVersion?: string): ReviewRecord['compatibility'] {
  const relevant = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  const runtime = runtimeVersion && valid(runtimeVersion)
  if (!runtime) return { status: 'unknown', reason: 'The active DSH runtime version could not be established.', runtimeVersion: null }
  if (relevant.length === 0) return { status: 'unknown', reason: 'No DSH peer dependency range is declared.', runtimeVersion: runtime }
  if (relevant.some(([, range]) => !validRange(range) || !satisfies(runtime, range, { includePrerelease: true }))) {
    return { status: 'incompatible', reason: `At least one declared DSH peer range excludes the active runtime ${runtime}.`, runtimeVersion: runtime }
  }
  return { status: 'compatible', reason: `Declared DSH peer ranges include the active runtime ${runtime}.`, runtimeVersion: runtime }
}

function evaluateFit(requirement: string, manifest: ManifestFacts, files: readonly ContentFile[]): { fit: ReviewRecord['fit']; missingCapabilities: string[] } {
  const anchors = capabilityAnchors(requirement)
  if (anchors.length === 0) return { fit: 'none', missingCapabilities: ['clear capability requirement'] }
  const readme = files.filter((file) => /(^|\/)(?:readme|skill)\.md$/i.test(file.path)).map((file) => Buffer.from(file.content).toString('utf8')).join('\n').toLowerCase()
  const declared = [
    manifest.packageName ?? '',
    ...manifest.expectedTools,
    ...files.map((file) => file.path),
  ].join(' ').toLowerCase()
  const haystack = `${readme}\n${declared}`
  const requirementNorm = normalizeSearchText(requirement)
  const missing: string[] = []
  let matched = 0
  for (const anchor of anchors) {
    const label = anchor.aliases.find((alias) => requirementNorm.includes(alias)) ?? anchor.aliases[0] ?? anchor.key
    const present = anchor.aliases.some((alias) => alias && haystack.includes(alias))
      || (anchor.key === 'execution' && manifest.kind === 'bundle')
    const explicitlyUnsupported = anchor.aliases.some((alias) => {
      if (!alias) return false
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(?:does\\s+not\\s+support|not\\s+supported|不支持)\\s*(?:the\\s+)?${escaped}`, 'i').test(readme)
    })
    if (!present || explicitlyUnsupported) missing.push(label)
    else matched += 1
  }
  if (missing.length === 0) return { fit: 'full', missingCapabilities: [] }
  return { fit: matched > 0 ? 'partial' : 'none', missingCapabilities: missing.sort() }
}

function recommendReview(input: {
  sourceKind: ReviewRecord['sourceSnapshot']['kind']
  truncated?: boolean
  kind: ManifestFacts['kind']
  fit: ReviewRecord['fit']
  securityRisk: ReviewRecord['securityRisk']
  compatible: ReviewRecord['compatibility']['status']
  findings: readonly ReviewFinding[]
  materializable: boolean
}): ReviewRecord['recommendation'] {
  if ((input.sourceKind === 'local' && input.truncated)
    || input.kind !== 'bundle'
    || input.findings.some((item) => HARD_SKIP_FINDING_CODES.has(item.code))) {
    return 'skip'
  }
  if (!input.materializable) return 'skip'
  if (input.compatible === 'incompatible') return 'modify'
  if (input.fit === 'none') return 'modify'
  if (input.securityRisk === 'high') return 'modify'
  if (input.securityRisk === 'low' || input.securityRisk === 'medium') return 'use'
  return 'modify'
}

function isMechanicalFacts(value: object): value is MechanicalFacts {
  return 'staticRisk' in value && 'semanticContextRequired' in value && 'truncated' in value
}

export function needsSemanticReviewer(
  review: MechanicalFacts | Pick<ReviewRecord, 'fit' | 'securityRisk' | 'compatibility' | 'findings' | 'mechanicalFacts'>,
): boolean {
  if (isMechanicalFacts(review)) {
    return review.semanticContextRequired
  }
  if (review.mechanicalFacts) return needsSemanticReviewer(review.mechanicalFacts)
  return review.findings.some((item) => SEMANTIC_CONTEXT_FINDING_CODES.has(item.code))
}

function mechanicalMaterializable(input: {
  sourceKind: ReviewRecord['sourceSnapshot']['kind']
  truncated?: boolean
  kind: ManifestFacts['kind']
  packageName?: string
  findings: readonly ReviewFinding[]
}): boolean {
  return !(input.sourceKind === 'local' && input.truncated)
    && input.kind === 'bundle'
    && Boolean(input.packageName)
    && !input.findings.some((item) => HARD_SKIP_FINDING_CODES.has(item.code))
}

function mintInstallSpec(input: {
  truncated?: boolean
  materializable: boolean
  sourceSnapshot: ReviewRecord['sourceSnapshot']
  packageName?: string
  installSpec?: string
}): string | null {
  if (!input.materializable || !input.packageName) return null
  if (input.installSpec) return input.installSpec
  if (input.sourceSnapshot.kind !== 'github') return null
  return `github:${input.sourceSnapshot.repository}#${input.sourceSnapshot.commit}${input.sourceSnapshot.packagePath ? `:path/${input.sourceSnapshot.packagePath}` : ''}`
}

function mechanicalFactsFrom(input: {
  fit: ReviewRecord['fit']
  missingCapabilities: string[]
  staticRisk: ReviewRecord['securityRisk']
  compatibility: ReviewRecord['compatibility']
  manifest: ManifestFacts
  truncated: boolean
  findings: readonly ReviewFinding[]
  materializable: boolean
  installSpec: string | null
}): MechanicalFacts {
  const semanticContextRequired = input.findings.some((item) => SEMANTIC_CONTEXT_FINDING_CODES.has(item.code))
  const evidenceHashes = [...new Set(input.findings.map((item) => item.evidenceHash).filter((item): item is string => Boolean(item)))]
    .sort((left, right) => left.localeCompare(right))
  return {
    fit: input.fit,
    missingCapabilities: input.missingCapabilities,
    staticRisk: input.staticRisk,
    compatibility: input.compatibility,
    manifest: {
      kind: input.manifest.kind,
      ...(input.manifest.packageName ? { packageName: input.manifest.packageName } : {}),
      ...(input.manifest.packageVersion ? { packageVersion: input.manifest.packageVersion } : {}),
      ...(input.manifest.bundlePatch ? { bundlePatch: input.manifest.bundlePatch } : {}),
      materializable: input.materializable,
      installSpec: input.installSpec,
    },
    truncated: input.truncated,
    findings: input.findings.map((item) => ({
      code: item.code,
      severity: item.severity,
      source: item.source,
      ...(item.evidenceHash ? { evidenceHash: item.evidenceHash } : {}),
    })),
    evidenceHashes,
    semanticContextRequired,
    ...(!input.materializable ? { directUseHostBoundary: 'not_materializable' as const } : {}),
  }
}

/** Evaluates already-bounded content without returning any third-party source text. */
export function evaluatePluginContent(input: ReviewContentInput): ReviewRecord {
  const inspectedFiles: InspectedFile[] = input.files.map((file) => ({
    path: file.path,
    ...(file.blobId ? { blobId: file.blobId } : {}),
    sha256: sha256(file.content),
    bytes: file.content.byteLength,
  })).sort((left, right) => left.path.localeCompare(right.path))
  const manifest = manifestFrom(input.files)
  const findings = scanContent(input.files, manifest)
  if (manifest.kind !== 'bundle') {
    findings.push(finding(
      'unsupported_plugin_shape',
      'warning',
      'package.json',
      'No exact dsh.bundle.patch declaration was found; plugin installation is not authorized.',
      hashObject(manifest),
    ))
  }
  if (input.truncated) findings.push(finding('review_truncated', 'warning', 'repository', 'Inspection stopped at configured file or byte limit.', hashObject(inspectedFiles)))
  const { fit, missingCapabilities } = evaluateFit(input.requirement, manifest, input.files)
  const securityRisk: ReviewRecord['securityRisk'] = findings.some((item) => item.severity === 'block') ? 'high'
    : findings.some((item) => item.severity === 'warning') || input.truncated ? 'medium'
      : 'low'
  const compatible = compatibility(manifest, input.runtimeVersion)
  const license = manifest.license ?? null
  const maintained = input.maintained ?? false
  const sortedFindings = findings.sort((left, right) => left.code.localeCompare(right.code) || left.source.localeCompare(right.source))
  const materializable = mechanicalMaterializable({
    sourceKind: input.sourceSnapshot.kind,
    ...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
    kind: manifest.kind,
    ...(manifest.packageName ? { packageName: manifest.packageName } : {}),
    findings: sortedFindings,
  })
  const installSpec = mintInstallSpec({
    ...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
    materializable,
    sourceSnapshot: input.sourceSnapshot,
    ...(manifest.packageName ? { packageName: manifest.packageName } : {}),
    ...(input.installSpec ? { installSpec: input.installSpec } : {}),
  })
  const recommendation = recommendReview({
    sourceKind: input.sourceSnapshot.kind,
    ...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
    kind: manifest.kind,
    fit,
    securityRisk,
    compatible: compatible.status,
    findings: sortedFindings,
    materializable,
  })
  const mechanicalFacts = mechanicalFactsFrom({
    fit,
    missingCapabilities,
    staticRisk: securityRisk,
    compatibility: compatible,
    manifest,
    truncated: Boolean(input.truncated),
    findings: sortedFindings,
    materializable,
    installSpec,
  })
  const runtimeSurface = freezeRuntimeSurface({
    manifest,
    findings: sortedFindings,
    files: input.files,
    truncated: Boolean(input.truncated),
  })
  return {
    schemaVersion: 1,
    id: input.id ?? `review_${hashObject({
      policyVersion: POLICY_VERSION,
      requirement: input.requirement,
      sourceSnapshot: input.sourceSnapshot,
      inspectedFiles,
      manifest,
      compatible,
      artifact: input.artifact
        ? { sha256: input.artifact.sha256, bytes: input.artifact.bytes, entryCount: input.artifact.entryCount }
        : undefined,
    })}`,
    policyVersion: POLICY_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    resolutionId: input.resolutionId,
    requirement: input.requirement,
    sourceSnapshot: input.sourceSnapshot,
    inspectedFiles,
    manifest,
    fit,
    confidence: input.truncated ? 0.4 : input.files.length > 0 ? 0.8 : 0.1,
    securityRisk,
    maintained,
    license,
    compatibility: compatible,
    missingCapabilities,
    findings: sortedFindings,
    recommendation,
    installSpec,
    ...(input.artifact ? { artifact: input.artifact } : {}),
    mechanicalFacts,
    runtimeSurface,
  }
}

function parseGithub<T>(stdout: string, description: string): T {
  try {
    return JSON.parse(stdout) as T
  } catch (cause) {
    throw new EvolutionError('github_unavailable', `GitHub returned malformed ${description}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

async function ghApi(runner: CommandRunner, config: RuntimeConfig, cwd: string, endpoint: string, signal?: AbortSignal): Promise<string> {
  const result = await runner.run({
    argv: [config.ghCommand, 'api', '--method', 'GET', endpoint],
    cwd,
    ...(signal ? { signal } : {}),
  })
  return result.stdout
}

function safeTreePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.split('/').some((part) => part === '.' || part === '..')) return null
  return value
}

function priority(filePath: string): number {
  const lower = filePath.toLowerCase()
  if (filePath === 'package.json') return 0
  if (/(^|\/)dsh\.bundle(?:\.|\/|$)/i.test(filePath)) return 1
  if (/(^|\/)[^/]*patch\.(?:json|ya?ml)$/i.test(filePath)) return 1
  if (/(^|\/)skill\.md$/i.test(filePath)) return 1
  if (/^readme(?:\.|$)/i.test(path.posix.basename(filePath))) return 2
  if (SOURCE_EXTENSIONS.has(path.posix.extname(lower))) return 3
  return 4
}

function selectedPreviewEntries(entries: readonly TreeEntry[], config: RuntimeConfig): { entries: TreeEntry[]; truncated: boolean } {
  const previewBytes = Math.min(config.maxRepositoryBytes, 262_144)
  const eligible = entries.filter((entry) => {
    if (entry.type !== 'blob' || typeof entry.sha !== 'string' || !/^[a-f0-9]{40,64}$/iu.test(entry.sha)) return false
    const filePath = safeTreePath(entry.path)
    if (!filePath) return false
    const lower = filePath.toLowerCase()
    return lower === 'package.json'
      || /^readme(?:\.|$)/iu.test(path.posix.basename(filePath)) && !filePath.includes('/')
      || /(^|\/)dsh\.bundle(?:\.|\/|$)/iu.test(filePath)
      || /(^|\/)[^/]*patch\.(?:json|ya?ml)$/iu.test(filePath)
  }).sort((left, right) => priority(left.path as string) - priority(right.path as string)
    || (left.path as string).localeCompare(right.path as string))
  const selected: TreeEntry[] = []
  let bytes = 0
  for (const entry of eligible) {
    const size = typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : 0
    if (selected.length >= 6 || bytes + size > previewBytes) continue
    selected.push(entry)
    bytes += size
  }
  return { entries: selected, truncated: selected.length < eligible.length }
}

async function githubIdentity(options: {
  runner: CommandRunner
  config: RuntimeConfig
  cwd: string
  repository: string
  ref: string
  packagePath?: string
  signal?: AbortSignal
}): Promise<{ sourceSnapshot: Extract<ReviewRecord['sourceSnapshot'], { kind: 'github' }>; maintained: boolean }> {
  const repository = validateGithubRepository(options.repository)
  if (!options.ref.trim() || options.ref.includes('\n') || options.ref.includes('\r')) throw new EvolutionError('invalid_input', 'GitHub ref must not be empty or contain newlines')
  const escapedRef = encodeURIComponent(options.ref)
  const commit = parseGithub<GithubCommit>(await ghApi(options.runner, options.config, options.cwd, `repos/${repository}/commits/${escapedRef}`, options.signal), 'commit data')
  if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(commit.sha)) throw new EvolutionError('github_unavailable', 'GitHub did not resolve the requested ref to an exact commit')
  const repo = parseGithub<GithubRepository>(await ghApi(options.runner, options.config, options.cwd, `repos/${repository}`, options.signal), 'repository data')
  if (typeof repo.default_branch !== 'string' || !repo.default_branch) throw new EvolutionError('github_unavailable', 'GitHub did not provide a default branch')
  const commitDate = commit.commit?.committer?.date
  const maintained = typeof commitDate === 'string' && Number.isFinite(Date.parse(commitDate))
    && Date.now() - Date.parse(commitDate) <= 366 * 24 * 60 * 60 * 1000
  return {
    sourceSnapshot: {
      kind: 'github',
      repository,
      requestedRef: options.ref,
      commit: commit.sha,
      defaultBranch: repo.default_branch,
      ...(normalizePackagePath(options.packagePath) ? { packagePath: normalizePackagePath(options.packagePath) } : {}),
    },
    maintained,
  }
}

function boundedPreviewText(content: Uint8Array, maxLength: number): string {
  return Buffer.from(content).toString('utf8').normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maxLength)
}

function githubPreviewFromSnapshot(
  sourceSnapshot: Extract<ReviewRecord['sourceSnapshot'], { kind: 'github' }>,
  snapshot: ContentSnapshot,
): GithubPluginPreview {
  const manifest = manifestFrom(snapshot.files)
  const packageFile = snapshot.files.find((file) => file.path === 'package.json')
  let packageSummary: GithubPluginPreview['packageSummary']
  if (packageFile) {
    try {
      const value: unknown = JSON.parse(Buffer.from(packageFile.content).toString('utf8'))
      const item = record(value)
      const description = typeof item?.description === 'string' ? boundedPreviewText(Buffer.from(item.description), 1_000) : undefined
      const keywords = Array.isArray(item?.keywords)
        ? item.keywords.filter((entry): entry is string => typeof entry === 'string').map((entry) => boundedPreviewText(Buffer.from(entry), 100)).filter(Boolean).slice(0, 30)
        : undefined
      if (description || keywords?.length) packageSummary = {
        ...(description ? { description } : {}),
        ...(keywords?.length ? { keywords } : {}),
      }
    } catch {
      // Formal review reports malformed package data. Preview stays best-effort.
    }
  }
  const readme = snapshot.files.find((file) => /^readme(?:\.|$)/iu.test(path.posix.basename(file.path)))
  const inspectedFiles = snapshot.files.map((file) => ({
    path: file.path,
    ...(file.blobId ? { blobId: file.blobId } : {}),
    sha256: sha256(file.content),
    bytes: file.content.byteLength,
  })).sort((left, right) => left.path.localeCompare(right.path))
  return {
    repository: sourceSnapshot.repository,
    commit: sourceSnapshot.commit,
    defaultBranch: sourceSnapshot.defaultBranch,
    packagePath: sourceSnapshot.packagePath ?? '',
    inspectedFiles,
    truncated: snapshot.truncated,
    manifest: {
      kind: manifest.kind,
      ...(manifest.packageName ? { packageName: manifest.packageName } : {}),
      ...(manifest.packageVersion ? { packageVersion: manifest.packageVersion } : {}),
      ...(manifest.bundlePatch ? { bundlePatch: manifest.bundlePatch } : {}),
      ...(manifest.license ? { license: manifest.license } : {}),
    },
    ...(packageSummary ? { packageSummary } : {}),
    ...(readme ? { readmeExcerpt: boundedPreviewText(readme.content, 2_000) } : {}),
  }
}

interface CachedTreeEntry extends TreeEntry { path: string; sha: string }

function parseCachedTree(stdout: string): CachedTreeEntry[] {
  return stdout.split(/\r?\n/gu).flatMap((line) => {
    if (!line) return []
    const tab = line.indexOf('\t')
    if (tab < 0) return []
    const metadata = line.slice(0, tab).split(' ')
    const filePath = safeTreePath(line.slice(tab + 1))
    const sha = metadata[2]
    if (metadata[1] !== 'blob' || !filePath || !sha || !/^[a-f0-9]{40,64}$/iu.test(sha)) return []
    return [{ path: filePath, sha, type: 'blob' as const }]
  })
}

/** Cache one exact commit, then expand each valid DSH bundle package locally. */
export async function previewGithubPlugins(options: {
  runner: CommandRunner
  config: RuntimeConfig
  cwd: string
  repository: string
  ref: string
  packagePath?: string
  signal?: AbortSignal
}): Promise<GithubPluginPreview[]> {
  const identity = await githubIdentity(options)
  return await withCachedGithubRepository({
    runner: options.runner,
    config: options.config,
    cacheRoot: resolveGitCacheRoot(options.cwd),
    workspaceRoot: options.cwd,
    repository: identity.sourceSnapshot.repository,
    commit: identity.sourceSnapshot.commit,
    ...(options.signal ? { signal: options.signal } : {}),
  }, async (cached) => {
    const tree = parseCachedTree(await cached.git(['ls-tree', '-r', identity.sourceSnapshot.commit]))
    const requestedPackagePath = normalizePackagePath(options.packagePath)
    const manifests = tree.filter((entry) => {
      if (entry.path !== 'package.json' && !entry.path.endsWith('/package.json')) return false
      const packagePath = entry.path === 'package.json' ? '' : path.posix.dirname(entry.path)
      return !requestedPackagePath || packagePath === requestedPackagePath
    })
    if (manifests.length > 100) {
      throw new EvolutionError('review_rejected', 'Repository contains too many package manifests for bounded plugin preview')
    }
    const packageRoots = manifests.map((entry) => entry.path === 'package.json' ? '' : path.posix.dirname(entry.path))
    const owningPackageRoot = (filePath: string): string => packageRoots
      .filter((root) => !root || filePath === root || filePath.startsWith(`${root}/`))
      .sort((left, right) => right.length - left.length)[0] ?? ''
    const previews: GithubPluginPreview[] = []
    for (const packageEntry of manifests) {
      const packagePath = packageEntry.path === 'package.json'
        ? ''
        : normalizePackagePath(path.posix.dirname(packageEntry.path))
      const prefix = packagePath ? `${packagePath}/` : ''
      const relativeEntries = tree.flatMap((entry): TreeEntry[] => {
        if (owningPackageRoot(entry.path) !== packagePath) return []
        if (prefix && !entry.path.startsWith(prefix)) return []
        const relative = prefix ? entry.path.slice(prefix.length) : entry.path
        if (!relative) return []
        return [{ ...entry, path: relative }]
      })
      const chosen = selectedPreviewEntries(relativeEntries, options.config)
      const files: ContentFile[] = []
      let actualBytes = 0
      let actualTruncated = chosen.truncated
      for (const entry of chosen.entries) {
        const relative = safeTreePath(entry.path)
        if (!relative || typeof entry.sha !== 'string') continue
        const fullPath = prefix + relative
        const content = Buffer.from(await cached.git(['show', `${identity.sourceSnapshot.commit}:${fullPath}`]), 'utf8')
        if (actualBytes + content.byteLength > options.config.maxRepositoryBytes) {
          actualTruncated = true
          continue
        }
        actualBytes += content.byteLength
        files.push({ path: relative, content, blobId: entry.sha })
      }
      const manifest = manifestFrom(files)
      if (manifest.kind !== 'bundle') continue
      previews.push(githubPreviewFromSnapshot({
        ...identity.sourceSnapshot,
        ...(packagePath ? { packagePath } : {}),
      }, { files, truncated: actualTruncated }))
    }
    if (previews.length > 5) {
      throw new EvolutionError('review_rejected', 'Repository contains more than five DSH bundle packages; retry with an exact package path', {
        packagePaths: previews.map((item) => item.packagePath).slice(0, 100),
      })
    }
    if (previews.length === 0) {
      throw new EvolutionError('review_rejected', 'Repository does not contain a reviewable DSH bundle package')
    }
    return previews.sort((left, right) => left.packagePath.localeCompare(right.packagePath))
  })
}

/** Backward-compatible single-package preview API. */
export async function previewGithubPlugin(options: Parameters<typeof previewGithubPlugins>[0] & { packagePath?: string }): Promise<GithubPluginPreview> {
  const previews = await previewGithubPlugins(options)
  const requested = normalizePackagePath(options.packagePath)
  const preview = previews.find((item) => item.packagePath === requested) ?? (!options.packagePath && previews.length === 1 ? previews[0] : undefined)
  if (!preview) throw new EvolutionError('review_rejected', 'Repository preview resolved to multiple packages; select an exact package path')
  return preview
}

export async function reviewGithubPluginWithFiles(options: {
  runner: CommandRunner
  config: RuntimeConfig
  cwd: string
  repository: string
  ref: string
  packagePath?: string
  resolutionId: string
  requirement: string
  artifactRoot: string
  runtimeVersion?: string
  signal?: AbortSignal
}): Promise<GithubReviewEvidence> {
  if (!options.artifactRoot.trim()) {
    throw new EvolutionError('invalid_input', 'Formal GitHub review requires a Host-owned artifact root')
  }
  const result = await githubIdentity(options)
  const artifact = await freezeGithubPackage({
    runner: options.runner,
    config: options.config,
    repository: result.sourceSnapshot.repository,
    commit: result.sourceSnapshot.commit,
    ...(result.sourceSnapshot.packagePath ? { packagePath: result.sourceSnapshot.packagePath } : {}),
    cacheRoot: resolveGitCacheRoot(options.cwd),
    workspaceRoot: options.cwd,
    artifactRoot: options.artifactRoot,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const record = evaluatePluginContent({
    resolutionId: options.resolutionId,
    requirement: options.requirement,
    sourceSnapshot: result.sourceSnapshot,
    files: artifact.files,
    truncated: false,
    maintained: result.maintained,
    installSpec: artifact.installSpec,
    artifact: reviewedArtifact(artifact),
    ...(options.runtimeVersion ? { runtimeVersion: options.runtimeVersion } : {}),
  })
  return { record, files: artifact.files }
}

function reviewedArtifact(artifact: FrozenPackageArtifact): ReviewedArtifact {
  return {
    sha256: artifact.artifactSha256,
    bytes: artifact.artifactBytes,
    entryCount: artifact.files.length,
    ownedRoot: artifact.artifactRoot,
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export async function inspectLocalDirectory(root: string, config: RuntimeConfig): Promise<ContentSnapshot> {
  const paths: string[] = []
  let visited = 0
  let truncated = false
  const maxVisited = Math.max(config.maxFiles * 20, 1_000)
  async function visit(directory: string): Promise<void> {
    if (truncated) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      visited += 1
      if (visited > maxVisited) { truncated = true; return }
      const relative = path.relative(root, path.join(directory, entry.name))
      if (isExcludedLocalPackagePath(relative)) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) { truncated = true; continue }
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) {
        paths.push(path.relative(root, absolute).split(path.sep).join('/'))
        if (paths.length > config.maxFiles) { truncated = true; return }
      } else {
        truncated = true
      }
    }
  }
  await visit(root)
  const selected = paths.sort((left, right) => priority(left) - priority(right) || left.localeCompare(right))
  const files: ContentFile[] = []
  let bytes = 0
  for (const filePath of selected) {
    if (files.length >= config.maxFiles) { truncated = true; continue }
    const content = await readFile(path.join(root, filePath))
    if (bytes + content.byteLength > config.maxRepositoryBytes) { truncated = true; continue }
    bytes += content.byteLength
    files.push({ path: filePath, content })
  }
  return { files, truncated }
}

const PACKAGE_FILE_GLOB_MAGIC = /[*?[\]{}!]/u
const NPM_ALWAYS_INCLUDED_FILE = /^(?:readme|licen[cs]e|notice|copying)(?:\.|$)/iu

function literalPackagePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || (process.platform === 'win32' && value.includes(':'))
    || PACKAGE_FILE_GLOB_MAGIC.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null
  const relative = value.replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (!relative || isExcludedLocalPackagePath(relative)
    || relative.split('/').some((part) => part === '.' || part === '..' || !part)) return null
  return relative
}

function nestedStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(nestedStringValues)
  return Object.values(value as Record<string, unknown>).flatMap(nestedStringValues)
}

function minimizePackageRoots(roots: readonly string[]): string[] {
  const selected: string[] = []
  for (const candidate of [...new Set(roots)].sort((left, right) => left.length - right.length || left.localeCompare(right))) {
    if (selected.some((root) => candidate === root || candidate.startsWith(`${root}/`))) continue
    selected.push(candidate)
  }
  return selected.sort((left, right) => priority(left) - priority(right) || left.localeCompare(right))
}

async function declaredPackageRoots(root: string): Promise<string[] | null> {
  let pkg: Record<string, unknown> | undefined
  try {
    pkg = jsonObject(await readFile(path.join(root, 'package.json')))
  } catch {
    return null
  }
  if (!pkg || !Array.isArray(pkg.files)) return null
  const declared = pkg.files.map(literalPackagePath)
  // npm supports a wide files grammar. Unsupported globs and unsafe paths fall
  // back to the complete-tree review instead of guessing a narrower package.
  if (declared.some((entry) => entry === null)) return null

  const roots = ['package.json', ...(declared as string[])]
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && (NPM_ALWAYS_INCLUDED_FILE.test(entry.name) || entry.name === 'npm-shrinkwrap.json')) roots.push(entry.name)
  }
  const dsh = record(pkg.dsh)
  const bundle = record(dsh?.bundle)
  const entrypoints = [
    pkg.main,
    pkg.types,
    pkg.typings,
    ...nestedStringValues(pkg.browser),
    ...nestedStringValues(pkg.exports),
    ...nestedStringValues(pkg.bin),
    ...nestedStringValues(pkg.man),
    bundle?.patch,
  ]
  for (const entrypoint of entrypoints) {
    const relative = literalPackagePath(entrypoint)
    if (relative) roots.push(relative)
  }
  return minimizePackageRoots(roots)
}

async function inspectLiteralPackageRoots(root: string, roots: readonly string[], config: RuntimeConfig): Promise<ContentSnapshot> {
  const paths = new Set<string>()
  const visitedDirectories = new Set<string>()
  let visited = 0
  let truncated = false
  const maxVisited = Math.max(config.maxFiles * 20, 1_000)

  async function visit(relative: string): Promise<void> {
    if (truncated) return
    const absolute = path.join(root, ...relative.split('/'))
    let facts: Awaited<ReturnType<typeof lstat>>
    try {
      facts = await lstat(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    visited += 1
    if (visited > maxVisited) { truncated = true; return }
    if (facts.isSymbolicLink() || (!facts.isDirectory() && !facts.isFile())) { truncated = true; return }
    if (facts.isFile()) {
      paths.add(relative)
      if (paths.size > config.maxFiles) truncated = true
      return
    }
    if (visitedDirectories.has(relative)) return
    visitedDirectories.add(relative)
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      await visit(`${relative}/${entry.name}`)
      if (truncated) return
    }
  }

  for (const relative of roots) {
    await visit(relative)
    if (truncated) break
  }
  const selected = [...paths].sort((left, right) => priority(left) - priority(right) || left.localeCompare(right))
  const files: ContentFile[] = []
  let bytes = 0
  for (const filePath of selected) {
    if (files.length >= config.maxFiles) { truncated = true; continue }
    const content = await readFile(path.join(root, ...filePath.split('/')))
    if (bytes + content.byteLength > config.maxRepositoryBytes) { truncated = true; continue }
    bytes += content.byteLength
    files.push({ path: filePath, content })
  }
  return { files, truncated }
}

/** Review the literal package surface when package.json declares one; otherwise review the complete tree. */
export async function inspectLocalPackageDirectory(root: string, config: RuntimeConfig): Promise<ContentSnapshot> {
  const roots = await declaredPackageRoots(root)
  return roots ? inspectLiteralPackageRoots(root, roots, config) : inspectLocalDirectory(root, config)
}

async function git(
  runner: CommandRunner,
  config: RuntimeConfig,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const result = await runner.run({
    argv: [config.gitCommand, ...args],
    cwd,
    ...(signal ? { signal } : {}),
  })
  signal?.throwIfAborted()
  return result.stdout.trim()
}

/**
 * Reviews only a Git worktree root inside the current workspace. The returned
 * content hash binds the exact local bytes in addition to Git HEAD and status.
 */
export async function reviewLocalPlugin(options: {
  runner: CommandRunner
  config: RuntimeConfig
  workspaceRoot: string
  path: string
  baseReviewId: string
  resolutionId: string
  requirement: string
  runtimeVersion?: string
  /** When provided, review exactly one retained npm artifact instead of the source tree. */
  artifactRoot?: string
  /** GitHub lineage-root SHA. When omitted, HEAD is treated as the root (uncommitted-only reviews). */
  lineageRootCommit?: string
  /** Pack/review this package while retaining the repository root as source provenance. */
  packagePath?: string
  signal?: AbortSignal
}): Promise<LocalReviewResult> {
  options.signal?.throwIfAborted()
  if (!/^review_[a-f0-9]{16,64}$/.test(options.baseReviewId)) throw new EvolutionError('invalid_input', 'Invalid base review id')
  const workspace = await realpath(options.workspaceRoot)
  const target = await realpath(options.path)
  if (!isWithin(workspace, target)) throw new EvolutionError('unsafe_path', 'Local review path is outside the current workspace')
  const gitRoot = await git(options.runner, options.config, target, ['-C', target, 'rev-parse', '--show-toplevel'], options.signal)
  const canonicalRoot = await realpath(gitRoot)
  if (canonicalRoot !== target || !isWithin(workspace, canonicalRoot)) {
    throw new EvolutionError('unsafe_path', 'Local review path must be a Git worktree root inside the current workspace')
  }
  const head = await git(options.runner, options.config, canonicalRoot, ['-C', canonicalRoot, 'rev-parse', 'HEAD'], options.signal)
  if (!/^[a-f0-9]{40}$/i.test(head)) throw new EvolutionError('command_failed', 'Git did not provide an exact base commit')
  const lineageRoot = options.lineageRootCommit ?? head
  if (!/^[a-f0-9]{40}$/i.test(lineageRoot)) throw new EvolutionError('invalid_input', 'lineageRootCommit must be a 40-character commit')
  if (head.toLowerCase() !== lineageRoot.toLowerCase()) {
    const ancestry = await options.runner.run({
      argv: [options.config.gitCommand, '-C', canonicalRoot, 'merge-base', '--is-ancestor', lineageRoot, head],
      cwd: canonicalRoot,
      allowFailure: true,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    options.signal?.throwIfAborted()
    if (ancestry.exitCode !== 0) {
      throw new EvolutionError(
        'review_rejected',
        'The local checkout HEAD is not the reviewed upstream commit or a descendant of it',
      )
    }
  }
  const baseCommit = lineageRoot.toLowerCase()
  const packagePath = normalizePackagePath(options.packagePath)
  const packageRoot = packagePath
    ? await realpath(path.join(canonicalRoot, ...packagePath.split('/')))
    : canonicalRoot
  if (!isWithin(canonicalRoot, packageRoot)) throw new EvolutionError('unsafe_path', 'Local package path escaped its managed repository')
  const status = await git(
    options.runner,
    options.config,
    canonicalRoot,
    ['-C', canonicalRoot, 'status', '--porcelain=v1', '--untracked-files=all'],
    options.signal,
  )
  options.signal?.throwIfAborted()
  const artifact = options.artifactRoot
    ? await freezeLocalPackage({
        sourceRoot: packageRoot,
        artifactRoot: options.artifactRoot,
        config: options.config,
        runner: options.runner,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    : undefined
  options.signal?.throwIfAborted()
  const snapshot = artifact
    ? { files: artifact.files, truncated: false }
    : await inspectLocalPackageDirectory(packageRoot, options.config)
  options.signal?.throwIfAborted()
  // A Host-committed managed change has a clean worktree, so status alone is
  // always the SHA-256 of empty text. Bind the local identity to exact HEAD as
  // well as any residual status to distinguish reviewed commits truthfully.
  const statusHash = sha256(`${head.toLowerCase()}\n${status}\n${packagePath}`)
  const contentHash = hashObject(snapshot.files.map((file) => ({ path: file.path, sha256: sha256(file.content), bytes: file.content.byteLength })))
  const record = evaluatePluginContent({
    resolutionId: options.resolutionId,
    requirement: options.requirement,
    sourceSnapshot: {
      kind: 'local', path: canonicalRoot, baseReviewId: options.baseReviewId, baseCommit, statusHash,
      ...(packagePath ? { packagePath } : {}),
    },
    files: snapshot.files,
    truncated: snapshot.truncated,
    maintained: true,
    ...(artifact ? { installSpec: artifact.installSpec, artifact: reviewedArtifact(artifact) } : {}),
    ...(options.runtimeVersion ? { runtimeVersion: options.runtimeVersion } : {}),
  })
  return { record, contentHash, files: snapshot.files }
}
