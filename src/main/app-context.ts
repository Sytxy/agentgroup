/**
 * 应用上下文组装。
 *
 * 把数据库、仓储、Git/工作区/任务/合并/分派服务装配成一个可复用的对象。
 * 本文件不依赖 Electron，测试可以传入临时路径直接构造。
 */
import { openDatabase, type Db } from './db/database'
import { AgentRepo } from './db/agent-repo'
import { MessageRepo } from './db/message-repo'
import { TaskRepo } from './db/task-repo'
import { WorkspaceRepo } from './db/workspace-repo'
import { EventBus } from './events'
import { DefaultAdapterFactory } from './services/agents/adapter-factory'
import { Dispatcher } from './services/chat/dispatcher'
import { GitService } from './services/git/git'
import { SerialQueue } from './services/git/serial-queue'
import { MergeCoordinator } from './services/tasks/merge-coordinator'
import { SetupRunner } from './services/tasks/setup-runner'
import { TaskManager } from './services/tasks/task-manager'
import { WorkspaceService } from './services/workspace-service'

export interface AppContextDeps {
  /** SQLite 数据库文件路径；测试传临时目录。 */
  dbPath: string
  /** sql.js 的 wasm 文件路径；未提供时交给 sql.js 默认查找。 */
  wasmPath?: string
  /** 所有任务/集成 worktree 的根目录。 */
  worktreesRoot: string
  /** 任务完整日志的根目录，文件名为 <taskId>.log。 */
  logsRoot: string
  /** 在系统文件管理器中打开路径；生产环境接 Electron shell.openPath。 */
  openPath: (path: string) => Promise<void>
}

export interface AppContext {
  db: Db
  workspaces: WorkspaceRepo
  agents: AgentRepo
  tasks: TaskRepo
  messages: MessageRepo
  events: EventBus
  git: GitService
  workspaceService: WorkspaceService
  taskManager: TaskManager
  mergeCoordinator: MergeCoordinator
  dispatcher: Dispatcher
  worktreesRoot: string
  logsRoot: string
  openPath: (path: string) => Promise<void>
}

export async function createAppContext(deps: AppContextDeps): Promise<AppContext> {
  const db = await openDatabase(deps.dbPath, deps.wasmPath)

  const workspaces = new WorkspaceRepo(db)
  const agents = new AgentRepo(db)
  const tasks = new TaskRepo(db)
  const messages = new MessageRepo(db)
  const events = new EventBus()
  const git = new GitService()

  const workspaceService = new WorkspaceService({
    repo: workspaces,
    git,
    worktreesRoot: deps.worktreesRoot
  })

  // TaskManager 与 MergeCoordinator 互相依赖：任务完成回调要调用合并协调器，
  // 合并协调器创建解决任务后又要通过 TaskManager 入队。先声明变量再构造，
  // 回调在真实调用时才读取该变量，避免构造期的循环依赖。
  let mergeCoordinator: MergeCoordinator | undefined
  const coordinator = (): MergeCoordinator => {
    if (mergeCoordinator === undefined) {
      throw new Error('合并协调器尚未初始化')
    }
    return mergeCoordinator
  }

  const taskManager = new TaskManager({
    tasks,
    agents,
    workspaces,
    messages,
    git,
    setup: new SetupRunner(),
    adapters: new DefaultAdapterFactory(),
    events,
    worktreesRoot: deps.worktreesRoot,
    logsRoot: deps.logsRoot,
    onTaskDone: (taskId) => coordinator().mergeTask(taskId),
    onApproveMerge: (taskId) => coordinator().approve(taskId),
    onAbandon: (taskId) => coordinator().abandon(taskId),
    integrationWorktreePath: (workspaceId) => workspaceService.integrationWorktreePath(workspaceId)
  })

  mergeCoordinator = new MergeCoordinator({
    queue: new SerialQueue(),
    git,
    tasks,
    agents,
    workspaces,
    events,
    enqueue: (taskId) => taskManager.enqueue(taskId),
    integrationWorktreePath: (workspaceId) => workspaceService.integrationWorktreePath(workspaceId)
  })

  const dispatcher = new Dispatcher({
    agents,
    tasks,
    messages,
    events,
    enqueue: (taskId) => taskManager.enqueue(taskId)
  })

  return {
    db,
    workspaces,
    agents,
    tasks,
    messages,
    events,
    git,
    workspaceService,
    taskManager,
    mergeCoordinator,
    dispatcher,
    worktreesRoot: deps.worktreesRoot,
    logsRoot: deps.logsRoot,
    openPath: deps.openPath
  }
}
