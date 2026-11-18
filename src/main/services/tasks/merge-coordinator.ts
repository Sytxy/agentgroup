/**
 * 合并协调器。
 *
 * 任务成功后在独立的 integration worktree 内串行合并：先做无改动判断，
 * 再依次通过自动合并开关与路径范围闸门；真正合并失败时保留任务 worktree 现场，
 * 供 Agent 创建解决任务或用户手动解决。
 *
 * 所有合并动作（包括审批、手动解决后的重试）都经过同一个 SerialQueue，
 * 保证同一时刻只有一个合并操作修改 integration 工作区。
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Task, Workspace } from '../../../shared/types'
import type { AgentRepo } from '../../db/agent-repo'
import type { TaskRepo } from '../../db/task-repo'
import type { WorkspaceRepo } from '../../db/workspace-repo'
import type { EventBus } from '../../events'
import type { GitService } from '../git/git'
import { outOfScopeFiles } from '../git/path-scope'
import type { SerialQueue } from '../git/serial-queue'

export interface MergeCoordinatorDeps {
  queue: SerialQueue
  git: GitService
  tasks: TaskRepo
  agents: AgentRepo
  workspaces: WorkspaceRepo
  events: EventBus
  /** 解决任务插入后重新触发调度，走 TaskManager 的同一套排队逻辑 */
  enqueue: (taskId: string) => void
  integrationWorktreePath: (workspaceId: string) => string
}

export class MergeCoordinator {
  private readonly queue: SerialQueue
  private readonly git: GitService
  private readonly tasks: TaskRepo
  private readonly agents: AgentRepo
  private readonly workspaces: WorkspaceRepo
  private readonly events: EventBus
  private readonly enqueue: (taskId: string) => void
  private readonly integrationWorktreePath: (workspaceId: string) => string

  constructor(deps: MergeCoordinatorDeps) {
    this.queue = deps.queue
    this.git = deps.git
    this.tasks = deps.tasks
    this.agents = deps.agents
    this.workspaces = deps.workspaces
    this.events = deps.events
    this.enqueue = deps.enqueue
    this.integrationWorktreePath = deps.integrationWorktreePath
  }

  /** TaskManager 在任务进入 done 后调用；仅 done 任务可合并 */
  mergeTask(taskId: string): Promise<void> {
    return this.queue.run(async () => {
      const task = this.loadTask(taskId)
      if (task.status !== 'done') {
        throw new Error(`只有已完成的任务可以合并：${taskId}`)
      }
      await this.performMerge(task, false)
    })
  }

  /** 用户审批越界修改或关闭自动合并后的任务；跳过自动合并与范围闸门直接合并 */
  approve(taskId: string): Promise<void> {
    return this.queue.run(async () => {
      const task = this.loadTask(taskId)
      if (task.status !== 'awaiting_approval') {
        throw new Error(`只允许审批等待确认的任务：${taskId}`)
      }
      await this.performMerge(task, true)
    })
  }

  /**
   * 以冲突任务保留的现场创建解决任务：复用同一 Agent 分支与 worktree，
   * 让 Agent 把 integration 合入当前分支并解决冲突；完成后仍走同一合并队列。
   */
  createResolveTask(taskId: string, agentId: string): Task {
    const conflict = this.loadTask(taskId)
    if (conflict.status !== 'conflict') {
      throw new Error(`只为冲突任务创建解决任务：${taskId}`)
    }
    if (conflict.branch === null || conflict.worktreePath === null || conflict.baseRef === null) {
      throw new Error(`冲突任务缺少分支或 worktree 现场：${taskId}`)
    }

    const workspace = this.loadWorkspace(conflict)
    const now = new Date().toISOString()
    const resolve: Task = {
      id: randomUUID(),
      workspaceId: conflict.workspaceId,
      agentId,
      parentTaskId: conflict.id,
      taskType: 'resolve',
      title: `解决冲突：${conflict.title}`,
      prompt: `请将 ${workspace.integrationBranch} 合并到当前分支，解决冲突后提交。\n\n原始任务：${conflict.title}`,
      branch: conflict.branch,
      worktreePath: conflict.worktreePath,
      baseRef: conflict.baseRef,
      status: 'queued',
      exitCode: null,
      summary: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null
    }

    this.tasks.insert(resolve)
    this.enqueue(resolve.id)
    return resolve
  }

  /**
   * 手动解决前打开冲突现场：正常返回原 worktree；若目录已被清理，
   * 用保留的分支重新检出，保证用户仍有可编辑的目录。
   */
  async prepareResolveWorktree(taskId: string): Promise<string> {
    const conflict = this.loadTask(taskId)
    if (conflict.status !== 'conflict') {
      throw new Error(`只有冲突任务可以准备解决 worktree：${taskId}`)
    }
    if (conflict.branch === null || conflict.worktreePath === null) {
      throw new Error(`冲突任务缺少分支或 worktree 现场：${taskId}`)
    }

    const worktreePath = conflict.worktreePath
    if (!existsSync(worktreePath)) {
      const workspace = this.loadWorkspace(conflict)
      // worktree add 只创建末级目录，父目录可能随现场清理一起被删除
      await mkdir(dirname(worktreePath), { recursive: true })
      await this.git.worktreeAddExisting(workspace.repoPath, worktreePath, conflict.branch)
    }
    return worktreePath
  }

