import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'capability-evolution-scripted-llm'
export const inject = ['llm']

function resultPairs(messages) {
  const calls = new Map()
  const pairs = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-call') {
        calls.set(block.id, { name: block.name, arguments: block.arguments })
      } else if (block.type === 'tool-result') {
        const call = calls.get(block.toolCallId)
        const text = block.content.find((item) => item.type === 'text')?.text ?? ''
        let value
        try {
          value = JSON.parse(text)
        } catch {
          value = text
        }
        pairs.push({ call, result: value, isError: block.isError === true })
      }
    }
  }
  return pairs
}

const E2E_TASKS = {
  'resolve-local': 'Resolve a capability that is already local and report the decision.',
  'adversarial-define': 'Resolve a capability that is already local and report the decision.',
  'marketplace-flow': 'Bootstrap the DSH plugin marketplace and resolve an existing Grok Build capability.',
}

function viewCard(value) {
  return value?.schema_version === 2 ? value : undefined
}

function firstCandidate(card) {
  return card?.facts?.candidates?.[0]
}

class ScriptedAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = config
  }

  async *stream(options) {
    const pairs = resultPairs(options.messages)
    const next = this.nextAction(pairs)
    if (next.kind === 'tool') {
      const id = CallId(`scripted-${pairs.length + 1}-${next.name}`)
      const rawArguments = JSON.stringify(next.arguments)
      const block = { type: 'tool-call', id, name: next.name, arguments: rawArguments }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: next.name, argumentsDelta: rawArguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: next.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: next.text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  nextAction(pairs) {
    if (this.config.scenario === 'resolve-local') {
      if (pairs.length === 0) {
        return { kind: 'tool', name: 'capability_workflow', arguments: { requirement: 'run a PowerShell command', intent: { operation: 'discover_or_reuse', required_surface: 'any' } } }
      }
      const card = viewCard(pairs.at(-1)?.result)
      if (card?.state === 'discovering' && firstCandidate(card)) {
        return {
          kind: 'tool',
          name: 'capability_workflow_present',
          arguments: { workflow_id: card.workflow_id, candidate_ids: [firstCandidate(card).candidate_id] },
        }
      }
      return card?.state === 'waiting_candidate_selection'
        ? { kind: 'text', text: `E2E_RESOLVE_LOCAL_OK ${JSON.stringify(card)}` }
        : { kind: 'text', text: `E2E_RESOLVE_LOCAL_ERROR ${JSON.stringify(card)}` }
    }

    if (this.config.scenario === 'adversarial-define') return this.adversarialDefine(pairs)
    if (this.config.scenario === 'marketplace-flow') return this.marketplaceFlow(pairs)

    return { kind: 'text', text: 'E2E_SCRIPTED_READY' }
  }

  adversarialDefine(pairs) {
    if (pairs.length === 0) {
      return {
        kind: 'tool',
        name: 'cordis_define',
        arguments: {
          plugin: {
            kind: 'new',
            name: 'adversarial-e2e-probe',
          },
        },
      }
    }

    if (pairs.length === 1) {
      const denial = pairs[0]
      const denialText = typeof denial.result === 'string' ? denial.result : JSON.stringify(denial.result)
      if (!denial.isError
        || !denialText.includes('AutoEvo denied new Cordis plugin creation: start or switch a blank/new session to the Capability Evolution (evolution) agent preset')
        || denialText.includes('UNKNOWN_TOOL')
        || denialText.includes('E2E_CORDIS_DEFINE_PROBE_EXECUTED')) {
        return { kind: 'text', text: `E2E_ADVERSARIAL_DEFINE_ERROR unexpected definition result ${denialText}` }
      }
      return { kind: 'tool', name: 'capability_workflow', arguments: { requirement: 'run a PowerShell command', intent: { operation: 'discover_or_reuse', required_surface: 'any' } } }
    }

    const card = viewCard(pairs.at(-1)?.result)
    if (card?.state === 'discovering' && firstCandidate(card)) {
      return {
        kind: 'tool',
        name: 'capability_workflow_present',
        arguments: { workflow_id: card.workflow_id, candidate_ids: [firstCandidate(card).candidate_id] },
      }
    }
    return card?.state === 'waiting_candidate_selection'
      ? { kind: 'text', text: `E2E_ADVERSARIAL_DEFINE_OK guard-denied-before-resolve ${JSON.stringify(pairs[0].result)} card=${JSON.stringify(card)}` }
      : { kind: 'text', text: `E2E_ADVERSARIAL_DEFINE_ERROR expected sealed Gate 1 ${JSON.stringify(card)}` }
  }

  marketplaceFlow(pairs) {
    if (pairs.length === 0) {
      return {
        kind: 'tool',
        name: 'capability_workflow',
        arguments: { requirement: '在 DSH 会话中调用 xAI Grok Build 的能力', intent: { operation: 'discover_or_reuse', required_surface: 'any' } },
      }
    }
    const last = pairs.at(-1)
    if (last?.isError) {
      return { kind: 'text', text: `E2E_MARKETPLACE_FLOW_ERROR ${JSON.stringify(last.result)}` }
    }
    const card = viewCard(last?.result)
    if (card?.state === 'discovering') {
      const candidates = card.facts?.candidates ?? []
      const preferred = candidates.find((candidate) => /dsh-(?:grok|xai|oauth)/iu.test(candidate.repository ?? ''))
      if (!preferred) return { kind: 'text', text: `E2E_MARKETPLACE_FLOW_ERROR no relevant candidate ${JSON.stringify(card)}` }
      return {
        kind: 'tool',
        name: 'capability_workflow_present',
        arguments: { workflow_id: card.workflow_id, candidate_ids: [preferred.candidate_id] },
      }
    }
    const repositories = card?.facts?.sealed_candidates?.map((candidate) => candidate.repository) ?? []
    const passed = card?.state === 'waiting_candidate_selection'
      && repositories.some((repository) => /dsh-(?:grok|xai|oauth)/iu.test(repository))
      && !repositories.includes('edison7009/EchoBird')
    return passed
      ? { kind: 'text', text: `E2E_MARKETPLACE_FLOW_OK ${JSON.stringify({ repositories, state: card.state })}` }
      : { kind: 'text', text: `E2E_MARKETPLACE_FLOW_ERROR ${JSON.stringify(card)}` }
  }

}

export function apply(ctx, config = {}) {
  ctx.llm.registerAdapter(['capability-evolution-scripted'], new ScriptedAdapter(config))
}
