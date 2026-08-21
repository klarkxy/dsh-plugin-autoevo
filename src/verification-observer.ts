import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyHostVerification, type HostDriverConfig } from './host-verification-driver.js'
import type { VerificationLayerKind } from './contracts.js'

export interface Config {
  receiptPath: string
  expectedTools: string[]
  expectedText?: string
  expectedProvider?: string
  expectedModel?: string
  layer?: string
  packageName?: string
  fixtureDigest?: string
  fixturesJson?: string
}

export const Config: Schema<Config> = Schema.object({
  receiptPath: Schema.string().required(),
  expectedTools: Schema.array(Schema.string()).default([]),
  expectedText: Schema.string().default(''),
  expectedProvider: Schema.string().default(''),
  expectedModel: Schema.string().default(''),
  layer: Schema.string().default(''),
  packageName: Schema.string().default(''),
  fixtureDigest: Schema.string().default(''),
  fixturesJson: Schema.string().default(''),
})

export const name = 'dsh-plugin-autoevo-verification-observer'
export const inject = ['tools', 'sessions']

type ReceiptEvent = {
  kind: 'tool/call' | 'tool/result'
  callId: string
  name: string
  isError?: boolean
} | {
  kind: 'task/result'
  resultSha256: string
  matchedExpectation?: boolean
  provider?: string
  model?: string
}

function appendReceipt(receiptPath: string, event: ReceiptEvent): void {
  appendFileSync(receiptPath, `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    flag: 'a',
  })
}

function hostLayer(value: string | undefined): VerificationLayerKind | undefined {
  if (value === 'bundle_activation' || value === 'tool_roundtrip' || value === 'manual_runtime') return value
  return undefined
}

/**
 * Trusted verification-only observer. It records call identity and outcome,
 * never tool arguments, result content, environment values, or model text.
 * When `layer` is a Host verification layer, this entry drives Loader/tool
 * execution instead of observing an Agent turn.
 */
export function apply(ctx: Context, config: Config): void {
  const layer = hostLayer(config.layer)
  if (layer) {
    const driverConfig: HostDriverConfig = {
      receiptPath: config.receiptPath,
      expectedTools: config.expectedTools,
      layer,
      packageName: config.packageName ?? '',
      fixtureDigest: config.fixtureDigest ?? '',
      ...(config.fixturesJson ? { fixturesJson: config.fixturesJson } : {}),
    }
    applyHostVerification(ctx, driverConfig)
    return
  }
  if (!path.isAbsolute(config.receiptPath)) {
    throw new Error('verification receiptPath must be absolute')
  }
  const expected = new Set(config.expectedTools)
  const callSessions = new Map<string, string>()
  const successfulSessions = new Set<string>()
  const routes = new Map<string, { provider: string; model: string }>()
  const finalByTurn = new Map<string, { resultSha256: string; matchedExpectation?: boolean }>()
  mkdirSync(path.dirname(config.receiptPath), { recursive: true })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (expected.has(exec.name)) {
      if (exec.agent) callSessions.set(exec.callId, String(exec.agent.session.id))
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
      const sessionId = callSessions.get(exec.callId)
      callSessions.delete(exec.callId)
      if (sessionId && result.isError === false) successfulSessions.add(sessionId)
      appendReceipt(config.receiptPath, {
        kind: 'tool/result',
        callId: exec.callId,
        name: exec.name,
        isError: result.isError,
      })
    }
  })

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (event.type === 'request/context') {
      routes.set(String(session.id), {
        provider: event.data.provider,
        model: event.data.model,
      })
      return
    }
    if (event.type === 'assistant/message') {
      if (expected.size > 0 && !successfulSessions.has(String(session.id))) return
      const text = event.data.message.content
        .filter((block): block is Extract<(typeof event.data.message.content)[number], { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim()
      if (!text) return
      finalByTurn.set(`${session.id}:${event.data.turn}`, {
        resultSha256: createHash('sha256').update(text).digest('hex'),
        ...(config.expectedText ? { matchedExpectation: text.includes(config.expectedText) } : {}),
      })
      return
    }
    if (event.type !== 'turn/end') return
    const turnKey = `${session.id}:${event.data.turn}`
    const candidate = finalByTurn.get(turnKey)
    finalByTurn.delete(turnKey)
    if (event.data.reason.kind === 'completed' && candidate) {
      const route = routes.get(String(session.id))
      appendReceipt(config.receiptPath, {
        kind: 'task/result',
        ...candidate,
        ...(route ? route : {}),
      })
    }
  })
}
