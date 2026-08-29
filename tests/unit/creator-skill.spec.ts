import { describe, expect, it } from 'vitest'
import { creatorSkillRegistration } from '../../src/creator-skill.js'

describe('bundled creator skill', () => {
  it('registers the packaged skill without throwing', () => {
    const registration = creatorSkillRegistration()
    expect(registration.name).toBe('autoevo-plugin-creator')
  })
})
