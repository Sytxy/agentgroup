import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AgentRepo } from '../../src/main/db/agent-repo'
import { MessageRepo } from '../../src/main/db/message-repo'
import { TaskRepo } from '../../src/main/db/task-repo'
import { WorkspaceRepo } from '../../src/main/db/workspace-repo'
import { EventBus } from '../../src/main/events'
import { GitService, runGit } from '../../src/main/services/git/git'
import { SetupRunner } from '../../src/main/services/tasks/setup-runner'
import { TaskFactory } from '../../src/main/services/tasks/task-factory'
import { TaskManager } from '../../src/main/services/tasks/task-manager'
import {
  INTEGRATION_BRANCH,
  WorkspaceService
} from '../../src/main/services/workspace-service'
import type { AgentConfig, AppEvent, Task, Workspace } from '../../src/shared/types'
import { createTestDb, type TestDb } from '../helpers/db'
import { FakeAdapter } from '../helpers/fake-adapter'
import { createTempRepo, gitRun, type TempRepo } from '../helpers/temp-repo'

const FIXED_TIME = '2026-11-18T10:00:00.000Z'

let tempRepo: TempRepo
let testDb: TestDb
let workspaces: WorkspaceRepo
let agents: AgentRepo
let tasks: TaskRepo
let messages: MessageRepo
let events: EventBus
let git: GitService
let workspaceService: WorkspaceService
let workspace: Workspace
let worktreesRoot: string
let logsRoot: string
let seen: AppEvent[]

beforeEach(async () => {
  tempRepo = await createTempRepo()
  testDb = await createTestDb()
  workspaces = new WorkspaceRepo(testDb.db)
  agents = new AgentRepo(testDb.db)
  tasks = new TaskRepo(testDb.db)
  messages = new MessageRepo(testDb.db)
  events = new EventBus()
  git = new GitService()
  worktreesRoot = join(tempRepo.root, 'worktrees')
  logsRoot = join(tempRepo.root, 'logs')
  workspaceService = new WorkspaceService({ repo: workspaces, git, worktreesRoot })
  workspace = await workspaceService.create({ name: 'Demo', repoPath: tempRepo.path })
  seen = []
  events.on((event) => seen.push(event))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await testDb.cleanup()
  await tempRepo.cleanup()
})

function insertAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const agent: AgentConfig = {
    id: 'agent-claude',
    workspaceId: workspace.id,
    name: 'claude',
    preset: 'claude',
    command: 'claude',
    argsTemplate: null,
    rolePrompt: '',
    pathScope: [],
    permissionProfile: 'edit-and-run',
    canDelegate: false,
    enabled: true,
    ...overrides
  }
  agents.insert(agent)
  return agent
}

function insertTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: randomUUID(),
    workspaceId: workspace.id,
    agentId: 'agent-claude',
    parentTaskId: null,
    taskType: 'code',
    title: 'Task',
    prompt: '做点事',
    branch: null,
    worktreePath: null,
    baseRef: null,
    status: 'queued',
    exitCode: null,
    summary: null,
    createdAt: FIXED_TIME,
    startedAt: null,
    finishedAt: null,
    ...overrides
  }
  tasks.insert(task)
  return task
}

function createManager(
  adapter: FakeAdapter,
  overrides: Partial<ConstructorParameters<typeof TaskManager>[0]> = {}
): TaskManager {
  let manager!: TaskManager
  const factory = new TaskFactory({
    tasks,
    messages,
    events,
    enqueue: (taskId) => manager.enqueue(taskId)
  })
  manager = new TaskManager({
    tasks,
    agents,
    workspaces,
    messages,
    git,
    setup: new SetupRunner(),
    adapters: { create: () => adapter },
    events,
    factory,
    worktreesRoot,
    logsRoot,
    ...overrides
  })
  return manager
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor 超时：条件未在预期时间内成立')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function recordStatuses(taskId: string): string[] {
  return seen
    .filter(
      (event): event is Extract<AppEvent, { type: 'task-updated' }> =>
        event.type === 'task-updated' && event.task.id === taskId
    )
    .map((event) => event.task.status)
}

function integrationPath(): string {
  return workspaceService.integrationWorktreePath(workspace.id)
}

