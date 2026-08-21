import assert from 'node:assert/strict'
import { access, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'autoevo-live-minimax-driver'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'agentPresets']

const PROMPTS = [
  '我需要一个能把当前 DSH 聊天记录导出成长截图的插件。请先查现成能力。',
  '我想在 DSH 里使用 Grok 订阅能力，请查找可复用插件并说明 OAuth 与 API 方案差异。',
  '我需要让 DSH 使用 Grok Coding Plan 登录能力。先找现成插件，再根据证据推荐。',
]
const RUN_INDEX = Number(process.env.AUTOEVO_LIVE_RUN_INDEX ?? 0)
const FIRST_PROMPT = PROMPTS[Math.abs(RUN_INDEX) % PROMPTS.length]
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
        arguments: event.data?.arguments ?? event.data?.call?.arguments,
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
  const remotes = workflow?.candidateSnapshot?.filter((item) => item.kind === 'remote') ?? []
  const scored = remotes.map((item) => {
    const hay = `${item.repository} ${item.name}`.toLowerCase()
    let score = 0
    if (hay.includes('conv-export') || hay.includes('dsh-companion')) score += 8
    if (hay.includes('export') || hay.includes('导出')) score += 4
    if (hay.includes('png') || hay.includes('长图') || hay.includes('长截图') || hay.includes('screenshot')) score += 5
    if (hay.includes('conversation') || hay.includes('会话') || hay.includes('聊天')) score += 3
    return { item, score }
  })
  scored.sort((left, right) => right.score - left.score || left.item.index - right.item.index)
  return scored[0]?.item
}

function nextUserMessage(workflow, review) {
  if (!workflow) return undefined
  if (workflow.status === 'completed' || workflow.status === 'failed') return undefined
  if (workflow.cursor === 'await_discovery') {
    return '请在当前 Host 事实和剩余预算内自主补查或收敛，并给出你认为最有价值的真实短名单。'
  }
  if (workflow.cursor === 'await_selection') {
    const candidate = pickRepository(workflow)
    if (!candidate) return '先停'
    return RUN_INDEX % 3 === 2 && workflow.candidateSnapshot.length >= 3
      ? '看看3'
      : candidate.index === 1 ? '按你的推荐看第一个' : `看看第${candidate.index}个`
  }
  if (workflow.cursor === 'await_confirmation') {
    return '先停，不安装、不修改也不新建。'
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
            pool: (workflow.discoveryPool ?? []).map((item) => ({
              id: item.id,
              index: item.index,
              kind: item.kind,
              fit: item.fit,
              repository: item.repository,
            })),
            sealed: (workflow.candidateSnapshot ?? []).map((item) => ({
              id: item.id,
              index: item.index,
              kind: item.kind,
              fit: item.fit,
              repository: item.repository,
            })),
            selectedRepositories: workflow.selectedRepositories,
          }
        : undefined,
      review: review
        ? {
            id: review.id,
            fit: review.fit,
            recommendation: review.recommendation,
            securityRisk: review.securityRisk,
            findingCodes: (review.findings ?? []).map((finding) => finding.code),
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
  for (let step = 0; step < 6; step += 1) {
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
  const allTools = transcript.turns.flatMap((turn) => turn.tools.map((tool) => tool.name)).filter(Boolean)
  const firstWorkflow = allTools.indexOf('capability_workflow')
  const firstPresent = allTools.indexOf('capability_workflow_present')
  const firstResume = allTools.indexOf('capability_workflow_resume')
  assert.equal(firstWorkflow, 0, 'the first AutoEvo tool must be capability_workflow')
  assert.ok(firstResume > firstWorkflow, 'resume must follow a fresh user turn')
  const publicText = transcript.turns.map((turn) => turn.assistant).join('\n')
  assert.doesNotMatch(
    publicText,
    /\b(?:parked|await_[a-z_]+|agent_directive|next_step|use_this|modify_this|create_new|search_more|review_candidates|reuse_local)\b|\b(?:workflow|candidate|interrupt)_[a-z0-9_-]+|\bGate[- ]?[12]\b/iu,
  )
  const reviewTurn = transcript.turns.find((turn) => turn.review?.repository)
  if (reviewTurn) {
    assert.ok(firstPresent > firstWorkflow, 'a reviewed candidate must first be sealed from the Host pool')
    assert.ok(firstResume > firstPresent, 'candidate review must follow shortlist presentation and a fresh user turn')
    assert.ok(transcript.turns.length >= 3, 'the conversation must exercise discovery, candidate selection, and final decision')
  } else {
    const confirmationWithoutCandidate = transcript.turns.find((turn) => (
      turn.workflow?.cursor === 'await_confirmation'
      && turn.workflow.pool.every((candidate) => candidate.kind !== 'remote' && candidate.fit !== 'full')
    ))
    assert.ok(confirmationWithoutCandidate, 'an exhausted discovery with no reviewable candidate must open a stop/search gate')
  }
  assert.ok(transcript.turns.some((turn) => turn.workflow?.cursor === 'await_confirmation'), 'Gate 2 must be reached before stop')
  assert.equal(current.workflow?.cursor, 'stopped', 'the fresh final stop decision must complete the workflow without mutation')
  assert.equal(current.installation, undefined, 'the no-install live acceptance must not create an installation receipt')
  const finalText = transcript.turns.at(-1)?.assistant ?? ''
  assert.doesNotMatch(finalText, /恢复.*工作流|改主意.*装|下次直接.*(?:用|装)/u)
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
