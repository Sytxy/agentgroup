import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Workspace } from '../../shared/types'
import type { WorkspaceRepo } from '../db/workspace-repo'
import type { DiffStat, GitService } from './git/git'

/** 所有工作区共用的集成分支名；任务完成后合并到这里，再由用户决定何时合入目标分支 */
export const INTEGRATION_BRANCH = 'agentgroup/integration'

export class WorkspaceService {
  private readonly repo: WorkspaceRepo
  private readonly git: GitService
  private readonly worktreesRoot: string

  constructor(deps: { repo: WorkspaceRepo; git: GitService; worktreesRoot: string }) {
    this.repo = deps.repo
    this.git = deps.git
    this.worktreesRoot = deps.worktreesRoot
  }

  /**
   * 校验并登记一个本地仓库：确保集成分支存在，并为其准备长期保留的 worktree。
   * worktree 完成后才写数据库，避免留下指向不存在目录的记录。
   */
  async create(input: {
    name: string
    repoPath: string
    /** 省略时使用仓库当前分支；显式传 null 表示不与任何分支比较 */
    targetBranch?: string | null
  }): Promise<Workspace> {
    let repoPath: string
    try {
      repoPath = await this.git.assertRepo(input.repoPath)
    } catch (error) {
      // 错误信息带上用户选择的目录，渲染进程可以直接提示具体是哪个路径无效
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`无法在 ${input.repoPath} 打开 git 仓库：${detail}`)
    }

    // v1 每个仓库只允许一个工作区：集成分支名固定，若重复创建，git 会因同一分支
    // 已在其他 worktree 检出而失败。这里提前拦截，且必须在创建分支/worktree 之前，
    // 保证失败的第二创建不会留下任何副作用。
    const duplicate = this.repo.list().find((workspace) => workspace.repoPath === repoPath)
    if (duplicate) {
      throw new Error(`该仓库已存在工作区：${duplicate.name}`)
    }

    const id = randomUUID()
    const worktreePath = this.integrationWorktreePath(id)

    try {
      // 复用已有集成分支，保留其历史；只有分支不存在时才从当前 HEAD 新建
      if (!(await this.git.branchExists(repoPath, INTEGRATION_BRANCH))) {
        await this.git.createBranch(repoPath, INTEGRATION_BRANCH, await this.git.head(repoPath))
      }
      // worktree add 只创建末级目录，父目录（worktreesRoot/<id>）可能还不存在
      await mkdir(dirname(worktreePath), { recursive: true })
      // 该路径已是 worktree 时跳过，避免重复添加导致 git 报错
      if (!existsSync(worktreePath)) {
        await this.git.worktreeAddExisting(repoPath, worktreePath, INTEGRATION_BRANCH)
      }
    } catch (error) {
      // 将底层 git 错误与仓库、worktree 路径一起抛出，便于定位是哪个目录出了问题
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`在 ${repoPath} 准备集成 worktree ${worktreePath} 失败：${detail}`)
    }

    // 未指定目标分支时默认使用仓库当前分支，使顶部 diff 统计有可比较的基线；
    // 调用方显式传 null 才表示不做比较。
    const targetBranch =
      input.targetBranch === undefined
        ? await this.git.currentBranch(repoPath)
        : input.targetBranch

    const workspace: Workspace = {
      id,
      name: input.name,
      repoPath,
      integrationBranch: INTEGRATION_BRANCH,
      targetBranch,
      setupCommand: null,
      setupCopy: [],
      setupTimeoutMin: 10,
      taskTimeoutMin: 60,
      autoMerge: true,
      autoTestAfterMerge: false,
      testAgentId: null,
      testTaskTemplate: '运行全部测试并汇总失败用例',
      lastVerification: 'unknown',
      createdAt: new Date().toISOString()
    }

    this.repo.insert(workspace)
    return workspace
  }

  list(): Workspace[] {
    return this.repo.list()
  }

  integrationWorktreePath(workspaceId: string): string {
    return join(this.worktreesRoot, workspaceId, 'integration')
  }

  /** 集成 worktree 相对目标分支的变更规模；没有目标分支时返回全零 */
  async diffStat(workspace: Workspace): Promise<DiffStat> {
    if (workspace.targetBranch === null) {
      return { files: 0, insertions: 0, deletions: 0 }
    }
    return this.git.diffStat(this.integrationWorktreePath(workspace.id), workspace.targetBranch)
  }
}
