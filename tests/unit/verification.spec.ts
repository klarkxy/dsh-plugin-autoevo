import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import { _testing } from '../../src/lifecycle/launcher.js'
import { DshLauncher } from '../../src/lifecycle/launcher.js'
import type { CommandRunner } from '../../src/process/runner.js'

const temporary = trackTempDirs()

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporary.push(directory)
  return directory
}

async function writeReceipt(lines: string[], prefix = 'capability-evolution-receipt-'): Promise<string> {
  const receipt = path.join(await tempDir(prefix), 'receipt.jsonl')
  await writeFile(receipt, lines.join('\n'), 'utf8')
  return receipt
}

describe('trusted verification receipt', () => {
  it('counts only call-id-matched successful results', async () => {
    const receipt = await writeReceipt([
      JSON.stringify({ kind: 'tool/call', callId: 'call-1', name: 'calculator' }),
      JSON.stringify({ kind: 'tool/result', callId: 'other-call', name: 'calculator', isError: false }),
      JSON.stringify({ kind: 'tool/result', callId: 'call-1', name: 'calculator', isError: false }),
      JSON.stringify({ kind: 'tool/call', callId: 'call-2', name: 'unsafe_tool', arguments: 'not stored' }),
      JSON.stringify({ kind: 'tool/result', callId: 'call-2', name: 'unsafe_tool', isError: true }),
      JSON.stringify({ kind: 'task/result', resultSha256: 'a'.repeat(64), matchedExpectation: true }),
    ])

    await expect(_testing.readReceipt(receipt)).resolves.toEqual({
      calledTools: ['calculator', 'unsafe_tool'],
      resultTools: ['calculator'],
      failedTools: ['unsafe_tool'],
      observerEventCount: 5,
      taskResultObserved: true,
      taskResultSha256: 'a'.repeat(64),
      taskResultMatchedExpectation: true,
    })
  })

  it('retains a completed final-answer mismatch as negative verification evidence', async () => {
    const receipt = await writeReceipt([JSON.stringify({
      kind: 'task/result', resultSha256: 'b'.repeat(64), matchedExpectation: false,
    })])

    await expect(_testing.readReceipt(receipt)).resolves.toMatchObject({
      taskResultObserved: true,
      taskResultMatchedExpectation: false,
    })
  })

  it('allows a later successful retry to clear an earlier tool failure', async () => {
    const receipt = await writeReceipt([
      JSON.stringify({ kind: 'tool/call', callId: 'call-1', name: 'calculator' }),
      JSON.stringify({ kind: 'tool/result', callId: 'call-1', name: 'calculator', isError: true }),
      JSON.stringify({ kind: 'tool/call', callId: 'call-2', name: 'calculator' }),
      JSON.stringify({ kind: 'tool/result', callId: 'call-2', name: 'calculator', isError: false }),
      JSON.stringify({ kind: 'task/result', resultSha256: 'c'.repeat(64), matchedExpectation: true }),
    ], 'capability-evolution-retry-')

    await expect(_testing.readReceipt(receipt)).resolves.toMatchObject({
      resultTools: ['calculator'],
      failedTools: [],
      taskResultObserved: true,
    })
  })

  it('treats a later failure as authoritative after an earlier success', async () => {
    const receipt = await writeReceipt([
      JSON.stringify({ kind: 'tool/call', callId: 'call-1', name: 'calculator' }),
      JSON.stringify({ kind: 'tool/result', callId: 'call-1', name: 'calculator', isError: false }),
      JSON.stringify({ kind: 'tool/call', callId: 'call-2', name: 'calculator' }),
      JSON.stringify({ kind: 'tool/result', callId: 'call-2', name: 'calculator', isError: true }),
      JSON.stringify({ kind: 'task/result', resultSha256: 'f'.repeat(64), matchedExpectation: true }),
    ], 'capability-evolution-last-failure-')

    await expect(_testing.readReceipt(receipt)).resolves.toMatchObject({
      resultTools: ['calculator'],
      failedTools: ['calculator'],
    })
  })

  it('uses call order when parallel tool results arrive out of order', async () => {
    const receipt = await writeReceipt([
      JSON.stringify({ kind: 'tool/call', callId: 'call-1', name: 'calculator' }),
      JSON.stringify({ kind: 'tool/call', callId: 'call-2', name: 'calculator' }),
      JSON.stringify({ kind: 'tool/result', callId: 'call-2', name: 'calculator', isError: true }),
      JSON.stringify({ kind: 'tool/result', callId: 'call-1', name: 'calculator', isError: false }),
      JSON.stringify({ kind: 'task/result', resultSha256: '1'.repeat(64), matchedExpectation: true }),
    ], 'capability-evolution-parallel-order-')

    await expect(_testing.readReceipt(receipt)).resolves.toMatchObject({ failedTools: ['calculator'] })
  })

  it('fails when the latest tool call has no result', async () => {
    const receipt = await writeReceipt([
      JSON.stringify({ kind: 'tool/call', callId: 'call-1', name: 'calculator' }),
      JSON.stringify({ kind: 'tool/result', callId: 'call-1', name: 'calculator', isError: false }),
      JSON.stringify({ kind: 'tool/call', callId: 'call-2', name: 'calculator' }),
      JSON.stringify({ kind: 'task/result', resultSha256: '2'.repeat(64), matchedExpectation: true }),
    ], 'capability-evolution-missing-result-')

    await expect(_testing.readReceipt(receipt)).resolves.toMatchObject({ failedTools: ['calculator'] })
  })

  it('records the provider and model used by the completed verification turn', async () => {
    const receipt = await writeReceipt([JSON.stringify({
      kind: 'task/result', resultSha256: 'd'.repeat(64), matchedExpectation: true,
      provider: 'xai-oauth', model: 'grok-4.5',
    })], 'capability-evolution-route-')

    await expect(_testing.readReceipt(receipt)).resolves.toMatchObject({
      observedProvider: 'xai-oauth',
      observedModel: 'grok-4.5',
    })
  })

  it('does not accept non-empty stdout as a task result without a completed-turn receipt', async () => {
    const directory = await tempDir('capability-evolution-stdout-')
    const config = testRuntimeConfig(directory, { dshHome: directory, evolutionPreset: true })
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

  it('persists bounded launch evidence when the runner throws before any observer event', async () => {
    const directory = await tempDir('capability-evolution-launch-error-')
    const config = testRuntimeConfig(directory, { dshHome: directory, evolutionPreset: true })
    const runner: CommandRunner = {
      async run() {
        throw new Error('private machine-specific launch detail')
      },
    }

    const result = await new DshLauncher(runner, config).verify(
      directory,
      'headless',
      process.cwd(),
      'sensitive task text',
      ['calculator'],
    )

    expect(result).toMatchObject({
      attempted: true,
      exitCode: null,
      taskResultObserved: false,
      launchEvidence: {
        attempted: true,
        processOutcome: 'threw',
        observerEventCount: 0,
        failureClass: 'launch_error',
        diagnosticHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    })
    expect(result.receiptPath).toBeTypeOf('string')
    const receipt = await readFile(result.receiptPath!, 'utf8')
    expect(receipt).toContain('host/launch')
    expect(receipt).toContain('host/process')
    expect(receipt).not.toContain('sensitive task text')
    expect(receipt).not.toContain('private machine-specific launch detail')
    expect(result.reason).toMatch(/cause is unknown/i)
  })

  it('generates a file-url observer overlay containing only derived verification configuration', () => {
    const overlay = _testing.verificationOverlay(path.resolve('receipt.jsonl'), ['calculator'])
    expect(JSON.stringify(overlay)).toContain('verification-observer.js')
    expect(JSON.stringify(overlay)).toContain('calculator')
    expect(JSON.stringify(overlay)).not.toContain('arguments')
  })

  it('passes only the expected final-answer text into the trusted child observer', () => {
    const overlay = _testing.verificationOverlay(path.resolve('receipt.jsonl'), ['calculator'], '42', {
      provider: 'xai-oauth', model: 'grok-4.5',
    })
    expect(JSON.stringify(overlay)).toContain('"expectedText":"42"')
    expect(JSON.stringify(overlay)).toContain('"expectedProvider":"xai-oauth"')
  })

  it('fails a completed child turn when its observed provider route differs', async () => {
    const directory = await tempDir('capability-evolution-route-verify-')
    const config = testRuntimeConfig(directory, { dshHome: directory, evolutionPreset: true })
    const runner: CommandRunner = {
      async run(request) {
        const patchIndex = request.argv.lastIndexOf('--patch')
        const overlay = JSON.parse(await readFile(request.argv[patchIndex + 1]!, 'utf8')) as Array<{ insert: Array<{ config: { receiptPath: string } }> }>
        await writeFile(overlay[0]!.insert[0]!.config.receiptPath, JSON.stringify({
          kind: 'task/result', resultSha256: 'e'.repeat(64), matchedExpectation: true,
          provider: 'xai-oauth', model: 'grok-2',
        }), 'utf8')
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    }

    const result = await new DshLauncher(runner, config).verify(
      directory, 'headless', process.cwd(), 'answer with Grok', [], undefined,
      { provider: 'xai-oauth', model: 'grok-4.5' },
    )
    expect(result).toMatchObject({
      routeMatchedExpectation: false,
      observedProvider: 'xai-oauth',
      observedModel: 'grok-2',
    })
    expect(result.reason).toMatch(/provider\/model route did not match/i)
  })

  it('treats expected-text substring as diagnostic and still records mechanical tool success', async () => {
    const directory = await tempDir('capability-evolution-diagnostic-text-')
    const config = testRuntimeConfig(directory, { dshHome: directory, evolutionPreset: true })
    const runner: CommandRunner = {
      async run(request) {
        const patchIndex = request.argv.lastIndexOf('--patch')
        const overlay = JSON.parse(await readFile(request.argv[patchIndex + 1]!, 'utf8')) as Array<{ insert: Array<{ config: { receiptPath: string } }> }>
        await writeFile(overlay[0]!.insert[0]!.config.receiptPath, [
          JSON.stringify({ kind: 'tool/call', callId: 'call-1', name: 'calculator' }),
          JSON.stringify({ kind: 'tool/result', callId: 'call-1', name: 'calculator', isError: false }),
          JSON.stringify({ kind: 'task/result', resultSha256: 'e'.repeat(64), matchedExpectation: false }),
        ].join('\n'), 'utf8')
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    }
    const result = await new DshLauncher(runner, config).verify(
      directory, 'headless', process.cwd(), 'calculate 6 * 7', ['calculator'], '42',
    )
    expect(result).toMatchObject({
      calledTools: ['calculator'],
      resultTools: ['calculator'],
      taskResultObserved: true,
      taskResultMatchedExpectation: false,
    })
    expect(result.reason).toMatch(/matching tool\/call and successful tool\/result/i)
    expect(result.reason).toMatch(/diagnostic only/i)
    expect(_testing.hostMechanicalSuccess({ sourceMatched: true, verification: result })).toBe(true)
    expect(_testing.hostMechanicalSuccess({
      sourceMatched: true,
      verification: { ...result, resultTools: [], failedTools: ['calculator'] },
    })).toBe(false)
  })
})
