import { describe, expect, test, vi } from 'vitest'
import { detectAgents, type AgentProbe } from '../../src/main/services/agents/agent-detector'

describe('detectAgents', () => {
  test('detects installed CLIs and tolerates version failures', async () => {
    const probe = vi.fn(async (command: string, args: string[]) => {
      if (command === 'which' && args[0] === 'claude') {
        return '/nvm/bin/claude\n'
      }
      if (command === 'which' && args[0] === 'codex') {
        return '/usr/local/bin/codex\n'
      }
      if (command === 'which' && args[0] === 'deepseek-cli') {
        return '/Users/me/.local/bin/deepseek-cli\n'
      }
      if (command === 'which') {
        throw new Error('not found')
      }
      if (command === 'claude') {
        return '2.1.327 (Claude Code)\n'
      }
      if (command === 'codex') {
        throw new Error('version command failed')
      }
      if (command === 'deepseek-cli') {
        return 'deepseek 1.2.0\n'
      }
      return ''
    }) as AgentProbe

    const result = await detectAgents(probe)

    expect(result).toHaveLength(6)
    expect(result.find((item) => item.id === 'claude')).toMatchObject({
      installed: true,
      version: '2.1.327 (Claude Code)',
      path: '/nvm/bin/claude'
    })
    // 版本命令失败仍然算已安装，只是版本未知
    expect(result.find((item) => item.id === 'codex')).toMatchObject({
      installed: true,
      version: null,
      path: '/usr/local/bin/codex'
    })
    expect(result.find((item) => item.id === 'gemini')).toMatchObject({
      installed: false,
      version: null,
      path: null
    })
    // DeepSeek CLI 没有统一命令名，命中别名时保留实际命令
    expect(result.find((item) => item.id === 'deepseek')).toMatchObject({
      installed: true,
      command: 'deepseek-cli',
      version: 'deepseek 1.2.0',
      path: '/Users/me/.local/bin/deepseek-cli'
    })
  })
})
