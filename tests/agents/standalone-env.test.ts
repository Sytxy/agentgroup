import { describe, expect, test } from 'vitest'
import { stripClaudeHostEnv } from '../../src/main/services/agents/standalone-env'

describe('stripClaudeHostEnv', () => {
  test('去掉 Claude Code 宿主注入的变量，保留用户环境', () => {
    const env = stripClaudeHostEnv({
      HOME: '/Users/me',
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      ANTHROPIC_AUTH_TOKEN: 'host-token',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
      CLAUDE_CODE_SESSION_ID: 'host-session',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop-3p',
      CLAUDE_AGENT_SDK_VERSION: '1.0.0',
      CLAUDE_PID: '123',
      CLAUDE_EFFORT: 'high',
      // CLI 自己的配置目录是合法覆盖，不能误删
      CLAUDE_CONFIG_DIR: '/Users/me/custom-claude',
      OPENAI_API_KEY: 'openai-key'
    })

    expect(env).toEqual({
      HOME: '/Users/me',
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/Users/me/custom-claude',
      OPENAI_API_KEY: 'openai-key'
    })
  })
})
