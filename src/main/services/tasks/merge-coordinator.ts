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
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Task, TaskStatus, Workspace } from '../../../shared/types'
import type { AgentRepo } from '../../db/agent-repo'
import type { TaskRepo } from '../../db/task-repo'
import type { WorkspaceRepo } from '../../db/workspace-repo'
import type { EventBus } from '../../events'
import type { GitService } from '../git/git'
import { outOfScopeFiles } from '../git/path-scope'
import type { SerialQueue } from '../git/serial-queue'
import type { TaskFactory } from './task-factory'

/**
 * 可以放弃的状态：任务已经不再由 Agent 执行，也没有正在进行的合并。
 * queued/preparing/running 删除 worktree 会破坏运行中的现场；
 * merging 的合并操作已经在队列中执行；merged 已经合入，不能回退成 abandoned。
 */
const ABANDONABLE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'done',
  'awaiting_approval',
  'conflict',
  'failed',
  'cancelled',
  'interrupted'
])

/**
 * 仍在占用父冲突任务现场的解决任务状态。
 *
 * 解决任务与父冲突任务共享同一分支和 worktree；只要它还没进入终态
 * （failed/cancelled/interrupted/abandoned），父任务的“指派/打开/标记/放弃”
 * 都可能与正在运行的 Agent 同时操作同一目录，造成现场损坏或重复解决任务。
 * done/merging 也算占用：任务已提交但尚未合入，现场仍需保留给合并队列。
 */
const ACTIVE_RESOLVE_CHILD_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'queued',
  'preparing',
  'running',
  'done',
  'merging'
])

export interface MergeCoordinatorDeps {
  queue: SerialQueue
  git: GitService
  tasks: TaskRepo
  agents: AgentRepo
  workspaces: WorkspaceRepo
  events: EventBus
  /** 统一创建任务 + task-card 消息，并在父任务合并后放行委派子任务 */
  factory: TaskFactory
  integrationWorktreePath: (workspaceId: string) => string
}

export class MergeCoordinator {
  private readonly queue: SerialQueue
  private readonly git: GitService
  private readonly tasks: TaskRepo
  private readonly agents: AgentRepo
  private readonly workspaces: WorkspaceRepo
  private readonly events: EventBus
  private readonly factory: TaskFactory
  private readonly integrationWorktreePath: (workspaceId: string) => string

  constructor(deps: MergeCoordinatorDeps) {
    this.queue = deps.queue
    this.git = deps.git
    this.tasks = deps.tasks
    this.agents = deps.agents
    this.workspaces = deps.workspaces
    this.events = deps.events
    this.factory = deps.factory
    this.integrationWorktreePath = deps.integrationWorktreePath
  }

  /** TaskManager 在任务进入 done 后调用；仅 done 任务可合并 */
  mergeTask(taskId: string): Promise<void> {
    return this.queue.run(async () => {
      const task = this.loadTask(taskId)
      if (task.status !== 'done') {
        throw new Error(`只有已完成的任务可以合并：${taskId}`)
      }

      // 合并前的读取/校验失败（工作区或 Agent 记录缺失、worktree 不存在等）
      // 不会进入 performMerge 内部的 git 错误处理；这里统一收敛为 failed，
      // 避免任务永久停在 done 且 UI 收不到任何更新。
      try {
        await this.performMerge(task, false)
      } catch (error) {
        const workspace = this.workspaces.get(task.workspaceId)
        if (workspace !== null) {
          await this.abortMerge(this.integrationWorktreePath(workspace.id))
        }
        this.updateTask(task.id, { status: 'failed', summary: `合并失败：${errorMessage(error)}` })
        this.emitTask(task.id)
      }
    })
  }

