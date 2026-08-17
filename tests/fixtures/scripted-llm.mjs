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

// full-flow / partial-flow review this repo. Live marketplace ranking is marketplace-flow.
export const E2E_CALCULATOR_REPOSITORY = 'omdsh-dev/dsh-tool-calculator'

export function targetRepository() {
  return E2E_CALCULATOR_REPOSITORY
}

const E2E_TASKS = {
  'resolve-local': 'Resolve a capability that is already local and report the decision.',
  'adversarial-define': 'Resolve a capability that is already local and report the decision.',
  'marketplace-flow': 'Bootstrap the DSH plugin marketplace and resolve an existing Grok Build capability.',
  'full-flow': 'Exercise the approved capability reuse workflow and report only after cleanup.',
  'partial-flow': 'Exercise the approved capability reuse workflow and report only after cleanup.',
}

function viewResolution(value) {
  return value?.resolution ?? value
}

function viewWorkflowId(value) {
  return value?.workflow?.id
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
    if (this.config.scenario === 'calculator-child') {
      if (pairs.length === 0) {
        return { kind: 'tool', name: 'calculator', arguments: { expression: this.config.expression ?? '6 * 7' } }
      }
      const last = pairs.at(-1)
      const resultText = JSON.stringify(last?.result)
      const expectedResult = String(this.config.expectedResult ?? '')
      return last?.isError || (expectedResult && !resultText.includes(expectedResult))
        ? { kind: 'text', text: 'E2E_CALCULATOR_ERROR' }
        : { kind: 'text', text: `E2E_CALCULATOR_OK ${resultText}` }
    }

    if (this.config.scenario === 'resolve-local') {
      if (pairs.length === 0) {
        return { kind: 'tool', name: 'capability_workflow', arguments: { requirement: 'run a PowerShell command' } }
      }
      return { kind: 'text', text: `E2E_RESOLVE_LOCAL_OK ${JSON.stringify(pairs.at(-1)?.result)}` }
    }

    if (this.config.scenario === 'adversarial-define') return this.adversarialDefine(pairs)
    if (this.config.scenario === 'marketplace-flow') return this.marketplaceFlow(pairs)

    if (this.config.scenario === 'full-flow') return this.fullFlow(pairs)
    if (this.config.scenario === 'partial-flow') return this.partialFlow(pairs)
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
      return { kind: 'tool', name: 'capability_workflow', arguments: { requirement: 'run a PowerShell command' } }
    }

    const resolution = viewResolution(pairs.at(-1)?.result)
    return resolution?.decision === 'use_local'
      ? { kind: 'text', text: `E2E_ADVERSARIAL_DEFINE_OK guard-denied-before-resolve ${JSON.stringify(pairs[0].result)} local=${JSON.stringify(resolution)}` }
      : { kind: 'text', text: `E2E_ADVERSARIAL_DEFINE_ERROR expected use_local ${JSON.stringify(resolution)}` }
  }

  marketplaceFlow(pairs) {
    if (pairs.length === 0) {
      return {
        kind: 'tool',
        name: 'capability_workflow',
        arguments: { requirement: '在 DSH 会话中调用 xAI Grok Build 的能力' },
      }
    }
    const last = pairs.at(-1)
    if (last?.isError) {
      return { kind: 'text', text: `E2E_MARKETPLACE_FLOW_ERROR ${JSON.stringify(last.result)}` }
    }
    const resolution = viewResolution(last?.result)
    const repositories = resolution?.remoteCandidates?.map((candidate) => candidate.repository) ?? []
    const passed = resolution?.remoteCandidateSource === 'dsh-find-plugin'
      && resolution?.authorization?.state === 'selection_required'
      && resolution?.remoteDiscoveryComplete === true
      && resolution?.queries?.some((query) => query.includes('grok build'))
      && repositories.some((repository) => /dsh-(?:grok|xai|oauth)/iu.test(repository))
      && !repositories.includes('edison7009/EchoBird')
      && resolution?.reasons?.some((reason) => reason.includes('hot-loaded') || reason.includes('热加载'))
    return passed
      ? { kind: 'text', text: `E2E_MARKETPLACE_FLOW_OK ${JSON.stringify({ repositories, queries: resolution.queries })}` }
      : { kind: 'text', text: `E2E_MARKETPLACE_FLOW_ERROR ${JSON.stringify(resolution)}` }
  }

  fullFlow(pairs) {
    const userMessage = E2E_TASKS['full-flow']
    if (pairs.length === 0) {
      return { kind: 'tool', name: 'capability_workflow', arguments: { requirement: 'calculator' } }
    }
    if (pairs.some((pair) => pair.isError)) {
      return { kind: 'text', text: `E2E_FULL_FLOW_ERROR ${JSON.stringify(pairs.at(-1)?.result)}` }
    }
    if (pairs.length === 1) {
      const started = pairs[0].result
      const resolution = viewResolution(started)
      const repository = targetRepository()
      const discovered = resolution?.remoteCandidates?.some((candidate) => candidate.repository === repository)
      if (!discovered) {
        return {
          kind: 'text',
          text: `E2E_FULL_FLOW_ERROR target repository not discovered ${JSON.stringify({
            decision: resolution?.decision,
            authorization: resolution?.authorization,
            remoteCandidateSource: resolution?.remoteCandidateSource,
            remoteDiscoveryComplete: resolution?.remoteDiscoveryComplete,
            remoteCandidates: resolution?.remoteCandidates?.map((candidate) => candidate.repository),
            queries: resolution?.queries,
            reasons: resolution?.reasons,
          })}`,
        }
      }
      return {
        kind: 'tool',
        name: 'capability_workflow_resume',
        arguments: {
          workflow_id: viewWorkflowId(started),
          user_message: userMessage,
          option_id: 'inspect',
          repositories: [repository],
          ...(this.config.baseCommit ? { ref: this.config.baseCommit } : {}),
        },
      }
    }
    if (pairs.length === 2) {
      const reviewed = pairs[1].result
      const review = reviewed.review
      if (review?.fit !== 'full' || review?.recommendation !== 'use') {
        return { kind: 'text', text: `E2E_FULL_FLOW_ERROR unexpected review ${JSON.stringify(reviewed)}` }
      }
      return {
        kind: 'tool',
        name: 'capability_workflow_resume',
        arguments: {
          workflow_id: viewWorkflowId(reviewed),
          user_message: userMessage,
          option_id: 'use_this',
          review_id: review.id,
          target_profile: 'headless',
          retention: 'temporary',
          verification_task: 'Use the calculator tool to calculate 6 * 7 and answer with the result.',
          verification_expected_text: '42',
        },
      }
    }
    if (pairs.length === 3) {
      const installed = pairs[2].result.installation ?? pairs[2].result
      if (!installed.installed || !installed.loaded || !installed.verified) {
        return { kind: 'text', text: `E2E_FULL_FLOW_ERROR unverified install ${JSON.stringify(pairs[2].result)}` }
      }
      return {
        kind: 'tool',
        name: 'plugin_remove',
        arguments: { installation_id: installed.id },
      }
    }
    const removal = pairs[3].result
    return removal.removed
      ? { kind: 'text', text: 'E2E_FULL_FLOW_OK search review install tool-call tool-result task-result cleanup' }
      : { kind: 'text', text: `E2E_FULL_FLOW_ERROR cleanup ${JSON.stringify(removal)}` }
  }

  partialFlow(pairs) {
    const userMessage = E2E_TASKS['partial-flow']
    if (pairs.length === 0) {
      return { kind: 'tool', name: 'capability_workflow', arguments: { requirement: 'scientific notation calculator' } }
    }
    if (pairs.some((pair) => pair.isError)) {
      return { kind: 'text', text: `E2E_PARTIAL_FLOW_ERROR ${JSON.stringify(pairs.at(-1)?.result)}` }
    }
    if (pairs.length === 1) {
      const started = pairs[0].result
      const resolution = viewResolution(started)
      const repository = targetRepository()
      const discovered = resolution?.remoteCandidates?.some((candidate) => candidate.repository === repository)
      if (!discovered) {
        return {
          kind: 'text',
          text: `E2E_PARTIAL_FLOW_ERROR target repository not discovered ${JSON.stringify({
            decision: resolution?.decision,
            authorization: resolution?.authorization,
            remoteCandidateSource: resolution?.remoteCandidateSource,
            remoteDiscoveryComplete: resolution?.remoteDiscoveryComplete,
            remoteCandidates: resolution?.remoteCandidates?.map((candidate) => candidate.repository),
            queries: resolution?.queries,
            reasons: resolution?.reasons,
          })}`,
        }
      }
      return {
        kind: 'tool',
        name: 'capability_workflow_resume',
        arguments: {
          workflow_id: viewWorkflowId(started),
          user_message: userMessage,
          option_id: 'inspect',
          repositories: [repository],
          ...(this.config.baseCommit ? { ref: this.config.baseCommit } : {}),
        },
      }
    }
    if (pairs.length === 2) {
      const reviewed = pairs[1].result
      const review = reviewed.review
      if (review?.fit !== 'partial' || review?.recommendation !== 'modify') {
        return { kind: 'text', text: `E2E_PARTIAL_FLOW_ERROR expected partial review ${JSON.stringify(reviewed)}` }
      }
      return {
        kind: 'tool',
        name: 'capability_workflow_resume',
        arguments: {
          workflow_id: viewWorkflowId(reviewed),
          user_message: userMessage,
          option_id: 'modify_this',
          review_id: review.id,
        },
      }
    }
    if (pairs.length === 3) {
      const decided = pairs[2].result
      if (decided?.resolution?.authorization?.state !== 'modify_review' && decided?.workflow?.cursor !== 'await_modify_work') {
        return { kind: 'text', text: `E2E_PARTIAL_FLOW_ERROR expected modify work ${JSON.stringify(decided)}` }
      }
      return {
        kind: 'tool',
        name: 'capability_workflow_resume',
        arguments: {
          workflow_id: viewWorkflowId(decided),
          user_message: userMessage,
          option_id: 'resume_modify',
          path: this.config.localPath,
        },
      }
    }
    if (pairs.length === 4) {
      const local = pairs[3].result
      const localReview = local.review
      if (localReview?.fit !== 'full' || localReview?.recommendation !== 'use') {
        return { kind: 'text', text: `E2E_PARTIAL_FLOW_ERROR local review ${JSON.stringify(local)}` }
      }
      return {
        kind: 'tool',
        name: 'capability_workflow_resume',
        arguments: {
          workflow_id: viewWorkflowId(local),
          user_message: userMessage,
          option_id: 'use_this',
          review_id: localReview.id,
          target_profile: 'headless',
          retention: 'temporary',
          verification_task: 'Use calculator to calculate 1e3 + 2 and answer with the result.',
          verification_expected_text: '1002',
        },
      }
    }
    if (pairs.length === 5) {
      const installation = pairs[4].result.installation ?? pairs[4].result
      if (!installation.verified || installation.contributionAdvice?.eligible !== true
        || !installation.installSpec?.startsWith('file:') || installation.installSpec.startsWith('link:')
        || !/^[a-f0-9]{64}$/u.test(installation.artifactSha256 ?? '')) {
        return { kind: 'text', text: `E2E_PARTIAL_FLOW_ERROR verification or contribution ${JSON.stringify(pairs[4].result)}` }
      }
      return { kind: 'tool', name: 'plugin_remove', arguments: { installation_id: installation.id } }
    }
    const removal = pairs[5].result
    return removal.removed
      ? { kind: 'text', text: 'E2E_PARTIAL_FLOW_OK partial modify re-review install scientific-notation verify cleanup suggest-pr-with-approval' }
      : { kind: 'text', text: `E2E_PARTIAL_FLOW_ERROR cleanup ${JSON.stringify(removal)}` }
  }
}

export function apply(ctx, config = {}) {
  ctx.llm.registerAdapter(['capability-evolution-scripted'], new ScriptedAdapter(config))
}
