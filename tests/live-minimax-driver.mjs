import { access, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'autoevo-live-minimax-driver'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'agentPresets']

const FIRST_PROMPT = '我需要一个能把当前 DSH 聊天记录导出成长截图的插件。'
const STATE_DIR = process.env.AUTOEVO_LIVE_STATE_DIR
const OUT_DIR = process.env.AUTOEVO_LIVE_OUT_DIR
const TURN_MS = Number(process.env.AUTOEVO_LIVE_TURN_MS ?? 480_000)

function summarize(events, firstSeq) {
  let started = false
  let text = ''
  let reason
  const tools = []
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined) text = joined
    }
    if (event.type === 'tools/call' || event.type === 'tool/call') {
      tools.push({
        type: event.type,
        name: event.data?.name ?? event.data?.toolName ?? event.data?.call?.name,
      })
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason, tools, eventTypes: [...new Set(events.filter((e) => e.seq >= firstSeq).map((e) => e.type))] }
}

async function latestJson(directory, prefix) {
  let entries
  try {
    entries = (await readdir(directory)).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).sort()
  } catch {
    return undefined
  }
  if (entries.length === 0) return undefined
  return JSON.parse(await readFile(path.join(directory, entries.at(-1)), 'utf8'))
}

function pickRepository(workflow) {
  const remotes = workflow?.interrupt?.facts?.remoteCandidates ?? []
  const scored = remotes.map((item) => {
    const hay = `${item.repository} ${item.name} ${item.description} ${(item.matchedTerms ?? []).join(' ')}`.toLowerCase()
    let score = 0
    if (hay.includes('conv-export') || hay.includes('dsh-companion')) score += 8
    if (hay.includes('export') || hay.includes('导出')) score += 4
    if (hay.includes('png') || hay.includes('长图') || hay.includes('长截图') || hay.includes('screenshot')) score += 5
    if (hay.includes('conversation') || hay.includes('会话') || hay.includes('聊天')) score += 3
    return { item, score }
  })
  scored.sort((left, right) => right.score - left.score || right.item.stars - left.item.stars)
  return scored[0]?.item
}

function nextUserMessage(workflow, review) {
  if (!workflow) return undefined
  if (workflow.status === 'completed' || workflow.status === 'failed') return undefined
  if (workflow.cursor === 'await_selection') {
    const candidate = pickRepository(workflow)
    if (!candidate) return '先停'
    return `审查 ${candidate.repository}`
  }
  if (workflow.cursor === 'await_confirmation') {
    if (review?.sourceSnapshot?.kind === 'local') return '先停，不安装。'
    return '确认 modify_this：按 turn 支持不连续多选，按原顺序拼成一张长截图并保留细分隔线。采用最小合理实现，立即调用 resume；改完先重新审查，先不要装。'
  }
  if (workflow.cursor === 'await_modify_work') return undefined
  return undefined
}

async function withTimeout(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${TURN_MS}ms`)), TURN_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitFor(filename) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await access(filename).then(() => true).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${filename}`)
}

