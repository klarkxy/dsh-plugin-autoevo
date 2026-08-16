import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { DshCommandRunner, _testing } from '../../src/process/runner.js'

describe('subprocess environment boundary', () => {
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

  it('unwraps a global Windows dsh.cmd to its native JavaScript entry', () => {
    const wrapped = _testing.argvForResolvedExecutable(
      'C:\\Users\\x\\AppData\\Roaming\\npm\\dsh.cmd',
      ['plugin', '--profile', 'web', 'add', '--save-exact', 'dsh-find-plugin'],
      'win32',
    )
    expect(wrapped[0]).toBe(process.execPath)
    expect(wrapped[1]).toBe('C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')
    expect(wrapped).toContain('dsh-find-plugin')
  })

  it('preserves spaces inside arguments without a shell parser', () => {
    const wrapped = _testing.argvForResolvedExecutable(
      'C:\\Users\\x\\dsh.cmd',
      ['plugin', '--profile', 'web', 'add', 'link:D:/0 code/dsh-plugin-autoevo'],
      'win32',
    )
    expect(wrapped.slice(-2)).toEqual(['add', 'link:D:/0 code/dsh-plugin-autoevo'])
    expect(wrapped[0]).toBe(process.execPath)
  })

  it('unwraps a pnpm node_modules .bin dsh shim', () => {
    const wrapped = _testing.argvForResolvedExecutable(
      'D:\\0 code\\repo\\node_modules\\.bin\\dsh.CMD',
      ['--version'],
      'win32',
    )
    expect(wrapped.slice(0, 2)).toEqual([
      process.execPath,
      'D:\\0 code\\repo\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    ])
  })

  it('fails closed for unsupported Windows command shims', () => {
    expect(() => _testing.argvForResolvedExecutable('C:\\tools\\unknown.cmd', ['arg'], 'win32'))
      .toThrow(/unsupported Windows command shim/u)
  })

  it('leaves native executables unchanged', () => {
    expect(_testing.argvForResolvedExecutable('C:\\Program Files\\GitHub CLI\\gh.exe', ['api'], 'win32'))
      .toEqual(['C:\\Program Files\\GitHub CLI\\gh.exe', 'api'])
    expect(_testing.argvForResolvedExecutable('/usr/bin/dsh', ['plugin'], 'linux'))
      .toEqual(['/usr/bin/dsh', 'plugin'])
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
})
