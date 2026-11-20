// 本机 Agent CLI 探测。
//
// 只执行固定的命令与参数（which / --version / 登录状态），不拼接用户输入，
// 也不安装任何东西。探测依赖主进程启动时合并好的登录 shell PATH，因此
// nvm/Homebrew 安装的 CLI 也能被找到。版本命令失败时仍视为已安装，只是版本未知。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DetectedAgent } from '../../../shared/types'
import { stripClaudeHostEnv } from './standalone-env'

export interface ProbeResult {
  stdout: string
  /** 部分 CLI（如 Codex）把状态文本写到 stderr，探测时一并保留。 */
  stderr?: string
  /** 进程退出码；命令无法启动时为 null。 */
  exitCode: number | null
}

export type AgentProbe = (
  command: string,
  args: string[],
  timeoutMs: number
) => Promise<ProbeResult>

const execFileAsync = promisify(execFile) as (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr: string }>

const defaultProbe: AgentProbe = async (command, args, timeoutMs) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      // 检测必须在与任务相同的干净环境中执行，否则 Claude Code 宿主注入的
      // BASE_URL/模型变量会让 auth status 误报未登录。
      env: stripClaudeHostEnv()
    })
    return { stdout, stderr, exitCode: 0 }
  } catch (error) {
    // claude auth status 在未登录时退出码为 1，但 stdout 仍是可解析的 JSON；
    // 保留输出交给调用方判断，只有命令无法启动时 exitCode 才为 null。
    const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown }
    return {
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
      exitCode: typeof failure.code === 'number' ? failure.code : null
    }
  }
}

interface AuthCheck {
  args: string[]
  kind: 'claude' | 'codex'
}

interface CatalogEntry {
  id: string
  name: string
  vendor: string
  description: string
  command: string
  /** 同一 Agent 可能存在的其他命令名；按顺序探测，命中即采用。 */
  aliases?: string[]
  preset: DetectedAgent['preset']
  installHint: string
  rolePrompt: string
  /** 可选的登录状态探测；没有统一命令的 CLI 不设置。 */
  auth?: AuthCheck
  loginHint?: string
}

const CATALOG: CatalogEntry[] = [
  {
    id: 'claude',
    name: 'Claude Code CLI',
    vendor: 'Anthropic',
    description: 'Anthropic 官方 CLI，支持无头模式与 stream-json 输出。',
    command: 'claude',
    preset: 'claude',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    rolePrompt: '负责编写代码、修改文件并完成分派的任务。',
    auth: { args: ['auth', 'status', '--json'], kind: 'claude' },
    loginHint: 'claude auth login'
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    vendor: 'OpenAI',
    description: 'OpenAI 的终端编码 Agent，使用 codex exec 非交互模式。',
    command: 'codex',
    preset: 'codex',
    installHint: 'npm install -g @openai/codex',
    rolePrompt: '负责编写代码、修改文件并完成分派的任务。',
    auth: { args: ['login', 'status'], kind: 'codex' },
    loginHint: 'codex login'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek CLI',
    vendor: 'DeepSeek',
    description: 'DeepSeek 的编码 CLI；命令名不固定，自动探测 deepseek / deepseek-cli。',
    command: 'deepseek',
    aliases: ['deepseek-cli'],
    preset: 'custom',
    installHint: '安装任意 DeepSeek CLI（命令名 deepseek 或 deepseek-cli），或使用手动配置',
    rolePrompt: '负责编写代码、修改文件并完成分派的任务。'
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    vendor: 'Google',
    description: 'Google 的终端 Agent，可接入 Gemini 模型。',
    command: 'gemini',
    preset: 'custom',
    installHint: 'npm install -g @google/gemini-cli',
    rolePrompt: '负责编写代码、修改文件并完成分派的任务。'
  },
  {
    id: 'aider',
    name: 'Aider',
    vendor: 'Open source',
    description: '在终端里与模型结对编程，支持多种模型后端。',
    command: 'aider',
    preset: 'custom',
    installHint: 'python3 -m pip install aider-chat',
    rolePrompt: '负责编写代码、修改文件并完成分派的任务。'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'Open source',
    description: '开源的终端编码 Agent。',
    command: 'opencode',
    preset: 'custom',
    installHint: 'npm install -g opencode-ai',
    rolePrompt: '负责编写代码、修改文件并完成分派的任务。'
  }
]

/** 探测本机 Agent；返回顺序与目录一致，未安装的项也保留。 */
export async function detectAgents(probe: AgentProbe = defaultProbe): Promise<DetectedAgent[]> {
  return Promise.all(
    CATALOG.map(async (entry) => {
      let path: string | null = null
      let version: string | null = null
      let resolvedCommand = entry.command

      for (const command of [entry.command, ...(entry.aliases ?? [])]) {
        try {
          const result = await probe('which', [command], 3_000)
          const found = result.stdout.trim()
          if (result.exitCode === 0 && found !== '') {
            path = found
            resolvedCommand = command
            break
          }
        } catch {
          // 尝试下一个别名命令
        }
      }

      if (path !== null) {
        try {
          const result = await probe(resolvedCommand, ['--version'], 4_000)
          if (result.exitCode === 0) {
            const output = result.stdout.trim()
            version = output.split(/\r?\n/)[0]?.trim() || null
          }
        } catch {
          // 版本命令不受支持或超时：已安装即可，版本留空
          version = null
        }
      }

      // 登录状态只对已知认证命令的预设探测；失败或无法判断时保持 null，
      // 不能把「无法判断」当成「未登录」，否则会阻止用户添加可用的自定义 CLI。
      let loggedIn: boolean | null = null
      if (path !== null && entry.auth !== undefined) {
        try {
          const result = await probe(resolvedCommand, entry.auth.args, 4_000)
          loggedIn = parseAuthStatus(
            entry.auth.kind,
            result.stdout,
            result.stderr ?? ''
          )
        } catch {
          loggedIn = null
        }
      }

      return {
        id: entry.id,
        name: entry.name,
        vendor: entry.vendor,
        description: entry.description,
        command: resolvedCommand,
        preset: entry.preset,
        installHint: entry.installHint,
        rolePrompt: entry.rolePrompt,
        installed: path !== null,
        version,
        path,
        loggedIn,
        loginHint: entry.loginHint ?? null
      }
    })
  )
}

/** 从 CLI 输出判断是否已登录；只接受明确结论，其余返回 null。 */
function parseAuthStatus(
  kind: AuthCheck['kind'],
  stdout: string,
  stderr: string
): boolean | null {
  const stdoutText = stdout.trim()
  const text = `${stdoutText}\n${stderr}`.trim()
  if (text === '') {
    return null
  }

  if (kind === 'claude' && stdoutText !== '') {
    try {
      const parsed = JSON.parse(stdoutText) as { loggedIn?: unknown }
      if (typeof parsed.loggedIn === 'boolean') {
        return parsed.loggedIn
      }
    } catch {
      // 老版本可能输出纯文本，继续走下面的文本判断
    }
  }

  if (/not logged in/i.test(text)) {
    return false
  }
  if (/\blogged in\b/i.test(text)) {
    return true
  }
  return null
}
