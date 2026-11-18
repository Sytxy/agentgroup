import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
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
import type {
  AgentConfig,
  AppEvent,
  Task,
  TaskType,
  Workspace
} from '../../src/shared/types'
import { createTestDb, type TestDb } from '../helpers/db'
import { FakeAdapter } from '../helpers/fake-adapter'
import { createTempRepo, type TempRepo } from '../helpers/temp-repo'

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
  // 协调器创建测试任务时通过工厂写入卡片消息并入队；本文件用数组记录入队，
  // 测试任务本身由各用例显式交给 TaskManager.start 调度。
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

/** 打开自动测试并使用指定测试 Agent；返回最新读取的工作区记录 */
function enableAutoTest(testAgentId: string | null): Workspace {
  workspaces.update(workspace.id, {
    autoTestAfterMerge: true,
    testAgentId,
    testTaskTemplate: '运行全部测试并汇总失败用例'
  })
  return workspaces.get(workspace.id) as Workspace
}

function integrationPath(): string {
  return workspaceService.integrationWorktreePath(workspace.id)
}

function listTestTasks(): Task[] {
  return tasks.listByWorkspace(workspace.id).filter((task) => task.taskType === 'test')
}

function recordStatuses(taskId: string): string[] {
  return seen
    .filter(
      (event): event is Extract<AppEvent, { type: 'task-updated' }> =>
        event.type === 'task-updated' && event.task.id === taskId
    )
    .map((event) => event.task.status)
}

