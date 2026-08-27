import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const projectRoot = path.resolve(import.meta.dirname, '..')
const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'capability-evolution-loader-'))
const root = new Context()
root.baseUrl = `${pathToFileURL(projectRoot).href}/`

try {
  await root.plugin(Loader)
  const entries = [
    ['system-prompt', import.meta.resolve('@deepseek-ai/dsh-system-prompt')],
    ['tools', import.meta.resolve('@deepseek-ai/dsh-tools')],
    ['skills', import.meta.resolve('@deepseek-ai/dsh-skill')],
    ['subprocess', import.meta.resolve('@deepseek-ai/dsh-subprocess')],
    ['autoevo', pathToFileURL(path.join(projectRoot, 'lib', 'index.js')).href],
  ]
  for (const [id, name] of entries) {
    await root.loader.create({
      id,
      name,
      ...(id === 'autoevo'
        ? { config: { dshHome: path.join(stateRoot, 'dsh'), stateDir: path.join(stateRoot, 'state') } }
        : {}),
    })
  }
  await root.loader.await()

  const expected = [
    'capability_adopt',
    'capability_rollback',
    'capability_updates',
    'capability_versions',
    'capability_workflow',
    'capability_workflow_diagnose',
    'capability_workflow_present',
    'capability_workflow_recover',
    'capability_workflow_refine',
    'capability_workflow_resume',
    'plugin_remove',
  ]
  const schemas = root.tools.schemas()
  const registered = schemas.map((tool) => tool.name).sort()
  assert.deepEqual(registered, expected)
  const startSchema = schemas.find((tool) => tool.name === 'capability_workflow')
  assert.ok(startSchema)
  assert.deepEqual(startSchema.parameters.required, ['requirement', 'intent'])
  assert.deepEqual(
    startSchema.parameters.properties.intent.required,
    ['operation', 'required_surface'],
  )
  assert.deepEqual(
    startSchema.parameters.properties.intent.properties.operation.enum,
    ['discover_or_reuse', 'reuse_existing', 'evolve_existing'],
  )
  const resumeSchema = schemas.find((tool) => tool.name === 'capability_workflow_resume')
  assert.ok(resumeSchema)
  assert.equal(resumeSchema.parameters.properties.decision.additionalProperties, false)
  assert.deepEqual(resumeSchema.parameters.properties.decision.required, ['action'])
  assert.deepEqual(
    resumeSchema.parameters.properties.decision.properties.action.enum,
    ['use_this', 'modify_this', 'create_new', 'stop'],
  )
  assert.equal(resumeSchema.parameters.properties.decision.properties.retention, undefined)
  assert.ok(resumeSchema.parameters.properties.navigation.properties.kind.enum.includes('clarify_requirement'))
  const assembly = await root.systemPrompt.assemble({ signal: AbortSignal.timeout(5_000) })
  assert.deepEqual(assembly.tools.map((tool) => tool.name).sort(), expected)
  const policy = assembly.sections.find((section) => section.name === 'autoevo:reuse-policy')
  assert.ok(policy)
  assert.match(policy.text, /runtime Policy V11/u)
  assert.match(policy.text, /authoritative original requirement/u)
  assert.match(policy.text, /zero candidates is a valid result/u)
  assert.match(policy.text, /fresh top-level user message/u)
  assert.match(policy.text, /Public decisions never accept retention/u)
  assert.match(policy.text, /ordinary subagent, agent, workflow, or model delegation/u)
  assert.match(policy.text, /Claim verified only from a Host tool-roundtrip pass/u)
  assert.match(policy.text, /Pre-V11 unfinished workflows/u)
  assert.doesNotMatch(policy.text, /runtime Policy V7/u)
  assert.doesNotMatch(policy.text, /independent semantic verifier/u)
  assert.doesNotMatch(policy.text, /next_step|agent_directive|await_confirmation|workspace-write/u)
  assert.doesNotMatch(policy.text, /replaces the shipped cordis-plugin-development/u)

  const recoverSchema = schemas.find((tool) => tool.name === 'capability_workflow_recover')
  assert.ok(recoverSchema)
  assert.notEqual(recoverSchema.parameters.properties.interrupt_id.required, true)
  assert.ok(!Array.isArray(recoverSchema.parameters.required) || !recoverSchema.parameters.required.includes('interrupt_id'))
  assert.match(recoverSchema.description, /Two legal modes/u)
  assert.match(recoverSchema.description, /omit interrupt_id/u)
  assert.match(recoverSchema.description, /sealed recovery interrupt/u)

  const packed = await import(pathToFileURL(path.join(projectRoot, 'lib', 'index.js')).href)
  assert.equal(packed.POLICY_VERSION, '11')
  assert.deepEqual([...packed.VERIFICATION_LAYER_KINDS], ['bundle_activation', 'tool_roundtrip', 'manual_runtime'])
  assert.equal(packed.classifyRuntimeSurface({
    llmDependency: false,
    llmRegistered: false,
    credentialsDependency: false,
    credentialsRegistered: false,
    networkSignal: false,
    environmentSignal: false,
    processSignal: false,
    skillOnly: false,
    unsafeTools: false,
    expectedTools: [],
    toolFixtures: [],
    kind: 'bundle',
  }), 'bundle_activation')
  assert.equal(packed.classifyRuntimeSurface({
    llmDependency: false,
    llmRegistered: false,
    credentialsDependency: false,
    credentialsRegistered: false,
    networkSignal: false,
    environmentSignal: false,
    processSignal: false,
    skillOnly: false,
    unsafeTools: false,
    expectedTools: ['calculator'],
    toolFixtures: [{ tool: 'calculator', available: true, safe: true, hostValidated: false }],
    kind: 'bundle',
  }), 'manual_runtime')
  assert.equal(packed.selectInstallVerificationLayer({
    review: {
      manifest: { expectedTools: ['calculator'] },
      runtimeSurface: {
        llmDependency: false,
        llmRegistered: false,
        credentialsDependency: false,
        credentialsRegistered: false,
        networkSignal: false,
        environmentSignal: false,
        processSignal: false,
        skillOnly: false,
        unsafeTools: false,
        expectedTools: ['calculator'],
        toolFixtures: [{ tool: 'calculator', available: true, safe: true, hostValidated: false }],
        kind: 'bundle',
        verificationLayer: 'manual_runtime',
      },
    },
    declaredFixtures: { calculator: { safe: true } },
  }).layer, 'manual_runtime')

  const { readdir, readFile, access } = await import('node:fs/promises')
  const presetsRoot = path.join(stateRoot, 'dsh', '.agent-presets', 'evolution')
  // Materialization is async on apply; give it a short window in this smoke test.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(path.join(presetsRoot, 'preset.yml'))
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const presetBody = await readFile(path.join(presetsRoot, 'preset.yml'), 'utf8')
  assert.match(presetBody, /能力进化/u)
  const composition = await readFile(path.join(presetsRoot, 'agent.cordis.yml'), 'utf8')
  assert.match(composition, /Policy V11 Search-first workflow/u)
  assert.match(composition, /disabled: true/u)
  const managed = await readdir(presetsRoot)
  assert.ok(managed.includes('agent.cordis.yml'))
  assert.ok(managed.includes('.autoevo-preset.json'))

  process.stdout.write(`${JSON.stringify({
    loader: '@deepseek-ai/cordis-plugin-loader@1.0.2',
    tools: registered,
    policySection: policy.name,
    policyVersion: packed.POLICY_VERSION,
  })}\n`)
} finally {
  await root.fiber.dispose()
  await rm(stateRoot, { recursive: true, force: true })
}
