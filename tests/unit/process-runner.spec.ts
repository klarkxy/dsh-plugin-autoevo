import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { DshCommandRunner, _testing } from '../../src/process/runner.js'
import { sha256 } from '../../src/state/hashes.js'

describe('subprocess environment boundary', () => {
  it('summarizes and hashes both command streams without retaining sensitive raw diagnostics', () => {
    const stdout = 'Progress\nERR_PNPM_FETCH_500 failed at C:\\Users\\Jane Doe\\cache; token=top-secret\n'
    const stderr = 'dsh: pnpm failed in profile directory C:\\Users\\Jane Doe\\.dsh\nSee https://example.test/?token=abc\n'
    const failure = _testing.commandResultFailure('dsh', { exitCode: 1, signal: null, stdout, stderr })

    expect(failure.details).toMatchObject({
      command: 'dsh',
      exitCode: 1,
      diagnosticHash: sha256(JSON.stringify([stdout, stderr])),
    })
    expect(failure.details.diagnosticSummary).toContain('ERR_PNPM_FETCH_500')
    expect(failure.details.diagnosticSummary).toContain('stderr:')
    expect(JSON.stringify(failure.details)).not.toContain('Jane Doe')
    expect(JSON.stringify(failure.details)).not.toContain('top-secret')
    expect(JSON.stringify(failure.details)).not.toContain('example.test')
    expect(String(failure.details.diagnosticSummary).length).toBeLessThanOrEqual(400)
    expect(failure.details).not.toHaveProperty('stdout')
    expect(failure.details).not.toHaveProperty('stderr')
  })

  it('extracts exact pnpm release-age entries even when a network diagnostic is also present', () => {
    const stdout = [
      'ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/example failed: ECONNRESET',
      '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 2 lockfile entries failed verification:',
      '  ds-harness-remote@0.3.35 was published 8 minutes ago',
      '  @deepseek-ai/dsh-file-viewer@0.2.5 was published 12 minutes ago',
    ].join('\n')
    const recovery = _testing.commandFailureRecovery({ exitCode: 1, signal: null, stdout, stderr: '' })

    expect(recovery).toEqual({
      kind: 'minimum_release_age',
      owner: 'pnpm',
      code: 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
      policyKey: 'minimumReleaseAge',
      entries: [
        { packageName: '@deepseek-ai/dsh-file-viewer', version: '0.2.5', reason: 'was published 12 minutes ago' },
        { packageName: 'ds-harness-remote', version: '0.3.35', reason: 'was published 8 minutes ago' },
      ],
    })
  })

  it('fails closed when a release-age report is malformed instead of treating it as transient', () => {
    const stderr = [
      '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 2 lockfile entries failed verification:',
      '  ds-harness-remote@0.3.35 was published 8 minutes ago',
      'ERR_PNPM_META_FETCH_FAIL ECONNRESET',
    ].join('\n')
    expect(_testing.commandFailureRecovery({ exitCode: 1, signal: null, stdout: '', stderr })).toBeUndefined()
  })

  it('classifies an allowlisted pnpm network failure for one same-authority retry', () => {
    expect(_testing.commandFailureRecovery({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'ERR_PNPM_FETCH_503 registry unavailable',
    })).toEqual({ kind: 'same_authority_once', owner: 'pnpm', code: 'ERR_PNPM_FETCH_503' })
  })

  it('classifies pnpm store mismatch without retaining either store path', () => {
    const stdout = [
      'ERR_PNPM_UNEXPECTED_STORE Unexpected store location',
      'The dependencies at "C:\\Users\\Jane\\profile\\node_modules" are currently linked from the store at "C:\\old-store".',
      'pnpm now wants to use the store at "D:\\new-store".',
    ].join('\n')
    const recovery = _testing.commandFailureRecovery({ exitCode: 1, signal: null, stdout, stderr: '' })

    expect(recovery).toEqual({
      kind: 'profile_store_mismatch',
      owner: 'pnpm',
      code: 'ERR_PNPM_UNEXPECTED_STORE',
    })
    expect(JSON.stringify(recovery)).not.toMatch(/Jane|old-store|new-store/u)
  })

  it('preserves the Windows OS root needed for Node CSPRNG startup', () => {
    expect(_testing.effectiveEnvironment('dsh', { DSH_HOME: 'C:\\dsh' }, {
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      USER_TOKEN: 'do-not-forward',
    }, 'win32', '')).toEqual({
      DSH_HOME: 'C:\\dsh',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    })
  })

  it('canonicalizes mixed-case Windows bootstrap keys to the trusted parent value', () => {
    expect(_testing.effectiveEnvironment('dsh', {
      DSH_HOME: 'C:\\dsh',
      SYSTEMROOT: 'C:\\broken',
      windir: 'C:\\also-broken',
    }, {
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    }, 'win32', '')).toEqual({
      DSH_HOME: 'C:\\dsh',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    })
  })

  it('preserves trusted LOCALAPPDATA so nested pnpm uses the profile store', () => {
    expect(_testing.effectiveEnvironment('dsh', {
      DSH_HOME: 'C:\\dsh',
      localappdata: 'C:\\attacker-controlled',
    }, {
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\tester',
    }, 'win32')).toEqual({
      DSH_HOME: 'C:\\dsh',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    })
  })

  it('limits trusted LOCALAPPDATA inheritance to DSH commands, including absolute dsh.cmd paths', () => {
    const parent = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }
    expect(_testing.effectiveEnvironment('C:\\tools\\dsh.cmd', {}, parent, 'win32'))
      .toMatchObject({ LOCALAPPDATA: parent.LOCALAPPDATA })
    for (const command of ['git', 'gh.exe', 'npm.cmd', 'node.exe']) {
      expect(_testing.effectiveEnvironment(command, {}, parent, 'win32')).not.toHaveProperty('LOCALAPPDATA')
    }
    expect(_testing.effectiveEnvironment(
      'dsh',
      { localappdata: 'C:\\untrusted' },
      {},
      'win32',
      'C:\\Users\\tester',
    )).toMatchObject({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' })
  })

  it('derives LOCALAPPDATA from the trusted OS home when the Desktop parent omits it', () => {
    expect(_testing.effectiveEnvironment(
      'dsh',
      { localappdata: 'C:\\attacker-controlled' },
      { SystemRoot: 'C:\\Windows' },
      'win32',
      'C:\\Users\\tester',
    )).toEqual({
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    })
    expect(_testing.effectiveEnvironment(
      'dsh',
      { localappdata: 'C:\\attacker-controlled' },
      {},
      'win32',
      '/not-a-windows-home',
    )).not.toHaveProperty('LOCALAPPDATA')
  })

  it.runIf(process.platform === 'win32')('starts Node with the scrubbed Windows bootstrap environment', () => {
    const env = _testing.effectiveEnvironment('dsh', { DSH_HOME: 'C:\\dsh' })
    const result = spawnSync(process.execPath, [
      '-e',
      "process.stdout.write(String(require('node:crypto').randomBytes(8).length))",
    ], { env, encoding: 'utf8', windowsHide: true })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('8')
    expect(result.stderr).toBe('')
  })

  it('neutralizes orphaned ambient Git config after credential scrubbing', () => {
    expect(_testing.effectiveEnvironment('git', {}, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
    })).toEqual({
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    })
  })

  it('forwards only the explicit GitHub CLI credential allowlist and disables color', () => {
    expect(_testing.effectiveEnvironment('gh', {}, {
      GH_TOKEN: 'token',
      OTHER_SECRET: 'do-not-forward',
    })).toEqual({
      GH_TOKEN: 'token',
      NO_COLOR: '1',
      CLICOLOR: '0',
      CLICOLOR_FORCE: '0',
      TERM: 'dumb',
    })
  })

  it.each<{
    name: string
    executable: string
    args: string[]
    platform: NodeJS.Platform
    throws?: RegExp
    verify?: (wrapped: string[]) => void
  }>([
    {
      name: 'unwraps a global Windows dsh.cmd to its native JavaScript entry',
      executable: 'C:\\Users\\x\\AppData\\Roaming\\npm\\dsh.cmd',
      args: ['plugin', '--profile', 'web', 'add', '--save-exact', 'dsh-find-plugin'],
      platform: 'win32',
      verify: (wrapped) => {
        expect(wrapped[0]).toBe(process.execPath)
        expect(wrapped[1]).toBe('C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')
        expect(wrapped).toContain('dsh-find-plugin')
      },
    },
    {
      name: 'preserves spaces inside arguments without a shell parser',
      executable: 'C:\\Users\\x\\dsh.cmd',
      args: ['plugin', '--profile', 'web', 'add', 'link:D:/0 code/dsh-plugin-autoevo'],
      platform: 'win32',
      verify: (wrapped) => {
        expect(wrapped.slice(-2)).toEqual(['add', 'link:D:/0 code/dsh-plugin-autoevo'])
        expect(wrapped[0]).toBe(process.execPath)
      },
    },
    {
      name: 'unwraps a pnpm node_modules .bin dsh shim',
      executable: 'D:\\0 code\\repo\\node_modules\\.bin\\dsh.CMD',
      args: ['--version'],
      platform: 'win32',
      verify: (wrapped) => {
        expect(wrapped.slice(0, 2)).toEqual([
          process.execPath,
          'D:\\0 code\\repo\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
        ])
      },
    },
    {
      name: 'fails closed for unsupported Windows command shims',
      executable: 'C:\\tools\\unknown.cmd',
      args: ['arg'],
      platform: 'win32',
      throws: /unsupported Windows command shim/u,
    },
    {
      name: 'leaves native Windows executables unchanged',
      executable: 'C:\\Program Files\\GitHub CLI\\gh.exe',
      args: ['api'],
      platform: 'win32',
      verify: (wrapped) => {
        expect(wrapped).toEqual(['C:\\Program Files\\GitHub CLI\\gh.exe', 'api'])
      },
    },
    {
      name: 'leaves native Linux executables unchanged',
      executable: '/usr/bin/dsh',
      args: ['plugin'],
      platform: 'linux',
      verify: (wrapped) => {
        expect(wrapped).toEqual(['/usr/bin/dsh', 'plugin'])
      },
    },
  ])('$name', ({ executable, args, platform, throws: error, verify }) => {
    if (error !== undefined) {
      expect(() => _testing.argvForResolvedExecutable(executable, args, platform)).toThrow(error)
      return
    }
    verify!(_testing.argvForResolvedExecutable(executable, args, platform))
  })

  it('spawns a resolved dsh.cmd through Node without cmd.exe', async () => {
    const spawned: string[][] = []
    const subprocess = {
      resolveExecutable: async () => 'C:\\Users\\x\\AppData\\Roaming\\npm\\dsh.cmd',
      spawn: (spec: { argv: string[] }) => {
        spawned.push([...spec.argv])
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: '', lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
        }
      },
    } as unknown as SubprocessRuntime
    const runner = new DshCommandRunner(subprocess, {
      commandTimeoutMs: 5_000,
    } as RuntimeConfig)
    await runner.run({
      argv: ['dsh', 'plugin', '--profile', 'web', 'add', '--save-exact', 'dsh-find-plugin'],
      cwd: 'D:\\tmp\\workspace',
    })
    expect(spawned).toHaveLength(1)
    const argv = spawned[0]!
    if (process.platform === 'win32') {
      expect(argv[0]).toBe(process.execPath)
      expect(argv[1]).toContain('node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')
    } else {
      expect(argv[0]).toBe('C:\\Users\\x\\AppData\\Roaming\\npm\\dsh.cmd')
    }
  })

  it('recovers complete verbose output from the subprocess spill instead of failing the command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-runner-spill-'))
    const spillPath = path.join(root, 'stdout.log')
    await writeFile(spillPath, 'complete verbose output')
    let spawned: { stdio: unknown } | undefined
    const subprocess = {
      resolveExecutable: async () => 'git',
      spawn: (spec: { stdio: unknown }) => {
        spawned = spec
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: 'tail', lossy: true, spillPath }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
        }
      },
    } as unknown as SubprocessRuntime
    try {
      const result = await new DshCommandRunner(subprocess, { commandTimeoutMs: 5_000 } as RuntimeConfig)
        .run({ argv: ['git', 'status'], cwd: root })
      expect(result.stdout).toBe('complete verbose output')
      expect(result.stdoutTruncated).toBeUndefined()
      expect(spawned?.stdio).toMatchObject({
        stdout: { spill: { maxBytes: 268_435_456 } },
        stderr: { spill: { maxBytes: 268_435_456 } },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports cancellation during executable lookup instead of claiming Git is unavailable', async () => {
    const controller = new AbortController()
    const subprocess = {
      resolveExecutable: async (_command: string, _env: Record<string, string>, signal: AbortSignal) => await new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('lookup aborted')), { once: true })
      }),
    } as unknown as SubprocessRuntime
    const runner = new DshCommandRunner(subprocess, { commandTimeoutMs: 5_000 } as RuntimeConfig)
    const running = runner.run({ argv: ['git', 'status'], cwd: process.cwd(), signal: controller.signal })
    controller.abort()
    await expect(running).rejects.toThrow(/git was cancelled/i)
    await expect(running).rejects.not.toThrow(/Executable is unavailable/i)
  })

  it('retains the unavailable-executable error for a genuine lookup failure', async () => {
    const subprocess = {
      resolveExecutable: async () => { throw new Error('ENOENT') },
    } as unknown as SubprocessRuntime
    const runner = new DshCommandRunner(subprocess, { commandTimeoutMs: 5_000 } as RuntimeConfig)
    await expect(runner.run({ argv: ['git', 'status'], cwd: process.cwd() }))
      .rejects.toThrow(/Executable is unavailable: git/i)
  })
})
