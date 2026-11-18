/**
 * 全流程集成测试上下文。
 *
 * 用真实组件装配一次完整的应用内链路：临时 sql.js 数据库、真实 git 仓库与
 * worktree、真实的 Dispatcher/TaskManager/MergeCoordinator/WorkspaceService。
 * 唯一替身是脚本化 FakeAdapter，避免启动 Electron 或真实 Agent CLI。
 *
 * createTestContext 返回的对象在测试结束时必须调用 cleanup()：关闭数据库并删除
 * 全部临时目录。调用方应先把任务等待到终态再清理，避免后台运行写入已删除目录。
 */
import { join } from 'node:path'
import type { AgentConfig, Task, TaskStatus, Workspace } from '../../src/shared/types'
import { AgentRepo } from '../../src/main/db/agent-repo'
import { MessageRepo } from '../../src/main/db/message-repo'
import { TaskRepo } from '../../src/main/db/task-repo'
import { WorkspaceRepo } from '../../src/main/db/workspace-repo'
import { EventBus } from '../../src/main/events'
import type { AgentAdapter } from '../../src/main/services/agents/adapter'
import type { AdapterFactory } from '../../src/main/services/agents/adapter-factory'
import { Dispatcher } from '../../src/main/services/chat/dispatcher'
import { GitService } from '../../src/main/services/git/git'
import { SerialQueue } from '../../src/main/services/git/serial-queue'
import { MergeCoordinator } from '../../src/main/services/tasks/merge-coordinator'
import { SetupRunner } from '../../src/main/services/tasks/setup-runner'
import { TaskFactory } from '../../src/main/services/tasks/task-factory'
import { TaskManager } from '../../src/main/services/tasks/task-manager'
import { WorkspaceService } from '../../src/main/services/workspace-service'
import { createTestDb, type TestDb } from './db'
import { FakeAdapter, type FakeAdapterRunCallback } from './fake-adapter'
import { createTempRepo, type TempRepo } from './temp-repo'

/** 仍在执行/合并中的状态：清理前等待它们收尾，避免关闭数据库后后台调度继续访问 */
const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'queued',
  'preparing',
  'running',
  'merging'
])

/**
 * 等待所有任务离开执行态，最多 timeoutMs。
 * 正常测试在断言前已等到终态，这里不会产生等待；仅在用例失败时用于让后台收尾，
 * 防止数据库先被关闭、调度器随后访问已关闭的连接。
 */
