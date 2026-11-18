import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AgentRepo } from '../../src/main/db/agent-repo'
import { MessageRepo } from '../../src/main/db/message-repo'
import { TaskRepo } from '../../src/main/db/task-repo'
import { WorkspaceRepo } from '../../src/main/db/workspace-repo'
import { EventBus } from '../../src/main/events'
import { GitService } from '../../src/main/services/git/git'
import { SerialQueue } from '../../src/main/services/git/serial-queue'
import { MergeCoordinator } from '../../src/main/services/tasks/merge-coordinator'
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
let coordinator: MergeCoordinator
let enqueued: string[]
let seen: AppEvent[]
let taskFactory: TaskFactory

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
  enqueued = []
  seen = []
  events.on((event) => seen.push(event))
  taskFactory = new TaskFactory({
    tasks,
    messages,
    events,
    enqueue: (taskId) => enqueued.push(taskId)
  })
  coordinator = new MergeCoordinator({
    queue: new SerialQueue(),
    git,
    tasks,
    agents,
    workspaces,
    events,
    factory: taskFactory,
    integrationWorktreePath: (workspaceId) =>
      workspaceService.integrationWorktreePath(workspaceId)
  })
})

afterEach(async () => {
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

function integrationPath(): string {
  return workspaceService.integrationWorktreePath(workspace.id)
}

/** 直接构造一个已经完成、带独立 worktree 与分支的任务，等价于 TaskManager 成功后的现场 */
async function createDoneTask(
  options: {
    title?: string
    files?: Record<string, string>
    agentId?: string
    taskType?: Task['taskType']
  } = {}
): Promise<Task> {
  const id = randomUUID()
  const baseRef = await git.revParse(tempRepo.path, INTEGRATION_BRANCH)
  const branch = `agent/${id}`
  const worktreePath = join(worktreesRoot, workspace.id, id)

  await mkdir(dirname(worktreePath), { recursive: true })
  await git.worktreeAdd(tempRepo.path, worktreePath, branch, baseRef)
  for (const [file, content] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(worktreePath, file)), { recursive: true })
    await writeFile(join(worktreePath, file), content)
  }
  if (Object.keys(options.files ?? {}).length > 0) {
    await git.commitAll(worktreePath, `agent(work): ${options.title ?? 'Task'}`)
  }

  const task: Task = {
    id,
    workspaceId: workspace.id,
    agentId: options.agentId ?? 'agent-claude',
    parentTaskId: null,
    taskType: options.taskType ?? 'code',
    title: options.title ?? 'Task',
    prompt: '做点事',
    branch,
    worktreePath,
    baseRef,
    status: 'done',
    exitCode: 0,
    summary: null,
    createdAt: FIXED_TIME,
    startedAt: FIXED_TIME,
    finishedAt: FIXED_TIME
  }
  tasks.insert(task)
  return task
}

/**
 * 先让任务分支与 integration 修改同一文件，再触发合并，得到冲突任务现场。
 * 冲突合并会被中止，integration 保持自己的内容。
 */
async function createConflictTask(fileName = 'README.md'): Promise<Task> {
  const task = await createDoneTask({
    title: 'Conflicting',
    files: { [fileName]: 'branch version\n' }
  })
  await writeFile(join(integrationPath(), fileName), 'integration version\n')
  await git.commitAll(integrationPath(), 'integration change')

  await coordinator.mergeTask(task.id)
  const stored = tasks.get(task.id) as Task
  expect(stored.status).toBe('conflict')
  return stored
}

function recordStatuses(taskId: string): string[] {
  return seen
    .filter(
      (event): event is Extract<AppEvent, { type: 'task-updated' }> =>
        event.type === 'task-updated' && event.task.id === taskId
    )
    .map((event) => event.task.status)
}