  /**
   * 代码任务合并成功后，按工作区配置创建验证任务。
   *
   * 只有代码任务会触发（test/resolve 不再级联），且必须同时开启自动测试、
   * 配置了属于本工作区且处于启用状态的测试 Agent；其余情况静默跳过。
   * 测试任务与普通任务一样入队，由 TaskManager 在启动时创建独立 worktree。
   */
  maybeCreateTestTask(workspace: Workspace, mergedTask: Task): Task | null {
    if (mergedTask.taskType !== 'code' || !workspace.autoTestAfterMerge) {
      return null
    }
    if (workspace.testAgentId === null) {
      return null
    }
    const agent = this.agents.get(workspace.testAgentId)
    if (agent === null || agent.workspaceId !== workspace.id || !agent.enabled) {
      return null
    }

    const test = this.factory.create({
      workspaceId: workspace.id,
      agentId: agent.id,
      parentTaskId: mergedTask.id,
      taskType: 'test',
      title: `验证：${mergedTask.title}`,
      prompt: workspace.testTaskTemplate
    })
    return test
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
    // 一个冲突现场同一时间只能有一个解决任务：两个解决任务会共享同一分支和
    // worktree，彼此覆盖对方的提交，且 UI 无法区分谁的改动。
    if (this.activeResolveChild(conflict.id) !== null) {
      throw new Error('已有进行中的解决任务，请先处理该任务')
    }
    if (conflict.branch === null || conflict.worktreePath === null || conflict.baseRef === null) {
      throw new Error(`冲突任务缺少分支或 worktree 现场：${taskId}`)
    }

    // 解决 Agent 必须属于同一工作区且处于启用状态：跨工作区或已停用的 Agent
    // 无法由本工作区的调度器执行，创建后只会留下永远排队的任务卡片。
    const agent = this.agents.get(agentId)
    if (agent === null || agent.workspaceId !== conflict.workspaceId) {
      throw new Error(`解决 Agent 不存在或不属于该项目：${agentId}`)
    }
    if (!agent.enabled) {
      throw new Error(`解决 Agent 已停用：${agent.name}`)
    }

    const workspace = this.loadWorkspace(conflict)
    const resolve = this.factory.create({
      workspaceId: conflict.workspaceId,
      agentId: agent.id,
      parentTaskId: conflict.id,
      taskType: 'resolve',
      title: `解决冲突：${conflict.title}`,
      prompt: `请将 ${workspace.integrationBranch} 合并到当前分支，解决冲突后提交。\n\n原始任务：${conflict.title}`,
      branch: conflict.branch,
      worktreePath: conflict.worktreePath,
      baseRef: conflict.baseRef
    })
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
      // 解决 Agent 正在同一 worktree 中工作时，用户的手动提交会与其竞争
      // index.lock 和文件内容，必须先处理完（或放弃）该解决任务。
      if (this.activeResolveChild(task.id) !== null) {
        throw new Error('已有进行中的解决任务，请先处理该任务')
      }
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
      // 解决任务仍在运行时删除父任务 worktree 会破坏正在执行的 Agent 现场。
      if (this.activeResolveChild(task.id) !== null) {
        throw new Error('已有进行中的解决任务，请先处理该任务')
      }
      // 运行中或已合并的任务不能放弃：前者会破坏 Agent 现场，后者会回退已合入的状态
      if (!ABANDONABLE_STATUSES.has(task.status)) {
        throw new Error(`只有未合并的任务可以放弃：${taskId}`)
      }
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
      // 没有代码改动时不需要 merge commit，直接结束并清理现场；
      // 但纯分析/问答任务的 Agent 文本结果必须保留，不能被占位摘要覆盖。
      const summary =
        task.summary !== null && task.summary !== '' ? task.summary : '无代码改动'
      await this.removeWorktree(workspace, task)
      this.updateTask(task.id, { status: 'merged', summary })
      this.emitTask(task.id)
      // 父任务已进入 integration，委派子任务现在才能基于包含父任务改动的代码启动
      this.releaseDelegatedChildren(task)
      // 创建验证任务失败只记录日志，不能影响已经完成的合并
      try {
        this.maybeCreateTestTask(workspace, task)
      } catch (error) {
        console.error(`创建测试任务失败：${task.id}`, error)
      }
      return
    }

