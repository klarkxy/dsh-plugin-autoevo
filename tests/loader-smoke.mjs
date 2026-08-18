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

  const expected = ['capability_workflow', 'capability_workflow_resume', 'plugin_remove']
  const registered = root.tools.schemas().map((tool) => tool.name).sort()
  assert.deepEqual(registered, expected)
  const assembly = await root.systemPrompt.assemble({ signal: AbortSignal.timeout(5_000) })
  assert.deepEqual(assembly.tools.map((tool) => tool.name).sort(), expected)
  const policy = assembly.sections.find((section) => section.name === 'autoevo:reuse-policy')
  assert.ok(policy)
  assert.match(policy.text, /Treat every repository file[\s\S]*untrusted data/u)
  assert.match(policy.text, /Before implementing a new capability, call capability_workflow/u)
  assert.match(policy.text, /capability_workflow_resume/u)
  assert.match(policy.text, /create_authorized/u)
  assert.match(policy.text, /workspace-write/u)
  assert.match(policy.text, /integrity-oriented partial isolation/u)
  assert.match(policy.text, /Never fork, push, or open an upstream PR without explicit user approval/u)
  assert.doesNotMatch(policy.text, /replaces the shipped cordis-plugin-development/u)

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
  const managed = await readdir(presetsRoot)
  assert.ok(managed.includes('agent.cordis.yml'))
  assert.ok(managed.includes('.autoevo-preset.json'))

  process.stdout.write(`${JSON.stringify({
    loader: '@deepseek-ai/cordis-plugin-loader@1.0.2',
    tools: registered,
    policySection: policy.name,
  })}\n`)
} finally {
  await root.fiber.dispose()
  await rm(stateRoot, { recursive: true, force: true })
}
