/**
 * 任务编排核心。
 *
 * 调度器按 createdAt 顺序挑选排队任务，但同一 Agent 同一时间只运行一个任务。
 * 每个任务在真正启动时创建独立 worktree（基于当时的 integration 提交），
 * 执行环境准备后运行 Agent 适配器，把输出写日志、进度实时推给任务卡片，
 * 结束后提交改动并进入 done/failed/cancelled 之一。合并与 worktree 清理由 Task 12 负责。
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentConfig, ChatMessage, Task, TaskStatus } from '../../../shared/types'
import type { AgentRepo } from '../../db/agent-repo'
import type { MessageRepo } from '../../db/message-repo'
import type { TaskRepo } from '../../db/task-repo'
import type { WorkspaceRepo } from '../../db/workspace-repo'
import type { EventBus } from '../../events'
import { AgentRunError } from '../agents/adapter'
import type { AdapterFactory } from '../agents/adapter-factory'
import type { GitService } from '../git/git'
import { LogWriter } from './log-writer'
import type { SetupRunner } from './setup-runner'

/** 群里进度系统消息的节流间隔：每分钟最多一条，避免刷屏 */
const PROGRESS_MESSAGE_INTERVAL_MS = 60_000

export interface TaskManagerDeps {
  tasks: TaskRepo
  agents: AgentRepo
  workspaces: WorkspaceRepo
  messages: MessageRepo
  git: GitService
  setup: SetupRunner
  adapters: AdapterFactory
  events: EventBus
  worktreesRoot: string
  logsRoot: string
  now?: () => Date
  /** 任务进入 done 后通知合并协调器；失败/取消不触发 */
  onTaskDone?: (taskId: string) => void
  /** IPC 层审批合并的转发目标；未注入时对应操作不可用 */
  onApproveMerge?: (taskId: string) => Promise<void>
  /** IPC 层放弃任务的转发目标；未注入时对应操作不可用 */
  onAbandon?: (taskId: string) => Promise<void>
  /** 集成 worktree 路径；默认与 WorkspaceService 的约定一致，崩溃恢复时用于中止残留合并 */
  integrationWorktreePath?: (workspaceId: string) => string
}

interface RunningTask {
  controller: AbortController
  /** 任务运行结束（无论成败）时 resolve，供 cancel 等待 */
  done: Promise<void>
}

export class TaskManager {
  private readonly tasks: TaskRepo
  private readonly agents: AgentRepo
  private readonly workspaces: WorkspaceRepo
  private readonly messages: MessageRepo
  private readonly git: GitService
  private readonly setup: SetupRunner
  private readonly adapters: AdapterFactory
  private readonly events: EventBus
  private readonly worktreesRoot: string
  private readonly logsRoot: string
  private readonly now: () => Date
  private readonly onTaskDone?: (taskId: string) => void
  private readonly onApproveMerge?: (taskId: string) => Promise<void>
  private readonly onAbandon?: (taskId: string) => Promise<void>
  private readonly integrationWorktreePath: (workspaceId: string) => string

  /** 正在运行的任务，value 持有取消信号与完成 Promise */
  private readonly running = new Map<string, RunningTask>()
  /** Agent 占用表：agentId -> 正在执行的任务 id */
  private readonly busyAgents = new Map<string, string>()
  /** 用户主动取消的任务；与超时区分，决定终态是 cancelled 还是 failed */
  private readonly cancelRequested = new Set<string>()

  constructor(deps: TaskManagerDeps) {
    this.tasks = deps.tasks
    this.agents = deps.agents
    this.workspaces = deps.workspaces
    this.messages = deps.messages
    this.git = deps.git
    this.setup = deps.setup
    this.adapters = deps.adapters
    this.events = deps.events
    this.worktreesRoot = deps.worktreesRoot
    this.logsRoot = deps.logsRoot
    this.now = deps.now ?? (() => new Date())
    this.onTaskDone = deps.onTaskDone
    this.onApproveMerge = deps.onApproveMerge
    this.onAbandon = deps.onAbandon
    // 与 WorkspaceService.integrationWorktreePath 保持同一目录约定
    this.integrationWorktreePath =
      deps.integrationWorktreePath ??
      ((workspaceId) => join(this.worktreesRoot, workspaceId, 'integration'))
  }

  /** 启动调度：应用启动时调用一次，接管数据库中已存在的排队任务 */
  start(): void {
    this.schedule()
  }

