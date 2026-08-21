import path from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { RuntimeConfig } from '../config.js'
import { EvolutionError } from '../errors.js'
import { sha256 } from '../state/hashes.js'

const WINDOWS_CMD_SHIMS = new Set(['.cmd', '.bat'])

/** Node 24 refuses to spawn a .cmd/.bat without a shell (EINVAL). */
export function argvForResolvedExecutable(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): [string, ...string[]] {
  if (platform !== 'win32' || !WINDOWS_CMD_SHIMS.has(path.extname(executable).toLowerCase())) {
    return [executable, ...args]
  }
  if (path.basename(executable).toLowerCase() !== 'dsh.cmd') {
    throw new EvolutionError('command_failed', 'Refusing to shell-interpret an unsupported Windows command shim', {
      executable,
    })
  }
  // Node 24 refuses to spawn .cmd directly, while cmd.exe introduces a second
  // parser over user-controlled task text and file specs. npm/pnpm DSH shims
  // have two stable layouts; invoke the real JS entry with Node instead.
  const directory = path.dirname(executable)
  const dshBin = path.basename(directory).toLowerCase() === '.bin'
    ? path.resolve(directory, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : path.join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return [process.execPath, dshBin, ...args]
}

export interface CommandRequest {
  argv: readonly [string, ...string[]]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  allowFailure?: boolean
}

export interface CommandResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>
  resolveExecutable?(command: string, signal?: AbortSignal): Promise<string>
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function signalFailure(command: string, signal: AbortSignal): EvolutionError {
  const reasonName = signal.reason instanceof Error ? signal.reason.name : undefined
  const timedOut = reasonName === 'TimeoutError'
  return new EvolutionError(
    'command_failed',
    timedOut ? `${command} timed out` : `${command} was cancelled`,
    {
      command,
      cancelled: !timedOut,
      timedOut,
    },
  )
}

function throwIfCommandAborted(command: string, signal: AbortSignal): void {
  if (signal.aborted) throw signalFailure(command, signal)
}

function effectiveEnvironment(
  command: string,
  requested: NodeJS.ProcessEnv = {},
  parent: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...requested }
  // A completely scrubbed Windows environment is not sufficient to start
  // Node: without SystemRoot its CSPRNG initialization aborts before user code
  // runs (the DSH parent observes 0xC0000409 / exit 3221226505). Preserve only
  // the OS bootstrap variables needed by native Windows process startup. Do
  // not copy the ambient environment wholesale; credentials stay opt-in.
  if (platform === 'win32') {
    for (const name of ['SystemRoot', 'WINDIR']) {
      const lower = name.toLowerCase()
      const inherited = Object.entries(parent)
        .find(([key, value]) => key.toLowerCase() === lower && value !== undefined)?.[1]
      const requestedValue = Object.entries(env)
        .find(([key, value]) => key.toLowerCase() === lower && value !== undefined)?.[1]
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === lower) delete env[key]
      }
      const value = inherited ?? requestedValue
      if (value !== undefined) env[name] = value
    }
  }
  if (/^gh(?:\.exe)?$/iu.test(command)) {
    for (const name of ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST']) {
      if (env[name] === undefined && parent[name] !== undefined) env[name] = parent[name]
    }
    // Collect-mode pipes are not TTYs, but a user/global `color.ui=always` (or
    // force-color env) still paints gh JSON with ANSI codes and breaks JSON.parse.
    env.NO_COLOR = '1'
    env.CLICOLOR = '0'
    env.CLICOLOR_FORCE = '0'
    if (env.TERM === undefined) env.TERM = 'dumb'
  }
  if (/^git(?:\.exe)?$/iu.test(command)) {
    // The DSH subprocess seam deliberately scrubs credential-shaped *KEY*
    // variables. An ambient GIT_CONFIG_COUNT would otherwise survive while
    // GIT_CONFIG_KEY_0 disappears, making every Git invocation fail at startup.
    env.GIT_CONFIG_COUNT = '0'
    env.GIT_TERMINAL_PROMPT = '0'
    env.GCM_INTERACTIVE = 'Never'
  }
  return env
}

export class DshCommandRunner implements CommandRunner {
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly config: RuntimeConfig,
  ) {}

  async resolveExecutable(command: string, signal?: AbortSignal): Promise<string> {
    const effectiveEnv = effectiveEnvironment(command)
    const lookupEnv = Object.fromEntries(Object.entries(effectiveEnv)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    return this.subprocess.resolveExecutable(command, lookupEnv, signal)
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    const [command, ...args] = request.argv
    const signal = combinedSignal(request.signal, request.timeoutMs ?? this.config.commandTimeoutMs)
    const effectiveEnv = effectiveEnvironment(command, request.env)
    const lookupEnv = Object.fromEntries(Object.entries(effectiveEnv)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    let executable: string
    throwIfCommandAborted(command, signal)
    try {
      executable = await this.subprocess.resolveExecutable(command, lookupEnv, signal)
    } catch (error) {
      throwIfCommandAborted(command, signal)
      throw new EvolutionError('command_failed', `Executable is unavailable: ${command}`, {
        command,
        cause: error instanceof Error ? error.message : String(error),
      })
    }

    let handle
    throwIfCommandAborted(command, signal)
    try {
      handle = this.subprocess.spawn({
        argv: argvForResolvedExecutable(executable, args),
        cwd: request.cwd,
        env: effectiveEnv,
        graceMs: 2_000,
        signal,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 2_000_000 },
          stderr: { maxBytes: 512_000 },
        },
      })
    } catch (error) {
      throwIfCommandAborted(command, signal)
      throw new EvolutionError('command_failed', `Failed to start ${command}`, {
        command,
        cause: error instanceof Error ? error.message : String(error),
      })
    }

    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throwIfCommandAborted(command, signal)
      throw new EvolutionError('command_failed', `Failed to start ${command}`, {
        command,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
    throwIfCommandAborted(command, signal)
    const stdoutRead = handle.collected.stdout?.readFrom(0)
    const stderrRead = handle.collected.stderr?.readFrom(0)
    if (stdoutRead?.lossy || stderrRead?.lossy) {
      throw new EvolutionError('command_failed', `${command} output exceeded the review limit`, { command })
    }
    const result: CommandResult = {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdoutRead?.text ?? '',
      stderr: stderrRead?.text ?? '',
    }
    if (!request.allowFailure && outcome.exitCode !== 0) {
      throw new EvolutionError('command_failed', `${command} exited with code ${outcome.exitCode ?? 'null'}`, {
        command,
        exitCode: outcome.exitCode,
        diagnosticHash: sha256(result.stderr),
      })
    }
    return result
  }
}

export const _testing = { effectiveEnvironment, argvForResolvedExecutable, signalFailure }
