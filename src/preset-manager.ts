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
import { isNotFound, isPathInside, isProcessAlive, normalizeLf } from './internal-utils.js'
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
  return Buffer.from(normalizeLf(Buffer.from(bytes).toString('utf8')), 'utf8')
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
    const absolute = assertContained(resolvedTemplate, path.join(resolvedTemplate, ...relative.split('/')), `template ${relative}`)
    const bytes = normalizeManagedText(await readFile(absolute))
    files[relative] = bytes
    hashes[relative] = sha256(bytes)
  }
  return { files, hashes }
}

function toPosixRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/')
}

async function listTreeFilesNoFollow(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const child = path.join(directory, entry.name)
      const info = await lstat(child)
      const relative = toPosixRelative(root, child)
      if (info.isSymbolicLink()) {
        throw new Error(`linked entry is not managed content: ${relative}`)
      }
      if (info.isDirectory()) {
        await walk(child)
        continue
      }
      if (!info.isFile()) {
        throw new Error(`unexpected non-file entry: ${relative}`)
      }
      files.push(relative)
    }
  }
  await walk(root)
  return files.sort((a, b) => a.localeCompare(b))
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
    children = await listTreeFilesNoFollow(resolvedTarget)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  for (const name of children) {
    if (!expectedNames.has(name)) {
      return { ok: false, reason: `extra file present: ${name}` }
    }
  }

  for (const relative of Object.keys(manifest.files)) {
    const absolute = path.join(resolvedTarget, ...relative.split('/'))
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
    const target = assertContained(stagingDir, path.join(stagingDir, ...relative.split('/')), `stage ${relative}`)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
  const manifestPath = assertContained(
    stagingDir,
    path.join(stagingDir, EVOLUTION_PRESET_MANIFEST_FILENAME),
    'stage manifest',
  )
  await writeFile(manifestPath, serializeManifest(manifest), 'utf8')
}

/** Bounded cleanup for the exact managed preset tree; never follows links. */
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
  const files: string[] = []
  const directories: string[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const child = assertContained(resolvedTree, path.join(directory, entry.name), 'cleanup entry')
      const childInfo = await lstat(child)
      const relative = toPosixRelative(resolvedTree, child)
      if (childInfo.isSymbolicLink()) {
        if (!allowedNames.has(relative) && !allowedNames.has(entry.name)) {
          throw new Error(`AutoEvo refused cleanup of unexpected preset entry: ${relative}`)
        }
        await unlink(child)
        continue
      }
      if (childInfo.isDirectory()) {
        directories.push(child)
        await walk(child)
        continue
      }
      if (!allowedNames.has(relative)) {
        throw new Error(`AutoEvo refused cleanup of unexpected preset entry: ${relative}`)
      }
      files.push(child)
    }
  }
  await walk(resolvedTree)
  for (const file of files) await unlink(file)
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    await rmdir(directory)
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

function migrationLockPath(presetsRoot: string): string {
  return assertContained(
    presetsRoot,
    path.join(presetsRoot, `.${EVOLUTION_PRESET_ID}.migrate.lock`),
    'migration lock',
  )
}

async function isPidAlive(pid: number): Promise<boolean> {
  return isProcessAlive(pid)
}

async function acquireMigrationLock(presetsRoot: string): Promise<string> {
  const lockFile = migrationLockPath(presetsRoot)
  const payload = `${JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`
  try {
    await writeFile(lockFile, payload, { encoding: 'utf8', flag: 'wx' })
    return lockFile
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
      throw error
    }
  }
  try {
    const existing = JSON.parse(await readFile(lockFile, 'utf8')) as { pid?: number }
    if (await isPidAlive(Number(existing.pid))) {
      throw new Error('AutoEvo evolution preset migration is already running')
    }
    await unlink(lockFile)
  } catch (error) {
    if (error instanceof Error && /already running/u.test(error.message)) throw error
    // Fail closed on unreadable/permissioned lock.
    throw new Error(`AutoEvo refused migration lock recovery: ${error instanceof Error ? error.message : String(error)}`)
  }
  await writeFile(lockFile, payload, { encoding: 'utf8', flag: 'wx' })
  return lockFile
}

async function releaseMigrationLock(lockFile: string): Promise<void> {
  try {
    await unlink(lockFile)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}

/**
 * Recover from interrupted staging/backup: drop orphan staging trees; if the
 * live target is missing but a single backup remains, restore it.
 */
async function recoverInterruptedMigration(
  presetsRoot: string,
  targetDir: string,
  renamePath: (from: string, to: string) => Promise<void>,
  logger?: MaterializeEvolutionPresetOptions['logger'],
): Promise<void> {
  const children = await listExactChildren(presetsRoot)
  const staging = children.filter((name) => name.startsWith(`.${EVOLUTION_PRESET_ID}.staging-`))
  const backups = children.filter((name) => name.startsWith(`.${EVOLUTION_PRESET_ID}.backup-`))
  for (const name of staging) {
    const stagingDir = assertContained(presetsRoot, path.join(presetsRoot, name), 'orphan staging')
    await cleanupOwnedTree(stagingDir, presetsRoot).catch((error) => {
      throw new Error(`AutoEvo failed to clean interrupted staging: ${error instanceof Error ? error.message : String(error)}`)
    })
    logger?.warn?.(`AutoEvo removed interrupted preset staging ${name}`)
  }
  const targetExists = await pathExists(targetDir)
  if (!targetExists && backups.length === 1 && backups[0]) {
    const backupDir = assertContained(presetsRoot, path.join(presetsRoot, backups[0]), 'orphan backup')
    await renamePath(backupDir, targetDir)
    logger?.warn?.(`AutoEvo restored interrupted preset backup ${backups[0]}`)
  } else if (!targetExists && backups.length > 1) {
    throw new Error('AutoEvo found multiple interrupted preset backups; refusing automatic recovery')
  }
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
  const renamePath = options.rename ?? rename

  const lockFile = await acquireMigrationLock(presetsRoot)
  try {
    await recoverInterruptedMigration(presetsRoot, targetDir, renamePath, options.logger)
    return await materializeEvolutionPresetLocked(options, paths, presetsRoot, targetDir, renamePath)
  } finally {
    await releaseMigrationLock(lockFile).catch(() => undefined)
  }
}

async function materializeEvolutionPresetLocked(
  options: MaterializeEvolutionPresetOptions,
  paths: EvolutionPresetPaths,
  presetsRoot: string,
  targetDir: string,
  renamePath: (from: string, to: string) => Promise<void>,
): Promise<EvolutionPresetInstallResult> {
  const templateVersion = options.templateVersion ?? EVOLUTION_PRESET_TEMPLATE_VERSION
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
  acquireMigrationLock,
  releaseMigrationLock,
  recoverInterruptedMigration,
  migrationLockPath,
  isPidAlive,
}
