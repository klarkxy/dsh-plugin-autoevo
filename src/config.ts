import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  dshHome?: string
  stateDir?: string
  /** Managed plugin source repositories. Defaults to `<stateDir>/sources`. */
  sourceDir?: string
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
}

export interface RuntimeConfig {
  dshHome: string
  stateDir: string
  sourceDir: string
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
}

export const Config: Schema<Config> = Schema.object({
  dshHome: Schema.string().default(''),
  stateDir: Schema.string().default(''),
  sourceDir: Schema.string().default(''),
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
})

export function normalizeConfig(input: Config): RuntimeConfig {
  const dshHome = path.resolve(input.dshHome || process.env.DSH_HOME || path.join(process.cwd(), '.dsh'))
  const stateDir = path.resolve(input.stateDir || path.join(dshHome, 'autoevo'))
  return {
    dshHome,
    stateDir,
    sourceDir: path.resolve(input.sourceDir || path.join(stateDir, 'sources')),
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
  }
}

