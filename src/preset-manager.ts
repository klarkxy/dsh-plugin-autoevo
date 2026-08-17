import { randomBytes } from 'node:crypto'
import {
  access,
  constants,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import {
  EVOLUTION_PRESET_ID,
  EVOLUTION_PRESET_KNOWN_MANIFESTS,
  EVOLUTION_PRESET_MANAGED_CONTENT_FILES,
  EVOLUTION_PRESET_MANIFEST_FILENAME,
  EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION,
  EVOLUTION_PRESET_TEMPLATE_VERSION,
  EVOLUTION_MODE_OWNER,
  isEvolutionPresetManifest,
  type EvolutionPresetInstallResult,
  type EvolutionPresetManifest,
} from './evolution-contracts.js'
import { sha256 } from './state/hashes.js'

export interface MaterializeEvolutionPresetOptions {
  dshHome: string
  enabled: boolean
  /** Absolute path to bundled presets/evolution directory (content files only). */
  templateDir: string
  templateVersion?: string
  logger?: { info?(msg: string): void; warn?(msg: string): void }
  /** Test-only rename override (defaults to fs.promises.rename). */
  rename?: (from: string, to: string) => Promise<void>
  /**
   * Test-only prior package manifests. Production callers use the built-in
   * shipped-manifest allowlist, never an on-disk manifest as its own proof.
   */
  trustedPriorManifests?: readonly EvolutionPresetManifest[]
}

export interface EvolutionPresetPaths {
  dshHome: string
  presetsRoot: string
  targetDir: string
}

interface PhysicalEvolutionPresetPaths {
  presetsRoot: string
  targetDir: string
}

function posixJoin(...parts: string[]): string {
  return parts.join('/')
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertContained(root: string, candidate: string, label: string): string {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  if (!isPathInside(resolvedRoot, resolvedCandidate)) {
    throw new Error(`AutoEvo preset path escaped containment (${label}): ${resolvedCandidate}`)
  }
  return resolvedCandidate
}

export function resolveEvolutionPresetPaths(dshHome: string): EvolutionPresetPaths {
  const resolvedHome = path.resolve(dshHome)
  const presetsRoot = path.join(resolvedHome, '.agent-presets')
  const targetDir = path.join(presetsRoot, EVOLUTION_PRESET_ID)
  assertContained(resolvedHome, presetsRoot, 'presets root')
  assertContained(presetsRoot, targetDir, 'evolution target')
  return { dshHome: resolvedHome, presetsRoot, targetDir }
}

export function buildManifest(
  files: Record<string, string>,
  templateVersion: string = EVOLUTION_PRESET_TEMPLATE_VERSION,
): EvolutionPresetManifest {
  const ordered: Record<string, string> = {}
  for (const key of Object.keys(files).sort((a, b) => a.localeCompare(b))) {
    ordered[key] = files[key]!
  }
  return {
    owner: EVOLUTION_MODE_OWNER,
    schemaVersion: EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION,
    templateVersion,
    files: ordered,
  }
}

function serializeManifest(manifest: EvolutionPresetManifest): string {
  const files: Record<string, string> = {}
  for (const key of Object.keys(manifest.files).sort((a, b) => a.localeCompare(b))) {
    files[key] = manifest.files[key]!
  }
  return `${JSON.stringify({
    owner: manifest.owner,
    schemaVersion: manifest.schemaVersion,
    templateVersion: manifest.templateVersion,
    files,
  }, null, 2)}\n`
}

function manifestsMatch(left: EvolutionPresetManifest, right: EvolutionPresetManifest): boolean {
  return serializeManifest(left) === serializeManifest(right)
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

/**
 * Resolve the root only after rejecting a pre-existing linked `.agent-presets`
 * entry. All writes below it then use the verified physical directory.
 */
async function resolvePhysicalPresetPaths(
  paths: EvolutionPresetPaths,
): Promise<{ ok: true; paths: PhysicalEvolutionPresetPaths } | { ok: false; reason: string }> {
  await mkdir(paths.dshHome, { recursive: true })
  const physicalHome = await realpath(paths.dshHome)
  const physicalPresetsRoot = assertContained(
    physicalHome,
    path.join(physicalHome, '.agent-presets'),
    'physical presets root',
  )

  let rootInfo: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    rootInfo = await lstat(physicalPresetsRoot)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  if (!rootInfo) {
    try {
      await mkdir(physicalPresetsRoot)
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
        throw error
      }
    }
    rootInfo = await lstat(physicalPresetsRoot)
  }

  if (rootInfo.isSymbolicLink()) {
    return { ok: false, reason: 'existing .agent-presets root is a link; preserved without changes' }
  }
  if (!rootInfo.isDirectory()) {
    return { ok: false, reason: 'existing .agent-presets root is not a directory; preserved without changes' }
  }

  const verifiedPresetsRoot = await realpath(physicalPresetsRoot)
  assertContained(physicalHome, verifiedPresetsRoot, 'verified physical presets root')
  return {
    ok: true,
    paths: {
      presetsRoot: verifiedPresetsRoot,
      targetDir: assertContained(
        verifiedPresetsRoot,
        path.join(verifiedPresetsRoot, EVOLUTION_PRESET_ID),
        'physical evolution target',
      ),
    },
  }
}

async function listExactChildren(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.map((entry) => entry.name).sort((a, b) => a.localeCompare(b))
}

/** Managed preset files are text. Hash and write LF so Windows autocrlf checkouts stay upgradeable. */
function normalizeManagedText(bytes: Uint8Array): Buffer {
  return Buffer.from(Buffer.from(bytes).toString('utf8').replace(/\r\n/gu, '\n'), 'utf8')
}

async function hashFile(filePath: string): Promise<string> {
  return sha256(normalizeManagedText(await readFile(filePath)))
}

async function readTemplateFiles(
  templateDir: string,
): Promise<{ files: Record<string, Buffer>; hashes: Record<string, string> }> {
  const resolvedTemplate = path.resolve(templateDir)
  const files: Record<string, Buffer> = {}
  const hashes: Record<string, string> = {}
  for (const relative of EVOLUTION_PRESET_MANAGED_CONTENT_FILES) {
    const absolute = assertContained(resolvedTemplate, path.join(resolvedTemplate, relative), `template ${relative}`)
    const bytes = normalizeManagedText(await readFile(absolute))
    files[relative] = bytes
    hashes[relative] = sha256(bytes)
  }
  return { files, hashes }
}

/** Verify target is pristine against the installed manifest (content + no extras). */
export async function verifyPristine(
  targetDir: string,
  manifest: EvolutionPresetManifest,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isEvolutionPresetManifest(manifest)) {
    return { ok: false, reason: 'manifest schema or managed file set is invalid' }
  }
  const resolvedTarget = path.resolve(targetDir)
  const expectedNames = new Set<string>([
    ...Object.keys(manifest.files),
    EVOLUTION_PRESET_MANIFEST_FILENAME,
  ])
  let children: string[]
  try {
    children = await listExactChildren(resolvedTarget)
  } catch (error) {
    return { ok: false, reason: `cannot list target: ${error instanceof Error ? error.message : String(error)}` }
  }

  for (const name of children) {
    if (!expectedNames.has(name)) {
      return { ok: false, reason: `extra file present: ${name}` }
    }
    const childPath = path.join(resolvedTarget, name)
    const info = await lstat(childPath)
    if (info.isSymbolicLink()) {
      return { ok: false, reason: `linked entry is not managed content: ${name}` }
    }
    if (!info.isFile()) {
      return { ok: false, reason: `unexpected non-file entry: ${name}` }
    }
  }

  for (const relative of Object.keys(manifest.files)) {
    const absolute = path.join(resolvedTarget, relative)
    if (!(await pathExists(absolute))) {
      return { ok: false, reason: `missing managed file: ${relative}` }
    }
    const digest = await hashFile(absolute)
    if (digest !== manifest.files[relative]) {
      return { ok: false, reason: `managed file modified: ${relative}` }
    }
  }

  const manifestPath = path.join(resolvedTarget, EVOLUTION_PRESET_MANIFEST_FILENAME)
  if (!(await pathExists(manifestPath))) {
    return { ok: false, reason: `missing managed file: ${EVOLUTION_PRESET_MANIFEST_FILENAME}` }
  }

  return { ok: true }
}

async function writeStagedPreset(
  stagingDir: string,
  contentFiles: Record<string, Buffer>,
  manifest: EvolutionPresetManifest,
): Promise<void> {
  await mkdir(stagingDir, { recursive: true })
  for (const [relative, bytes] of Object.entries(contentFiles)) {
    const target = assertContained(stagingDir, path.join(stagingDir, relative), `stage ${relative}`)
    await writeFile(target, bytes)
  }
  const manifestPath = assertContained(
    stagingDir,
    path.join(stagingDir, EVOLUTION_PRESET_MANIFEST_FILENAME),
    'stage manifest',
  )
  await writeFile(manifestPath, serializeManifest(manifest), 'utf8')
}

/** Bounded cleanup for the flat, exact managed preset tree; never follows links. */
async function cleanupOwnedTree(treeRoot: string, containmentRoot: string): Promise<void> {
  const resolvedTree = assertContained(containmentRoot, treeRoot, 'cleanup tree')
  if (!(await pathExists(resolvedTree))) return

  const rootInfo = await lstat(resolvedTree)
  if (rootInfo.isSymbolicLink()) {
    throw new Error(`AutoEvo refused cleanup of linked preset tree: ${resolvedTree}`)
  }
  if (!rootInfo.isDirectory()) {
    throw new Error(`AutoEvo refused cleanup of non-directory preset tree: ${resolvedTree}`)
  }

  const allowedNames = new Set<string>([
    ...EVOLUTION_PRESET_MANAGED_CONTENT_FILES,
    EVOLUTION_PRESET_MANIFEST_FILENAME,
  ])
  const entries = await readdir(resolvedTree, { withFileTypes: true })
  for (const entry of entries) {
    if (!allowedNames.has(entry.name)) {
      throw new Error(`AutoEvo refused cleanup of unexpected preset entry: ${entry.name}`)
    }
    const child = assertContained(resolvedTree, path.join(resolvedTree, entry.name), 'cleanup entry')
    const childInfo = await lstat(child)
    if (childInfo.isDirectory() && !childInfo.isSymbolicLink()) {
      throw new Error(`AutoEvo refused cleanup of nested preset directory: ${entry.name}`)
    }
    await unlink(child)
  }
  await rmdir(resolvedTree)
}

async function readInstalledManifest(targetDir: string): Promise<EvolutionPresetManifest | undefined> {
  const manifestPath = path.join(targetDir, EVOLUTION_PRESET_MANIFEST_FILENAME)
  if (!(await pathExists(manifestPath))) return undefined
  try {
    const text = await readFile(manifestPath, 'utf8')
    const raw = JSON.parse(text) as unknown
    if (!isEvolutionPresetManifest(raw)) return undefined
    // The manifest itself is managed content. Any byte-level edit, including
    // formatting-only changes, makes the directory user-owned and fail-closed.
    return text === serializeManifest(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

function randomSuffix(): string {
  return randomBytes(8).toString('hex')
}

export async function materializeEvolutionPreset(
  options: MaterializeEvolutionPresetOptions,
): Promise<EvolutionPresetInstallResult> {
  const paths = resolveEvolutionPresetPaths(options.dshHome)
  if (!options.enabled) {
    return {
      status: 'skipped',
      targetDir: paths.targetDir,
      reason: 'evolutionPreset config is false; install/update skipped without deleting an existing preset',
    }
  }

  const physicalPaths = await resolvePhysicalPresetPaths(paths)
  if (!physicalPaths.ok) {
    options.logger?.warn?.(physicalPaths.reason)
    return { status: 'preserved', targetDir: paths.targetDir, reason: physicalPaths.reason }
  }
  const { presetsRoot, targetDir } = physicalPaths.paths

  const templateVersion = options.templateVersion ?? EVOLUTION_PRESET_TEMPLATE_VERSION
  const renamePath = options.rename ?? rename
  const { files: contentFiles, hashes } = await readTemplateFiles(options.templateDir)
  const desiredManifest = buildManifest(hashes, templateVersion)

  let targetInfo: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    targetInfo = await lstat(targetDir)
  } catch (error) {
    if (!isNotFound(error)) {
      throw error
    }
  }

  if (!targetInfo) {
    const stagingDir = assertContained(
      presetsRoot,
      path.join(presetsRoot, `.${EVOLUTION_PRESET_ID}.staging-${randomSuffix()}`),
      'staging',
    )
    try {
      await writeStagedPreset(stagingDir, contentFiles, desiredManifest)
      await renamePath(stagingDir, targetDir)
      options.logger?.info?.(`AutoEvo installed managed preset ${EVOLUTION_PRESET_ID} at ${paths.targetDir}`)
      return {
        status: 'installed',
        targetDir: paths.targetDir,
        reason: 'first install completed',
        templateVersion,
      }
    } catch (error) {
      await cleanupOwnedTree(stagingDir, presetsRoot).catch(() => undefined)
      throw error
    }
  }

  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    const reason = targetInfo.isSymbolicLink()
      ? 'existing evolution preset target is a link; preserved without changes'
      : 'existing evolution preset target is not a directory; preserved without changes'
    options.logger?.warn?.(reason)
    return { status: 'preserved', targetDir: paths.targetDir, reason }
  }

  const installedManifest = await readInstalledManifest(targetDir)
  if (!installedManifest) {
    const reason = 'existing evolution directory has no valid AutoEvo manifest; preserved without changes'
    options.logger?.warn?.(reason)
    return { status: 'preserved', targetDir: paths.targetDir, reason }
  }

  const isCurrentDesiredManifest = manifestsMatch(installedManifest, desiredManifest)
  const trustedPriorManifests = options.trustedPriorManifests ?? EVOLUTION_PRESET_KNOWN_MANIFESTS
  const isKnownPriorManifest = trustedPriorManifests.some((known) => {
    return isEvolutionPresetManifest(known) && manifestsMatch(installedManifest, known)
  })
  if (!isCurrentDesiredManifest && !isKnownPriorManifest) {
    const reason = 'existing evolution directory manifest is not a known AutoEvo release; preserved without changes'
    options.logger?.warn?.(reason)
    return { status: 'preserved', targetDir: paths.targetDir, reason }
  }

  const pristine = await verifyPristine(targetDir, installedManifest)
  if (!pristine.ok) {
    const reason = `existing managed preset is not pristine (${pristine.reason}); preserved without changes`
    options.logger?.warn?.(reason)
    return { status: 'preserved', targetDir: paths.targetDir, reason }
  }

  if (isCurrentDesiredManifest) {
    return {
      status: 'noop',
      targetDir: paths.targetDir,
      reason: 'template version and managed file hashes already match',
      templateVersion,
    }
  }

  const stagingDir = assertContained(
    presetsRoot,
    path.join(presetsRoot, `.${EVOLUTION_PRESET_ID}.staging-${randomSuffix()}`),
    'upgrade staging',
  )
  const backupDir = assertContained(
    presetsRoot,
    path.join(presetsRoot, `.${EVOLUTION_PRESET_ID}.backup-${randomSuffix()}`),
    'upgrade backup',
  )

  try {
    await writeStagedPreset(stagingDir, contentFiles, desiredManifest)
    await renamePath(targetDir, backupDir)
    try {
      await renamePath(stagingDir, targetDir)
    } catch (error) {
      try {
        await renamePath(backupDir, targetDir)
      } catch (restoreError) {
        throw new Error(
          `AutoEvo preset upgrade failed and restore also failed: ${error instanceof Error ? error.message : String(error)}; restore: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        )
      }
      await cleanupOwnedTree(stagingDir, presetsRoot).catch(() => undefined)
      throw error
    }
    await cleanupOwnedTree(backupDir, presetsRoot).catch(() => undefined)
    options.logger?.info?.(`AutoEvo upgraded managed preset ${EVOLUTION_PRESET_ID} to template ${templateVersion}`)
    return {
      status: 'upgraded',
      targetDir: paths.targetDir,
      reason: 'pristine managed preset upgraded',
      templateVersion,
    }
  } catch (error) {
    await cleanupOwnedTree(stagingDir, presetsRoot).catch(() => undefined)
    if (await pathExists(backupDir) && !(await pathExists(targetDir))) {
      await renamePath(backupDir, targetDir).catch(() => undefined)
    } else if (await pathExists(backupDir) && await pathExists(targetDir)) {
      await cleanupOwnedTree(backupDir, presetsRoot).catch(() => undefined)
    }
    throw error
  }
}

export const _testing = {
  assertContained,
  isPathInside,
  serializeManifest,
  manifestsMatch,
  cleanupOwnedTree,
  posixJoin,
  listExactChildren,
}
