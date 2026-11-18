import { describe, expect, test } from 'vitest'
import { mergeUserPath } from '../src/main/path-env'

describe('mergeUserPath', () => {
  test('login shell entries come first and current-only entries are appended', () => {
    expect(mergeUserPath('/usr/bin:/bin:/app-only', '/opt/homebrew/bin:/usr/bin:/user-only')).toBe(
      '/opt/homebrew/bin:/usr/bin:/user-only:/bin:/app-only'
    )
  })

  test('duplicates are removed across both paths', () => {
    expect(mergeUserPath('/a:/b:/a', '/b:/c:/c')).toBe('/b:/c:/a')
  })

  test('empty entries are ignored', () => {
    expect(mergeUserPath('::/bin::', ':/usr/local/bin::')).toBe('/usr/local/bin:/bin')
  })

  test('relative entries are dropped so worktree files cannot hijack commands', () => {
    // `.`、`bin`、`../tools` 都会相对任务 worktree 解析；仓库里的同名文件可能劫持
    // pnpm/git/claude 等命令，因此只保留绝对路径。
    expect(mergeUserPath('./node_modules/.bin:/bin:relative', '.:bin:../tools:/usr/bin')).toBe(
      '/usr/bin:/bin'
    )
  })

  test('entries are trimmed before the absolute-path check', () => {
    expect(mergeUserPath(' /usr/bin : . : /bin ', ' /opt/homebrew/bin ')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin'
    )
  })

  test('empty inputs produce an empty PATH', () => {
    expect(mergeUserPath('', '')).toBe('')
  })

  test('one empty side keeps the other unchanged', () => {
    expect(mergeUserPath('', '/usr/bin:/bin')).toBe('/usr/bin:/bin')
    expect(mergeUserPath('/usr/bin:/bin', '')).toBe('/usr/bin:/bin')
  })
})
