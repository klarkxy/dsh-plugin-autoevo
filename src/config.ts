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
  /** Optional; omitted callers resolve to `<stateDir>/sources` at the SourceManager boundary. */
  sourceDir?: string
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
  dshHome: Schema.string().default('').description('DSH home directory. Empty uses DSH_HOME or ./.dsh.'),
  stateDir: Schema.string().default('').description('AutoEvo state directory. Empty uses <dshHome>/autoevo.'),
  sourceDir: Schema.string().default('').description('Managed plugin source directory. Empty uses <stateDir>/sources.'),
  ghCommand: Schema.string().default('gh').description('GitHub CLI executable.'),
  gitCommand: Schema.string().default('git').description('git executable.'),
  dshCommand: Schema.string().default('dsh').description('dsh executable.'),
  dshCommandArgs: Schema.array(Schema.string()).default([]).description('Extra arguments forwarded to dsh.'),
  maxCandidates: Schema.number().min(1).max(20).default(20).description('Maximum discovery candidates to keep.'),
  maxFiles: Schema.number().min(4).max(200).default(80).description('Maximum files to read during review.'),
  maxRepositoryBytes: Schema.number().min(65_536).max(8_388_608).default(1_048_576).description('Maximum review snapshot size in bytes.'),
  commandTimeoutMs: Schema.number().min(1_000).max(300_000).default(30_000).description('External command timeout in milliseconds.'),
  forwardedCredentialEnv: Schema.array(Schema.string()).default([]).description('Credential environment variable names forwarded to managed children.'),
  verificationPatchPaths: Schema.array(Schema.string()).default([]).description('Extra verification patch paths.'),
  evolutionPreset: Schema.boolean().default(true).description('Install or upgrade the managed Capability Evolution user preset. Never auto-deletes an existing preset.'),
}).description('Capability reuse and safe evolution').i18n({
  'en-US': {
    $description: 'Capability reuse and safe evolution',
    dshHome: 'DSH home directory. Empty uses DSH_HOME or ./.dsh.',
    stateDir: 'AutoEvo state directory. Empty uses <dshHome>/autoevo.',
    sourceDir: 'Managed plugin source directory. Empty uses <stateDir>/sources.',
    ghCommand: 'GitHub CLI executable.',
    gitCommand: 'git executable.',
    dshCommand: 'dsh executable.',
    dshCommandArgs: 'Extra arguments forwarded to dsh.',
    maxCandidates: 'Maximum discovery candidates to keep.',
    maxFiles: 'Maximum files to read during review.',
    maxRepositoryBytes: 'Maximum review snapshot size in bytes.',
    commandTimeoutMs: 'External command timeout in milliseconds.',
    forwardedCredentialEnv: 'Credential environment variable names forwarded to managed children.',
    verificationPatchPaths: 'Extra verification patch paths.',
    evolutionPreset: 'Install or upgrade the managed Capability Evolution user preset. Never auto-deletes an existing preset.',
  },
  'zh-CN': {
    $description: '能力复用与安全进化',
    dshHome: 'DSH 主目录。留空则使用环境变量 DSH_HOME 或当前目录下的 .dsh。',
    stateDir: 'AutoEvo 状态目录。留空则使用 <dshHome>/autoevo。',
    sourceDir: '托管插件源仓库目录。留空则使用 <stateDir>/sources。',
    ghCommand: 'GitHub CLI 可执行文件。',
    gitCommand: 'git 可执行文件。',
    dshCommand: 'dsh 可执行文件。',
    dshCommandArgs: '传给 dsh 的额外参数。',
    maxCandidates: '单次发现最多保留的候选数。',
    maxFiles: '审查时最多读取的文件数。',
    maxRepositoryBytes: '审查快照的最大仓库体积（字节）。',
    commandTimeoutMs: '外部命令超时（毫秒）。',
    forwardedCredentialEnv: '转发给托管子进程的凭证环境变量名。',
    verificationPatchPaths: '额外的验证补丁路径。',
    evolutionPreset: '是否安装或升级托管的「能力进化」用户预设。不会自动删除已有预设。',
  },
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
    maxCandidates: input.maxCandidates ?? 20,
    maxFiles: input.maxFiles ?? 80,
    maxRepositoryBytes: input.maxRepositoryBytes ?? 1_048_576,
    commandTimeoutMs: input.commandTimeoutMs ?? 30_000,
    forwardedCredentialEnv: [...(input.forwardedCredentialEnv ?? [])],
    verificationPatchPaths: [...(input.verificationPatchPaths ?? [])].map((entry) => path.resolve(entry)),
    evolutionPreset: input.evolutionPreset !== false,
  }
}

