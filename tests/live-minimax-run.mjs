import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const projectRoot = path.resolve(import.meta.dirname, '..')
const modelId = process.argv[2] ?? 'minimax-m3'
const runIndex = Number(process.argv[3] ?? 0)
if (!/^[a-z0-9._-]{2,80}$/iu.test(modelId)) throw new Error(`invalid model id ${JSON.stringify(modelId)}`)
const runId = new Date().toISOString().replace(/[:.]/gu, '-')
const outDir = path.join('C:/tmp', `autoevo-live-flow-${modelId.replace(/[^a-z0-9._-]/giu, '-')}-${runIndex}-${runId}`)
const stateDir = path.join(outDir, 'state')
const realDshHome = path.join(os.homedir(), '.dsh')
const dshHome = path.join(outDir, 'dsh-home')
const autoevo = path.join(projectRoot, 'lib/index.js')
const evolutionMode = path.join(projectRoot, 'lib/evolution-mode.js')
const findPlugin = path.join(realDshHome, 'profiles/web/node_modules/dsh-find-plugin/lib/index.js')
const approval = path.join(projectRoot, 'tests/fixtures/approval-allow-once.mjs')
const driver = path.join(projectRoot, 'tests/live-minimax-driver.mjs')
const agentPresets = path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/lib/index.js')
const cordisHost = path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-cordis-host-runner/lib/index.js')

const credentials = parse(await readFile(path.join(realDshHome, '.credentials.yaml'), 'utf8'))
if (typeof credentials.NEW_API_API_KEY !== 'string' || credentials.NEW_API_API_KEY.length === 0) {
  throw new Error('NEW_API_API_KEY is missing from ~/.dsh/.credentials.yaml')
}

await mkdir(outDir, { recursive: true })
await mkdir(stateDir, { recursive: true })

const childModelPatch = path.join(outDir, 'child-model.cordis.yml')
await writeFile(childModelPatch, `${JSON.stringify([
  {
    id: 'llm-pi-ai',
    config: {
      providers: {
        'new-api': {
          displayName: 'New API',
          apiKeyEnv: 'NEW_API_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://newapi.klarkxy.xyz/v1',
          models: [{ id: modelId }],
        },
      },
    },
  },
  { id: 'agent-default-model', config: { provider: 'new-api', model: modelId } },
], null, 2)}\n`)

const patch = path.join(outDir, 'main.cordis.yml')
await writeFile(patch, `${JSON.stringify([
  {
    id: 'llm-pi-ai',
    config: {
      providers: {
        'new-api': {
          displayName: 'New API',
          apiKeyEnv: 'NEW_API_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://newapi.klarkxy.xyz/v1',
          models: [{ id: modelId }],
        },
      },
    },
  },
  { id: 'agent-default-model', config: { provider: 'new-api', model: modelId } },
  { id: 'headless-runner', disabled: true },
  {
    insert: [
      { id: 'cordis-host-runner', name: pathToFileURL(cordisHost).href },
      { id: 'agent-presets', name: pathToFileURL(agentPresets).href, config: { default: 'evolution' } },
      {
        id: 'autoevo',
        name: pathToFileURL(autoevo).href,
        config: {
          dshHome,
          stateDir,
          evolutionPreset: true,
          commandTimeoutMs: 180_000,
          forwardedCredentialEnv: ['NEW_API_API_KEY'],
          verificationPatchPaths: [childModelPatch],
        },
      },
      { id: 'autoevo-live-find-plugin', name: pathToFileURL(findPlugin).href },
      { id: 'autoevo-live-approval', name: pathToFileURL(approval).href },
      { id: 'autoevo-live-minimax-driver', name: pathToFileURL(driver).href },
    ],
  },
], null, 2)}\n`)

const dshBin = path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const child = spawn(process.execPath, [dshBin, '--profile', 'headless', '--patch', patch, 'live-autoevo'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    DSH_HOME: dshHome,
    NEW_API_API_KEY: credentials.NEW_API_API_KEY,
    AUTOEVO_LIVE_STATE_DIR: stateDir,
    AUTOEVO_LIVE_OUT_DIR: outDir,
    AUTOEVO_LIVE_EVOLUTION_MODE_URL: pathToFileURL(evolutionMode).href,
    AUTOEVO_LIVE_RUN_INDEX: String(runIndex),
    DSH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => process.stdout.write(chunk))
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

const code = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', resolve)
})
process.exit(code ?? 1)
