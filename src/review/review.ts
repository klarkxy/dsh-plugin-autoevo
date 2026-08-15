import { readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { satisfies, validRange } from 'semver'
import type { RuntimeConfig } from '../config.js'
import type { InspectedFile, ManifestFacts, ReviewFinding, ReviewRecord } from '../contracts.js'
import { EvolutionError } from '../errors.js'
import { validateGithubRepository } from '../github/discovery.js'
import { isSafePackageName } from '../package-name.js'
import type { CommandRunner } from '../process/runner.js'
import { hashObject, sha256 } from '../state/hashes.js'

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

interface GithubBlob {
  content?: unknown
  encoding?: unknown
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
}

export interface LocalReviewResult {
  record: ReviewRecord
  /** Hash of ordered, inspected content hashes. Kept outside ReviewRecord until its shared schema grows this field. */
  contentHash: string
}

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.tsx', '.jsx', '.json', '.yaml', '.yml'])
const LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepublish', 'prepare', 'prepack', 'postpack', 'prepublishOnly'])

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

function manifestFrom(files: readonly ContentFile[]): ManifestFacts {
  const packageFile = files.find((file) => file.path === 'package.json')
  const pkg = packageFile ? jsonObject(packageFile.content) : undefined
  const dsh = pkg?.dsh && typeof pkg.dsh === 'object' && !Array.isArray(pkg.dsh) ? pkg.dsh as Record<string, unknown> : undefined
  const bundle = dsh?.bundle && typeof dsh.bundle === 'object' && !Array.isArray(dsh.bundle) ? dsh.bundle as Record<string, unknown> : undefined
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
  const bundlePatch = typeof bundle?.patch === 'string' ? bundle.patch : undefined
  return {
    kind: bundlePatch ? 'bundle' : hasSkill ? 'skill' : pkg ? 'legacy' : 'unknown',
    ...(isSafePackageName(pkg?.name) ? { packageName: pkg.name } : {}),
    ...(typeof pkg?.version === 'string' ? { packageVersion: pkg.version } : {}),
    ...(bundlePatch ? { bundlePatch } : {}),
    ...(license ? { license } : {}),
    scripts,
    dependencies,
    peerDependencies,
    expectedTools,
  }
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
  for (const name of manifest.scripts) {
    const value = scripts[name] ?? ''
    const remoteExecutor = /\b(?:curl|wget|powershell|cmd(?:\.exe)?|bash|sh)\b/i.test(value)
    findings.push(finding('lifecycle_script', remoteExecutor ? 'block' : 'warning', 'package.json', `declares lifecycle script: ${name}`, packageHash))
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
  for (const file of files) {
    const extension = path.posix.extname(file.path).toLowerCase()
    const executableSource = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.tsx', '.jsx']).has(extension)
    const documentation = /(^|\/)(?:skill|readme)(?:\.[^/]+)?\.md$/i.test(file.path)
    const testOnly = /(^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(file.path)
    if ((!executableSource && !documentation) || testOnly || file.path.endsWith('.d.ts')) continue
    const text = Buffer.from(file.content).toString('utf8')
    const fileHash = sha256(file.content)
    if (executableSource) {
      const childProcessImport = /(?:from\s*['"](?:node:)?child_process['"]|require\s*\(\s*['"](?:node:)?child_process['"]\s*\))/i.test(text)
      const processExecution = /\b(?:exec|execFile|execFileSync|spawn|spawnSync)\s*\(|\b\w+\.(?:exec|execFile|execFileSync|spawn|spawnSync)\s*\(/.test(text)
      if (childProcessImport) findings.push(finding('child_process', 'warning', file.path, 'imports child_process', fileHash))
      if (childProcessImport && processExecution) findings.push(finding('process_execution', 'block', file.path, 'invokes an imported process execution API', fileHash))
      if (/(?:\b|new\s+)(?:globalThis\.)?Function\s*\(|(?:^|[^\w.$])eval\s*\(/m.test(text)) {
        findings.push(finding('dynamic_evaluation', 'block', file.path, 'uses dynamic evaluation', fileHash))
      }
      if (/\bprocess\.env\b/.test(text)) findings.push(finding('environment_access', 'warning', file.path, 'accesses process environment', fileHash))
      if (/(?:from\s*['"](?:node:)?fs(?:\/promises)?['"]|require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\))/i.test(text)) {
        findings.push(finding('filesystem_access', 'warning', file.path, 'imports filesystem APIs', fileHash))
      }
      if (/\bfetch\s*\(|\b(?:curl|wget)\b/i.test(text)) findings.push(finding('network_access', 'warning', file.path, 'accesses network APIs', fileHash))
    }
    if (/ignore\s+(?:all\s+)?previous\s+instructions|system\s+message|you\s+are\s+chatgpt|do\s+not\s+obey/i.test(text)) {
      findings.push(finding('prompt_injection', 'block', file.path, 'contains prompt-injection-like instruction text', fileHash))
    }
  }
  return findings.sort((left, right) => left.code.localeCompare(right.code) || left.source.localeCompare(right.source))
}

function compatibility(manifest: ManifestFacts): ReviewRecord['compatibility'] {
  const relevant = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  if (relevant.length === 0) return { status: 'unknown', reason: 'No DSH peer dependency range is declared.' }
  if (relevant.some(([, range]) => !validRange(range) || !satisfies('0.1.0-rc.6', range, { includePrerelease: true }))) {
    return { status: 'incompatible', reason: 'At least one declared DSH peer range excludes 0.1.0-rc.6.' }
  }
  return { status: 'compatible', reason: 'Declared DSH peer ranges include 0.1.0-rc.6.' }
}

function requirementTerms(requirement: string): string[] {
  const terms = new Set<string>()
  const lower = requirement.toLowerCase()
  const phrases = ['scientific notation', 'calculator', 'calculation', 'calculate', 'math', '科学计数法', '计算器', '计算']
  for (const phrase of phrases) {
    if (lower.includes(phrase)) terms.add(phrase)
  }
  for (const token of lower.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
    if (phrases.some((phrase) => phrase.includes(' ') && phrase.split(' ').includes(token))) continue
    if (!new Set(['that', 'with', 'from', 'need', 'want', 'support', 'plugin', 'tool', 'does']).has(token)) terms.add(token)
  }
  return [...terms].sort((left, right) => right.length - left.length || left.localeCompare(right))
}

function evaluateFit(requirement: string, manifest: ManifestFacts, files: readonly ContentFile[]): { fit: ReviewRecord['fit']; missingCapabilities: string[] } {
  const requested = requirementTerms(requirement)
  if (requested.length === 0) return { fit: 'none', missingCapabilities: ['clear capability requirement'] }
  const readme = files.filter((file) => /(^|\/)(?:readme|skill)\.md$/i.test(file.path)).map((file) => Buffer.from(file.content).toString('utf8')).join('\n').toLowerCase()
  const declared = [manifest.packageName ?? '', ...manifest.expectedTools].join(' ').toLowerCase()
  const missing: string[] = []
  let matched = 0
  for (const term of requested) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const explicitlyUnsupported = new RegExp(`(?:does\\s+not\\s+support|not\\s+supported|不支持)\\s*(?:the\\s+)?${escaped}`, 'i').test(readme)
    const present = readme.includes(term) || declared.includes(term)
    if (!present || explicitlyUnsupported) missing.push(term)
    else matched += 1
  }
  if (missing.length === 0) return { fit: 'full', missingCapabilities: [] }
  return { fit: matched > 0 ? 'partial' : 'none', missingCapabilities: missing.sort() }
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
  const compatible = compatibility(manifest)
  const license = manifest.license ?? null
  const maintained = input.maintained ?? false
  const recommendation: ReviewRecord['recommendation'] = input.truncated || manifest.kind !== 'bundle' || securityRisk === 'high' || compatible.status === 'incompatible' || fit === 'none'
    ? 'skip'
    : fit === 'full' && compatible.status === 'compatible'
      ? 'use'
      : 'modify'
  return {
    schemaVersion: 1,
    id: input.id ?? `review_${hashObject({ policyVersion: 'v1-2026-08-15', requirement: input.requirement, sourceSnapshot: input.sourceSnapshot, inspectedFiles, manifest })}`,
    policyVersion: 'v1-2026-08-15',
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
    findings: findings.sort((left, right) => left.code.localeCompare(right.code) || left.source.localeCompare(right.source)),
    recommendation,
    installSpec: input.truncated || compatible.status === 'incompatible' || manifest.kind !== 'bundle' ? null
      : input.sourceSnapshot.kind === 'github' && manifest.packageName
        ? `github:${input.sourceSnapshot.repository}#${input.sourceSnapshot.commit}`
        : null,
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
  if (/(^|\/)skill\.md$/i.test(filePath)) return 1
  if (/^readme(?:\.|$)/i.test(path.posix.basename(filePath))) return 2
  if (SOURCE_EXTENSIONS.has(path.posix.extname(lower))) return 3
  return 4
}

function selectedEntries(entries: readonly TreeEntry[], config: RuntimeConfig): { entries: TreeEntry[]; truncated: boolean } {
  const valid = entries.filter((entry) => entry.type === 'blob' && typeof entry.sha === 'string' && /^[a-f0-9]{40,64}$/i.test(entry.sha) && safeTreePath(entry.path))
    .sort((left, right) => priority(left.path as string) - priority(right.path as string) || (left.path as string).localeCompare(right.path as string))
  const selected: TreeEntry[] = []
  let bytes = 0
  let truncated = false
  for (const entry of valid) {
    const size = typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : 0
    if (selected.length >= config.maxFiles || bytes + size > config.maxRepositoryBytes) {
      truncated = true
      continue
    }
    selected.push(entry)
    bytes += size
  }
  return { entries: selected, truncated }
}

async function githubSnapshot(options: {
  runner: CommandRunner
  config: RuntimeConfig
  cwd: string
  repository: string
  ref: string
  signal?: AbortSignal
}): Promise<{ sourceSnapshot: Extract<ReviewRecord['sourceSnapshot'], { kind: 'github' }>; snapshot: ContentSnapshot; maintained: boolean }> {
  const repository = validateGithubRepository(options.repository)
  if (!options.ref.trim() || options.ref.includes('\n') || options.ref.includes('\r')) throw new EvolutionError('invalid_input', 'GitHub ref must not be empty or contain newlines')
  const escapedRef = encodeURIComponent(options.ref)
  const commit = parseGithub<GithubCommit>(await ghApi(options.runner, options.config, options.cwd, `repos/${repository}/commits/${escapedRef}`, options.signal), 'commit data')
  if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(commit.sha)) throw new EvolutionError('github_unavailable', 'GitHub did not resolve the requested ref to an exact commit')
  const repo = parseGithub<GithubRepository>(await ghApi(options.runner, options.config, options.cwd, `repos/${repository}`, options.signal), 'repository data')
  if (typeof repo.default_branch !== 'string' || !repo.default_branch) throw new EvolutionError('github_unavailable', 'GitHub did not provide a default branch')
  const tree = parseGithub<GithubTree>(await ghApi(options.runner, options.config, options.cwd, `repos/${repository}/git/trees/${commit.sha}?recursive=1`, options.signal), 'tree data')
  if (!Array.isArray(tree.tree)) throw new EvolutionError('github_unavailable', 'GitHub did not provide a file tree')
  const chosen = selectedEntries(tree.tree as TreeEntry[], options.config)
  const files: ContentFile[] = []
  let actualBytes = 0
  let truncated = chosen.truncated || tree.truncated === true
  for (const entry of chosen.entries) {
    const filePath = safeTreePath(entry.path)
    if (!filePath || typeof entry.sha !== 'string') continue
    const blob = parseGithub<GithubBlob>(await ghApi(options.runner, options.config, options.cwd, `repos/${repository}/git/blobs/${entry.sha}`, options.signal), 'blob data')
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new EvolutionError('github_unavailable', 'GitHub returned an unsupported blob encoding', { path: filePath })
    const content = Buffer.from(blob.content.replace(/[\r\n]/g, ''), 'base64')
    if (actualBytes + content.byteLength > options.config.maxRepositoryBytes) {
      truncated = true
      continue
    }
    actualBytes += content.byteLength
    files.push({ path: filePath, content, blobId: entry.sha })
  }
  const commitDate = commit.commit?.committer?.date
  const maintained = typeof commitDate === 'string' && Number.isFinite(Date.parse(commitDate))
    && Date.now() - Date.parse(commitDate) <= 366 * 24 * 60 * 60 * 1000
  return {
    sourceSnapshot: { kind: 'github', repository, requestedRef: options.ref, commit: commit.sha, defaultBranch: repo.default_branch },
    snapshot: { files, truncated },
    maintained,
  }
}

export async function reviewGithubPlugin(options: {
  runner: CommandRunner
  config: RuntimeConfig
  cwd: string
  repository: string
  ref: string
  resolutionId: string
  requirement: string
  signal?: AbortSignal
}): Promise<ReviewRecord> {
  const result = await githubSnapshot(options)
  return evaluatePluginContent({
    resolutionId: options.resolutionId,
    requirement: options.requirement,
    sourceSnapshot: result.sourceSnapshot,
    files: result.snapshot.files,
    truncated: result.snapshot.truncated,
    maintained: result.maintained,
  })
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
      if (entry.name === '.git' || entry.name === 'node_modules') continue
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

async function git(runner: CommandRunner, config: RuntimeConfig, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run({ argv: [config.gitCommand, ...args], cwd })
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
}): Promise<LocalReviewResult> {
  if (!/^review_[a-f0-9]{16,64}$/.test(options.baseReviewId)) throw new EvolutionError('invalid_input', 'Invalid base review id')
  const workspace = await realpath(options.workspaceRoot)
  const target = await realpath(options.path)
  if (!isWithin(workspace, target)) throw new EvolutionError('unsafe_path', 'Local review path is outside the current workspace')
  const gitRoot = await git(options.runner, options.config, target, ['-C', target, 'rev-parse', '--show-toplevel'])
  const canonicalRoot = await realpath(gitRoot)
  if (canonicalRoot !== target || !isWithin(workspace, canonicalRoot)) {
    throw new EvolutionError('unsafe_path', 'Local review path must be a Git worktree root inside the current workspace')
  }
  const baseCommit = await git(options.runner, options.config, canonicalRoot, ['-C', canonicalRoot, 'rev-parse', 'HEAD'])
  if (!/^[a-f0-9]{40}$/i.test(baseCommit)) throw new EvolutionError('command_failed', 'Git did not provide an exact base commit')
  const status = await git(options.runner, options.config, canonicalRoot, ['-C', canonicalRoot, 'status', '--porcelain=v1', '--untracked-files=all'])
  const snapshot = await inspectLocalDirectory(canonicalRoot, options.config)
  const statusHash = sha256(status)
  const contentHash = hashObject(snapshot.files.map((file) => ({ path: file.path, sha256: sha256(file.content), bytes: file.content.byteLength })))
  const record = evaluatePluginContent({
    resolutionId: options.resolutionId,
    requirement: options.requirement,
    sourceSnapshot: { kind: 'local', path: canonicalRoot, baseReviewId: options.baseReviewId, baseCommit, statusHash },
    files: snapshot.files,
    truncated: snapshot.truncated,
    maintained: true,
  })
  return { record, contentHash }
}
