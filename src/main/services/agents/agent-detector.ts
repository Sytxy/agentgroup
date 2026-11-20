// 本机 Agent CLI 探测。
//
// 只执行固定的命令与参数（which / --version），不拼接用户输入，也不安装任何东西。
// 探测依赖主进程启动时合并好的登录 shell PATH，因此 nvm/Homebrew 安装的 CLI
// 也能被找到。版本命令失败时仍视为已安装，只是版本未知。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DetectedAgent } from '../../../shared/types'

export type AgentProbe = (
  command: string,
  args: string[],
  timeoutMs: number
) => Promise<string>

const execFileAsync = promisify(execFile) as (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number }
) => Promise<{ stdout: string }>

const defaultProbe: AgentProbe = async (command, args, timeoutMs) => {
  const { stdout } = await execFileAsync(command, args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  })
  return stdout
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
    rolePrompt: '负责编写代码、修改文件并完成分派的任务。'
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    vendor: 'OpenAI',
    description: 'OpenAI 的终端编码 Agent，使用 codex exec 非交互模式。',
    command: 'codex',
    preset: 'codex',
    installHint: 'npm install -g @openai/codex',
    rolePrompt: '负责编写代码、修改文件并完成分派的任务。'
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
          const found = (await probe('which', [command], 3_000)).trim()
          if (found !== '') {
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
          const output = (await probe(resolvedCommand, ['--version'], 4_000)).trim()
          version = output.split(/\r?\n/)[0]?.trim() || null
        } catch {
          // 版本命令不受支持或超时：已安装即可，版本留空
          version = null
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
        path
      }
    })
  )
}