describe('crash recovery', () => {
  test('startup marks preparing/running/merging tasks as interrupted and emits updates', async () => {
    insertAgent()
    const preparing = insertTask({ title: 'Preparing', status: 'preparing' })
    const running = insertTask({ title: 'Running', status: 'running' })
    const merging = insertTask({
      title: 'Merging',
      status: 'merging',
      // 合并流程会先经 finish 写入结束时间，恢复时必须清掉
      finishedAt: FIXED_TIME
    })
    const queued = insertTask({ title: 'Still queued', status: 'queued' })

    const manager = createManager(new FakeAdapter())
    manager.recoverInterrupted()

    await waitFor(
      () =>
        tasks.get(preparing.id)?.status === 'interrupted' &&
        tasks.get(running.id)?.status === 'interrupted' &&
        tasks.get(merging.id)?.status === 'interrupted'
    )

    for (const task of [preparing, running, merging]) {
      const stored = tasks.get(task.id) as Task
      expect(stored.status).toBe('interrupted')
      // 中断不是正常结束，不写结束时间
      expect(stored.finishedAt).toBeNull()
      expect(recordStatuses(task.id)).toContain('interrupted')
    }
    // 未开始的任务不受恢复影响
    expect(tasks.get(queued.id)?.status).toBe('queued')
  })

  test('interrupted tasks are not dispatched automatically', async () => {
    insertAgent()
    const interrupted = insertTask({ title: 'Interrupted', status: 'interrupted' })
    const adapter = new FakeAdapter()

    const manager = createManager(adapter)
    manager.start()
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(adapter.runs).toHaveLength(0)
    expect(tasks.get(interrupted.id)?.status).toBe('interrupted')
  })

  test('retry cleans the stale branch and worktree, then runs the task again', async () => {
    insertAgent()
    const id = randomUUID()
    const worktreePath = join(worktreesRoot, workspace.id, id)
    const staleBranch = `agent/${id}-stale`
    const baseRef = await git.revParse(tempRepo.path, INTEGRATION_BRANCH)

    // 旧现场：已检出的分支 + worktree 里还有未提交的残留文件
    await mkdir(dirname(worktreePath), { recursive: true })
    await git.worktreeAdd(tempRepo.path, worktreePath, staleBranch, baseRef)
    await writeFile(join(worktreePath, 'STALE.md'), 'leftover\n')

    const task = insertTask({
      id,
      title: 'Retry cleanup',
      prompt: '保留这段提示词',
      status: 'failed',
      branch: staleBranch,
      worktreePath,
      baseRef,
      exitCode: 1,
      summary: '环境准备失败',
      startedAt: FIXED_TIME,
      finishedAt: FIXED_TIME
    })

    const adapter = new FakeAdapter({
      steps: [
        {
          before: async (cwd) => {
            await writeFile(join(cwd, 'OUT.md'), 'fresh run\n')
          },
          event: { type: 'final', summary: '重试完成' }
        }
      ]
    })
    const manager = createManager(adapter)

    await manager.retry(task.id)

    const reset = tasks.get(task.id) as Task
    expect(reset.status).toBe('queued')
    expect(reset.branch).toBeNull()
    expect(reset.worktreePath).toBeNull()
    expect(reset.baseRef).toBeNull()
    expect(reset.startedAt).toBeNull()
    expect(reset.finishedAt).toBeNull()
    expect(reset.exitCode).toBeNull()
    expect(reset.summary).toBeNull()
    // 原始提示词与标题保留
    expect(reset.prompt).toBe('保留这段提示词')
    expect(reset.title).toBe('Retry cleanup')

    await waitFor(() => tasks.get(task.id)?.status === 'done')

    const stored = tasks.get(task.id) as Task
    expect(stored.branch).toBe(`agent/${id}-retry-cleanup`)
    expect(stored.worktreePath).toBe(worktreePath)
    // 旧分支已删除，新分支由全新 worktree 创建
    expect(await git.branchExists(tempRepo.path, staleBranch)).toBe(false)
    expect(await git.branchExists(tempRepo.path, stored.branch as string)).toBe(true)
    // 残留文件没有进入新现场
    expect(existsSync(join(worktreePath, 'STALE.md'))).toBe(false)
    expect(existsSync(join(worktreePath, 'OUT.md'))).toBe(true)
    expect(adapter.runs).toHaveLength(1)
  })

  test('retry on a non-retryable status rejects without changing the task', async () => {
    insertAgent()
    const task = insertTask({ title: 'Already merged', status: 'merged' })

    const manager = createManager(new FakeAdapter())

    await expect(manager.retry(task.id)).rejects.toThrow(
      '只有中断、失败或取消的任务可以重试'
    )
    expect(tasks.get(task.id)?.status).toBe('merged')
  })

  test('retry cleanup failure produces a readable error and leaves the task retryable', async () => {
    insertAgent()
    const id = randomUUID()
    const worktreePath = join(worktreesRoot, workspace.id, id)
    const branch = `agent/${id}-cleanup-failure`
    const baseRef = await git.revParse(tempRepo.path, INTEGRATION_BRANCH)

    await mkdir(dirname(worktreePath), { recursive: true })
    await git.worktreeAdd(tempRepo.path, worktreePath, branch, baseRef)

    const task = insertTask({
      title: 'Cleanup failure',
      status: 'failed',
      branch,
      worktreePath,
      baseRef
    })

    // 只让 worktree 清理失败，其余 git 命令仍走真实实现
    const failingGit = new GitService(async (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('cannot remove worktree')
      }
      return runGit(cwd, args)
    })
    const failingManager = createManager(new FakeAdapter(), { git: failingGit })

    await expect(failingManager.retry(task.id)).rejects.toThrow(
      '重试前清理任务现场失败：cannot remove worktree'
    )
    // 清理失败：不广播、不改状态、不入队，现场保持原样
    expect(tasks.get(task.id)?.status).toBe('failed')
    expect(recordStatuses(task.id)).toEqual([])
    expect(existsSync(worktreePath)).toBe(true)
    expect(await git.branchExists(tempRepo.path, branch)).toBe(true)

    // 状态未被破坏，换回正常 git 后可再次重试并成功执行
    const adapter = new FakeAdapter({
      steps: [{ event: { type: 'final', summary: '重试完成' } }]
    })
    const manager = createManager(adapter)
    await manager.retry(task.id)
    await waitFor(() => tasks.get(task.id)?.status === 'done')
    expect(adapter.runs).toHaveLength(1)
  })

  test('retry re-queues a resolve task without touching the parent conflict scene', async () => {
    insertAgent()
    const parentId = randomUUID()
    const resolveId = randomUUID()
    const branch = `agent/${parentId}-conflict`
    const worktreePath = join(worktreesRoot, workspace.id, parentId)
    const baseRef = await git.revParse(tempRepo.path, INTEGRATION_BRANCH)

    // 父冲突任务与解决任务共享同一分支和 worktree
    await mkdir(dirname(worktreePath), { recursive: true })
    await git.worktreeAdd(tempRepo.path, worktreePath, branch, baseRef)

    const parent = insertTask({
      id: parentId,
      title: 'Conflicting parent',
      status: 'conflict',
      branch,
      worktreePath,
      baseRef,
      startedAt: FIXED_TIME,
      finishedAt: FIXED_TIME
    })
    const resolve = insertTask({
      id: resolveId,
      title: 'Resolve conflict',
      taskType: 'resolve',
      parentTaskId: parentId,
      status: 'failed',
      branch,
      worktreePath,
      baseRef,
      prompt: '解决冲突后提交',
      startedAt: FIXED_TIME,
      finishedAt: FIXED_TIME,
      summary: '解决失败',
      exitCode: 1
    })

    const adapter = new FakeAdapter({
      steps: [{ event: { type: 'final', summary: '重试完成' } }]
    })
    const manager = createManager(adapter)

    await manager.retry(resolve.id)
    await waitFor(() => tasks.get(resolve.id)?.status === 'done')

    // 重试只重置运行结果，保留共享现场
    const stored = tasks.get(resolve.id) as Task
    expect(stored.branch).toBe(branch)
    expect(stored.worktreePath).toBe(worktreePath)
    expect(stored.baseRef).toBe(baseRef)
    expect(stored.prompt).toBe('解决冲突后提交')
    expect(recordStatuses(resolve.id)).toEqual(['queued', 'preparing', 'running', 'done'])
    expect(adapter.runs).toHaveLength(1)
    expect(adapter.runs[0]?.cwd).toBe(worktreePath)

    // 父冲突任务的现场未被清理，状态也不受影响
    expect(tasks.get(parent.id)?.status).toBe('conflict')
    expect(existsSync(worktreePath)).toBe(true)
    expect(await git.branchExists(tempRepo.path, branch)).toBe(true)
  })

  test('retry rejects a resolve task whose worktree is missing or invalid', async () => {
    insertAgent()
    const branch = 'agent/missing-parent-conflict'
    const worktreePath = join(worktreesRoot, workspace.id, 'missing-parent')
    const task = insertTask({
      title: 'Resolve missing',
      taskType: 'resolve',
      status: 'failed',
      branch,
      worktreePath,
      baseRef: 'base-ref',
      prompt: '解决冲突后提交'
    })

    const manager = createManager(new FakeAdapter())

    // 目录不存在
    await expect(manager.retry(task.id)).rejects.toThrow(
      '解决任务的工作区已不存在，请放弃后重新指派'
    )
    expect(tasks.get(task.id)?.status).toBe('failed')
    expect(tasks.get(task.id)?.branch).toBe(branch)

    // 目录存在但不是有效 worktree（缺少 .git 标记）同样拒绝
    await mkdir(worktreePath, { recursive: true })
    await expect(manager.retry(task.id)).rejects.toThrow(
      '解决任务的工作区已不存在，请放弃后重新指派'
    )
    expect(tasks.get(task.id)?.status).toBe('failed')
    expect(tasks.get(task.id)?.branch).toBe(branch)
    // 两次拒绝都没有广播 queued，也没有启动 Agent
    expect(recordStatuses(task.id)).toEqual([])
  })

  test('recovery re-drives the merge callback for done tasks and isolates failures', async () => {
    insertAgent()
    const firstDone = insertTask({ title: 'Done one', status: 'done' })
    const failed = insertTask({ title: 'Failed', status: 'failed' })
    const secondDone = insertTask({ title: 'Done two', status: 'done' })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onTaskDone = vi.fn((taskId: string) => {
      if (taskId === secondDone.id) {
        throw new Error('boom')
      }
    })

    const manager = createManager(new FakeAdapter(), { onTaskDone })
    manager.recoverInterrupted()

    await waitFor(() => onTaskDone.mock.calls.length === 2)

    expect(onTaskDone).toHaveBeenCalledWith(firstDone.id)
    expect(onTaskDone).toHaveBeenCalledWith(secondDone.id)
    expect(onTaskDone).not.toHaveBeenCalledWith(failed.id)
    // 单个回调失败只记录，不能阻止其余任务补合并
    expect(errorSpy).toHaveBeenCalledWith(
      `合并任务失败：${secondDone.id}`,
      expect.any(Error)
    )
    // done 状态保持不变，由合并协调器接管后续状态
    expect(tasks.get(firstDone.id)?.status).toBe('done')
    expect(tasks.get(secondDone.id)?.status).toBe('done')
  })

  test('recovery aborts a half-finished merge left in the integration worktree', async () => {
    insertAgent()
    const id = randomUUID()
    const branch = `agent/${id}-conflict`
    const taskWorktree = join(worktreesRoot, workspace.id, id)
    const baseRef = await git.revParse(tempRepo.path, INTEGRATION_BRANCH)

    // 构造真实冲突：任务分支与 integration 修改同一文件
    await mkdir(dirname(taskWorktree), { recursive: true })
    await git.worktreeAdd(tempRepo.path, taskWorktree, branch, baseRef)
    await writeFile(join(taskWorktree, 'README.md'), 'branch version\n')
    await git.commitAll(taskWorktree, 'branch change')
    await writeFile(join(integrationPath(), 'README.md'), 'integration version\n')
    await git.commitAll(integrationPath(), 'integration change')

    // 模拟崩溃前合并到一半：integration worktree 留下未解决的冲突
    await gitRun(integrationPath(), ['merge', '--no-ff', branch]).catch(() => undefined)
    expect(await git.unmergedFiles(integrationPath())).toEqual(['README.md'])

    const task = insertTask({
      id,
      title: 'Interrupted merge',
      status: 'merging',
      branch,
      worktreePath: taskWorktree,
      baseRef,
      startedAt: FIXED_TIME
    })

    const manager = createManager(new FakeAdapter(), {
      integrationWorktreePath: (workspaceId) =>
        workspaceService.integrationWorktreePath(workspaceId)
    })
    manager.recoverInterrupted()

    // 状态改为 interrupted 发生在 merge --abort 之后，等到它即可确认中止流程完成
    await waitFor(() => tasks.get(task.id)?.status === 'interrupted')

    expect(tasks.get(task.id)?.finishedAt).toBeNull()
    expect(await git.unmergedFiles(integrationPath())).toEqual([])
    const { stdout: status } = await gitRun(integrationPath(), ['status', '--porcelain'])
    expect(status.trim()).toBe('')
    expect(await gitRun(integrationPath(), ['show', 'HEAD:README.md']).then((r) => r.stdout)).toBe(
      'integration version\n'
    )
    expect(recordStatuses(task.id)).toContain('interrupted')
  })
})
