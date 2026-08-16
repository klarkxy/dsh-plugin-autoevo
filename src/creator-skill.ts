import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillDefinition, SkillRegistration } from '@deepseek-ai/dsh-skill'
import { parse } from 'yaml'

export const CREATOR_SKILL_NAME = 'autoevo-plugin-creator'
export const OFFICIAL_CREATOR_SKILL_NAME = 'cordis-plugin-development'
export const CREATOR_SKILL_PROVIDER = 'dsh-plugin-autoevo'
export const CREATOR_SKILL_MARKER = 'autoevo-plugin-creator:v1'

const CREATOR_SKILL_DIRECTORY = fileURLToPath(new URL('../skills/autoevo-plugin-creator/', import.meta.url))
const CREATOR_SKILL_PATH = fileURLToPath(new URL('../skills/autoevo-plugin-creator/SKILL.md', import.meta.url))
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u

interface SkillFrontmatter {
  name?: unknown
  description?: unknown
}

function parseCreatorSkill(raw: string): { name: string; description: string; content: string } {
  const match = FRONTMATTER.exec(raw)
  if (!match) throw new Error(`AutoEvo bundled skill is missing valid frontmatter: ${CREATOR_SKILL_PATH}`)
  const metadata = parse(match[1]!) as SkillFrontmatter
  if (metadata.name !== CREATOR_SKILL_NAME) {
    throw new Error(`AutoEvo bundled skill must be named ${CREATOR_SKILL_NAME}`)
  }
  if (typeof metadata.description !== 'string' || metadata.description.trim().length === 0) {
    throw new Error('AutoEvo bundled skill requires a non-empty description')
  }
  const content = match[2]!.trim()
  if (!content.includes(CREATOR_SKILL_MARKER)) {
    throw new Error(`AutoEvo bundled skill is missing marker ${CREATOR_SKILL_MARKER}`)
  }
  return { name: metadata.name, description: metadata.description.trim(), content }
}

export function creatorSkillRegistration(): SkillRegistration {
  const skill = parseCreatorSkill(readFileSync(CREATOR_SKILL_PATH, 'utf8'))
  return {
    ...skill,
    source: 'runtime',
    provider: CREATOR_SKILL_PROVIDER,
    path: CREATOR_SKILL_PATH,
    resourceBase: { kind: 'directory', path: CREATOR_SKILL_DIRECTORY },
  }
}

export function isAutoEvoCreatorSkill(skill: Pick<SkillDefinition, 'name' | 'provider' | 'content'>): boolean {
  return skill.name === CREATOR_SKILL_NAME
    && skill.provider === CREATOR_SKILL_PROVIDER
    && skill.content.includes(CREATOR_SKILL_MARKER)
}

export function registerCreatorSkill(ctx: Context): () => void {
  return ctx.skills.register(creatorSkillRegistration())
}

export function isWorkflowSkill(name: string): boolean {
  return name === CREATOR_SKILL_NAME || name === OFFICIAL_CREATOR_SKILL_NAME
}

export const _testing = { parseCreatorSkill, CREATOR_SKILL_DIRECTORY, CREATOR_SKILL_PATH }