  /**
   * 用户手动解决冲突后：确认没有残留的未合并文件，提交残余修改，
   * 再复用同一合并流程（跳过自动闸门，视为用户已明确确认）。
   */
  markManuallyResolved(taskId: string): Promise<void> {
    return this.queue.run(async () => {
      const task = this.loadTask(taskId)
      if (task.status !== 'conflict') {
        throw new Error(`只有冲突任务可以标记为已解决：${taskId}`)
      }
      if (task.worktreePath === null) {
        throw new Error(`冲突任务缺少 worktree 现场：${taskId}`)
      }

      const unmerged = await this.git.unmergedFiles(task.worktreePath)
      if (unmerged.length > 0) {
        throw new Error(`仍存在未解决的冲突文件：${unmerged.join('、')}`)
      }

      await this.git.commitAll(task.worktreePath, `resolve: ${task.title}`)
      await this.performMerge(task, true)
    })
  }

  /** 放弃任务：删除 worktree 现场，分支保留以便追溯；不触碰用户工作区 */
  abandon(taskId: string): Promise<void> {
    return this.queue.run(async () => {
      const task = this.loadTask(taskId)
      const workspace = this.loadWorkspace(task)
      await this.removeWorktree(workspace, task)
      this.updateTask(task.id, { status: 'abandoned' })
      this.emitTask(task.id)
    })
  }

  /**
   * 合并主流程；必须已处在 SerialQueue 内。
   * skipGates 用于审批/手动解决等用户已明确确认的场景。
   */
  private async performMerge(task: Task, skipGates: boolean): Promise<void> {
    const workspace = this.loadWorkspace(task)
    if (task.worktreePath === null || task.baseRef === null || task.branch === null) {
      throw new Error(`任务缺少分支或 worktree 现场：${task.id}`)
    }

    const files = await this.git.changedFiles(task.worktreePath, task.baseRef)
    if (files.length === 0) {
      // 没有代码改动时不需要 merge commit，直接结束并清理现场
      await this.removeWorktree(workspace, task)
      this.updateTask(task.id, { status: 'merged', summary: '无代码改动' })
      this.emitTask(task.id)
      return
    }

    if (!skipGates) {
      if (!workspace.autoMerge) {
        this.updateTask(task.id, { status: 'awaiting_approval', summary: '需要确认合并' })
        this.emitTask(task.id)
        return
      }

      const agent = this.agents.get(task.agentId)
      if (agent === null) {
        throw new Error(`任务所属 Agent 不存在：${task.agentId}`)
      }
      const outOfScope = outOfScopeFiles(files, agent.pathScope)
      if (outOfScope.length > 0) {
        this.updateTask(task.id, {
          status: 'awaiting_approval',
          summary: `修改超出允许范围，需要确认：${outOfScope.join('、')}`
        })
        this.emitTask(task.id)
        return
      }
    }

    this.updateTask(task.id, { status: 'merging' })
    this.emitTask(task.id)

    const integrationWorktree = this.integrationWorktreePath(workspace.id)
    let result: Awaited<ReturnType<GitService['merge']>>
    try {
      result = await this.git.merge(integrationWorktree, task.branch)
    } catch (error) {
      // merge 已把非冲突错误原样抛出（例如分支不存在）；尽力恢复 integration 现场
      await this.abortMerge(integrationWorktree)
      this.updateTask(task.id, { status: 'failed', summary: `合并失败：${errorMessage(error)}` })
      this.emitTask(task.id)
      return
    }

    if (result.status === 'conflict') {
      // 冲突时先中止 integration 的合并，任务 worktree 保持原样供后续解决
      await this.abortMerge(integrationWorktree)
      this.updateTask(task.id, {
        status: 'conflict',
        summary: `合并冲突：${result.conflicts.join('、')}`
      })
      this.emitTask(task.id)
      return
    }

    // 合并成功后先清理任务现场，再落终态；清理失败不能把已经合入的任务误报为失败
    try {
      await this.removeWorktree(workspace, task)
    } catch {
      // 分支已合入 integration，现场清理属于收尾工作，失败时保留目录即可
    }
    this.updateTask(task.id, { status: 'merged' })
    this.emitTask(task.id)
  }

  private async abortMerge(cwd: string): Promise<void> {
    try {
      await this.git.mergeAbort(cwd)
    } catch {
      // 没有进行中的 merge 时 abort 会失败，这里只做尽力恢复
    }
  }

  private async removeWorktree(workspace: Workspace, task: Task): Promise<void> {
    if (task.worktreePath === null || !existsSync(task.worktreePath)) {
      return
    }
    await this.git.worktreeRemove(workspace.repoPath, task.worktreePath)
  }

  private loadTask(taskId: string): Task {
    const task = this.tasks.get(taskId)
    if (task === null) {
      throw new Error(`任务不存在：${taskId}`)
    }
    return task
  }

  private loadWorkspace(task: Task): Workspace {
    const workspace = this.workspaces.get(task.workspaceId)
    if (workspace === null) {
      throw new Error(`任务所属工作区不存在：${task.workspaceId}`)
    }
    return workspace
  }

  private updateTask(taskId: string, patch: Parameters<TaskRepo['update']>[1]): void {
    this.tasks.update(taskId, patch)
  }

  private emitTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (task !== null) {
      this.events.emit({ type: 'task-updated', task })
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
