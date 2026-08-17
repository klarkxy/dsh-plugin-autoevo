import { EvolutionError } from '../errors.js'

const REPOSITORY = /^(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}))\/(?<name>[A-Za-z0-9_.-]+)$/

/** Reject URLs, path traversal, and ambiguous GitHub repository identifiers. */
export function validateGithubRepository(value: string): string {
  const match = REPOSITORY.exec(value.trim())
  if (!match || value.includes('..') || value.includes('\\')) {
    throw new EvolutionError('invalid_input', 'Repository must be a strict owner/repository identifier', { repository: value })
  }
  return `${match.groups?.owner}/${match.groups?.name}`
}
