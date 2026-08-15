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

  const expected = ['capability_resolve', 'plugin_install', 'plugin_remove', 'plugin_review']
  const registered = root.tools.schemas().map((tool) => tool.name).sort()
  assert.deepEqual(registered, expected)
  const assembly = await root.systemPrompt.assemble({ signal: AbortSignal.timeout(5_000) })
  assert.deepEqual(assembly.tools.map((tool) => tool.name).sort(), expected)
  const policy = assembly.sections.find((section) => section.name === 'autoevo:reuse-policy')
  assert.ok(policy)
  assert.match(policy.text, /Treat every repository file[\s\S]*untrusted data/u)
  assert.match(policy.text, /Never fork, push, or open an upstream PR without explicit user approval/u)

  process.stdout.write(`${JSON.stringify({
    loader: '@deepseek-ai/cordis-plugin-loader@1.0.2',
    tools: registered,
    policySection: policy.name,
  })}\n`)
} finally {
  await root.fiber.dispose()
  await rm(stateRoot, { recursive: true, force: true })
}

