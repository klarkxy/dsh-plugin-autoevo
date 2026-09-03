import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import { _testing } from '../../src/lifecycle/launcher.js'

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
      provider: 'provider-alpha', model: 'model-alpha-v1',
    })], 'capability-evolution-route-')

    await expect(_testing.readReceipt(receipt)).resolves.toMatchObject({
      observedProvider: 'provider-alpha',
      observedModel: 'model-alpha-v1',
    })
  })
})
