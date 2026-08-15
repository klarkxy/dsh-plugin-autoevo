import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  receiptPath: string
  expectedTools: string[]
}

export const Config: Schema<Config> = Schema.object({
  receiptPath: Schema.string().required(),
  expectedTools: Schema.array(Schema.string()).default([]),
})

export const name = 'dsh-plugin-autoevo-verification-observer'
export const inject = ['tools']

interface ReceiptEvent {
  kind: 'tool/call' | 'tool/result'
  callId: string
  name: string
  isError?: boolean
}

function appendReceipt(receiptPath: string, event: ReceiptEvent): void {
  appendFileSync(receiptPath, `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    flag: 'a',
  })
}

/**
 * Trusted verification-only observer. It records call identity and outcome,
 * never tool arguments, result content, environment values, or model text.
 */
export function apply(ctx: Context, config: Config): void {
  if (!path.isAbsolute(config.receiptPath)) {
    throw new Error('verification receiptPath must be absolute')
  }
  const expected = new Set(config.expectedTools)
  mkdirSync(path.dirname(config.receiptPath), { recursive: true })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (expected.has(exec.name)) {
      appendReceipt(config.receiptPath, {
        kind: 'tool/call',
        callId: exec.callId,
        name: exec.name,
      })
    }
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    if (expected.has(exec.name)) {
      appendReceipt(config.receiptPath, {
        kind: 'tool/result',
        callId: exec.callId,
        name: exec.name,
        isError: result.isError,
      })
    }
  })
}