/** 直接构造一个已完成、带独立 worktree 与分支的任务，等价于 TaskManager 成功后的现场 */
async function createDoneTask(
  options: {
    title?: string
    files?: Record<string, string>
    agentId?: string
    taskType?: TaskType
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

function insertTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: randomUUID(),
    workspaceId: workspace.id,
    agentId: 'agent-tester',
    parentTaskId: null,
    taskType: 'test',
    title: '验证：既有功能',
    prompt: '运行全部测试并汇总失败用例',
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

describe('MergeCoordinator.maybeCreateTestTask', () => {
  test('code task merge creates a test task when enabled', async () => {
    insertAgent()
    insertAgent({ id: 'agent-tester', name: 'tester' })
    enableAutoTest('agent-tester')

    const merged = await createDoneTask({ title: '新增功能', files: { 'FEATURE.md': 'feature\n' } })
    await coordinator.mergeTask(merged.id)

    expect(tasks.get(merged.id)?.status).toBe('merged')
    const created = listTestTasks()
    expect(created).toHaveLength(1)

    const testTask = created[0] as Task
    expect(testTask.parentTaskId).toBe(merged.id)
    expect(testTask.status).toBe('queued')
    expect(tasks.get(testTask.id)).toEqual(testTask)
    // 落库后广播任务卡片并重新入队，与解决任务保持同一套 UI/调度路径
    const testEvents = seen.filter(
      (event): event is Extract<AppEvent, { type: 'task-updated' }> =>
        event.type === 'task-updated' && event.task.id === testTask.id
    )
    expect(testEvents).toHaveLength(1)
    expect(testEvents[0]?.task).toEqual(testTask)
    expect(enqueued).toEqual([testTask.id])
    // 自动测试任务同样有 task-card 消息，ChatTimeline 才能渲染任务卡片
    const card = messages
      .listByWorkspace(workspace.id)
      .find((message) => message.kind === 'task-card' && message.taskId === testTask.id)
    expect(card?.content).toBe(testTask.title)
  })

  test('disabled setting creates no test task', async () => {
    insertAgent()
    insertAgent({ id: 'agent-tester', name: 'tester' })
    // 默认 autoTestAfterMerge 为 false，只配置测试 Agent 不应触发
    workspaces.update(workspace.id, { testAgentId: 'agent-tester' })

    const merged = await createDoneTask({ files: { 'FEATURE.md': 'feature\n' } })
    await coordinator.mergeTask(merged.id)

    expect(tasks.get(merged.id)?.status).toBe('merged')
    expect(listTestTasks()).toEqual([])
    expect(enqueued).toEqual([])
  })

  test('test task uses testAgentId, taskType test and the template prompt', async () => {
    insertAgent()
    insertAgent({ id: 'agent-tester', name: 'tester' })
    const current = enableAutoTest('agent-tester')

    const merged = await createDoneTask({ title: '新增功能', files: { 'FEATURE.md': 'feature\n' } })
    await coordinator.mergeTask(merged.id)

    const testTask = listTestTasks()[0] as Task
    expect(testTask.taskType).toBe('test')
    expect(testTask.agentId).toBe('agent-tester')
    expect(testTask.title).toBe('验证：新增功能')
    expect(testTask.prompt).toBe(current.testTaskTemplate)
    expect(testTask.workspaceId).toBe(workspace.id)
    // 测试任务启动时才创建独立现场，创建阶段这些字段全部为空
    expect(testTask.branch).toBeNull()
    expect(testTask.worktreePath).toBeNull()
    expect(testTask.baseRef).toBeNull()
    expect(testTask.exitCode).toBeNull()
    expect(testTask.summary).toBeNull()
    expect(testTask.startedAt).toBeNull()
    expect(testTask.finishedAt).toBeNull()
    expect(Number.isNaN(Date.parse(testTask.createdAt))).toBe(false)
  })

  test('missing or disabled test agent creates nothing', async () => {
    insertAgent()
    insertAgent({ id: 'agent-tester', name: 'tester', enabled: false })
    const current = enableAutoTest('agent-tester')

    // 配置的测试 Agent 已停用：不创建测试任务
    const candidate = await createDoneTask({ files: { 'A.md': 'a\n' } })
    expect(coordinator.maybeCreateTestTask(current, candidate)).toBeNull()

    // 配置的测试 Agent 在工作区中不存在：不创建测试任务
    workspaces.update(workspace.id, { testAgentId: 'agent-ghost' })
    const missing = workspaces.get(workspace.id) as Workspace
    expect(coordinator.maybeCreateTestTask(missing, candidate)).toBeNull()

    // 未配置测试 Agent：不创建测试任务
    workspaces.update(workspace.id, { testAgentId: null })
    const unset = workspaces.get(workspace.id) as Workspace
    expect(coordinator.maybeCreateTestTask(unset, candidate)).toBeNull()

    expect(listTestTasks()).toEqual([])
    expect(enqueued).toEqual([])
  })

  test('test and resolve tasks do not trigger another test task', async () => {
    insertAgent()
    insertAgent({ id: 'agent-tester', name: 'tester' })
    const current = enableAutoTest('agent-tester')

    const codeTask = await createDoneTask({ files: { 'FEATURE.md': 'feature\n' } })
    // 同一任务现场改成测试/解决类型，验证类型闸门只放行 code
    expect(coordinator.maybeCreateTestTask(current, { ...codeTask, taskType: 'test' })).toBeNull()
    expect(coordinator.maybeCreateTestTask(current, { ...codeTask, taskType: 'resolve' })).toBeNull()

    expect(listTestTasks()).toEqual([])
    expect(enqueued).toEqual([])
  })

  test('a merged test task does not cascade into another test task', async () => {
    insertAgent()
    insertAgent({ id: 'agent-tester', name: 'tester' })
    enableAutoTest('agent-tester')

    const testTask = await createDoneTask({
      title: '既有测试',
      taskType: 'test',
      agentId: 'agent-tester',
      files: { 'VERIFY.md': 'verification\n' }
    })

    await coordinator.mergeTask(testTask.id)

    expect(tasks.get(testTask.id)?.status).toBe('merged')
    // 只有被合并的测试任务本身，没有因合并再生成新的测试任务
    expect(listTestTasks()).toHaveLength(1)
    expect(listTestTasks()[0]?.id).toBe(testTask.id)
    expect(enqueued).toEqual([])
  })
})

describe('workspace.lastVerification', () => {
  test('test task done marks lastVerification passed', async () => {
    insertAgent()
    insertAgent({ id: 'agent-tester', name: 'tester' })
    enableAutoTest('agent-tester')
    const task = insertTask()

    const manager = createManager(
      new FakeAdapter({ steps: [{ event: { type: 'final', summary: '全部通过' } }] })
    )
    manager.start()
    await waitFor(() => tasks.get(task.id)?.status === 'done')

    expect(workspaces.get(workspace.id)?.lastVerification).toBe('passed')
  })

  test('test task merged marks lastVerification passed', async () => {
    insertAgent()
    insertAgent({ id: 'agent-tester', name: 'tester' })
    enableAutoTest('agent-tester')
    const testTask = await createDoneTask({
      taskType: 'test',
      agentId: 'agent-tester',
      files: { 'VERIFY.md': 'verification\n' }
    })

    await coordinator.mergeTask(testTask.id)

    expect(tasks.get(testTask.id)?.status).toBe('merged')
    expect(workspaces.get(workspace.id)?.lastVerification).toBe('passed')
  })

  test('test task conflict marks lastVerification failed', async () => {
    insertAgent()
    insertAgent({ id: 'agent-tester', name: 'tester' })
    enableAutoTest('agent-tester')
    const testTask = await createDoneTask({
      taskType: 'test',
      agentId: 'agent-tester',
      files: { 'README.md': 'branch version\n' }
    })
    // integration 与测试任务分支修改同一文件，制造冲突
    await writeFile(join(integrationPath(), 'README.md'), 'integration version\n')
    await git.commitAll(integrationPath(), 'integration change')

    await coordinator.mergeTask(testTask.id)

    expect(tasks.get(testTask.id)?.status).toBe('conflict')
    expect(workspaces.get(workspace.id)?.lastVerification).toBe('failed')
  })

  test('test task merge failure marks lastVerification failed', async () => {
    // 测试任务引用的 Agent 已被删除：合并闸门读取 Agent 失败，任务收敛为 failed
    const testTask = await createDoneTask({
      taskType: 'test',
      agentId: 'agent-deleted',
      files: { 'VERIFY.md': 'verification\n' }
    })

    await coordinator.mergeTask(testTask.id)

    expect(tasks.get(testTask.id)?.status).toBe('failed')
    expect(workspaces.get(workspace.id)?.lastVerification).toBe('failed')
  })

  test('cancelling a queued test task marks lastVerification failed', async () => {
    insertAgent()
    insertAgent({ id: 'agent-tester', name: 'tester' })
    enableAutoTest('agent-tester')
    const task = insertTask()
    const manager = createManager(new FakeAdapter())

    await manager.cancel(task.id)

    expect(tasks.get(task.id)?.status).toBe('cancelled')
    expect(workspaces.get(workspace.id)?.lastVerification).toBe('failed')
  })

  test('recovered interrupted test task marks lastVerification failed', async () => {
    insertAgent()
    insertAgent({ id: 'agent-tester', name: 'tester' })
    enableAutoTest('agent-tester')
    const task = insertTask({ status: 'running' })
    const manager = createManager(new FakeAdapter())

    manager.recoverInterrupted()
    await waitFor(() => tasks.get(task.id)?.status === 'interrupted')

    expect(workspaces.get(workspace.id)?.lastVerification).toBe('failed')
  })

  test('non-test task endings leave lastVerification untouched', async () => {
    insertAgent()
    const merged = await createDoneTask({ files: { 'FEATURE.md': 'feature\n' } })

    await coordinator.mergeTask(merged.id)

    expect(tasks.get(merged.id)?.status).toBe('merged')
    expect(workspaces.get(workspace.id)?.lastVerification).toBe('unknown')
  })
})
