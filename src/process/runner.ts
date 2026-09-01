import os from 'node:os'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { RuntimeConfig } from '../config.js'
import { EvolutionError } from '../errors.js'
import { sha256 } from '../state/hashes.js'
import { boundedAgentText } from '../workflow/sanitize.js'

const WINDOWS_CMD_SHIMS = new Set(['.cmd', '.bat'])

function isDshCommand(command: string, platform: NodeJS.Platform): boolean {
  const commandPath = platform === 'win32' ? path.win32 : path.posix
  return /^dsh(?:\.cmd|\.exe)?$/iu.test(commandPath.basename(command))
}

/** Node 24 refuses to spawn a .cmd/.bat without a shell (EINVAL). */
export function argvForResolvedExecutable(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): [string, ...string[]] {
  const executablePath = platform === 'win32' ? path.win32 : path
  if (platform !== 'win32' || !WINDOWS_CMD_SHIMS.has(executablePath.extname(executable).toLowerCase())) {
    return [executable, ...args]
  }
  if (executablePath.basename(executable).toLowerCase() !== 'dsh.cmd') {
    throw new EvolutionError('command_failed', 'Refusing to shell-interpret an unsupported Windows command shim', {
      executable,
    })
  }
  // Node 24 refuses to spawn .cmd directly, while cmd.exe introduces a second
  // parser over user-controlled task text and file specs. npm/pnpm DSH shims
  // have two stable layouts; invoke the real JS entry with Node instead.
  const directory = executablePath.dirname(executable)
  const dshBin = executablePath.basename(directory).toLowerCase() === '.bin'
    ? executablePath.resolve(directory, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : executablePath.join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
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
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
}

const DIAGNOSTIC_LINE = /(?:ERR_[A-Z0-9_]+|\b(?:error|failed|failure|not found|timed? out|cannot|unable|denied)\b|\bE(?:PERM|ACCES|NOENT|CONN\w*|TIMEDOUT|NOTFOUND)\b)/iu
const MINIMUM_RELEASE_AGE_CODE = 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION'
const UNEXPECTED_STORE_CODE = 'ERR_PNPM_UNEXPECTED_STORE'
const MAX_POLICY_ENTRIES = 8
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/iu
const TRANSIENT_CODES = new Set([
  'ERR_PNPM_FETCH_500',
  'ERR_PNPM_FETCH_502',
  'ERR_PNPM_FETCH_503',
  'ERR_PNPM_FETCH_504',
  'ERR_PNPM_META_FETCH_FAIL',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

export function isTransientPnpmRecoveryCode(value: unknown): value is string {
  return typeof value === 'string' && TRANSIENT_CODES.has(value)
}

export type CommandFailureRecovery =
  | { kind: 'same_authority_once'; owner: 'pnpm'; code: string }
  | { kind: 'profile_store_mismatch'; owner: 'pnpm'; code: typeof UNEXPECTED_STORE_CODE }
  | {
      kind: 'minimum_release_age'
      owner: 'pnpm'
      code: typeof MINIMUM_RELEASE_AGE_CODE
      policyKey: 'minimumReleaseAge'
      entries: Array<{ packageName: string; version: string; reason: string }>
    }

function plainDiagnosticLines(value: string): string[] {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .split(/\r?\n/gu)
}

function parseReleaseAgeRecovery(lines: string[]): CommandFailureRecovery | undefined {
  const headerIndex = lines.findIndex((line) => line.includes(`[${MINIMUM_RELEASE_AGE_CODE}]`))
  if (headerIndex < 0) return undefined
  const countMatch = /\]\s+(\d+)\s+lockfile entries failed verification:/u.exec(lines[headerIndex] ?? '')
  const expectedCount = countMatch ? Number.parseInt(countMatch[1]!, 10) : Number.NaN
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > MAX_POLICY_ENTRIES) return undefined

  const entries: Array<{ packageName: string; version: string; reason: string }> = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (!/^\s{2,}\S/u.test(line)) {
      if (entries.length > 0) break
      continue
    }
    const match = /^\s{2,}((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@([^\s]+)\s+(.+)$/iu.exec(line)
    if (!match || !NPM_NAME.test(match[1]!) || !PACKAGE_VERSION.test(match[2]!)) return undefined
    const reason = boundedAgentText(match[3], 220)
    if (!reason) return undefined
    entries.push({ packageName: match[1]!, version: match[2]!, reason })
    if (entries.length > MAX_POLICY_ENTRIES) return undefined
  }
  if (entries.length !== expectedCount) return undefined
  const unique = new Set(entries.map((entry) => `${entry.packageName.toLowerCase()}@${entry.version}`))
  if (unique.size !== entries.length) return undefined
  return {
    kind: 'minimum_release_age',
    owner: 'pnpm',
    code: MINIMUM_RELEASE_AGE_CODE,
    policyKey: 'minimumReleaseAge',
    entries: entries.sort((left, right) => `${left.packageName}@${left.version}`.localeCompare(`${right.packageName}@${right.version}`)),
  }
}

function commandFailureRecovery(result: CommandResult): CommandFailureRecovery | undefined {
  const lines = [...plainDiagnosticLines(result.stdout), ...plainDiagnosticLines(result.stderr)]
  const releaseAge = parseReleaseAgeRecovery(lines)
  if (releaseAge) return releaseAge
  const text = lines.join('\n')
  // A truncated or malformed policy report must never be downgraded to a
  // transient network failure merely because both diagnostics were emitted.
  if (text.includes(MINIMUM_RELEASE_AGE_CODE)) return undefined
  if (text.includes(UNEXPECTED_STORE_CODE)) {
    return { kind: 'profile_store_mismatch', owner: 'pnpm', code: UNEXPECTED_STORE_CODE }
  }
  const code = [...TRANSIENT_CODES].find((item) => new RegExp(`(?:^|[^A-Z0-9_])${item}(?:$|[^A-Z0-9_])`, 'u').test(text))
  return code ? { kind: 'same_authority_once', owner: 'pnpm', code } : undefined
}

function diagnosticStreamTail(value: string, maxLength: number): string {
  const lines = plainDiagnosticLines(value)
    .map((line) => line.trim())
    .filter(Boolean)
  const diagnosticIndexes = lines.flatMap((line, index) => DIAGNOSTIC_LINE.test(line) ? [index] : [])
  const selected = new Set<number>()
  for (const index of diagnosticIndexes) {
    selected.add(index)
    for (let offset = 1; offset <= MAX_POLICY_ENTRIES && index + offset < lines.length; offset += 1) {
      const next = lines[index + offset]!
      if (!/^(?:@?[a-z0-9]|\s{2,})/iu.test(next)) break
      selected.add(index + offset)
    }
  }
  const diagnosticLines = [...selected].sort((left, right) => left - right).map((index) => lines[index]!)
  return boundedAgentText((diagnosticLines.length > 0 ? diagnosticLines : lines).slice(-10).join(' | '), maxLength)
}

function commandDiagnosticSummary(result: CommandResult): string {
  const hasStdout = result.stdout.trim().length > 0
  const hasStderr = result.stderr.trim().length > 0
  const maxPerStream = hasStdout && hasStderr ? 180 : 360
  const parts = [
    ...(hasStdout ? [`stdout: ${diagnosticStreamTail(result.stdout, maxPerStream)}`] : []),
    ...(hasStderr ? [`stderr: ${diagnosticStreamTail(result.stderr, maxPerStream)}`] : []),
  ]
  return boundedAgentText(parts.join(' | '), 400)
}

/** Create a persistable command failure without retaining either raw output stream. */
export function commandResultFailure(command: string, result: CommandResult): EvolutionError {
  const diagnosticSummary = commandDiagnosticSummary(result)
  const recovery = commandFailureRecovery(result)
  return new EvolutionError('command_failed', `${command} exited with code ${result.exitCode ?? 'null'}`, {
    command,
    exitCode: result.exitCode,
    ...(diagnosticSummary ? { diagnosticSummary } : {}),
    ...(recovery ? { recovery } : {}),
    diagnosticHash: sha256(JSON.stringify([result.stdout, result.stderr])),
  })
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

async function readSpillFile(
  spillPath: string,
  command: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  throwIfCommandAborted(command, signal)
  try {
    const text = await readFile(spillPath, { encoding: 'utf8', signal })
    throwIfCommandAborted(command, signal)
    return text
  } catch {
    // Missing/unreadable spill output retains the existing truncated fallback,
    // but cancellation and deadlines must remain command failures.
    throwIfCommandAborted(command, signal)
    return undefined
  }
}

function effectiveEnvironment(
  command: string,
  requested: NodeJS.ProcessEnv = {},
  parent: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
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
    // Nested pnpm in DSH uses LOCALAPPDATA to select its Windows store. Keep
    // this trusted parent value only for DSH commands; other subprocesses stay
    // on the narrower scrubbed environment.
    if (isDshCommand(command, platform)) {
      const inherited = Object.entries(parent)
        .find(([key, value]) => key.toLowerCase() === 'localappdata' && value !== undefined)?.[1]
      const derived = /^(?:[A-Z]:\\|\\\\)/iu.test(homeDirectory)
        ? path.win32.join(homeDirectory, 'AppData', 'Local')
        : undefined
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'localappdata') delete env[key]
      }
      const localAppData = inherited ?? derived
      if (localAppData !== undefined) env.LOCALAPPDATA = localAppData
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
          stdout: { maxBytes: 2_000_000, spill: { maxBytes: 268_435_456 } },
          stderr: { maxBytes: 512_000, spill: { maxBytes: 268_435_456 } },
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
    throwIfCommandAborted(command, signal)
    const stderrRead = handle.collected.stderr?.readFrom(0)
    throwIfCommandAborted(command, signal)
    const stdoutSpill = stdoutRead?.lossy && stdoutRead.spillPath
      ? await readSpillFile(stdoutRead.spillPath, command, signal)
      : undefined
    throwIfCommandAborted(command, signal)
    const stderrSpill = stderrRead?.lossy && stderrRead.spillPath
      ? await readSpillFile(stderrRead.spillPath, command, signal)
      : undefined
    throwIfCommandAborted(command, signal)
    const stdout = stdoutSpill ?? stdoutRead?.text ?? ''
    const stderr = stderrSpill ?? stderrRead?.text ?? ''
    const result: CommandResult = {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout,
      stderr,
      ...(stdoutRead?.lossy && stdoutSpill === undefined ? { stdoutTruncated: true } : {}),
      ...(stderrRead?.lossy && stderrSpill === undefined ? { stderrTruncated: true } : {}),
    }
    if (!request.allowFailure && outcome.exitCode !== 0) {
      throw commandResultFailure(command, result)
    }
    return result
  }
}

export const _testing = {
  commandDiagnosticSummary,
  commandFailureRecovery,
  commandResultFailure,
  effectiveEnvironment,
  argvForResolvedExecutable,
  signalFailure,
}
