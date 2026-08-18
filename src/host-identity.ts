import type { Agent } from '@deepseek-ai/dsh-agent'
import { hashObject } from './state/hashes.js'

/** Stable owner session identity used to bind workflow interrupts. */
export function ownerSessionId(agent: Agent | undefined): string | undefined {
  if (!agent) return undefined
  const headerId = agent.session?.header?.id
  if (typeof headerId === 'string' && headerId.length > 0) return headerId
  if (typeof agent.id === 'string' && agent.id.length > 0) return agent.id
  return undefined
}

export function sessionCwd(agent: Agent | undefined, fallback = process.cwd()): string {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : fallback
}

export function normalizeRequirement(requirement: string): string {
  return requirement.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

export function newBootId(): string {
  return `boot_${hashObject({ at: new Date().toISOString(), nonce: Math.random() }).slice(0, 24)}`
}

export function newInterruptId(binding: {
  ownerSessionId: string
  bootId: string
  validAfterTurnId: string
  snapshotDigest: string
}): string {
  return `interrupt_${hashObject({ ...binding, at: new Date().toISOString() }).slice(0, 24)}`
}

export function newTurnId(sessionId: string, sequence: number): string {
  return `turn_${hashObject({ sessionId, sequence }).slice(0, 24)}`
}
