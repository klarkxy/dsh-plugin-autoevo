/**
 * Shared Capability Evolution mode contracts.
 * Owned by the top-level agent; leaves must import, not redefine or mutate.
 */

export const EVOLUTION_PRESET_ID = 'evolution' as const
export const EVOLUTION_PRESET_DISPLAY_NAME = '能力进化' as const
export const EVOLUTION_PRESET_DESCRIPTION = '用于按需进化能力：具备官方创造模式的全部能力，并由 AutoEvo 治理复用、审查、安装与升级；改进过的插件可在明确批准后贡献回上游。' as const

/** Scoped Cordis service key published only behind a preset isolate realm. */
export const EVOLUTION_MODE_SERVICE_KEY = 'autoevoEvolutionMode' as const

/** Exact marker owner. Preset id alone is never authority. */
export const EVOLUTION_MODE_OWNER = 'dsh-plugin-autoevo' as const

/** Integer protocol version for the evolution-mode marker payload. */
export const EVOLUTION_MODE_PROTOCOL_VERSION = 1 as const

/** Managed user-preset manifest filename under the evolution preset directory. */
export const EVOLUTION_PRESET_MANIFEST_FILENAME = '.autoevo-preset.json' as const

/** Template version for the bundled `presets/evolution` tree. */
export const EVOLUTION_PRESET_TEMPLATE_VERSION = '14' as const

/** Manifest schema version for `.autoevo-preset.json`. */
export const EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION = 1 as const

/** Public package export subpath for the scoped evolution-mode entry. */
export const EVOLUTION_MODE_PACKAGE_EXPORT = 'dsh-plugin-autoevo/evolution-mode' as const

/** Relative managed template files (posix style), excluding the generated manifest. */
export const EVOLUTION_PRESET_MANAGED_CONTENT_FILES = [
  'preset.yml',
  'agent.cordis.yml',
  'skills/cordis-plugin-development/SKILL.md',
  'skills/editing-cordis-compositions/SKILL.md',
] as const

export interface EvolutionPresetManifest {
  owner: typeof EVOLUTION_MODE_OWNER
  schemaVersion: typeof EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION
  templateVersion: string
  /** SHA-256 hex digests keyed by relative posix path for the exact managed file set. */
  files: Record<string, string>
}

/**
 * The one template this unreleased line owns.
 *
 * V13 is the last non-superset template. A pristine V13 install may upgrade
 * to the current Creator-superset template. Anything else is preserved.
 */
export const EVOLUTION_PRESET_V13_MANIFEST: EvolutionPresetManifest = Object.freeze({
  owner: EVOLUTION_MODE_OWNER,
  schemaVersion: EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION,
  templateVersion: '13',
  files: Object.freeze({
    'agent.cordis.yml': '521d2133694c5642e3e78fcd5ddfa7f2d7af6eab80244fdd2c22030dd586d55c',
    'preset.yml': 'd51f8ab85feeb76c73de0cb091735b7ddbdad4d2b3d8adfc878dd35b6e79bbbd',
  }),
})

export const EVOLUTION_PRESET_KNOWN_MANIFESTS: readonly EvolutionPresetManifest[] = Object.freeze([
  EVOLUTION_PRESET_V13_MANIFEST,
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
  const actualFiles = Object.keys(files)
  if (actualFiles.length === 0) return false
  for (const [key, digest] of Object.entries(files)) {
    if (typeof key !== 'string' || key.length === 0) return false
    if (key.startsWith('/') || key.includes('\\') || key.split('/').some((part) => part === '' || part === '.' || part === '..')) return false
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) return false
  }
  return true
}

/** Stable denial when AutoEvo-governed construction is attempted outside genuine evolution mode. */
export const OUTSIDE_EVOLUTION_MODE_DENIAL =
  'AutoEvo denied this AutoEvo-governed construction action: start or switch a blank/new session to the Capability Evolution (evolution) agent preset. Temporary live Cordis plugins remain available in official Creator; Host-managed create/modify continues only in Capability Evolution after an explicit user decision.'
