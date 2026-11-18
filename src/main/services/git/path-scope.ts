import picomatch from 'picomatch'

/**
 * 返回不在声明范围内的文件。
 * scope 为空表示不限制（全部允许）；pattern 为仓库相对的 POSIX 路径
 * （如 web/**、tests/**、**\/*.md 或具体文件），点开头的目录/文件也参与匹配。
 */
export function outOfScopeFiles(files: string[], scope: string[]): string[] {
  if (scope.length === 0) {
    return []
  }

  const matchesScope = picomatch(scope, { dot: true })
  return files.filter((file) => !matchesScope(file))
}
