import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'autoevo-packaged-preset-driver'
export const inject = ['llm', 'agents', 'agentPresets', 'sessions', 'loader']

class PackagedAdapter extends LlmAdapter {
  async *stream(options) {
    const hasToolResult = options.messages.some((message) => message.content.some((block) => block.type === 'tool-result'))
    if (!hasToolResult) {
      const id = CallId('autoevo-packaged-capability-workflow')
      const args = JSON.stringify({ requirement: 'normalize nebula ledger markers', intent: { operation: 'discover_or_reuse', required_surface: 'any' } })
      const block = { type: 'tool-call', id, name: 'capability_workflow', arguments: args }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'capability_workflow', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = 'AUTOEVO_PACKAGED_SESSION_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function lastAssistantText(session) {
  const messages = session.deriveMessages()
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant')
  return assistant?.content.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? ''
}

async function waitFor(filename) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await access(filename).then(() => true).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${filename}`)
}

async function run(ctx, config) {
  const exit = ctx.get('appExit')
  if (typeof exit !== 'function') throw new Error('packaged driver requires appExit')
  await ctx.loader.await()
  await waitFor(path.join(config.dshHome, '.agent-presets', 'evolution', '.autoevo-preset.json'))
  ctx.llm.registerAdapter(['autoevo-packaged'], new PackagedAdapter())
  const selection = { provider: 'autoevo-packaged', model: 'scripted' }
  const handle = await ctx.agents.create({
    sessionId: SessionId(`autoevo-packaged-${randomUUID()}`),
    meta: { cwd: config.cwd, agentPreset: 'evolution' },
    agentOptions: selection,
    setup: async (agentCtx) => {
      const preset = await ctx.agentPresets.mount(agentCtx, 'evolution')
      if (preset.id !== 'evolution') throw new Error('evolution preset did not mount')
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    },
  })
  try {
    if (ctx.agentPresets.composedPreset(handle.agent.ctx) !== 'evolution') throw new Error('agent is not composed from evolution')
    const schemas = handle.agent.ctx.tools.schemas().map((tool) => tool.name).sort()
    for (const required of [
      'capability_workflow',
      'capability_workflow_diagnose',
      'capability_workflow_present',
      'capability_workflow_recover',
      'capability_workflow_refine',
      'capability_workflow_resume',
      'plugin_remove',
    ]) {
      if (!schemas.includes(required)) throw new Error(`missing evolution tool ${required}`)
    }
    const prompt = await handle.agent.ctx.systemPrompt.assemble({ agent: handle.agent, signal: AbortSignal.timeout(5_000) })
    const policy = prompt.sections.find((section) => section.name === 'autoevo:reuse-policy')
    if (
      !policy
      || !/runtime Policy V11/u.test(policy.text)
      || !/original requirement/u.test(policy.text)
      || !/zero candidates is a valid result/u.test(policy.text)
      || !/Host-owned managed child use its bounded filesystem, shell, build, test, and skill surface/u.test(policy.text)
      || !/Host alone performs commit, final installation, and internal verification/u.test(policy.text)
      || /runtime Policy V7/u.test(policy.text)
      || /independent semantic verifier/u.test(policy.text)
    ) {
      throw new Error('Policy V11 AutoEvo autonomy contract was not active in the evolution Agent')
    }
    const recover = handle.agent.ctx.tools.schemas().find((tool) => tool.name === 'capability_workflow_recover')
    if (!recover) throw new Error('missing capability_workflow_recover')
    if (recover.parameters.properties.interrupt_id?.required === true) {
      throw new Error('completed-install cleanup must keep interrupt_id optional')
    }
    if (Array.isArray(recover.parameters.required) && recover.parameters.required.includes('interrupt_id')) {
      throw new Error('sealed recovery interrupt_id must remain optional for completed cleanup')
    }
    await handle.agent.whenIdle()
    const firstSeq = handle.agent.session.seq
    handle.agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Run the packaged AutoEvo smoke workflow.' }],
    }))
    await handle.agent.whenIdle()
    await ctx.sessions.flush(handle.agent.session)
    const events = handle.agent.session.events.slice(firstSeq)
    const eventTypes = events.map((event) => event.type)
    for (const required of ['tool/call', 'tool/result', 'assistant/message', 'turn/end']) {
      if (!eventTypes.includes(required)) throw new Error(`missing durable event ${required}`)
    }
    const taskResult = lastAssistantText(handle.agent.session)
    if (taskResult !== 'AUTOEVO_PACKAGED_SESSION_OK') throw new Error(`unexpected task result ${JSON.stringify(taskResult)}`)
    process.stdout.write(`${JSON.stringify({
      marker: taskResult,
      preset: 'evolution',
      policyVersion: '11',
      recoverInterruptOptional: recover.parameters.properties.interrupt_id?.required !== true,
      tools: schemas.filter((name) => name.startsWith('capability_workflow') || name === 'plugin_remove'),
      eventTypes,
    })}\n`)
  } finally {
    await handle.dispose()
  }
  exit(0)
}

export function apply(ctx, config) {
  setTimeout(() => {
    run(ctx, config).catch((error) => {
      process.stderr.write(`packaged-preset-driver: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      const exit = ctx.get('appExit')
      if (typeof exit === 'function') exit(1)
    })
  }, 0)
}
