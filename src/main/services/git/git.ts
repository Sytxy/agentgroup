import { execFile } from 'node:child_process'

export type RunGit = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

/**
 * git 命令执行失败时抛出，保留退出码与 stderr，便于调用方区分“分支不存在”
 * 这类可预期结果和真实的执行失败。
 */
export class GitError extends Error {
  readonly code: number | string | null
  readonly stderr: string

  constructor(args: string[], code: number | string | null, stderr: string, fallback: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || fallback}`)
    this.name = 'GitError'
    this.code = code
    this.stderr = stderr
  }
}

/** 默认实现：直接 execFile 调用 git，不经过 shell，避免参数注入与转义问题 */
export const runGit: RunGit = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new GitError(args, error.code ?? null, stderr, error.message))
        return
      }
      resolve({ stdout, stderr })
    })
  })

export type MergeResult = { status: 'merged' } | { status: 'conflict'; conflicts: string[] }

export type DiffStat = { files: number; insertions: number; deletions: number }

export class GitService {
  constructor(private readonly git: RunGit = runGit) {}

  /** 校验目录位于 git 仓库内，并返回仓库根目录 */
  async assertRepo(path: string): Promise<string> {
    const { stdout } = await this.git(path, ['rev-parse', '--show-toplevel'])
    const root = stdout.trim()
    if (!root) {
      throw new Error(`${path} is not inside a git repository`)
    }
    return root
  }

  async head(repo: string): Promise<string> {
    const { stdout } = await this.git(repo, ['rev-parse', 'HEAD'])
    return stdout.trim()
  }

  /**
   * rev-parse --verify --quiet 在 ref 不存在时以退出码 1 结束，
   * 这是“分支不存在”的正常结果；其他退出码表示 git 执行异常，需要向上抛出。
   */
  async branchExists(repo: string, branch: string): Promise<boolean> {
    try {
      await this.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      return true
    } catch (error) {
      if (error instanceof GitError && error.code === 1) {
        return false
      }
      throw error
    }
  }

  async createBranch(repo: string, branch: string, fromRef: string): Promise<void> {
    await this.git(repo, ['branch', branch, fromRef])
  }

  /** 新建分支并同时检出到独立 worktree，任务实现就在该目录中进行 */
  async worktreeAdd(
    repo: string,
    worktreePath: string,
    newBranch: string,
    fromRef: string
  ): Promise<void> {
    await this.git(repo, ['worktree', 'add', '-b', newBranch, worktreePath, fromRef])
  }

  /** 将已存在的分支检出到独立 worktree（用于验证/测试等复用已有分支的场景） */
  async worktreeAddExisting(repo: string, worktreePath: string, branch: string): Promise<void> {
    await this.git(repo, ['worktree', 'add', worktreePath, branch])
  }

  /** 强制移除 worktree，允许清理由任务遗留的未提交改动 */
  async worktreeRemove(repo: string, worktreePath: string): Promise<void> {
    await this.git(repo, ['worktree', 'remove', '--force', worktreePath])
  }

  /**
   * 提交工作区全部改动。没有改动时返回 null 而不是创建空提交；
   * 有改动时执行 add -A + commit，并返回新提交的 HEAD。
   */
  async commitAll(cwd: string, message: string): Promise<string | null> {
    const { stdout: status } = await this.git(cwd, ['status', '--porcelain'])
    if (status.trim() === '') {
      return null
    }
    await this.git(cwd, ['add', '-A'])
    await this.git(cwd, ['commit', '-m', message])
    return this.head(cwd)
  }

  /** 与 baseRef 的合并基点到 HEAD 之间变更的文件列表 */
  async changedFiles(cwd: string, baseRef: string): Promise<string[]> {
    const { stdout } = await this.git(cwd, ['diff', '--name-only', `${baseRef}...HEAD`])
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  }

  /** 统计与 baseRef 合并基点之间变更的规模，二进制文件的增删行按 0 计 */
  async diffStat(cwd: string, baseRef: string): Promise<DiffStat> {
    const { stdout } = await this.git(cwd, ['diff', '--numstat', `${baseRef}...HEAD`])
    let files = 0
    let insertions = 0
    let deletions = 0

    for (const line of stdout.split('\n')) {
      if (line.trim() === '') {
        continue
      }
      const [added = '', removed = ''] = line.split('\t')
      files += 1
      insertions += added === '-' ? 0 : Number(added)
      deletions += removed === '-' ? 0 : Number(removed)
    }

    return { files, insertions, deletions }
  }

  /**
   * 合并分支。发生冲突时不自动 abort，由调用方决定后续处理（例如中止或转交解决冲突）。
   * 没有未合并文件说明失败原因不是冲突（如分支不存在），此时保留原始错误向上抛出，
   * 避免把 git 执行错误误报为“无冲突文件的冲突”。
   */
  async merge(cwd: string, branch: string): Promise<MergeResult> {
    try {
      await this.git(cwd, ['merge', '--no-ff', branch])
      return { status: 'merged' }
    } catch (error) {
      const { stdout } = await this.git(cwd, ['diff', '--name-only', '--diff-filter=U'])
      const conflicts = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
      if (conflicts.length === 0) {
        throw error
      }
      return { status: 'conflict', conflicts }
    }
  }

  async mergeAbort(cwd: string): Promise<void> {
    await this.git(cwd, ['merge', '--abort'])
  }
}
