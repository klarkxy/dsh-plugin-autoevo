import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const documentationFiles = [
  'README.md',
  'README.en.md',
  'docs/user-guide.md',
  'docs/user-guide.en.md',
  'docs/developer-guide.md',
  'docs/developer-guide.en.md',
  'docs/architecture.md',
  'docs/security.md',
  'docs/real-world-samples.md',
] as const

function read(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8')
}

interface RelativeLink {
  anchor?: string
  target: string
}

function relativeLinks(markdown: string): RelativeLink[] {
  return [...markdown.matchAll(/\[[^\]]*\]\((?!https?:|mailto:|#)([^)#]+)(?:#([^)]+))?\)/gu)]
    .flatMap((match) => {
      const target = match[1]?.trim()
      const anchor = match[2]?.trim()
      return target ? [{ target, ...(anchor ? { anchor } : {}) }] : []
    })
}

function headingAnchors(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) => (
    (match[1] ?? '')
      .toLowerCase()
      .replace(/[`*_]/gu, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/gu, '-')
  )))
}

describe('documentation set', () => {
  it('keeps every relative documentation link resolvable', () => {
    for (const relativePath of documentationFiles) {
      const directory = path.dirname(path.join(projectRoot, relativePath))
      for (const { target, anchor } of relativeLinks(read(relativePath))) {
        const resolvedTarget = path.resolve(directory, target)
        expect(existsSync(resolvedTarget), `${relativePath} -> ${target}`).toBe(true)
        if (anchor) {
          expect(headingAnchors(readFileSync(resolvedTarget, 'utf8')).has(anchor), `${relativePath} -> #${anchor}`).toBe(true)
        }
      }
    }
  })

  it('keeps the published install target consistent across user entry points', () => {
    const match = read('README.md').match(/github:klarkxy\/dsh-plugin-autoevo#v\d+\.\d+\.\d+/u)
    expect(match?.[0]).toBeTruthy()
    for (const relativePath of ['README.en.md', 'docs/user-guide.md', 'docs/user-guide.en.md']) {
      expect(read(relativePath)).toContain(match?.[0])
    }
  })

  it('documents the four distinct completion signals', () => {
    for (const relativePath of ['docs/user-guide.md', 'docs/user-guide.en.md']) {
      const guide = read(relativePath)
      expect(guide).toContain('verified')
      expect(guide).toContain('activated')
      expect(guide).toContain('awaiting_user_test')
      expect(guide).toContain('restartRequired')
    }
  })

  it('does not revive the removed child-agent construction contract', () => {
    const governedDocs = [
      ...documentationFiles,
      'skills/autoevo-plugin-creator/SKILL.md',
      'skills/autoevo-plugin-creator/references/autoevo-state.md',
      'skills/autoevo-plugin-creator/references/eval-traces.md',
    ].map(read).join('\n')

    expect(governedDocs).not.toMatch(/Host-launched child|workspace-write child|workspace-write 子会话|AgentHandle\.dispose\(\)|resume with the local checkout path/u)
    expect(read('skills/autoevo-plugin-creator/SKILL.md')).toContain('finish_managed_work')
  })
})
