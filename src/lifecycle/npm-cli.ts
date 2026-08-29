import { access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { EvolutionError } from '../errors.js'
import type { CommandRunner } from '../process/runner.js'

export function shellForwardedFileSpec(filename: string): string {
  const absolute = path.resolve(filename)
  // DSH rc.6 forwards plugin arguments to pnpm through cmd.exe on Windows.
  // Keep the owned package path out of that second parser's metacharacter surface.
  // The path is plugin-owned, but an unsafe configured parent path must still
  // fail closed rather than become shell syntax downstream.
  if (/[\u0000-\u001f"&|<>^()%!]/u.test(absolute)) {
    throw new EvolutionError('unsafe_path', 'The owned package path contains characters unsafe for DSH plugin forwarding')
  }
  return `file:${absolute.replaceAll('\\', '/')}`
}

export async function npmPackArgv(runner: CommandRunner, signal?: AbortSignal): Promise<[string, ...string[]]> {
  const adjacent = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  try {
    await access(adjacent)
    return [process.execPath, await realpath(adjacent)]
  } catch {
    // Fall through to the npm shim installed alongside the DSH runtime.
  }
  if (!runner.resolveExecutable) return ['npm']
  const shim = await runner.resolveExecutable('npm', signal)
  if (!/\.(?:cmd|ps1)$/iu.test(shim)) return [shim]
  const directory = path.dirname(shim)
  const candidates = [
    path.resolve(directory, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(directory, '../../node/node_modules/npm/bin/npm-cli.js'),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return [process.execPath, await realpath(candidate)]
    } catch {
      // Try the next standard npm shim layout.
    }
  }
  throw new EvolutionError('command_failed', 'npm resolved to a Windows shim, but its JavaScript CLI could not be located safely')
}
