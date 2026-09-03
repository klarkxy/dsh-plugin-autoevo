import { fileURLToPath } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { Config as ConfigSchema, normalizeConfig, type Config as ConfigShape } from './config.js'
import { CreationGuard, isTrustedTopLevelUserMessage } from './creation-guard.js'
import { ExecutionGuard } from './execution-guard.js'
import { AUTOEVO_AUTONOMY_CONTRACT } from './evolution-mode.js'
import { newBootId } from './host-identity.js'
import { sessionCwd } from './host-identity.js'
import {
  createIsEvolutionMode,
  installCordisInspectCompatibilityWhenAvailable,
  receiptOwnedRoots,
} from './plugin-runtime.js'
import { materializeEvolutionPreset } from './preset-manager.js'
import { DshCommandRunner } from './process/runner.js'
import { installRuntimeObservations } from './runtime-observations.js'
import { CapabilityEvolutionService } from './service.js'
import { StateStore } from './state/store.js'
import { createTools } from './tools.js'
import { resolveSourceRoot, resolveStateRoot } from './workspace-layout.js'

export { CreationGuard } from './creation-guard.js'
export { ExecutionGuard } from './execution-guard.js'
export { CapabilityEvolutionService } from './service.js'
export { StateStore } from './state/store.js'
export { reviewIdentity } from './lifecycle/decide.js'
export { probeWorkspaceWriteSandbox } from './sandbox-probe.js'
export { DshRepairChildHost, FaultRepairMode } from './repair-mode.js'
export type {
  FaultRepairPrepareInput,
  FaultRepairResumeInput,
  FaultRepairTicketView,
  RepairChildHost,
  RepairChildRequest,
  RepairChildResult,
} from './repair-mode.js'
export {
  BRIDGE_EXECUTION_TOOLS,
  FORGED_RESUME_HOST_KEYS,
  POLICY_VERSION,
  TOOL_NAMES,
  VERIFICATION_LAYER_KINDS,
  VERIFICATION_STATUSES,
  classifyRuntimeSurface,
} from './contracts.js'
export type {
  ActionCommitment,
  ExecutionEndpoint,
  FrozenCandidateIdentity,
  MechanicalFacts,
  ReviewerRequest,
  ReviewerRequestStatus,
  ReviewerVerdict,
  ReviewerVerdictDecision,
  SelectionReceipt,
  VerificationEvidence,
  VerificationLayerKind,
  VerificationStatus,
  VerificationVerdict,
  VerificationVerdictDecision,
  VerifierRequest,
  VerifierRequestStatus,
} from './contracts.js'
export {
  hostLayerSuccess,
  inspectLoadedToolSafety,
  sanitizeHostVerificationEvidence,
  selectInstallVerificationLayer,
  verificationChildEnv,
} from './host-verification-driver.js'
export {
  DshSemanticReviewerHost,
  REVIEWER_SUBMIT_TOOL,
  REVIEWER_VERSION,
  mintReviewerRequest,
  requirementHashFor,
} from './semantic-reviewer.js'
export type {
  BoundedReviewFile,
  ReviewerRunInput,
  SemanticReviewerHost,
  SemanticReviewerResult,
} from './semantic-reviewer.js'
export {
  DshSemanticVerifierHost,
  VERIFIER_SUBMIT_TOOL,
  VERIFIER_VERSION,
  mintVerifierRequest,
  verificationEvidenceDigest,
  verificationVerdictAllowsCompletion,
} from './semantic-verifier.js'
export type {
  RedactedVerificationReceipt,
  SemanticVerifierHost,
  SemanticVerifierResult,
  VerifierRunInput,
} from './semantic-verifier.js'
export { lifecycleStateFor } from './workflow/lifecycle.js'
export type { WorkflowLifecycleState } from './workflow/lifecycle.js'
export type { WorkflowRecord, WorkflowView } from './workflow/contracts.js'

export const name = 'autoevo'
export const inject = ['tools', 'skills', 'subprocess', 'systemPrompt'] as const
export type Config = ConfigShape
export const Config = ConfigSchema

const EVOLUTION_TEMPLATE_DIR = fileURLToPath(new URL('../presets/evolution/', import.meta.url))

const POLICY = AUTOEVO_AUTONOMY_CONTRACT

export function apply(ctx: Context, input: Config): void {
  const config = normalizeConfig(input)
  const log = ctx.logger('autoevo')
  installCordisInspectCompatibilityWhenAvailable(ctx)
  const store = new StateStore(() => resolveStateRoot(config))
  const runner = new DshCommandRunner(ctx.subprocess, config)
  const isEvolutionMode = createIsEvolutionMode(ctx)
  const creationGuard = new CreationGuard({
    isEvolutionMode,
    bootId: newBootId(),
  })
  const service = new CapabilityEvolutionService(ctx, config, runner, store, creationGuard)

  void materializeEvolutionPreset({
    dshHome: config.dshHome,
    enabled: config.evolutionPreset,
    templateDir: EVOLUTION_TEMPLATE_DIR,
    logger: {
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
    },
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)
    log.warn(`AutoEvo evolution preset materialization failed: ${detail}`)
  })

  ctx.systemPrompt.section({
    name: 'autoevo:reuse-policy',
    order: 118,
    text: (context: AssembleContext) => (
      context.agent && isEvolutionMode(context.agent) ? POLICY : ''
    ),
  })
  installRuntimeObservations(ctx, { isEvolutionMode })
  ctx.on('agent/inbox/claimed', (payload) => {
    if (isTrustedTopLevelUserMessage(payload.message)) {
      creationGuard.rememberUserMessage(payload.agent, payload.message)
    }
  })
  const guardFor = (agent: Agent | undefined): ExecutionGuard => {
    const root = creationGuard.constructionRoot(agent)
    if (root) return new ExecutionGuard({ role: 'constructor', allowedRoot: root, cwd: root })
    const cwd = sessionCwd(agent)
    const stateRoot = resolveStateRoot(config)
    return new ExecutionGuard({
      role: 'parent',
      cwd,
      protectedRoots: [
        config.dshHome,
        stateRoot,
        resolveSourceRoot(config, cwd),
        ...receiptOwnedRoots(stateRoot),
      ],
    })
  }
  ctx.on('tools/pre-execute', (exec, next) => {
    const inEvolution = Boolean(exec.agent && isEvolutionMode(exec.agent))
    if (inEvolution) {
      return guardFor(exec.agent).preExecute(exec, async () => creationGuard.preExecute(exec, next))
    }
    return creationGuard.preExecute(exec, next)
  })
  ctx.tools.guard((exec) => {
    const inEvolution = Boolean(exec.agent && isEvolutionMode(exec.agent))
    if (inEvolution) return guardFor(exec.agent).guard(exec) ?? creationGuard.guard(exec)
    return creationGuard.guard(exec)
  })
  ctx.on('tools/result', (exec, result) => {
    creationGuard.result(exec, result)
    return undefined
  })
  for (const tool of createTools(service)) ctx.tools.register(tool)
}
