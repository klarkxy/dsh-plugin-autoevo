export type EvolutionErrorCode =
  | 'approval_required'
  | 'command_failed'
  | 'github_unavailable'
  | 'invalid_input'
  | 'not_found'
  | 'review_expired'
  | 'review_rejected'
  | 'unsafe_path'

export class EvolutionError extends Error {
  constructor(
    readonly code: EvolutionErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'EvolutionError'
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
