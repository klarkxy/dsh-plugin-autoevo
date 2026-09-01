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

  it('does not install @deepseek-ai/dsh at the repo root', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      expect(pkg[field]?.['@deepseek-ai/dsh'], field).toBeUndefined()
    }
  })

  it('documents the Host-owned managed-child construction boundary in the creator skill', () => {
    const skill = read('skills/autoevo-plugin-creator/SKILL.md')
    expect(skill).not.toMatch(/resume with the local checkout path|finish_managed_work/u)
    expect(skill).toContain('short-lived, cwd-bound managed child')
    expect(skill).toContain('The parent Capability Evolution session remains read-only')
    expect(skill).toContain('Do not pass an arbitrary checkout path or edit from the parent session')
  })

  it('keeps the cheap test gate free of pack, integration, and DSH harness work', () => {
    const packSpawningSpecs = [
      'tests/unit/package-artifact.spec.ts',
      'tests/unit/confirmation-gates.spec.ts',
      'tests/unit/semantic-review-attach.spec.ts',
    ] as const
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    const invoked = (name: string, seen = new Set<string>()): Set<string> => {
      const body = scripts[name]
      if (!body || seen.has(name)) return seen
      seen.add(name)
      for (const match of body.matchAll(/\bpnpm\s+([a-z0-9:_-]+)/giu)) invoked(match[1]!, seen)
      return seen
    }
    const forbiddenFromFast = [
      'test:integration',
      'test:acceptance',
      'test:loader',
      'test:packaged',
      'test:e2e',
      'test:e2e:offline',
      'test:e2e:live',
      'test:e2e:local',
      'test:e2e:adversarial',
      'test:e2e:marketplace',
    ]

    expect(scripts.test).toBe('vitest run')
    expect(scripts['test:integration']).toContain('vitest.integration.config.ts')
    expect(scripts['check:fast']).toBe('pnpm lint && pnpm typecheck && pnpm test && pnpm build')
    expect(scripts.check).toBe('pnpm check:fast')

    for (const name of ['test', 'check:fast', 'check'] as const) {
      const names = invoked(name)
      for (const forbidden of forbiddenFromFast) {
        expect(names.has(forbidden), `${name} invokes ${forbidden}`).toBe(false)
      }
    }

    const release = invoked('check:release')
    expect(release.has('test')).toBe(true)
    expect(release.has('test:integration')).toBe(true)
    expect(release.has('test:acceptance')).toBe(true)
    expect(release.has('test:loader')).toBe(true)
    expect(release.has('test:packaged')).toBe(true)
    expect(release.has('test:e2e:offline')).toBe(true)
    expect(release.has('test:e2e:live')).toBe(true)
    expect(release.has('pack:dry-run')).toBe(true)

    const vitest = read('vitest.config.ts')
    const integration = read('vitest.integration.config.ts')
    expect(vitest).toContain("include: ['tests/unit/**/*.spec.ts']")
    expect(vitest).not.toContain("include: ['tests/**/*.spec.ts']")
    expect(integration).toContain('tests/integration/**/*.spec.ts')
    for (const spec of packSpawningSpecs) {
      expect(existsSync(path.join(projectRoot, spec)), spec).toBe(true)
      expect(vitest).toContain(spec)
      expect(integration).toContain(spec)
    }

    const ci = read('.github/workflows/ci.yml')
    expect(ci).not.toMatch(/test:acceptance|test:e2e|DSH_PACKAGE_ROOT|@deepseek-ai\/dsh/u)

    for (const relativePath of ['docs/developer-guide.md', 'docs/developer-guide.en.md'] as const) {
      const guide = read(relativePath)
      expect(guide).toContain('pnpm check:fast')
      expect(guide).toContain('pnpm check:release')
      expect(guide).toContain('pnpm test:integration')
      expect(guide).not.toMatch(/日常完整合入门|Complete daily integration gate/u)
      expect(guide).not.toMatch(/pnpm check\n```/u)
    }
  })
})
