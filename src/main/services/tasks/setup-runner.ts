/**
 * 任务运行环境准备。
 *
 * worktree 是从 integration 提交新建的，不包含 node_modules、.env 等未提交内容。
 * 本服务先把工作区声明的文件/目录从仓库根复制到 worktree，再在 worktree 内执行
 * setup 命令（如 pnpm install）。准备时间不计入任务超时，由 setupTimeoutMin 单独限制。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface SetupInput {
  worktreePath: string
  repoPath: string
  /** null 或空白表示不需要执行命令 */
  command: string | null
  /** 相对仓库根的路径；按声明顺序复制，目录递归复制 */
  copy: string[]
  timeoutMin: number
}

export type SetupResult = { ok: true } | { ok: false; error: string }

export class SetupRunner {
  async run(input: SetupInput): Promise<SetupResult> {
    // 先完成全部复制：源缺失时直接失败，避免 Agent 在缺少配置的 worktree 中启动。
    for (const entry of input.copy) {
      const source = join(input.repoPath, entry)
      if (!existsSync(source)) {
        return { ok: false, error: `要复制的文件不存在：${source}` }
      }

      const target = join(input.worktreePath, entry)
      try {
        // 复制嵌套路径（如 config/local.json）时目标父目录可能不存在；
        // 目标位于 worktree 内，创建父目录不会影响仓库本身。
        await mkdir(dirname(target), { recursive: true })
        await cp(source, target, { recursive: true })
      } catch (error) {
        return { ok: false, error: `复制 ${entry} 失败：${errorMessage(error)}` }
      }
    }

    const command = input.command?.trim()
    if (command === undefined || command === '') {
      return { ok: true }
    }

    try {
      await runSetupCommand(command, input.worktreePath, input.timeoutMin)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }
}

/** 用 sh -c 执行 setup 命令，保留 shell 语义（管道、&& 等） */
function runSetupCommand(command: string, cwd: string, timeoutMin: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'sh',
      ['-c', command],
      {
        cwd,
        timeout: timeoutMin * 60_000,
        // 安装依赖等命令输出可能较多，放大上限避免因输出截断误报失败。
        maxBuffer: 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve()
          return
        }

        // Node 在超时杀进程时标记 killed；据此区分超时与普通非零退出。
        if ((error as { killed?: boolean }).killed === true) {
          reject(new Error(`setup 命令超时（超过 ${timeoutMin} 分钟）：${command}`))
          return
        }

        const code = (error as { code?: number | string }).code
        const detail = stderr.trim() || stdout.trim() || error.message
        reject(new Error(`setup 命令执行失败（退出码 ${String(code)}）：${detail}`))
      }
    )
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
