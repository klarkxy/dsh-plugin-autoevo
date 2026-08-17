import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  dshHome?: string
  stateDir?: string
  ghCommand?: string
  gitCommand?: string
  dshCommand?: string
  dshCommandArgs?: string[]
  maxCandidates?: number
  maxFiles?: number
  maxRepositoryBytes?: number
  commandTimeoutMs?: number
  forwardedCredentialEnv?: string[]
  verificationPatchPaths?: string[]
  /** When true (default), materialize/upgrade the managed evolution user preset. Never auto-deletes. */
  evolutionPreset?: boolean
  /** Opt in to community quality lookups that hide broken and junk marketplace candidates. */
  communityQualityFilter?: boolean
  /** Opt in to sending anonymous, structured review/install observations. */
  communityReports?: boolean
  /** Base URL for the AutoEvo community quality service. Empty disables network access. */
  communityQualityEndpoint?: string
  communityQualityTimeoutMs?: number
}

export interface RuntimeConfig {
  dshHome: string
  stateDir: string
  ghCommand: string
  gitCommand: string
  dshCommand: string
  dshCommandArgs: string[]
  maxCandidates: number
  maxFiles: number
  maxRepositoryBytes: number
  commandTimeoutMs: number
  forwardedCredentialEnv: string[]
  verificationPatchPaths: string[]
  evolutionPreset: boolean
  communityQualityFilter: boolean
  communityReports: boolean
  communityQualityEndpoint: string
  communityQualityTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  dshHome: Schema.string().default(''),
  stateDir: Schema.string().default(''),
  ghCommand: Schema.string().default('gh'),
  gitCommand: Schema.string().default('git'),
  dshCommand: Schema.string().default('dsh'),
  dshCommandArgs: Schema.array(Schema.string()).default([]),
  maxCandidates: Schema.number().min(1).max(20).default(5),
  maxFiles: Schema.number().min(4).max(200).default(80),
  maxRepositoryBytes: Schema.number().min(65_536).max(8_388_608).default(1_048_576),
  commandTimeoutMs: Schema.number().min(1_000).max(300_000).default(30_000),
  forwardedCredentialEnv: Schema.array(Schema.string()).default([]),
  verificationPatchPaths: Schema.array(Schema.string()).default([]),
  evolutionPreset: Schema.boolean().default(true),
  communityQualityFilter: Schema.boolean().default(false),
  communityReports: Schema.boolean().default(false),
  communityQualityEndpoint: Schema.string().default(''),
  communityQualityTimeoutMs: Schema.number().min(250).max(10_000).default(2_000),
})

function normalizeCommunityQualityEndpoint(input: string | undefined): string {
  const value = input?.trim() ?? ''
  if (!value) return ''
  const url = new URL(value)
  const host = url.hostname
  const localHttp = url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]')
  if (url.protocol !== 'https:' && !localHttp) {
    throw new TypeError('communityQualityEndpoint must use HTTPS (HTTP is allowed only for localhost)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('communityQualityEndpoint must not contain credentials, a query, or a fragment')
  }
  return url.toString().replace(/\/$/u, '')
}

export function normalizeConfig(input: Config): RuntimeConfig {
  const dshHome = path.resolve(input.dshHome || process.env.DSH_HOME || path.join(process.cwd(), '.dsh'))
  return {
    dshHome,
    stateDir: path.resolve(input.stateDir || path.join(dshHome, 'autoevo')),
    ghCommand: input.ghCommand || 'gh',
    gitCommand: input.gitCommand || 'git',
    dshCommand: input.dshCommand || 'dsh',
    dshCommandArgs: [...(input.dshCommandArgs ?? [])],
    maxCandidates: input.maxCandidates ?? 5,
    maxFiles: input.maxFiles ?? 80,
    maxRepositoryBytes: input.maxRepositoryBytes ?? 1_048_576,
    commandTimeoutMs: input.commandTimeoutMs ?? 30_000,
    forwardedCredentialEnv: [...(input.forwardedCredentialEnv ?? [])],
    verificationPatchPaths: [...(input.verificationPatchPaths ?? [])].map((entry) => path.resolve(entry)),
    evolutionPreset: input.evolutionPreset !== false,
    communityQualityFilter: input.communityQualityFilter === true,
    communityReports: input.communityReports === true,
    communityQualityEndpoint: normalizeCommunityQualityEndpoint(input.communityQualityEndpoint),
    communityQualityTimeoutMs: input.communityQualityTimeoutMs ?? 2_000,
  }
}

export const _testing = { normalizeCommunityQualityEndpoint }

