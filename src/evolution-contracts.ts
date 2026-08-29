/**
 * Shared Capability Evolution mode contracts.
 * Owned by the top-level agent; leaves must import, not redefine or mutate.
 */

export const EVOLUTION_PRESET_ID = 'evolution' as const
export const EVOLUTION_PRESET_DISPLAY_NAME = '能力进化' as const
export const EVOLUTION_PRESET_DESCRIPTION = '用于按需进化能力：所有实验、复用、修改、创建与安装都经过 AutoEvo Search-first 治理。' as const

/** Scoped Cordis service key published only behind a preset isolate realm. */
export const EVOLUTION_MODE_SERVICE_KEY = 'autoevoEvolutionMode' as const

/** Exact marker owner. Preset id alone is never authority. */
export const EVOLUTION_MODE_OWNER = 'dsh-plugin-autoevo' as const

/** Integer protocol version for the evolution-mode marker payload. */
export const EVOLUTION_MODE_PROTOCOL_VERSION = 1 as const

/** Managed user-preset manifest filename under the evolution preset directory. */
export const EVOLUTION_PRESET_MANIFEST_FILENAME = '.autoevo-preset.json' as const

/** Template version for the bundled `presets/evolution` tree. */
export const EVOLUTION_PRESET_TEMPLATE_VERSION = '18' as const

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

export const EVOLUTION_PRESET_V14_MANIFEST: EvolutionPresetManifest = Object.freeze({
  owner: EVOLUTION_MODE_OWNER,
  schemaVersion: EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION,
  templateVersion: '14',
  files: Object.freeze({
    'agent.cordis.yml': '0a1352f1dd4e68abf01a6c80f23be30aeb239294071207cc225815bfffa17c5b',
    'preset.yml': 'c3e8587363b21edeba9c36e4009c8496c0938144f5c552e489ffda3b5316c4a4',
    'skills/cordis-plugin-development/SKILL.md': '01811d3ee9c03a466abae12d54d229e7de7bd74ca6b730c54ce9d5e696b294aa',
    'skills/editing-cordis-compositions/SKILL.md': 'b223233e9df5c8cbedeb7dee8d38ddc47d545af54b323abe3830f4748b688f6c',
  }),
})

export const EVOLUTION_PRESET_V15_MANIFEST: EvolutionPresetManifest = Object.freeze({
  owner: EVOLUTION_MODE_OWNER,
  schemaVersion: EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION,
  templateVersion: '15',
  files: Object.freeze({
    'agent.cordis.yml': '8727d922f5b320fd143d47d92d9b90ac191c28c42acbdafd67975775516e7d88',
    'preset.yml': '366df26e794b478a9de0391fa640d1ae684dcdcbedbb5a08d9cf1b7339bd2e1e',
    'skills/cordis-plugin-development/SKILL.md': '01811d3ee9c03a466abae12d54d229e7de7bd74ca6b730c54ce9d5e696b294aa',
    'skills/editing-cordis-compositions/SKILL.md': 'b223233e9df5c8cbedeb7dee8d38ddc47d545af54b323abe3830f4748b688f6c',
  }),
})

export const EVOLUTION_PRESET_V16_MANIFEST: EvolutionPresetManifest = Object.freeze({
  owner: EVOLUTION_MODE_OWNER,
  schemaVersion: EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION,
  templateVersion: '16',
  files: Object.freeze({
    'agent.cordis.yml': '334f46d87e6f071a9db0da7b334010b1ff20e59996584ba27564f3cb77eb0d86',
    'preset.yml': '366df26e794b478a9de0391fa640d1ae684dcdcbedbb5a08d9cf1b7339bd2e1e',
    'skills/cordis-plugin-development/SKILL.md': '01811d3ee9c03a466abae12d54d229e7de7bd74ca6b730c54ce9d5e696b294aa',
    'skills/editing-cordis-compositions/SKILL.md': 'b223233e9df5c8cbedeb7dee8d38ddc47d545af54b323abe3830f4748b688f6c',
  }),
})

export const EVOLUTION_PRESET_V17_MANIFEST: EvolutionPresetManifest = Object.freeze({
  owner: EVOLUTION_MODE_OWNER,
  schemaVersion: EVOLUTION_PRESET_MANIFEST_SCHEMA_VERSION,
  templateVersion: '17',
  files: Object.freeze({
    'agent.cordis.yml': 'b0cbe8d0a90bbfd1a554c9df94d050d0dc5d04da0c908a04636657eba8c2b508',
    'preset.yml': '366df26e794b478a9de0391fa640d1ae684dcdcbedbb5a08d9cf1b7339bd2e1e',
    'skills/cordis-plugin-development/SKILL.md': '01811d3ee9c03a466abae12d54d229e7de7bd74ca6b730c54ce9d5e696b294aa',
    'skills/editing-cordis-compositions/SKILL.md': 'b223233e9df5c8cbedeb7dee8d38ddc47d545af54b323abe3830f4748b688f6c',
  }),
})

export const EVOLUTION_PRESET_KNOWN_MANIFESTS: readonly EvolutionPresetManifest[] = Object.freeze([
  EVOLUTION_PRESET_V13_MANIFEST,
  EVOLUTION_PRESET_V14_MANIFEST,
  EVOLUTION_PRESET_V15_MANIFEST,
  EVOLUTION_PRESET_V16_MANIFEST,
  EVOLUTION_PRESET_V17_MANIFEST,
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
  'AutoEvo denied this governed construction action: start or switch a blank/new session to the Capability Evolution (evolution) agent preset. Host-managed create/modify continues only there after Search-first review and an explicit final user decision.'
