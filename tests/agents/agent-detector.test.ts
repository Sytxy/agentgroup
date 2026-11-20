import { describe, expect, test, vi } from 'vitest'
import { detectAgents, type AgentProbe } from '../../src/main/services/agents/agent-detector'

describe('detectAgents', () => {
  test('detects installed CLIs and tolerates version failures', async () => {
    const probe = vi.fn(async (command: string, args: string[]) => {
      if (command === 'which' && args[0] === 'claude') {
        return { stdout: '/nvm/bin/claude\n', exitCode: 0 }
      }
      if (command === 'which' && args[0] === 'codex') {
        return { stdout: '/usr/local/bin/codex\n', exitCode: 0 }
      }
      if (command === 'which' && args[0] === 'deepseek-cli') {
        return { stdout: '/Users/me/.local/bin/deepseek-cli\n', exitCode: 0 }
      }
      if (command === 'which') {
        return { stdout: '', exitCode: 1 }
      }
      if (command === 'claude' && args[0] === '--version') {
        return { stdout: '2.1.327 (Claude Code)\n', exitCode: 0 }
      }
      if (command === 'claude' && args[0] === 'auth') {
        // 未登录时 CLI 退出码为 1，但 stdout 仍是可解析的 JSON
        return {
          stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
          exitCode: 1
        }
      }
      if (command === 'codex' && args[0] === '--version') {
        throw new Error('version command failed')
      }
      if (command === 'codex' && args[0] === 'login') {
        // Codex 把登录状态写到 stderr
        return { stdout: '', stderr: 'Logged in using ChatGPT\n', exitCode: 0 }
      }
      if (command === 'deepseek-cli') {
        return { stdout: 'deepseek 1.2.0\n', exitCode: 0 }
      }
      return { stdout: '', exitCode: 0 }
    }) as AgentProbe

    const result = await detectAgents(probe)

    expect(result).toHaveLength(6)
    expect(result.find((item) => item.id === 'claude')).toMatchObject({
      installed: true,
      version: '2.1.327 (Claude Code)',
      path: '/nvm/bin/claude',
      loggedIn: false,
      loginHint: 'claude auth login'
    })
    // 版本命令失败仍然算已安装，只是版本未知
    expect(result.find((item) => item.id === 'codex')).toMatchObject({
      installed: true,
      version: null,
      path: '/usr/local/bin/codex',
      loggedIn: true,
      loginHint: 'codex login'
    })
    expect(result.find((item) => item.id === 'gemini')).toMatchObject({
      installed: false,
      version: null,
      path: null,
      loggedIn: null
    })
    // DeepSeek CLI 没有统一命令名，命中别名时保留实际命令；
    // 没有登录状态命令时 loggedIn 必须是 null，不能误判为未登录
    expect(result.find((item) => item.id === 'deepseek')).toMatchObject({
      installed: true,
      command: 'deepseek-cli',
      version: 'deepseek 1.2.0',
      path: '/Users/me/.local/bin/deepseek-cli',
      loggedIn: null,
      loginHint: null
    })
  })
})
