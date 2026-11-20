/**
 * 生成启动 Claude CLI 子进程的环境变量。
 *
 * AgentGroup 可能从 Claude Code 的终端或桌面宿主中启动，从而继承宿主注入的
 * ANTHROPIC_BASE_URL、ANTHROPIC_DEFAULT_*_MODEL、CLAUDE_CODE_* 等变量。
 * 这些变量优先级高于 CLI 自己的 ~/.claude/settings.json，而宿主又不会把
 * ANTHROPIC_AUTH_TOKEN 传给子进程，导致 CLI 误报未登录或模型不存在。
 * 这里去掉宿主注入的变量，让 CLI 按自己的配置完成认证与模型选择。
 *
 * 只用于 Claude 预设；Codex、自定义 Agent 可能依赖自身的 OPENAI_* 等变量，
 * 不能套用这套过滤。
 */
const HOST_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_']
const HOST_ENV_KEYS = new Set(['CLAUDE_PID', 'CLAUDE_EFFORT'])

export function stripClaudeHostEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue
    }
    if (HOST_ENV_KEYS.has(key)) {
      continue
    }
    if (HOST_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue
    }
    result[key] = value
  }
  return result
}
