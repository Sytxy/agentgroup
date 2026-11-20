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
import { extractMentionIds } from '../chat/mentions'
import type { GitService } from '../git/git'
import { LogWriter } from './log-writer'
import type { SetupRunner } from './setup-runner'
import type { TaskFactory } from './task-factory'

/** 群里进度系统消息的节流间隔：每分钟最多一条，避免刷屏 */
const PROGRESS_MESSAGE_INTERVAL_MS = 60_000

/**
 * 委派链的最大深度：用户直接分派的任务深度为 0，其委派任务为 1。
 * 只允许创建深度不超过该值的任务，防止 Agent 之间无限链式委派。
 */
const MAX_DELEGATION_DEPTH = 3

export interface TaskManagerDeps {
  tasks: TaskRepo
  agents: AgentRepo
  workspaces: WorkspaceRepo
  messages: MessageRepo
  git: GitService
  setup: SetupRunner
  adapters: AdapterFactory
  events: EventBus
  /** 统一创建任务 + task-card 消息；委派任务通过它延迟到父任务合并后启动 */
  factory: TaskFactory
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
  private readonly factory: TaskFactory
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
  /** cancelAll 开始后停止调度，避免已取消任务的收尾 schedule() 又启动新的任务 */
  private shuttingDown = false

  constructor(deps: TaskManagerDeps) {
    this.tasks = deps.tasks
    this.agents = deps.agents
    this.workspaces = deps.workspaces
    this.messages = deps.messages
    this.git = deps.git
    this.setup = deps.setup
    this.adapters = deps.adapters
    this.events = deps.events
    this.factory = deps.factory
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

          // 即使 merging 任务此前经 finish 写入过结束时间，中断态也不能带完成时间
          this.tasks.update(task.id, { status: 'interrupted', finishedAt: null })
          // 测试任务被中断说明验证没有结论，按失败记录
          if (task.taskType === 'test') {
            this.workspaces.update(task.workspaceId, { lastVerification: 'failed' })
          }
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
      // 排队中的测试任务被取消也是一次未完成的验证
      if (task.taskType === 'test') {
        this.workspaces.update(task.workspaceId, { lastVerification: 'failed' })
      }
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

  /**
   * 退出应用前取消所有正在运行的任务。
   *
   * 子进程以独立进程组启动，主进程直接退出会留下孤儿 Agent（可能仍在改动
   * worktree）。这里对每个活动任务合成一次“用户取消”，触发适配器的 AbortSignal
   * 与进程组 SIGTERM，并等待它们收尾。等待最多 5 秒：个别 CLI 不响应 SIGTERM 时
   * 也不能让退出流程无限挂起（ChildProcessRunner 会继续在后台升级为 SIGKILL）。
   */
  async cancelAll(): Promise<void> {
    // 先关闭调度入口：活动任务收到 abort 后会在 launch 的 finally 里再次调用
    // schedule()，如果不拦住，排队任务会在退出前被启动成新的孤儿进程。
    this.shuttingDown = true
    const active = [...this.running.entries()]
    if (active.length === 0) {
      return
    }

    for (const [taskId] of active) {
      this.cancelRequested.add(taskId)
      this.running.get(taskId)?.controller.abort()
    }

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5000)
    })
    try {
      await Promise.race([
        Promise.allSettled(active.map(([, running]) => running.done)),
        timeout
      ])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
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
    // cancelAll 之后不再启动任何新任务
    if (this.shuttingDown) {
      return
    }
    for (const task of this.collectQueued()) {
      if (this.running.has(task.id)) {
        continue
      }
      if (!this.isReady(task)) {
        continue
      }
      if (this.busyAgents.has(task.agentId)) {
        continue
      }
      this.launch(task)
    }
  }

  /**
   * 排队任务是否已具备启动条件。
   *
   * 委派任务（code 且带 parentTaskId）在父任务结束时就已创建，但必须等父任务
   * 真正合入 integration 后才能启动，否则子 Agent 基于缺少父任务改动的代码工作。
   * 这里以父任务状态作为持久化判据：重启后即使内存中的延迟入队记录丢失，
   * 调度器也不会抢跑；父任务合并完成后由 TaskFactory.enqueueDeferredChildren 触发调度。
   * 用户直接分派的任务 parentTaskId 为 null，test/resolve 任务也不受此限制。
   */
  private isReady(task: Task): boolean {
    if (task.taskType !== 'code' || task.parentTaskId === null) {
      return true
    }
    const parent = this.tasks.get(task.parentTaskId)
    return parent !== null && parent.status === 'merged'
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
        // 分支按 Agent 类型分组，例如 claude/<taskId>、codex/<taskId>；
        // 自定义 Agent 没有固定类型，用成员名作前缀，中文名回退为 custom。
        const memberSlug = agent.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 24)
          .replace(/-+$/g, '')
        const branchPrefix =
          agent.preset === 'custom'
            ? memberSlug === ''
              ? 'custom'
              : memberSlug
            : agent.preset
        const branch = `${branchPrefix}/${task.id}`
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
        // CLI 未登录时原始输出只有 “Not logged in · Please run /login” 一类的英文，
        // 统一转成可执行的登录提示；其他失败仍保留原始错误便于排查。
        this.finish(task, 'failed', taskFailureSummary(error, agent), exitCodeOf(error))
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
    // 测试任务结束即代表一次验证：完成记为通过，失败/取消记为失败
    if (task.taskType === 'test') {
      this.workspaces.update(task.workspaceId, {
        lastVerification: status === 'done' ? 'passed' : 'failed'
      })
    }
    this.emitTask(task.id)
    this.addSystemMessage(task, terminalMessage(status, task.title, summary))

    // 成功任务先处理 Agent 委派：委派只依赖摘要与 Agent 配置，放在合并回调之前
    // 创建任务卡片，但委派任务会延迟到父任务 merged 后才入队（见 maybeDelegate）。
    // 失败/取消不触发委派；委派异常只记录，不影响终态与合并。
    if (status === 'done') {
      try {
        this.maybeDelegate(task, summary)
      } catch (error) {
        console.error(`委派任务失败：${task.id}`, error)
      }
    }

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

  /**
   * 任务成功完成后检查并创建 Agent 委派任务。
   *
   * 仅当当前 Agent 开启 canDelegate 且摘要非空时处理。按摘要中的提及顺序取
   * 第一个符合条件的 Agent：属于同一工作区、已启用、不是当前 Agent、不在
   * 祖先链上；若多个提及都合格，v1 只为第一个创建任务，其余忽略。
   *
   * 深度按 parentTaskId 祖先数量计算：用户直接分派的任务为 0，其委派任务
   * 为 1；新任务深度超过 3 时拒绝。祖先 Agent 集合用于阻断环，包括自己
   * 提及自己与 A->B->A 的直接回环。
   */
  private maybeDelegate(task: Task, summary: string | null): void {
    if (summary === null || summary === '') {
      return
    }
    const agent = this.agents.get(task.agentId)
    if (agent === null || !agent.canDelegate) {
      return
    }

    // 一次遍历祖先链同时得到深度与祖先 Agent 集合；visited 防御脏数据中的环。
    const ancestorAgentIds = new Set<string>()
    const visited = new Set<string>([task.id])
    let depth = 0
    let parentId = task.parentTaskId
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId)
      const parent = this.tasks.get(parentId)
      // 父任务缺失（例如被清理）时只能按已找到的祖先计算深度
      if (parent === null) {
        break
      }
      ancestorAgentIds.add(parent.agentId)
      depth += 1
      parentId = parent.parentTaskId
    }

    // 新任务作为当前任务的子任务，深度在当前深度基础上加 1
    if (depth + 1 > MAX_DELEGATION_DEPTH) {
      return
    }

    // 只从当前工作区的 Agent 中匹配，保证目标与来源属于同一工作区
    const candidates = this.agents.listByWorkspace(task.workspaceId)
    const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    let target: AgentConfig | undefined
    for (const id of extractMentionIds(summary, candidates)) {
      const candidate = candidatesById.get(id)
      if (
        candidate !== undefined &&
        candidate.enabled &&
        candidate.id !== task.agentId &&
        !ancestorAgentIds.has(candidate.id)
      ) {
        target = candidate
        break
      }
    }
    if (target === undefined) {
      return
    }

    // 委派任务的 prompt 直接使用摘要原文，让目标 Agent 看到前序工作的完整结论。
    // 关键：此时父任务刚刚 done，改动还没有合入 integration，必须延迟入队
    // （deferEnqueue），由 MergeCoordinator 在父任务 merged 后统一放行。
    this.factory.create({
      workspaceId: task.workspaceId,
      agentId: target.id,
      parentTaskId: task.id,
      taskType: 'code',
      title: `委派：${target.name}`,
      prompt: summary,
      deferEnqueue: true
    })
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

