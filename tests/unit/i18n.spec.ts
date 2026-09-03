import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../../src/config.js'
import { copy, copyForArgs, prefersChinese, rememberRequirementLanguage, _testing } from '../../src/i18n.js'
import { _testing as installTesting } from '../../src/lifecycle/install.js'
import { removalApprovalReason } from '../../src/lifecycle/remove.js'
import type { InstallationRecord } from '../../src/contracts.js'

afterEach(() => {
  _testing.clearLanguageCache()
})

describe('user-facing copy', () => {
  it('selects Chinese only when the hint contains Han characters', () => {
    expect(prefersChinese('I need a calculator')).toBe(false)
    expect(prefersChinese('我需要一个计算器')).toBe(true)
    expect(copy('calculator', 'Install', '安装')).toBe('Install')
    expect(copy('需要计算器', 'Install', '安装')).toBe('安装')
    expect(copy(undefined, 'Install', '安装')).toBe('Install')
  })

  it('uses a cached workflow requirement for later tool cards', () => {
    expect(copyForArgs({ workflow_id: 'workflow_abc' }, 'Searching', '正在搜索')).toBe('Searching')
    rememberRequirementLanguage('workflow_abc', '给我找一个计算器插件')
    expect(copyForArgs({ workflow_id: 'workflow_abc' }, 'Searching', '正在搜索')).toBe('正在搜索')
    expect(copyForArgs({ requirement: 'I need a calculator' }, 'Searching', '正在搜索')).toBe('Searching')
  })
})

describe('config form i18n', () => {
  it('ships English descriptions and Chinese overlays for the settings form', () => {
    const description = Config.meta.description as Record<string, string>
    expect(description['']).toContain('Capability reuse')
    expect(description['en-US']).toContain('Capability reuse')
    expect(description['zh-CN']).toContain('能力复用')
    expect(Config.dict?.evolutionPreset?.meta.description).toEqual(expect.objectContaining({
      'zh-CN': expect.stringContaining('能力进化'),
    }))
  })
})

describe('approval prompts', () => {
  it('writes install approval in the requirement language', () => {
    const english = installTesting.installApprovalReason({
      requirement: 'scientific calculator',
      packageName: 'dsh-tool-calculator',
      targetProfile: 'web',
      riskPrefix: '',
      fit: 'full',
      securityRisk: 'medium',
      compatibility: 'compatible',
      scripts: 'prepare',
      findings: 'lifecycle_script:info',
    })
    expect(english).toContain('Install the exact reviewed dsh-tool-calculator into profile web (persistent)')
    expect(english).toContain('risk=medium')
    expect(english).not.toMatch(/[\u4e00-\u9fff]/u)

    const chinese = installTesting.installApprovalReason({
      requirement: '科学计算器',
      packageName: 'dsh-tool-calculator',
      targetProfile: 'web',
      riskPrefix: '',
      fit: 'full',
      securityRisk: 'medium',
      compatibility: 'compatible',
      scripts: 'prepare',
      findings: 'lifecycle_script:info',
    })
    expect(chinese).toContain('将已审查的 dsh-tool-calculator 安装到 profile web')
    expect(chinese).toContain('风险=medium')
    expect(chinese).not.toMatch(/Install the exact reviewed/u)
  })

  it('writes removal approval in the requirement language', () => {
    const record = {
      id: 'installation_aaaaaaaaaaaaaaaaaaaaaaaa',
      targetProfile: 'web',
      retention: 'persistent',
    } as InstallationRecord
    expect(removalApprovalReason('calculator', record)).toContain('Remove reviewed installation')
    expect(removalApprovalReason('卸载这个插件', record)).toContain('将已审查的安装')
  })
})
