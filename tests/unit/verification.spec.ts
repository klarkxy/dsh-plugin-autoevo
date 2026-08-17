import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { _testing } from '../../src/lifecycle/launcher.js'
import { DshLauncher } from '../../src/lifecycle/launcher.js'
import type { RuntimeConfig } from '../../src/config.js'
import type { CommandRunner } from '../../src/process/runner.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

describe('trusted verification receipt', () => {
  it('counts only call-id-matched successful results', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-receipt-'))
    temporary.push(directory)
    const receipt = path.join(directory, 'receipt.jsonl')
    await writeFile(receipt, [
      JSON.stringify({ kind: 'tool/call', callId: 'call-1', name: 'calculator' }),
      JSON.stringify({ kind: 'tool/result', callId: 'other-call', name: 'calculator', isError: false }),
      JSON.stringify({ kind: 'tool/result', callId: 'call-1', name: 'calculator', isError: false }),
      JSON.stringify({ kind: 'tool/call', callId: 'call-2', name: 'unsafe_tool', arguments: 'not stored' }),
      JSON.stringify({ kind: 'tool/result', callId: 'call-2', name: 'unsafe_tool', isError: true }),
      JSON.stringify({ kind: 'task/result', resultSha256: 'a'.repeat(64), matchedExpectation: true }),
    ].join('\n'), 'utf8')

    await expect(_testing.readReceipt(receipt)).resolves.toEqual({
      calledTools: ['calculator', 'unsafe_tool'],
      resultTools: ['calculator'],
      failedTools: ['unsafe_tool'],
      taskResultObserved: true,
      taskResultSha256: 'a'.repeat(64),
      taskResultMatchedExpectation: true,
    })
  })

  it('retains a completed final-answer mismatch as negative verification evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-receipt-'))
    temporary.push(directory)
    const receipt = path.join(directory, 'receipt.jsonl')
    await writeFile(receipt, JSON.stringify({
      kind: 'task/result', resultSha256: 'b'.repeat(64), matchedExpectation: false,
    }), 'utf8')

    await expect(_testing.readReceipt(receipt)).resolves.toMatchObject({
      taskResultObserved: true,
      taskResultMatchedExpectation: false,
    })
  })

  it('does not accept non-empty stdout as a task result without a completed-turn receipt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-stdout-'))
    temporary.push(directory)
    const config: RuntimeConfig = {
      dshHome: directory,
      stateDir: directory,
      ghCommand: 'gh',
      gitCommand: 'git',
      dshCommand: 'dsh',
      dshCommandArgs: [],
      maxCandidates: 5,
      maxFiles: 80,
      maxRepositoryBytes: 1_048_576,
      commandTimeoutMs: 30_000,
      forwardedCredentialEnv: [],
      verificationPatchPaths: [],
      evolutionPreset: true,
    }
    const runner: CommandRunner = {
      async run(request) {
        const patchIndex = request.argv.lastIndexOf('--patch')
        const overlay = JSON.parse(await readFile(request.argv[patchIndex + 1]!, 'utf8')) as Array<{ insert: Array<{ config: { receiptPath: string } }> }>
        await writeFile(overlay[0]!.insert[0]!.config.receiptPath, [
          JSON.stringify({ kind: 'tool/call', callId: 'call-1', name: 'calculator' }),
          JSON.stringify({ kind: 'tool/result', callId: 'call-1', name: 'calculator', isError: false }),
        ].join('\n'), 'utf8')
        return { exitCode: 0, signal: null, stdout: 'ordinary DSH log output', stderr: '' }
      },
    }

    const result = await new DshLauncher(runner, config).verify(
      directory,
      'headless',
      process.cwd(),
      'calculate 6 * 7',
      ['calculator'],
    )

    expect(result).toMatchObject({
      calledTools: ['calculator'],
      resultTools: ['calculator'],
      taskResultObserved: false,
    })
    expect(result.reason).toContain('no completed-turn final answer')
  })

  it('generates a file-url observer overlay containing only derived verification configuration', () => {
    const overlay = _testing.verificationOverlay(path.resolve('receipt.jsonl'), ['calculator'])
    expect(JSON.stringify(overlay)).toContain('verification-observer.js')
    expect(JSON.stringify(overlay)).toContain('calculator')
    expect(JSON.stringify(overlay)).not.toContain('arguments')
  })

  it('passes only the expected final-answer text into the trusted child observer', () => {
    const overlay = _testing.verificationOverlay(path.resolve('receipt.jsonl'), ['calculator'], '42')
    expect(JSON.stringify(overlay)).toContain('"expectedText":"42"')
  })
})
