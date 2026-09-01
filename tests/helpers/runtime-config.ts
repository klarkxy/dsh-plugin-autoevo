import path from 'node:path'
import type { RuntimeConfig } from '../../src/config.js'

export type TestRuntimeConfigOverrides = Partial<Omit<RuntimeConfig, 'stateDir' | 'sourceDir'>> & {
  /** Pass `false` to omit the key entirely. */
  stateDir?: string | false
  /** Pass `false` to omit the key entirely. */
  sourceDir?: string | false
}

export function testRuntimeConfig(root: string, overrides: TestRuntimeConfigOverrides = {}): RuntimeConfig {
  const { stateDir, sourceDir, ...rest } = overrides
  return {
    dshHome: path.join(root, 'dsh-home'),
    ...(stateDir === false ? {} : { stateDir: stateDir ?? root }),
    ...(sourceDir === false || sourceDir === undefined ? {} : { sourceDir }),
    ghCommand: 'gh',
    gitCommand: 'git',
    dshCommand: 'dsh',
    dshCommandArgs: [],
    maxFiles: 200,
    maxRepositoryBytes: 2_097_152,
    commandTimeoutMs: 30_000,
    forwardedCredentialEnv: [],
    verificationPatchPaths: [],
    evolutionPreset: false,
    ...rest,
  }
}