/** 插入一个等待父任务合并的委派子任务（与 TaskManager.maybeDelegate 的落库结果一致） */
function insertQueuedChild(parent: Task): Task {
  const child: Task = {
    id: randomUUID(),
    workspaceId: parent.workspaceId,
    agentId: parent.agentId,
    parentTaskId: parent.id,
    taskType: 'code',
    title: '委派：claude',
    prompt: '继续完成后续工作',
    branch: null,
    worktreePath: null,
    baseRef: null,
    status: 'queued',
    exitCode: null,
    summary: null,
    createdAt: FIXED_TIME,
    startedAt: null,
    finishedAt: null
  }
  tasks.insert(child)
  return child
}

function createManager(
  adapter: FakeAdapter,
  overrides: Partial<ConstructorParameters<typeof TaskManager>[0]> = {}
): TaskManager {
  return new TaskManager({
    tasks,
    agents,
    workspaces,
    messages,
    git,
    setup: new SetupRunner(),
    adapters: { create: () => adapter },
    events,
    factory: taskFactory,
    worktreesRoot,
    logsRoot,
    ...overrides
  })
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

describe('MergeCoordinator', () => {
  test('clean in-scope task is merged automatically into integration', async () => {
    insertAgent()
    const task = await createDoneTask({ files: { 'FEATURE.md': 'feature\n' } })
    const integrationHead = await git.head(integrationPath())

    await coordinator.mergeTask(task.id)

    const stored = tasks.get(task.id) as Task
    expect(stored.status).toBe('merged')
    expect(stored.summary).toBeNull()
    expect(recordStatuses(task.id)).toContain('merging')
    expect(recordStatuses(task.id).at(-1)).toBe('merged')

    expect(await readFile(join(integrationPath(), 'FEATURE.md'), 'utf8')).toBe('feature\n')
    expect(await git.head(integrationPath())).not.toBe(integrationHead)
  })

  test('delegated child is released only after the parent actually merges', async () => {
    insertAgent()
    const parent = await createDoneTask({ files: { 'PARENT.md': 'parent\n' } })
    const child = insertQueuedChild(parent)

    expect(enqueued).toEqual([])
    await coordinator.mergeTask(parent.id)

    expect(tasks.get(parent.id)?.status).toBe('merged')
    // 父任务改动已经进入 integration，此时才允许子任务启动
    expect(enqueued).toEqual([child.id])
  })

  test('delegated child is released after a no-change parent reaches merged', async () => {
    insertAgent()
    const parent = await createDoneTask()
    const child = insertQueuedChild(parent)

    await coordinator.mergeTask(parent.id)

    expect(tasks.get(parent.id)).toMatchObject({ status: 'merged', summary: '无代码改动' })
    expect(enqueued).toEqual([child.id])
  })

  test('delegated child of a test task is released after merge', async () => {
    insertAgent()
    const parent = await createDoneTask({
      title: '验证：登录',
      files: { 'TESTS.md': 'tests\n' },
      taskType: 'test'
    })
    const child = insertQueuedChild(parent)

    await coordinator.mergeTask(parent.id)

    expect(tasks.get(parent.id)?.status).toBe('merged')
    expect(enqueued).toEqual([child.id])
  })

  test('delegated child of a resolve task is released after merge', async () => {
    insertAgent()
    const parent = await createDoneTask({
      title: '解决冲突',
      files: { 'RESOLVED.md': 'resolved\n' },
      taskType: 'resolve'
    })
    const child = insertQueuedChild(parent)

    await coordinator.mergeTask(parent.id)

    expect(tasks.get(parent.id)?.status).toBe('merged')
    expect(enqueued).toEqual([child.id])
  })

  test('merged task worktree is removed after merge but its branch is kept', async () => {
    insertAgent()
    const task = await createDoneTask({ files: { 'FEATURE.md': 'feature\n' } })

    await coordinator.mergeTask(task.id)

    expect(tasks.get(task.id)?.status).toBe('merged')
    expect(existsSync(task.worktreePath as string)).toBe(false)
    expect(await git.branchExists(tempRepo.path, task.branch as string)).toBe(true)
  })

  test('task with no changes is marked merged without a merge commit', async () => {
    insertAgent()
    const task = await createDoneTask()
    const integrationHead = await git.head(integrationPath())

    await coordinator.mergeTask(task.id)

    const stored = tasks.get(task.id) as Task
    expect(stored.status).toBe('merged')
    expect(stored.summary).toBe('无代码改动')
    // 没有产生 merge commit，integration 指向不变
    expect(await git.head(integrationPath())).toBe(integrationHead)
    expect(existsSync(task.worktreePath as string)).toBe(false)
  })

  test('conflict marks task conflict, aborts merge and later tasks still merge', async () => {
    insertAgent()
    const conflicting = await createConflictTask()

    expect(conflicting.summary).toContain('README.md')
    expect(recordStatuses(conflicting.id)).toContain('merging')
    // 合并已中止，integration 工作区保持干净
    const { stdout: status } = await gitRun(integrationPath(), ['status', '--porcelain'])
    expect(status.trim()).toBe('')
    expect(await readFile(join(integrationPath(), 'README.md'), 'utf8')).toBe(
      'integration version\n'
    )
    // 冲突保留现场
    expect(existsSync(conflicting.worktreePath as string)).toBe(true)

    const later = await createDoneTask({ files: { 'LATER.md': 'later\n' } })
    await coordinator.mergeTask(later.id)
    expect(tasks.get(later.id)?.status).toBe('merged')
    expect(await readFile(join(integrationPath(), 'LATER.md'), 'utf8')).toBe('later\n')
  })

  test('merge of a Chinese-named file conflict reports the exact path', async () => {
    insertAgent()
    const task = await createConflictTask('设计说明.md')

    expect(task.status).toBe('conflict')
    expect(task.summary).toBe('合并冲突：设计说明.md')
    expect(existsSync(task.worktreePath as string)).toBe(true)
    // 冲突中止后 integration 保持自身内容
    expect(await readFile(join(integrationPath(), '设计说明.md'), 'utf8')).toBe(
      'integration version\n'
    )
  })

  test('out-of-scope changes pause at awaiting_approval until approved', async () => {
    insertAgent({ pathScope: ['src/**'] })
    const task = await createDoneTask({ files: { 'README.md': 'out of scope\n' } })
    const integrationHead = await git.head(integrationPath())

    await coordinator.mergeTask(task.id)

    const stored = tasks.get(task.id) as Task
    expect(stored.status).toBe('awaiting_approval')
    expect(stored.summary).toContain('README.md')
    // 未合并：integration 内容与提交都不变，现场保留
    expect(await git.head(integrationPath())).toBe(integrationHead)
    expect(await readFile(join(integrationPath(), 'README.md'), 'utf8')).not.toBe(
      'out of scope\n'
    )
    expect(existsSync(task.worktreePath as string)).toBe(true)
  })

  test('approve merges an out-of-scope task', async () => {
    insertAgent({ pathScope: ['src/**'] })
    const task = await createDoneTask({ files: { 'README.md': 'approved content\n' } })

    await coordinator.mergeTask(task.id)
    expect(tasks.get(task.id)?.status).toBe('awaiting_approval')

    await coordinator.approve(task.id)

    const stored = tasks.get(task.id) as Task
    expect(stored.status).toBe('merged')
    expect(await readFile(join(integrationPath(), 'README.md'), 'utf8')).toBe(
      'approved content\n'
    )
    expect(existsSync(task.worktreePath as string)).toBe(false)
  })

  test('auto-merge disabled pauses at awaiting_approval with a manual confirmation reason', async () => {
    workspaces.update(workspace.id, { autoMerge: false })
    insertAgent()
    const task = await createDoneTask({ files: { 'FEATURE.md': 'feature\n' } })
    const integrationHead = await git.head(integrationPath())

    await coordinator.mergeTask(task.id)

    const stored = tasks.get(task.id) as Task
    expect(stored.status).toBe('awaiting_approval')
    expect(stored.summary).toBe('需要确认合并')
    expect(await git.head(integrationPath())).toBe(integrationHead)
    expect(existsSync(task.worktreePath as string)).toBe(true)
  })

  test('approve only accepts tasks that are awaiting approval', async () => {
    insertAgent()
    const task = await createDoneTask({ files: { 'FEATURE.md': 'feature\n' } })

    await expect(coordinator.approve(task.id)).rejects.toThrow('只允许审批等待确认的任务')

    await coordinator.mergeTask(task.id)
    await expect(coordinator.approve(task.id)).rejects.toThrow('只允许审批等待确认的任务')
  })

  test('createResolveTask produces a resolve task on the agent branch', async () => {
    insertAgent()
    const conflict = await createConflictTask()

    const resolve = coordinator.createResolveTask(conflict.id, 'agent-claude')

    expect(resolve.taskType).toBe('resolve')
    expect(resolve.workspaceId).toBe(conflict.workspaceId)
    expect(resolve.agentId).toBe('agent-claude')
    expect(resolve.parentTaskId).toBe(conflict.id)
    expect(resolve.branch).toBe(conflict.branch)
    expect(resolve.worktreePath).toBe(conflict.worktreePath)
    expect(resolve.baseRef).toBe(conflict.baseRef)
    expect(resolve.status).toBe('queued')
    expect(resolve.prompt).toContain(INTEGRATION_BRANCH)
    expect(resolve.prompt).toContain('解决冲突')
    expect(resolve.prompt).toContain('提交')
    // 落库、广播任务卡片并重新入队
    expect(tasks.get(resolve.id)).toEqual(resolve)
    const resolveEvents = seen.filter(
      (event): event is Extract<AppEvent, { type: 'task-updated' }> =>
        event.type === 'task-updated' && event.task.id === resolve.id
    )
    expect(resolveEvents).toHaveLength(1)
    expect(resolveEvents[0]?.task).toEqual(resolve)
    expect(enqueued).toEqual([resolve.id])
    // 解决任务也必须有 task-card 消息，群聊里才能看到并操作它
    const card = messages
      .listByWorkspace(workspace.id)
      .find((message) => message.kind === 'task-card' && message.taskId === resolve.id)
    expect(card?.content).toBe(resolve.title)
  })

  test('createResolveTask rejects a task that is not in conflict', async () => {
    insertAgent()
    const task = await createDoneTask()

    expect(() => coordinator.createResolveTask(task.id, 'agent-claude')).toThrow(
      '只为冲突任务创建解决任务'
    )
  })

  test('an active resolve child blocks abandon, mark and re-assignment', async () => {
    insertAgent()
    const conflict = await createConflictTask()
    const resolve = coordinator.createResolveTask(conflict.id, 'agent-claude')

    // 解决任务与父任务共享 worktree；在其运行/待合并期间，父任务卡片的
    // 放弃、手动标记和再次指派都必须被拒绝，避免两个操作同时改同一现场。
    await expect(coordinator.abandon(conflict.id)).rejects.toThrow(
      '已有进行中的解决任务，请先处理该任务'
    )
    await expect(coordinator.markManuallyResolved(conflict.id)).rejects.toThrow(
      '已有进行中的解决任务，请先处理该任务'
    )
    expect(() => coordinator.createResolveTask(conflict.id, 'agent-claude')).toThrow(
      '已有进行中的解决任务，请先处理该任务'
    )

    expect(tasks.get(conflict.id)?.status).toBe('conflict')
    expect(tasks.get(resolve.id)?.status).toBe('queued')
    expect(existsSync(conflict.worktreePath as string)).toBe(true)
  })

  test('a finished resolve child no longer blocks the parent conflict actions', async () => {
    insertAgent()
    const conflict = await createConflictTask()
    const resolve = coordinator.createResolveTask(conflict.id, 'agent-claude')
    // 解决任务失败后现场仍归父任务处理，允许重新指派或改为手动解决
    tasks.update(resolve.id, { status: 'failed', summary: '解决失败' })

    expect(() => coordinator.createResolveTask(conflict.id, 'agent-claude')).not.toThrow()
  })

  test('createResolveTask validates that the agent exists in the workspace and is enabled', async () => {
    insertAgent()
    const conflict = await createConflictTask()

    expect(() => coordinator.createResolveTask(conflict.id, 'agent-missing')).toThrow(
      '解决 Agent 不存在或不属于该工作区：agent-missing'
    )

    insertAgent({ id: 'agent-disabled', name: 'disabled', enabled: false })
    expect(() => coordinator.createResolveTask(conflict.id, 'agent-disabled')).toThrow(
      '解决 Agent 已停用：disabled'
    )

    // 其他工作区的 Agent 同样不能接管本工作区的冲突现场
    insertAgent({ id: 'agent-other', name: 'other', workspaceId: 'other-workspace' })
    expect(() => coordinator.createResolveTask(conflict.id, 'agent-other')).toThrow(
      '解决 Agent 不存在或不属于该工作区：agent-other'
    )

    expect(
      tasks.listByWorkspace(workspace.id).filter((task) => task.taskType === 'resolve')
    ).toEqual([])
  })

  test('prepareResolveWorktree recreates the worktree on the conflicting agent branch', async () => {
    insertAgent()
    const conflict = await createConflictTask()
    const worktreePath = conflict.worktreePath as string

    // 现场存在时直接返回原路径
    expect(await coordinator.prepareResolveWorktree(conflict.id)).toBe(worktreePath)

    await git.worktreeRemove(tempRepo.path, worktreePath)
    expect(existsSync(worktreePath)).toBe(false)

    const recreated = await coordinator.prepareResolveWorktree(conflict.id)
    expect(recreated).toBe(worktreePath)
    expect(existsSync(worktreePath)).toBe(true)
    const { stdout } = await gitRun(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(stdout.trim()).toBe(conflict.branch)
  })

  test('markManuallyResolved rejects while unmerged files remain', async () => {
    insertAgent()
    const conflict = await createConflictTask()
    const worktreePath = conflict.worktreePath as string

    // 在工作区里把 integration 合入分支，制造未解决冲突
    await gitRun(worktreePath, ['merge', '--no-ff', INTEGRATION_BRANCH]).catch(() => undefined)
    expect(await git.unmergedFiles(worktreePath)).toEqual(['README.md'])

    await expect(coordinator.markManuallyResolved(conflict.id)).rejects.toThrow(
      '仍存在未解决的冲突文件：README.md'
    )
    expect(tasks.get(conflict.id)?.status).toBe('conflict')
  })

  test('markManuallyResolved commits the fix and re-merges', async () => {
    insertAgent()
    const conflict = await createConflictTask()
    const worktreePath = conflict.worktreePath as string

    await gitRun(worktreePath, ['merge', '--no-ff', INTEGRATION_BRANCH]).catch(() => undefined)
    await writeFile(join(worktreePath, 'README.md'), 'manually resolved\n')
    await gitRun(worktreePath, ['add', 'README.md'])
    expect(await git.unmergedFiles(worktreePath)).toEqual([])

    await coordinator.markManuallyResolved(conflict.id)

    const stored = tasks.get(conflict.id) as Task
    expect(stored.status).toBe('merged')
    expect(await readFile(join(integrationPath(), 'README.md'), 'utf8')).toBe(
      'manually resolved\n'
    )
    expect(existsSync(worktreePath)).toBe(false)
    // 残余修改以 resolve: 标题 提交到任务分支
    const { stdout: message } = await gitRun(tempRepo.path, [
      'log',
      '-1',
      '--pretty=%s',
      stored.branch as string
    ])
    expect(message.trim()).toBe('resolve: Conflicting')
  })

  test('abandon rejects running tasks and leaves the worktree intact', async () => {
    insertAgent()
    const task = await createDoneTask({ files: { 'FEATURE.md': 'feature\n' } })
    tasks.update(task.id, { status: 'running' })

    await expect(coordinator.abandon(task.id)).rejects.toThrow('只有未合并的任务可以放弃')

    expect(tasks.get(task.id)?.status).toBe('running')
    expect(existsSync(task.worktreePath as string)).toBe(true)
  })

  test('abandon removes the worktree, marks abandoned and keeps the branch', async () => {
    insertAgent()
    const task = await createDoneTask({ files: { 'FEATURE.md': 'feature\n' } })
    await coordinator.mergeTask(task.id)
    expect(tasks.get(task.id)?.status).toBe('merged')
    // 已合入的任务不能被回退为 abandoned
    await expect(coordinator.abandon(task.id)).rejects.toThrow('只有未合并的任务可以放弃')
    expect(tasks.get(task.id)?.status).toBe('merged')

    const abandoned = await createDoneTask({ files: { 'OTHER.md': 'other\n' } })
    await coordinator.abandon(abandoned.id)

    const stored = tasks.get(abandoned.id) as Task
    expect(stored.status).toBe('abandoned')
    expect(existsSync(abandoned.worktreePath as string)).toBe(false)
    expect(await git.branchExists(tempRepo.path, abandoned.branch as string)).toBe(true)
  })

  test('mergeTask rejects tasks that are not done', async () => {
    insertAgent()
    const task = await createDoneTask()
    tasks.update(task.id, { status: 'running' })

    await expect(coordinator.mergeTask(task.id)).rejects.toThrow('只有已完成的任务可以合并')
  })

  test('merge failure before git merge marks the task failed instead of leaving it done', async () => {    // Agent 记录被删除（或任务引用了不存在的 Agent）时，范围闸门读取 Agent 会失败
    const task = await createDoneTask({
      files: { 'FEATURE.md': 'feature\n' },
      agentId: 'agent-deleted'
    })

    await coordinator.mergeTask(task.id)

    const stored = tasks.get(task.id) as Task
    expect(stored.status).toBe('failed')
    expect(stored.summary).toBe('合并失败：任务所属 Agent 不存在：agent-deleted')
    expect(recordStatuses(task.id).at(-1)).toBe('failed')
    // 合并未执行，integration 不包含该任务改动
    expect(existsSync(join(integrationPath(), 'FEATURE.md'))).toBe(false)
    // 失败保留现场，便于排查
    expect(existsSync(task.worktreePath as string)).toBe(true)
  })
})

describe('TaskManager merge wiring', () => {
  test('done tasks notify onTaskDone, while cancelled tasks do not', async () => {
    insertAgent()
    const doneTask = await createDoneTask()
    tasks.update(doneTask.id, { status: 'queued', branch: null, worktreePath: null, baseRef: null })
    await git.worktreeRemove(tempRepo.path, doneTask.worktreePath as string)

    const onTaskDone = vi.fn()
    const adapter = new FakeAdapter({
      steps: [
        {
          before: async (cwd) => {
            await writeFile(join(cwd, 'OUT.md'), 'done\n')
          },
          event: { type: 'final', summary: '完成' }
        }
      ]
    })
    const manager = createManager(adapter, { onTaskDone })
    manager.start()
    await waitFor(() => tasks.get(doneTask.id)?.status === 'done')

    expect(onTaskDone).toHaveBeenCalledTimes(1)
    expect(onTaskDone).toHaveBeenCalledWith(doneTask.id)
  })

  test('approveMerge and abandon delegate to injected callbacks', async () => {
    const onApproveMerge = vi.fn(async () => undefined)
    const onAbandon = vi.fn(async () => undefined)
    const manager = createManager(new FakeAdapter(), { onApproveMerge, onAbandon })

    await manager.approveMerge('task-a')
    await manager.abandon('task-b')

    expect(onApproveMerge).toHaveBeenCalledWith('task-a')
    expect(onAbandon).toHaveBeenCalledWith('task-b')
  })

  test('delegates reject when no callback is configured', async () => {
    const manager = createManager(new FakeAdapter())

    await expect(manager.approveMerge('task-a')).rejects.toThrow('未配置合并协调器')
    await expect(manager.abandon('task-b')).rejects.toThrow('未配置合并协调器')
  })

  test('resolve task preserves its pre-set branch, worktree and baseRef', async () => {
    insertAgent()
    const conflict = await createConflictTask()
    const resolve = coordinator.createResolveTask(conflict.id, 'agent-claude')

    const adapter = new FakeAdapter({ steps: [{ event: { type: 'final', summary: '已解决' } }] })
    const manager = createManager(adapter)
    manager.start()
    await waitFor(() => tasks.get(resolve.id)?.status === 'done')

    const stored = tasks.get(resolve.id) as Task
    expect(stored.branch).toBe(conflict.branch)
    expect(stored.worktreePath).toBe(conflict.worktreePath)
    expect(stored.baseRef).toBe(conflict.baseRef)
    expect(adapter.runs[0]?.cwd).toBe(conflict.worktreePath)
  })

  test('resolve task commit makes the retry merge succeed', async () => {
    insertAgent()
    const conflict = await createConflictTask()
    const resolve = coordinator.createResolveTask(conflict.id, 'agent-claude')

    // 模拟 Agent 把 integration 合入当前分支、解决冲突；TaskManager 结束后统一提交
    const adapter = new FakeAdapter({
      steps: [
        {
          before: async (cwd) => {
            await gitRun(cwd, ['merge', '--no-ff', INTEGRATION_BRANCH]).catch(() => undefined)
            await writeFile(join(cwd, 'README.md'), 'resolved by agent\n')
          },
          event: { type: 'final', summary: '冲突已解决' }
        }
      ]
    })
    const manager = createManager(adapter, {
      onTaskDone: (taskId) => {
        void coordinator.mergeTask(taskId)
      }
    })
    manager.start()

    await waitFor(() => tasks.get(resolve.id)?.status === 'merged')

    // 父冲突任务一并收敛，不再保留已删除的 worktree 路径
    const parent = tasks.get(conflict.id) as Task
    expect(parent.status).toBe('merged')
    expect(parent.summary).toBe('冲突已解决并合入')
    expect(parent.worktreePath).toBeNull()
    expect(await readFile(join(integrationPath(), 'README.md'), 'utf8')).toBe(
      'resolved by agent\n'
    )
    expect(existsSync(conflict.worktreePath as string)).toBe(false)
  })

  test('resolve task with non-empty pathScope merges without awaiting approval', async () => {
    insertAgent()
    // 解决任务会带入其他任务合入 integration 的文件，不能按解决 Agent 的范围判断越界
    insertAgent({ id: 'agent-resolver', name: 'resolver', pathScope: ['src/**'] })

    const conflict = await createConflictTask()
    const resolve = coordinator.createResolveTask(conflict.id, 'agent-resolver')

    const adapter = new FakeAdapter({
      steps: [
        {
          before: async (cwd) => {
            await gitRun(cwd, ['merge', '--no-ff', INTEGRATION_BRANCH]).catch(() => undefined)
            await writeFile(join(cwd, 'README.md'), 'resolved outside scope\n')
          },
          event: { type: 'final', summary: '冲突已解决' }
        }
      ]
    })
    const manager = createManager(adapter, {
      onTaskDone: (taskId) => {
        void coordinator.mergeTask(taskId)
      }
    })
    manager.start()

    await waitFor(() => tasks.get(resolve.id)?.status === 'merged')

    expect(recordStatuses(resolve.id)).not.toContain('awaiting_approval')
    expect(await readFile(join(integrationPath(), 'README.md'), 'utf8')).toBe(
      'resolved outside scope\n'
    )
    expect(tasks.get(conflict.id)?.status).toBe('merged')
  })
})