  /**
   * 应用启动时修复上次异常退出留下的状态。
   *
   * preparing/running/merging 说明任务在执行或合并途中被打断：先尽力中止 integration
   * worktree 里可能残留的半完成合并，再把任务标为 interrupted（不写结束时间）。
   * interrupted 不属于调度器挑选的排队状态，因此不会自动重跑，只能由用户显式重试。
   * done 但尚未合并的任务（重启前 onTaskDone 没来得及执行）重新交给合并协调器补合并。
   */
  recoverInterrupted(): void {
    void (async () => {
      for (const workspace of this.workspaces.list()) {
        for (const task of this.tasks.listByWorkspace(workspace.id)) {
          if (
            task.status !== 'preparing' &&
            task.status !== 'running' &&
            task.status !== 'merging'
          ) {
            continue
          }

          // 只有 merging 会留下半完成的合并；其余状态 abort 失败属于可忽略的尽力恢复
          try {
            await this.git.mergeAbort(this.integrationWorktreePath(workspace.id))
          } catch {
            // 没有进行中的合并，无需处理
          }

          this.tasks.update(task.id, { status: 'interrupted' })
          this.emitTask(task.id)
        }
      }

      // 重启前已成功但未来得及合并的任务：补调回调，让合并协调器继续收尾
      if (this.onTaskDone !== undefined) {
        for (const workspace of this.workspaces.list()) {
          for (const task of this.tasks.listByWorkspace(workspace.id)) {
            if (task.status !== 'done') {
              continue
            }
            try {
              const pending: unknown = this.onTaskDone(task.id)
              if (pending instanceof Promise) {
                void pending.catch((error: unknown) => {
                  console.error(`合并任务失败：${task.id}`, error)
                })
              }
            } catch (error) {
              // 单个任务补合并失败不能阻止其余任务
              console.error(`合并任务失败：${task.id}`, error)
            }
          }
        }
      }
    })().catch((error: unknown) => {
      // 恢复流程中的数据库/查询异常不应变成未处理的 Promise 拒绝
      console.error('恢复中断任务失败', error)
    })
  }

  /** 新任务落库后触发调度；队列顺序始终以数据库中的 createdAt 为准 */
  enqueue(taskId: string): void {
    if (this.tasks.get(taskId) === null) {
      return
    }
    this.schedule()
  }

  /**
   * 取消任务。运行中：标记用户取消并中止适配器，等待运行收尾后返回；
   * 仍在排队：直接置为 cancelled 并回群通知。已进入终态的任务不做处理。
   */
  async cancel(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (task === null) {
      throw new Error(`任务不存在：${taskId}`)
    }

    const running = this.running.get(taskId)
    if (running !== undefined) {
      this.cancelRequested.add(taskId)
      running.controller.abort()
      await running.done
      return
    }

    if (task.status === 'queued') {
      this.tasks.update(taskId, {
        status: 'cancelled',
        summary: '任务已取消',
        finishedAt: this.now().toISOString()
      })
      this.emitTask(taskId)
      this.addSystemMessage(task, `任务已取消：${task.title}`)
    }
  }

  /**
   * 重试任务：仅 interrupted/failed/cancelled 可重试。
   * 普通任务重试前彻底清理旧现场（worktree 目录、git worktree 元数据、旧分支），
   * 保证新一次执行从干净的 integration 基线开始；清理失败时保持原状态可再次重试。
   * 解决任务与父冲突任务共享分支与 worktree，重试时只重置运行结果、保留现场。
   * 原始 prompt 与标题始终保留。
   */
  async retry(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (task === null) {
      throw new Error(`任务不存在：${taskId}`)
    }
    if (task.status !== 'interrupted' && task.status !== 'failed' && task.status !== 'cancelled') {
      throw new Error(`只有中断、失败或取消的任务可以重试：${taskId}`)
    }

    const workspace = this.workspaces.get(task.workspaceId)
    if (workspace === null) {
      throw new Error(`任务所属工作区不存在：${task.workspaceId}`)
    }

    // 解决任务复用父冲突任务的现场：清理会连同父任务的 worktree/分支一起删除。
    // 目录已被清理或不再是有效 worktree（缺少 .git 标记）时无法恢复现场，只能放弃后重新指派。
    if (task.taskType === 'resolve') {
      if (task.worktreePath === null || !existsSync(join(task.worktreePath, '.git'))) {
        throw new Error('解决任务的工作区已不存在，请放弃后重新指派')
      }

      this.tasks.update(taskId, {
        status: 'queued',
        exitCode: null,
        summary: null,
        startedAt: null,
        finishedAt: null
      })
      this.emitTask(taskId)
      this.enqueue(taskId)
      return
    }

    try {
      if (task.worktreePath !== null) {
        // 崩溃后目录可能已被移除：先按实际存在与否清理，再 prune 失效的 worktree 元数据
        if (existsSync(task.worktreePath)) {
          await this.git.worktreeRemove(workspace.repoPath, task.worktreePath)
        }
        await this.git.pruneWorktrees(workspace.repoPath)
      }
      if (task.branch !== null && (await this.git.branchExists(workspace.repoPath, task.branch))) {
        await this.git.deleteBranch(workspace.repoPath, task.branch)
      }
    } catch (error) {
      // 清理失败时不入队，任务仍是可重试状态，用户可再次重试
      throw new Error(`重试前清理任务现场失败：${errorMessage(error)}`)
    }

    this.tasks.update(taskId, {
      status: 'queued',
      branch: null,
      worktreePath: null,
      baseRef: null,
      exitCode: null,
      summary: null,
      startedAt: null,
      finishedAt: null
    })
    this.emitTask(taskId)
    this.enqueue(taskId)
  }

