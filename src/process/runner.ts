import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { RuntimeConfig } from '../config.js'
import { EvolutionError } from '../errors.js'
import { sha256 } from '../state/hashes.js'

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

function effectiveEnvironment(
  command: string,
  requested: NodeJS.ProcessEnv = {},
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...requested }
  if (/^gh(?:\.exe)?$/iu.test(command)) {
    for (const name of ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST']) {
      if (env[name] === undefined && parent[name] !== undefined) env[name] = parent[name]
    }
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
    try {
      executable = await this.subprocess.resolveExecutable(command, lookupEnv, signal)
    } catch (error) {
      throw new EvolutionError('command_failed', `Executable is unavailable: ${command}`, {
        command,
        cause: error instanceof Error ? error.message : String(error),
      })
    }

    const handle = this.subprocess.spawn({
      argv: [executable, ...args],
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

    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new EvolutionError('command_failed', `Failed to start ${command}`, {
        command,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
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

export const _testing = { effectiveEnvironment }
