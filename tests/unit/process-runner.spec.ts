import { describe, expect, it } from 'vitest'
import { _testing } from '../../src/process/runner.js'

describe('subprocess environment boundary', () => {
  it('neutralizes orphaned ambient Git config after credential scrubbing', () => {
    expect(_testing.effectiveEnvironment('git', {}, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
    })).toEqual({
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    })
  })

  it('forwards only the explicit GitHub CLI credential allowlist and disables color', () => {
    expect(_testing.effectiveEnvironment('gh', {}, {
      GH_TOKEN: 'token',
      OTHER_SECRET: 'do-not-forward',
    })).toEqual({
      GH_TOKEN: 'token',
      NO_COLOR: '1',
      CLICOLOR: '0',
      CLICOLOR_FORCE: '0',
      TERM: 'dumb',
    })
  })
})