function terminalMessage(status: TaskStatus, title: string, summary: string | null): string {
  const head =
    status === 'done'
      ? `任务完成：${title}`
      : status === 'cancelled'
        ? `任务已取消：${title}`
        : `任务失败：${title}`
  return summary === null || summary === '' ? head : `${head}\n${summary}`
}

/**
 * 把 CLI 的原始认证失败转换成用户能直接照做的中文提示。
 * 只匹配明确的登录错误特征，避免把普通命令输出里的 401/unauthorized 误判为登录问题。
 */
function taskFailureSummary(error: unknown, agent: AgentConfig): string {
  const message = errorMessage(error)
  if (!isAuthenticationFailure(message)) {
    return message
  }
  const loginCommand =
    agent.preset === 'claude'
      ? 'claude auth login'
      : agent.preset === 'codex'
        ? 'codex login'
        : null
  const hint =
    loginCommand === null
      ? '请在终端重新登录该 Agent CLI 后重试。'
      : `请在终端执行「${loginCommand}」完成登录后重试。`
  return `Agent 未登录：${agent.name} 没有可用的登录凭据。${hint}`
}

function isAuthenticationFailure(message: string): boolean {
  return /not logged in|please run \/login|authentication_failed|invalid api key/i.test(
    message
  )
}

function exitCodeOf(error: unknown): number | null {
  return error instanceof AgentRunError ? error.exitCode : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
