import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const projectRoot = path.resolve(import.meta.dirname, '..')

function skip(reason) {
  process.stdout.write(`${JSON.stringify({ status: 'skipped', reason })}\n`)
  process.exit(0)
}

let Context
let Loader
try {
  ;({ Context } = await import('@deepseek-ai/cordis'))
  Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
} catch (error) {
  skip(`live-only Loader/Cordis dependency unavailable: ${error instanceof Error ? error.message : String(error)}`)
}

const blankHome = await mkdtemp(path.join(os.tmpdir(), 'autoevo-packaged-blank-'))
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
        ? {
            config: {
              dshHome: path.join(blankHome, 'dsh'),
              stateDir: path.join(blankHome, 'state'),
              evolutionPreset: true,
            },
          }
        : {}),
    })
  }
  await root.loader.await()

  // Allow async preset materialization to settle without touching the user profile.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const { access } = await import('node:fs/promises')
      await access(path.join(blankHome, 'dsh', '.agent-presets', 'evolution', 'preset.yml'))
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(
    path.join(blankHome, 'dsh', '.agent-presets', 'evolution', '.autoevo-preset.json'),
    'utf8',
  ))
  assert.equal(manifest.templateVersion, '5')

  const expected = ['capability_workflow', 'capability_workflow_resume', 'plugin_remove']
  const registered = root.tools.schemas().map((tool) => tool.name).sort()
  assert.deepEqual(registered, expected)

  const resume = root.tools.schemas().find((tool) => tool.name === 'capability_workflow_resume')
  assert.ok(resume)
  const resumeParams = resume.parameters ?? {}
  const resumeProps = resumeParams.properties ?? resumeParams
  const resumeKeys = Object.keys(resumeProps).sort()
  assert.deepEqual(resumeKeys, ['interrupt_id', 'workflow_id'])
  if (Array.isArray(resumeParams.required)) {
    assert.deepEqual([...resumeParams.required].sort(), ['interrupt_id', 'workflow_id'])
  }

  // Exercise real Loader tool/call + tool/result contract for a denied/invalid resume without a live agent.
  let toolResult
  try {
    toolResult = await root.tools.execute({
      name: 'capability_workflow_resume',
      arguments: {
        workflow_id: `workflow_${'a'.repeat(24)}`,
        interrupt_id: `interrupt_${'b'.repeat(24)}`,
      },
    })
  } catch (error) {
    toolResult = { isError: true, error: { message: error instanceof Error ? error.message : String(error) } }
  }
  assert.equal(toolResult.isError, true)

  const policy = (await root.systemPrompt.assemble({ signal: AbortSignal.timeout(5_000) }))
    .sections.find((section) => section.name === 'autoevo:reuse-policy')
  assert.ok(policy)
  assert.match(policy.text, /interrupt_id/u)
  assert.match(policy.text, /workspace-write/u)
  assert.match(policy.text, /integrity-oriented partial isolation/u)
  assert.doesNotMatch(policy.text, /scratch_ready/u)

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    templateVersion: manifest.templateVersion,
    tools: registered,
    blankHome,
  })}\n`)
} finally {
  await root.fiber.dispose().catch(() => undefined)
  await rm(blankHome, { recursive: true, force: true })
}