async function waitForIdleTasks(
  workspaces: WorkspaceRepo,
  tasks: TaskRepo,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const busy = workspaces
      .list()
      .some((workspace) =>
        tasks.listByWorkspace(workspace.id).some((task) => ACTIVE_TASK_STATUSES.has(task.status))
      )
    if (!busy) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * 每个测试 Agent 的配置与脚本；id 固定为 agent-<name>，便于断言定位。
 * canDelegate 固定为 false，保证场景不会产生额外的委派任务。
 */
export interface TestAgentSpec {
  name: string
  preset?: AgentConfig['preset']
  /** 空数组表示不限制修改范围 */
  pathScope?: string[]
  /** 在任务 worktree 内执行的脚本；返回值作为任务摘要 */
  run: FakeAdapterRunCallback
}

export interface TestContextOptions {
  agents: TestAgentSpec[]
}

export interface TestContext {
  tempRepo: TempRepo
  db: TestDb
  workspaces: WorkspaceRepo
  agents: AgentRepo
  tasks: TaskRepo
  messages: MessageRepo
  events: EventBus
  git: GitService
  workspaceService: WorkspaceService
  workspace: Workspace
  taskManager: TaskManager
  coordinator: MergeCoordinator
  dispatcher: Dispatcher
  worktreesRoot: string
  logsRoot: string
  /** 集成 worktree 绝对路径 */
  integrationPath: string
  /** 按名称读取已落库的 Agent 配置；名称不存在时抛错 */
  agent(name: string): AgentConfig
  /** 关闭数据库并删除临时目录，重复调用安全 */
  cleanup(): Promise<void>
}

/** 按 Agent 的固定 id 选择脚本；未配置脚本说明测试漏配，直接抛错避免静默跳过 */
class ScriptedAdapterFactory implements AdapterFactory {
  constructor(private readonly scripts: ReadonlyMap<string, FakeAdapterRunCallback>) {}

  create(agent: AgentConfig): AgentAdapter {
    const run = this.scripts.get(agent.id)
    if (run === undefined) {
      throw new Error(`测试未为 Agent 配置脚本：${agent.name}`)
    }
    return new FakeAdapter({ run })
  }
}

export async function createTestContext(options: TestContextOptions): Promise<TestContext> {
  const tempRepo = await createTempRepo()
  const testDb = await createTestDb()

  try {
    const workspaces = new WorkspaceRepo(testDb.db)
    const agents = new AgentRepo(testDb.db)
    const tasks = new TaskRepo(testDb.db)
    const messages = new MessageRepo(testDb.db)
    const events = new EventBus()
    const git = new GitService()
    const worktreesRoot = join(tempRepo.root, 'worktrees')
    const logsRoot = join(tempRepo.root, 'logs')
    const workspaceService = new WorkspaceService({ repo: workspaces, git, worktreesRoot })

    // 工作区默认 autoMerge=true、autoTestAfterMerge=false，并由场景显式等待终态
    const workspace = await workspaceService.create({ name: 'Demo', repoPath: tempRepo.path })

    const scripts = new Map<string, FakeAdapterRunCallback>()
    for (const spec of options.agents) {
      const agent: AgentConfig = {
        id: `agent-${spec.name}`,
        workspaceId: workspace.id,
        name: spec.name,
        preset: spec.preset ?? 'custom',
        command: spec.name,
        argsTemplate: '{prompt}',
        rolePrompt: '',
        pathScope: spec.pathScope ?? [],
        permissionProfile: 'edit-and-run',
        canDelegate: false,
        enabled: true
      }
      agents.insert(agent)
      scripts.set(agent.id, spec.run)
    }

    // TaskManager 与 MergeCoordinator 互相依赖，与生产装配方式一致：
    // 先声明再构造，回调在真正触发时才读取变量。
    const integrationWorktreePath = (workspaceId: string): string =>
      workspaceService.integrationWorktreePath(workspaceId)
    let taskManager!: TaskManager
    const taskFactory = new TaskFactory({
      tasks,
      messages,
      events,
      enqueue: (taskId) => taskManager.enqueue(taskId)
    })
    const coordinator = new MergeCoordinator({
      queue: new SerialQueue(),
      git,
      tasks,
      agents,
      workspaces,
      events,
      factory: taskFactory,
      integrationWorktreePath
    })

    taskManager = new TaskManager({
      tasks,
      agents,
      workspaces,
      messages,
      git,
      setup: new SetupRunner(),
      adapters: new ScriptedAdapterFactory(scripts),
      events,
      factory: taskFactory,
      worktreesRoot,
      logsRoot,
      onTaskDone: (taskId) => coordinator.mergeTask(taskId),
      onApproveMerge: (taskId) => coordinator.approve(taskId),
      onAbandon: (taskId) => coordinator.abandon(taskId),
      integrationWorktreePath
    })

    const dispatcher = new Dispatcher({
      agents,
      messages,
      events,
      factory: taskFactory,
      defaultAgentIdFor: (workspaceId) => workspaces.get(workspaceId)?.defaultAgentId ?? null,
      enqueue: (taskId) => taskManager.enqueue(taskId)
    })

    taskManager.start()

    let cleaned = false
    return {
      tempRepo,
      db: testDb,
      workspaces,
      agents,
      tasks,
      messages,
      events,
      git,
      workspaceService,
      workspace,
      taskManager,
      coordinator,
      dispatcher,
      worktreesRoot,
      logsRoot,
      integrationPath: integrationWorktreePath(workspace.id),
      agent(name: string): AgentConfig {
        const found = agents.listByWorkspace(workspace.id).find((item) => item.name === name)
        if (found === undefined) {
          throw new Error(`测试上下文不存在 Agent：${name}`)
        }
        return found
      },
      async cleanup(): Promise<void> {
        if (cleaned) {
          return
        }
        cleaned = true
        await waitForIdleTasks(workspaces, tasks)
        await testDb.cleanup()
        await tempRepo.cleanup()
      }
    }
  } catch (error) {
    // 装配中途失败时也要释放临时资源
    await testDb.cleanup()
    await tempRepo.cleanup()
    throw error
  }
}

/**
 * 轮询任务状态直到匹配或超时。
 * 每 25ms 读取一次数据库，最长等待 timeoutMs（默认 10 秒）；超时错误带上最后观察到的状态。
 */
export async function waitForTaskStatus(
  tasks: TaskRepo,
  taskId: string,
  status: TaskStatus,
  timeoutMs = 10_000
): Promise<Task> {
  const deadline = Date.now() + timeoutMs
  let lastStatus = '不存在'
  while (true) {
    const task = tasks.get(taskId)
    if (task !== null) {
      lastStatus = task.status
      if (task.status === status) {
        return task
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`任务 ${taskId} 未在 ${timeoutMs}ms 内进入 ${status}，最后状态：${lastStatus}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