  /**
   * 审批合并：只做转发，合并闸门与状态更新由合并协调器负责。
   * 未注入回调时明确报错，避免静默忽略用户操作。
   */
  async approveMerge(taskId: string): Promise<void> {
    if (this.onApproveMerge === undefined) {
      throw new Error('未配置合并协调器：无法审批合并')
    }
    await this.onApproveMerge(taskId)
  }

  /** 放弃任务：同样转发给合并协调器清理 worktree 并更新状态 */
  async abandon(taskId: string): Promise<void> {
    if (this.onAbandon === undefined) {
      throw new Error('未配置合并协调器：无法放弃任务')
    }
    await this.onAbandon(taskId)
  }

  /** 收集所有工作区的排队任务并按 createdAt 正序排列 */
  private collectQueued(): Task[] {
    const queued: Task[] = []
    for (const workspace of this.workspaces.list()) {
      for (const task of this.tasks.listByWorkspace(workspace.id)) {
        if (task.status === 'queued') {
          queued.push(task)
        }
      }
    }

    queued.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? -1 : 1
      }
      // 同一消息分派的任务共享时间戳，使用 id 保证顺序稳定
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    return queued
  }

  /** 为每个空闲 Agent 启动其最早的排队任务 */
  private schedule(): void {
    for (const task of this.collectQueued()) {
      if (this.running.has(task.id)) {
        continue
      }
      if (this.busyAgents.has(task.agentId)) {
        continue
      }
      this.launch(task)
    }
  }

  private launch(task: Task): void {
    const controller = new AbortController()
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })

    // 先登记占用再开始执行，保证同一轮调度不会重复启动同一 Agent 的任务
    this.running.set(task.id, { controller, done })
    this.busyAgents.set(task.agentId, task.id)
    this.events.emit({ type: 'agent-status', agentId: task.agentId, status: 'busy' })

    void (async () => {
      try {
        await this.execute(task.id, controller)
      } catch (error) {
        // execute 已处理所有预期失败；这里兜底，避免异常逃逸导致 Agent 永久占用
        const current = this.tasks.get(task.id)
        if (current !== null && isActiveStatus(current.status)) {
          this.finish(task, 'failed', `任务执行异常：${errorMessage(error)}`, null)
        }
      } finally {
        this.running.delete(task.id)
        this.busyAgents.delete(task.agentId)
        this.cancelRequested.delete(task.id)
        this.events.emit({ type: 'agent-status', agentId: task.agentId, status: 'idle' })
        resolveDone()
        // 任意终态都会释放 Agent，此时才有机会启动该 Agent 的下一个任务
        this.schedule()
      }
    })()
  }

  /** 用户已请求取消，或运行信号已中止（setup 阶段的 abort 仅来自取消） */
  private isCancelled(taskId: string, signal: AbortSignal): boolean {
    return this.cancelRequested.has(taskId) || signal.aborted
  }

  /** 单个任务的完整运行流程；所有失败都在这里收敛成终态，不向上抛错 */
  private async execute(taskId: string, controller: AbortController): Promise<void> {
    const task = this.tasks.get(taskId)
    if (task === null) {
      return
    }

    const workspace = this.workspaces.get(task.workspaceId)
    if (workspace === null) {
      this.finish(task, 'failed', `任务所属工作区不存在：${task.workspaceId}`, null)
      return
    }
    const agent = this.agents.get(task.agentId)
    if (agent === null) {
      this.finish(task, 'failed', `任务所属 Agent 不存在：${task.agentId}`, null)
      return
    }

    // 解决冲突任务复用冲突现场：跳过 worktree 创建与 setup，在原分支上继续执行
    const reusesWorktree = task.taskType === 'resolve' && task.worktreePath !== null

    let worktreePath: string
    try {
      if (reusesWorktree) {
        worktreePath = task.worktreePath as string
        this.tasks.update(task.id, {
          status: 'preparing',
          startedAt: this.now().toISOString()
        })
        this.emitTask(task.id)
      } else {
        worktreePath = join(this.worktreesRoot, task.workspaceId, task.id)
        const branch = `agent/${task.id}-${branchSlug(task.title)}`
        // baseRef 记录任务启动时 integration 分支的确切提交，后面按其创建分支
        const baseRef = await this.git.revParse(workspace.repoPath, workspace.integrationBranch)

        this.tasks.update(task.id, {
          status: 'preparing',
          branch,
          worktreePath,
          baseRef,
          startedAt: this.now().toISOString()
        })
        this.emitTask(task.id)

        // git worktree add 只创建末级目录，父目录（worktreesRoot/<workspaceId>）可能不存在
        await mkdir(dirname(worktreePath), { recursive: true })
        await this.git.worktreeAdd(workspace.repoPath, worktreePath, branch, baseRef)
      }
    } catch (error) {
      this.finish(task, 'failed', `准备任务 worktree 失败：${errorMessage(error)}`, null)
      return
    }

    let copiedPaths: string[] = []
    if (!reusesWorktree) {
      // 取消可能发生在 worktree 创建完成、setup 尚未开始的间隙
      if (this.isCancelled(task.id, controller.signal)) {
        this.finish(task, 'cancelled', '任务已取消', null)
        return
      }

      const setupResult = await this.setup.run({
        worktreePath,
        repoPath: workspace.repoPath,
        command: workspace.setupCommand,
        copy: workspace.setupCopy,
        timeoutMin: workspace.setupTimeoutMin,
        signal: controller.signal
      })
      if (!setupResult.ok) {
        // setup 期间被取消时终态是 cancelled；其他失败保留 worktree 现场便于排查
        if (this.isCancelled(task.id, controller.signal)) {
          this.finish(task, 'cancelled', '任务已取消', null)
        } else {
          this.finish(task, 'failed', `环境准备失败：${setupResult.error}`, null)
        }
        return
      }
      // 取消可能恰好落在 setup 结束之后；此时不再进入 running，也不发开始消息
      if (this.isCancelled(task.id, controller.signal)) {
        this.finish(task, 'cancelled', '任务已取消', null)
        return
      }
      copiedPaths = setupResult.copiedPaths
    }

    // setup 复制的是运行环境文件（如 .env），不能进入 Agent 提交与后续合并。
    // 已忽略的文件不会被 commitAll 的 git add -A 加入；未忽略时在启动 Agent 前快速失败。
    try {
      const notIgnored = await this.git.isIgnored(worktreePath, copiedPaths)
      if (notIgnored.length > 0) {
        this.finish(
          task,
          'failed',
          `setup_copy 目标未被 .gitignore 忽略：${notIgnored.join('、')}`,
          null
        )
        return
      }
    } catch (error) {
      this.finish(task, 'failed', `检查 setup_copy 忽略状态失败：${errorMessage(error)}`, null)
      return
    }

    // 兜底：resolve 任务复用 worktree 或忽略检查期间发生取消时，仍不进入 running
    if (this.isCancelled(task.id, controller.signal)) {
      this.finish(task, 'cancelled', '任务已取消', null)
      return
    }

    this.tasks.update(task.id, { status: 'running' })
    this.emitTask(task.id)
    this.addSystemMessage(task, `开始执行任务：${task.title}`)

    let summary: string | null = null
    let timedOut = false
    let lastProgressMessageAt: number | null = null
    // 超时只覆盖 Agent 运行阶段；setup 时间不计入任务超时
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, workspace.taskTimeoutMin * 60_000)

    try {
      const writer = new LogWriter(this.logsRoot, task.id)
      await writer.reset()

      const adapter = this.adapters.create(agent)
      const prompt = composePrompt(agent, task)

      for await (const event of adapter.start({
        prompt,
        cwd: worktreePath,
        signal: controller.signal
      })) {
        if (event.type === 'log') {
          await writer.append(`${event.text}\n`)
          continue
        }

        if (event.type === 'progress') {
          // 任务卡片实时滚动依赖 task-progress；群消息按每分钟一条节流
          this.events.emit({ type: 'task-progress', taskId: task.id, lines: [event.text] })
          const nowMs = this.now().getTime()
          if (
            lastProgressMessageAt === null ||
            nowMs - lastProgressMessageAt >= PROGRESS_MESSAGE_INTERVAL_MS
          ) {
            lastProgressMessageAt = nowMs
            this.addSystemMessage(task, event.text)
          }
          continue
        }

        summary = event.summary
      }

      // 成功结束后提交全部改动；没有改动时返回 null，摘要标记为无代码改动
      const commit = await this.git.commitAll(
        worktreePath,
        `agent(${agent.name}): ${task.title}`
      )
      if (commit === null) {
        summary = '无代码改动'
      }
      this.finish(task, 'done', summary, 0)
    } catch (error) {
      // 超时优先于用户取消判断：两种路径都会 abort，但终态语义不同
      if (timedOut) {
        this.finish(
          task,
          'failed',
          `任务超时（超过 ${workspace.taskTimeoutMin} 分钟未完成）`,
          exitCodeOf(error)
        )
      } else if (this.cancelRequested.has(task.id)) {
        this.finish(task, 'cancelled', '任务已取消', exitCodeOf(error))
      } else {
        this.finish(task, 'failed', errorMessage(error), exitCodeOf(error))
      }
    } finally {
      clearTimeout(timeoutTimer)
    }
  }

  /** 写入终态：持久化状态/摘要/退出码/结束时间，广播任务卡片并回群系统消息 */
  private finish(
    task: Task,
    status: TaskStatus,
    summary: string | null,
    exitCode: number | null
  ): void {
    this.tasks.update(task.id, {
      status,
      summary,
      exitCode,
      finishedAt: this.now().toISOString()
    })
    this.emitTask(task.id)
    this.addSystemMessage(task, terminalMessage(status, task.title, summary))

    // 成功任务交给合并协调器；回调失败只记录，不影响任务终态与 Agent 释放
    if (status === 'done' && this.onTaskDone !== undefined) {
      try {
        const pending: unknown = this.onTaskDone(task.id)
        if (pending instanceof Promise) {
          void pending.catch((error: unknown) => {
            console.error(`合并任务失败：${task.id}`, error)
          })
        }
      } catch (error) {
        console.error(`合并任务失败：${task.id}`, error)
      }
    }
  }

  private emitTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (task !== null) {
      this.events.emit({ type: 'task-updated', task })
    }
  }

  private addSystemMessage(task: Task, content: string): void {
    const message: ChatMessage = {
      id: randomUUID(),
      workspaceId: task.workspaceId,
      kind: 'system',
      authorType: 'system',
      authorId: null,
      content,
      taskId: task.id,
      createdAt: this.now().toISOString()
    }
    this.messages.insert(message)
    this.events.emit({ type: 'message', message })
  }
}

