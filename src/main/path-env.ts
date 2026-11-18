/**
 * 合并登录 shell 的 PATH 与 GUI 进程已有的 PATH。
 *
 * 优先使用登录 shell 的顺序（nvm、Homebrew 等通常在用户 profile 里追加），
 * 再补上当前进程独有的条目，避免重复。空值会被忽略。
 */
export function mergeUserPath(current: string, shellPath: string): string {
  const result: string[] = []
  const seen = new Set<string>()

  for (const entry of [...shellPath.split(':'), ...current.split(':')]) {
    if (entry === '' || seen.has(entry)) {
      continue
    }
    seen.add(entry)
    result.push(entry)
  }

  return result.join(':')
}