    // 解决任务的本职就是把 integration 合回自己的分支：baseRef 之后 integration
    // 带入的其他任务改动不属于该 Agent 的越界修改，因此跳过自动合并与范围闸门。
    if (!skipGates && task.taskType !== 'resolve') {
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

    // 只有 code 任务会派生子任务；test/resolve 没有需要放行的子任务
    this.releaseDelegatedChildren(task)

    // 创建验证任务失败只记录日志，不能影响已经完成的合并
    try {
      this.maybeCreateTestTask(workspace, task)
    } catch (error) {
      console.error(`创建测试任务失败：${task.id}`, error)
    }

    // 解决任务合并成功后，父冲突任务不再需要保留冲突现场：
    // 否则卡片会继续提供“打开 worktree / 标记已解决”，而目录已随解决任务删除。
    if (task.taskType === 'resolve' && task.parentTaskId !== null) {
      const parent = this.tasks.get(task.parentTaskId)
      if (parent !== null) {
        this.updateTask(parent.id, {
          status: 'merged',
          summary: '冲突已解决并合入',
          worktreePath: null
        })
        this.emitTask(parent.id)
      }
    }
  }

  /**
   * 任务合入 integration 后放行它的委派子任务。
   *
   * 委派任务在父任务成功结束时创建，但此时父任务的改动还没有进入 integration；
   * 如果立刻启动，子 Agent 会基于缺少父任务改动的代码工作。因此委派任务创建时
   * 延迟入队，只有父任务真正 merged（包括无改动直接 merged）后才放行。
   * 父任务类型不限：测试/解决任务同样可能产生委派子任务。
   * 放行失败只记录日志，不能把已经合入的任务回退为失败。
   */
  private releaseDelegatedChildren(task: Task): void {
    try {
      this.factory.enqueueDeferredChildren(task.id)
    } catch (error) {
      console.error(`启动委派任务失败：${task.id}`, error)
    }
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

  /** 查找父任务当前仍占用现场的解决任务；没有时返回 null */
  private activeResolveChild(parentTaskId: string): Task | null {
    const parent = this.tasks.get(parentTaskId)
    if (parent === null) {
      return null
    }
    const child = this.tasks
      .listByWorkspace(parent.workspaceId)
      .find(
        (task) =>
          task.taskType === 'resolve' &&
          task.parentTaskId === parentTaskId &&
          ACTIVE_RESOLVE_CHILD_STATUSES.has(task.status)
      )
    return child ?? null
  }

  private loadWorkspace(task: Task): Workspace {
    const workspace = this.workspaces.get(task.workspaceId)
    if (workspace === null) {
      throw new Error(`任务所属项目不存在：${task.workspaceId}`)
    }
    return workspace
  }

  private updateTask(taskId: string, patch: Parameters<TaskRepo['update']>[1]): void {
    this.tasks.update(taskId, patch)

    // 测试任务进入终态时同步工作区的最近验证结果：合并完成为通过，其余终态为失败。
    // 合并失败/冲突可能覆盖此前 done 的 passed，按写入顺序以最后一次为准。
    if (patch.status === undefined) {
      return
    }
    const passed = patch.status === 'merged' || patch.status === 'done'
    const terminal =
      passed ||
      patch.status === 'failed' ||
      patch.status === 'conflict' ||
      patch.status === 'cancelled' ||
      patch.status === 'abandoned' ||
      patch.status === 'interrupted'
    if (!terminal) {
      return
    }
    const task = this.tasks.get(taskId)
    if (task === null || task.taskType !== 'test') {
      return
    }
    this.workspaces.update(task.workspaceId, { lastVerification: passed ? 'passed' : 'failed' })
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
