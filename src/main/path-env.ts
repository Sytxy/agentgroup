import { isAbsolute } from 'node:path'

/**
 * 合并登录 shell 的 PATH 与 GUI 进程已有的 PATH。
 *
 * 优先使用登录 shell 的顺序（nvm、Homebrew 等通常在用户 profile 里追加），
 * 再补上当前进程独有的条目，避免重复。空值会被忽略。
 *
 * 只保留绝对路径：用户 shell 的 PATH 里可能存在 ``.``、``bin`` 等相对条目，
 * 而 Agent/git/setup 子进程的 cwd 是任务 worktree。若保留相对条目，仓库中的
 * ``pnpm``、``git``、``claude`` 等同名文件会先于真实命令被找到并执行（PATH
 * 劫持）。相对条目在 GUI 启动场景也没有可预期的语义，因此直接丢弃。
 */
export function mergeUserPath(current: string, shellPath: string): string {
  const result: string[] = []
  const seen = new Set<string>()

  for (const rawEntry of [...shellPath.split(':'), ...current.split(':')]) {
    const entry = rawEntry.trim()
    if (entry === '' || !isAbsolute(entry) || seen.has(entry)) {
      continue
    }
    seen.add(entry)
    result.push(entry)
  }

  return result.join(':')
}
