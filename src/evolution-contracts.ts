/**
 * Shared Capability Evolution mode contracts.
 * Owned by the top-level agent; leaves must import, not redefine or mutate.
 */

export const EVOLUTION_PRESET_ID = 'evolution' as const
export const EVOLUTION_PRESET_DISPLAY_NAME = '能力进化' as const
export const EVOLUTION_PRESET_DESCRIPTION = '用于按需创造新能力：具备创造模式的全部能力，并提供社区插件复用、审查安装和受控的动态 Cordis 插件创建。' as const

/** Scoped Cordis service key published only behind a preset isolate realm. */
export const EVOLUTION_MODE_SERVICE_KEY = 'autoevoEvolutionMode' as const

/** Exact marker owner. Preset id alone is never authority. */
export const EVOLUTION_MODE_OWNER = 'dsh-plugin-autoevo' as const

/** Integer protocol version for the evolution-mode marker payload. */
export const EVOLUTION_MODE_PROTOCOL_VERSION = 1 as const

/** Managed user-preset manifest filename under the evolution preset directory. */
export const EVOLUTION_PRESET_MANIFEST_FILENAME = '.autoevo-preset.json' as const

/**
 * Template version for the bundled `presets/evolution` tree.
 * Bump when any managed template file content changes.
 */
export const EVOLUTION_PRESET_TEMPLATE_VERSION = '2' as const

/** Manifest schema version for `.autoevo-preset.json`. */
export const EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION = 1 as const

/** Public package export subpath for the scoped evolution-mode entry. */
export const EVOLUTION_MODE_PACKAGE_EXPORT = 'dsh-plugin-autoevo/evolution-mode' as const

/** Relative managed template files (posix style), excluding the generated manifest. */
export const EVOLUTION_PRESET_MANAGED_CONTENT_FILES = [
  'preset.yml',
  'agent.cordis.yml',
] as const

export type EvolutionPresetManagedContentFile =
  (typeof EVOLUTION_PRESET_MANAGED_CONTENT_FILES)[number]

export interface EvolutionPresetManifest {
  owner: typeof EVOLUTION_MODE_OWNER
  schemaVersion: typeof EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION
  templateVersion: string
  /** SHA-256 hex digests keyed by relative posix path for the exact managed file set. */
  files: Record<string, string>
}

/**
 * Exact manifests that AutoEvo itself has shipped and may therefore upgrade.
 *
 * The on-disk manifest is only an integrity record, not an authority token:
 * a user can rewrite both content and hashes.  Keep this allowlist in the
 * package so an altered manifest is preserved instead of being upgraded over.
 */
export const EVOLUTION_PRESET_KNOWN_MANIFESTS: readonly EvolutionPresetManifest[] = Object.freeze([
  Object.freeze({
    owner: EVOLUTION_MODE_OWNER,
    schemaVersion: EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION,
    templateVersion: '1',
    files: Object.freeze({
      'agent.cordis.yml': '1998d90fcb17ab3ca0a43e831ade6fe1f4e9513fe9efbe6777e00c417963edb5',
      'preset.yml': '6a571f49983f3c3bdde1b70c4500a0594ecea5f67dad7a893895d2952dbda751',
    }),
  }),
  Object.freeze({
    owner: EVOLUTION_MODE_OWNER,
    schemaVersion: EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION,
    templateVersion: '2',
    files: Object.freeze({
      'agent.cordis.yml': '50815c246fb23c6dedee57069541771b5d9b8934a49d5b3b5a043a7af278add9',
      'preset.yml': 'bad59239f10692dbe91baac3e8eae13ba0492726c52d4420e6cc5e9f492c9334',
    }),
  }),
])

export interface EvolutionModeMarker {
  owner: typeof EVOLUTION_MODE_OWNER
  protocolVersion: typeof EVOLUTION_MODE_PROTOCOL_VERSION
}

export type EvolutionPresetInstallStatus =
  | 'installed'
  | 'noop'
  | 'upgraded'
  | 'skipped'
  | 'preserved'

export interface EvolutionPresetInstallResult {
  status: EvolutionPresetInstallStatus
  targetDir: string
  reason: string
  templateVersion?: string
}

export function createEvolutionModeMarker(): EvolutionModeMarker {
  return {
    owner: EVOLUTION_MODE_OWNER,
    protocolVersion: EVOLUTION_MODE_PROTOCOL_VERSION,
  }
}

export function isEvolutionModeMarker(value: unknown): value is EvolutionModeMarker {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b))
  if (keys.length !== 2 || keys[0] !== 'owner' || keys[1] !== 'protocolVersion') return false
  return record.owner === EVOLUTION_MODE_OWNER
    && record.protocolVersion === EVOLUTION_MODE_PROTOCOL_VERSION
}

export function isEvolutionPresetManifest(value: unknown): value is EvolutionPresetManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const expectedKeys = ['files', 'owner', 'schemaVersion', 'templateVersion']
  const actualKeys = Object.keys(record).sort((a, b) => a.localeCompare(b))
  if (actualKeys.length !== expectedKeys.length) return false
  if (actualKeys.some((key, index) => key !== expectedKeys[index])) return false
  if (record.owner !== EVOLUTION_MODE_OWNER) return false
  if (record.schemaVersion !== EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION) return false
  if (typeof record.templateVersion !== 'string' || record.templateVersion.length === 0) return false
  if (record.files === null || typeof record.files !== 'object' || Array.isArray(record.files)) return false
  const files = record.files as Record<string, unknown>
  const expectedFiles = [...EVOLUTION_PRESET_MANAGED_CONTENT_FILES].sort((a, b) => a.localeCompare(b))
  const actualFiles = Object.keys(files).sort((a, b) => a.localeCompare(b))
  if (actualFiles.length !== expectedFiles.length) return false
  if (actualFiles.some((key, index) => key !== expectedFiles[index])) return false
  for (const [key, digest] of Object.entries(files)) {
    if (typeof key !== 'string' || key.length === 0) return false
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) return false
  }
  return true
}

/** Stable denial when cordis_define(kind:new) is attempted outside genuine evolution mode. */
export const OUTSIDE_EVOLUTION_MODE_DENIAL =
  'AutoEvo denied new Cordis plugin creation: start or switch a blank/new session to the Capability Evolution (evolution) agent preset. Dynamic new Cordis definitions are permitted only in Capability Evolution mode after capability_resolve returns scratch_ready.'
