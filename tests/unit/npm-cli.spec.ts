import { describe, expect, it } from 'vitest'
import { EvolutionError } from '../../src/errors.js'
import { _testing } from '../../src/lifecycle/npm-cli.js'
import type { CommandRunner } from '../../src/process/runner.js'

describe('npm CLI interpreter selection', () => {
  it('keeps a native Node host as the npm JavaScript interpreter', async () => {
    const runner = { run: async () => { throw new Error('not used') } } as CommandRunner
    await expect(_testing.npmCliInterpreter(runner, undefined, 'C:\\Program Files\\nodejs\\node.exe'))
      .resolves.toBe('C:\\Program Files\\nodejs\\node.exe')
  })

  it('resolves Node instead of using a DSH Desktop host to interpret npm-cli.js', async () => {
    const runner = {
      run: async () => { throw new Error('not used') },
      resolveExecutable: async (command: string) => {
        expect(command).toBe('node')
        return 'C:\\Program Files\\nodejs\\node.exe'
      },
    } as CommandRunner
    await expect(_testing.npmCliInterpreter(runner, undefined, 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe'))
      .resolves.toBe('C:\\Program Files\\nodejs\\node.exe')
  })

  it.each([
    'C:\\Users\\tester\\AppData\\Roaming\\npm\\node.cmd',
    'C:\\Users\\tester\\AppData\\Roaming\\npm\\node.ps1',
    'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe',
  ])('rejects a non-native Node resolution: %s', async (resolved) => {
    const runner = {
      run: async () => { throw new Error('not used') },
      resolveExecutable: async () => resolved,
    } as CommandRunner
    await expect(_testing.npmCliInterpreter(runner, undefined, 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe'))
      .rejects.toBeInstanceOf(EvolutionError)
    await expect(_testing.npmCliInterpreter(runner, undefined, 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe'))
      .rejects.toThrow(/not a native node binary/u)
  })

  it('fails closed when a non-Node host cannot resolve Node', async () => {
    const runner = { run: async () => { throw new Error('not used') } } as CommandRunner
    await expect(_testing.npmCliInterpreter(runner, undefined, 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe'))
      .rejects.toThrow(/Node could not be resolved/u)
  })
})