/** 运行中的状态；其余状态视为终态（合并相关状态由 Task 12 管理） */
function isActiveStatus(status: TaskStatus): boolean {
  return status === 'queued' || status === 'preparing' || status === 'running'
}

/**
 * 拼装 Agent 提示：角色说明、路径范围约束与任务文本之间用空行分隔。
 * 路径范围同时用于合并前的越界检查，写进 prompt 是为了让 Agent 提前遵守。
 */
function composePrompt(agent: AgentConfig, task: Task): string {
  const parts: string[] = []
  if (agent.rolePrompt.trim() !== '') {
    parts.push(agent.rolePrompt)
  }
  parts.push(`你的修改范围：${agent.pathScope.join('、')}；为空表示不限`)
  parts.push(task.prompt)
  return parts.join('\n\n')
}

/** 任务标题转分支 slug：小写、非字母数字折叠为 '-'、去首尾 '-'、最多 30 字符 */
function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '')
  return slug === '' ? 'task' : slug
}

function terminalMessage(status: TaskStatus, title: string, summary: string | null): string {
  const head =
    status === 'done'
      ? `任务完成：${title}`
      : status === 'cancelled'
        ? `任务已取消：${title}`
        : `任务失败：${title}`
  return summary === null || summary === '' ? head : `${head}\n${summary}`
}

function exitCodeOf(error: unknown): number | null {
  return error instanceof AgentRunError ? error.exitCode : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
