import { spawnSync } from 'node:child_process'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { DshCommandRunner, _testing } from '../../src/process/runner.js'

describe('subprocess environment boundary', () => {
  it('preserves the Windows OS root needed for Node CSPRNG startup', () => {
    expect(_testing.effectiveEnvironment('dsh', { DSH_HOME: 'C:\\dsh' }, {
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      USER_TOKEN: 'do-not-forward',
    }, 'win32')).toEqual({
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
    }, 'win32')).toEqual({
      DSH_HOME: 'C:\\dsh',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    })
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
