import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { satisfies, valid } from 'semver'

export const HARNESS_DSH_VERSION = '0.1.1-rc.2'
export const SUPPORTED_DSH_RANGE = '>=0.1.0-rc.6 <0.2.0'

async function exists(target) {
  return await access(target).then(() => true).catch(() => false)
}

async function npmGlobalRoot() {
  const adjacent = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const attempts = []
  if (await exists(adjacent)) attempts.push([process.execPath, [adjacent, 'root', '-g'], false])
  attempts.push(['npm', ['root', '-g'], true])
  for (const [command, args, shell] of attempts) {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, shell })
    const root = result.stdout?.trim()
    if (result.status === 0 && root) return root
  }
  return undefined
}

function extraCandidateRoots() {
  const roots = []
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  if (process.platform === 'win32') {
    roots.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  } else {
    roots.push('/usr/local/lib/node_modules/@deepseek-ai/dsh')
  }
  return roots
}

const projectRoot = path.resolve(import.meta.dirname, '..', '..')

/**
 * Resolve the Host DSH CLI. This repo must not depend on `@deepseek-ai/dsh`,
 * or `npx @deepseek-ai/dsh` from the workspace shadows the real CLI.
 * CI may inject the package into node_modules for packaged/E2E tests.
 */
export async function resolveHostDsh() {
  const fromEnv = process.env.DSH_PACKAGE_ROOT?.trim()
  const candidates = []
  if (fromEnv) candidates.push(fromEnv)
  candidates.push(path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh'))
  const globalRoot = await npmGlobalRoot()
  if (globalRoot) candidates.push(path.join(globalRoot, '@deepseek-ai', 'dsh'))
  candidates.push(...extraCandidateRoots())

  for (const packageRoot of candidates) {
    const bin = path.join(packageRoot, 'lib', 'bin.js')
    const presets = path.join(packageRoot, 'config', 'agent-presets')
    if (await exists(bin) && await exists(presets)) {
      return { packageRoot, bin, presets }
    }
  }
  throw new Error('Host DSH (@deepseek-ai/dsh) not found. Install it globally or set DSH_PACKAGE_ROOT.')
}

export function hostDshVersion(bin) {
  const result = spawnSync(process.execPath, [bin, '-V'], { encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? result.stdout.trim() : ''
}

export function skipUnlessHarnessDsh(version) {
  const runtime = valid(version.trim())
  if (runtime && satisfies(runtime, SUPPORTED_DSH_RANGE, { includePrerelease: true })) return false
  if (process.env.CI) {
    throw new Error(`Host DSH ${version || '(unknown)'} is outside ${SUPPORTED_DSH_RANGE} (CI injects ${HARNESS_DSH_VERSION}).`)
  }
  process.stderr.write(`skip: Host DSH ${version || '(unknown)'} is outside ${SUPPORTED_DSH_RANGE}\n`)
  return true
}
