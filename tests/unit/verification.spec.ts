import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { _testing } from '../../src/lifecycle/launcher.js'

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
    ].join('\n'), 'utf8')

    await expect(_testing.readReceipt(receipt)).resolves.toEqual({
      calledTools: ['calculator', 'unsafe_tool'],
      resultTools: ['calculator'],
      failedTools: ['unsafe_tool'],
    })
  })

  it('generates a file-url observer overlay containing only derived verification configuration', () => {
    const overlay = _testing.verificationOverlay(path.resolve('receipt.jsonl'), ['calculator'])
    expect(JSON.stringify(overlay)).toContain('verification-observer.js')
    expect(JSON.stringify(overlay)).toContain('calculator')
    expect(JSON.stringify(overlay)).not.toContain('arguments')
  })
})