function apply(ctx) {
  const exit = ctx.get('appExit')
  if (!exit) throw new Error('live driver needs appExit')
  run(ctx).then(
    (code) => exit(code),
    (error) => {
      process.stderr.write(`dsh live driver: ${error instanceof Error ? error.message : String(error)}\n`)
      if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`)
      exit(1)
    },
  )
}

async function run(ctx) {
  await ctx.get('loader')?.await()
  const presetDir = path.join(process.env.DSH_HOME, '.agent-presets', 'evolution')
  await waitFor(path.join(presetDir, '.autoevo-preset.json'))
  const presetAgent = path.join(presetDir, 'agent.cordis.yml')
  const evolutionModeUrl = process.env.AUTOEVO_LIVE_EVOLUTION_MODE_URL
  if (!evolutionModeUrl) throw new Error('AUTOEVO_LIVE_EVOLUTION_MODE_URL is missing')
  const presetBody = await readFile(presetAgent, 'utf8')
  if (!presetBody.includes('dsh-plugin-autoevo/evolution-mode')) {
    throw new Error('isolated preset does not contain the expected AutoEvo evolution-mode entry')
  }
  await writeFile(presetAgent, presetBody.replace('dsh-plugin-autoevo/evolution-mode', evolutionModeUrl), 'utf8')
  const agents = ctx.agents
  const defaultModel = ctx.agentDefaultModel
  const sessions = ctx.sessions
  const presets = ctx.agentPresets
  const selection = defaultModel.currentSelection()
  process.stderr.write(`live driver model=${selection.provider}/${selection.model} preset=evolution\n`)

  const { agent } = await agents.create({
    sessionId: `session-live-autoevo-${Date.now()}`,
    meta: { cwd: process.cwd(), agentPreset: 'evolution' },
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
    },
    setup: async (agentCtx) => {
      await presets.mount(agentCtx, 'evolution')
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    },
  })
  await agent.whenIdle()

  const transcript = {
    model: selection,
    firstPrompt: FIRST_PROMPT,
    turns: [],
  }

  const send = async (text) => {
    process.stderr.write(`\n----- user -----\n${text}\n`)
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await withTimeout(agent.whenIdle(), 'turn')
    const outcome = summarize(agent.session.events, firstSeq)
    const workflow = STATE_DIR ? await latestJson(path.join(STATE_DIR, 'workflows'), 'workflow_') : undefined
    const review = STATE_DIR ? await latestJson(path.join(STATE_DIR, 'reviews'), 'review_') : undefined
    const installation = STATE_DIR ? await latestJson(path.join(STATE_DIR, 'installations'), 'installation_') : undefined
    transcript.turns.push({
      user: text,
      assistant: outcome.text,
      reason: outcome.reason,
      tools: outcome.tools,
      eventTypes: outcome.eventTypes,
      workflow: workflow
        ? {
            id: workflow.id,
            status: workflow.status,
            cursor: workflow.cursor,
            lastFailure: workflow.lastFailure,
            interruptKind: workflow.interrupt?.kind,
            options: workflow.interrupt?.options?.map((item) => item.id),
            remotes: (workflow.interrupt?.facts?.remoteCandidates ?? []).map((item) => item.repository),
            fit: workflow.interrupt?.facts?.fit,
            recommendation: workflow.interrupt?.facts?.recommendation,
          }
        : undefined,
      review: review
        ? {
            id: review.id,
            fit: review.fit,
            recommendation: review.recommendation,
            securityRisk: review.securityRisk,
            repository: review.sourceSnapshot?.kind === 'github' ? review.sourceSnapshot.repository : undefined,
          }
        : undefined,
      installation: installation
        ? {
            id: installation.id,
            installed: installation.installed,
            verified: installation.verified,
            removed: installation.removed,
            reason: installation.verification?.reason,
          }
        : undefined,
    })
    process.stderr.write(`----- assistant (${outcome.reason?.kind ?? 'unknown'}) -----\n${outcome.text}\n`)
    return { outcome, workflow, review, installation }
  }

  let current = await send(FIRST_PROMPT)
  for (let step = 0; step < 4; step += 1) {
    const follow = nextUserMessage(current.workflow, current.review)
    if (!follow) break
    current = await send(follow)
    if (current.workflow?.status === 'completed' || current.workflow?.status === 'failed') break
  }

  await sessions.flush(agent.session)
  await mkdir(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, 'transcript.json')
  await writeFile(outFile, `${JSON.stringify(transcript, null, 2)}\n`)
  process.stderr.write(`\nlive driver wrote ${outFile}\n`)
  process.stdout.write(`${JSON.stringify({
    model: transcript.model,
    turns: transcript.turns.length,
    lastCursor: current.workflow?.cursor,
    lastStatus: current.workflow?.status,
    review: current.review && { fit: current.review.fit, recommendation: current.review.recommendation },
    installation: current.installation,
    outFile,
  }, null, 2)}\n`)
  return current.outcome.reason?.kind === 'error' ? 1 : 0
}

export { apply }
