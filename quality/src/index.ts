import { aggregateAll } from './aggregate.js'
import {
  parseObservationBatch,
  type QualityObservation,
  type SnapshotFile,
} from './protocol.js'

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  run(): Promise<unknown>
  all<T>(): Promise<{ results: T[] }>
}

interface D1Database {
  prepare(query: string): D1PreparedStatement
}

interface R2ObjectBody {
  text(): Promise<string>
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string, cacheControl?: string } }): Promise<unknown>
}

export interface Env {
  DB: D1Database
  SNAPSHOT?: R2Bucket
}

const SNAPSHOT_KEY = 'v1/quality/assessments.json'
const RAW_RETENTION_DAYS = 45
const CACHE_CONTROL = 'public, max-age=86400, s-maxage=86400'

interface StoredRow {
  id: string
  created_at: string
  repository: string
  commit: string
  local_modification: number
  policy_version: string
  autoevo_version: string
  dsh_version: string | null
  stage: QualityObservation['stage']
  outcome: string
  reason_codes: string
  security_risk: QualityObservation['securityRisk']
  repairability: QualityObservation['repairability']
  evolution_value: QualityObservation['evolutionValue']
}

function json(status: number, payload: unknown, cacheControl = 'no-store'): Response {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: {
      'cache-control': cacheControl,
      'content-type': 'application/json; charset=utf-8',
    },
  })
}

function rowToObservation(row: StoredRow): QualityObservation {
  return {
    schemaVersion: 1,
    id: row.id,
    createdAt: row.created_at,
    repository: row.repository,
    commit: row.commit,
    localModification: row.local_modification === 1,
    policyVersion: row.policy_version,
    autoevoVersion: row.autoevo_version,
    dshVersion: row.dsh_version,
    stage: row.stage,
    outcome: row.outcome,
    reasonCodes: JSON.parse(row.reason_codes) as string[],
    securityRisk: row.security_risk,
    repairability: row.repairability,
    evolutionValue: row.evolution_value,
  }
}

async function readObservations(db: D1Database): Promise<QualityObservation[]> {
  const cutoff = new Date(Date.now() - RAW_RETENTION_DAYS * 86_400_000).toISOString()
  const result = await db.prepare(
    'SELECT id, created_at, repository, commit, local_modification, policy_version, autoevo_version, dsh_version, stage, outcome, reason_codes, security_risk, repairability, evolution_value FROM observations WHERE created_at >= ?',
  ).bind(cutoff).all<StoredRow>()
  return result.results.map(rowToObservation)
}

async function writeSnapshot(env: Env, snapshot: SnapshotFile): Promise<void> {
  const body = `${JSON.stringify(snapshot)}\n`
  await env.SNAPSHOT?.put(SNAPSHOT_KEY, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: CACHE_CONTROL },
  })
}

async function rebuildSnapshot(env: Env): Promise<SnapshotFile> {
  const assessments = aggregateAll(await readObservations(env.DB))
  const snapshot: SnapshotFile = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    assessments,
  }
  await writeSnapshot(env, snapshot)
  return snapshot
}

async function readSnapshot(env: Env): Promise<SnapshotFile> {
  const object = await env.SNAPSHOT?.get(SNAPSHOT_KEY)
  if (object) {
    try {
      return JSON.parse(await object.text()) as SnapshotFile
    } catch {
      // Rebuild below.
    }
  }
  return rebuildSnapshot(env)
}

async function acceptObservations(env: Env, request: Request): Promise<Response> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json(400, { error: 'invalid json' })
  }
  const observations = parseObservationBatch(raw)
  if (!observations) return json(400, { error: 'invalid observation batch' })
  const receivedAt = new Date().toISOString()
  for (const item of observations) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO observations (
        id, created_at, repository, commit, local_modification, policy_version, autoevo_version, dsh_version,
        stage, outcome, reason_codes, security_risk, repairability, evolution_value, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      item.id,
      item.createdAt,
      item.repository,
      item.commit,
      item.localModification ? 1 : 0,
      item.policyVersion,
      item.autoevoVersion,
      item.dshVersion,
      item.stage,
      item.outcome,
      JSON.stringify(item.reasonCodes),
      item.securityRisk,
      item.repairability,
      item.evolutionValue,
      receivedAt,
    ).run()
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/$/u, '')
    if (request.method === 'GET' && (path === '/v1/quality/assessments' || path === '/v1/quality/query')) {
      const snapshot = await readSnapshot(env)
      return json(200, snapshot, CACHE_CONTROL)
    }
    if (request.method === 'POST' && path === '/v1/quality/observations') {
      return acceptObservations(env, request)
    }
    if (request.method === 'GET' && path === '/health') {
      return json(200, { ok: true })
    }
    return json(404, { error: 'not found' })
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    await rebuildSnapshot(env)
  },
}
