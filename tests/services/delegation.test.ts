import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AgentRepo } from '../../src/main/db/agent-repo'
import { MessageRepo } from '../../src/main/db/message-repo'
import { TaskRepo } from '../../src/main/db/task-repo'
import { WorkspaceRepo } from '../../src/main/db/workspace-repo'
import { EventBus } from '../../src/main/events'
import { AgentRunError, type AgentAdapter } from '../../src/main/services/agents/adapter'
import { extractMentionIds } from '../../src/main/services/chat/mentions'
import { GitService } from '../../src/main/services/git/git'
import { SetupRunner } from '../../src/main/services/tasks/setup-runner'
import { TaskManager } from '../../src/main/services/tasks/task-manager'
import { WorkspaceService } from '../../src/main/services/workspace-service'
import type { AgentConfig, AppEvent, Task, Workspace } from '../../src/shared/types'
import { createTestDb, type TestDb } from '../helpers/db'
import { FakeAdapter } from '../helpers/fake-adapter'
import { createTempRepo, type TempRepo } from '../helpers/temp-repo'

const FIXED_TIME = '2026-11-18T10:00:00.000Z'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let tempRepo: TempRepo
let testDb: TestDb
let workspaces: WorkspaceRepo
let agents: AgentRepo
let tasks: TaskRepo
let messages: MessageRepo
let events: EventBus
let git: GitService
let workspace: Workspace
let worktreesRoot: string
let logsRoot: string

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
  workspace = await new WorkspaceService({ repo: workspaces, git, worktreesRoot }).create({
    name: 'Demo',
    repoPath: tempRepo.path
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

/** 按 Agent 装配适配器；未映射的 Agent 使用空脚本适配器，不会产生委派或改动 */
function createManager(adapters: Record<string, AgentAdapter>): TaskManager {
  const fallback = new FakeAdapter()
  return new TaskManager({
    tasks,
    agents,
    workspaces,
    messages,
    git,
    setup: new SetupRunner(),
    adapters: { create: (agent) => adapters[agent.id] ?? fallback },
    events,
    worktreesRoot,
    logsRoot
  })
}

/**
 * 产出指定摘要并写入一个改动文件的适配器。
 *
 * 任务成功但没有代码改动时 TaskManager 会把摘要替换为「无代码改动」，
 * 会导致摘要中的提及丢失；这条测试路径必须真实产生改动。
 */
function adapterWithSummary(summary: string): FakeAdapter {
  return new FakeAdapter({
    steps: [
      {
        before: async (cwd) => {
          await writeFile(join(cwd, 'OUT.md'), 'done\n')
        },
        event: { type: 'final', summary }
      }
    ]
  })
}

/** 直接读取某任务的子任务；委派任务通过 parentTaskId 关联 */
function childrenOf(taskId: string): Task[] {
  return tasks.listByWorkspace(workspace.id).filter((task) => task.parentTaskId === taskId)
}

/** 轮询等待条件成立；条件始终不成立时抛出可读错误，避免测试卡死 */
async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor 超时：条件未在预期时间内成立')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 收集父任务直接子任务的 queued 状态事件，用于断言 emit 次数与初始字段 */
function recordQueuedChildren(seen: AppEvent[], parentId: string): Task[] {
  return seen
    .filter(
      (event): event is Extract<AppEvent, { type: 'task-updated' }> =>
        event.type === 'task-updated' &&
        event.task.parentTaskId === parentId &&
        event.task.status === 'queued'
    )
    .map((event) => event.task)
}

describe('extractMentionIds', () => {
  const agents = [
    { id: 'a-claude', name: 'claude' },
    { id: 'a-codex', name: 'codex' },
    { id: 'a-long', name: 'claude2' },
    { id: 'a-cn', name: '小助手' },
    { id: 'a-plus', name: 'c++' }
  ]

  test('returns unique ids in first-mention order and ignores unknown names', () => {
    expect(extractMentionIds('开始 @codex，然后 @Claude，再 @codex @nobody', agents)).toEqual([
      'a-codex',
      'a-claude'
    ])
  })

  test('matches only @ after start or whitespace', () => {
    expect(extractMentionIds('mail foo@codex.com 不是提及', agents)).toEqual([])
  })

  test('prefers the longest name and supports Chinese and regex-special names', () => {
    expect(
      extractMentionIds('@claude2 和 @claude 和 @小助手 和 @c++', agents)
    ).toEqual(['a-long', 'a-claude', 'a-cn', 'a-plus'])
  })

  test('returns an empty list when there are no agents', () => {
    expect(extractMentionIds('@claude', [])).toEqual([])
  })
})

describe('agent delegation', () => {
  test('agent summary mentioning another agent creates a delegated task', async () => {
    insertAgent({ id: 'agent-claude', name: 'claude', canDelegate: true })
    insertAgent({ id: 'agent-codex', name: 'codex', canDelegate: false })
    insertAgent({ id: 'agent-gemini', name: 'gemini', canDelegate: false })

    const summary = '登录页完成，请 @codex 接着补测试，也可以找 @gemini'
    const claudeAdapter = adapterWithSummary(summary)
    const codexAdapter = new FakeAdapter()
    const task = insertTask({ title: 'Implement login' })

    const seen: AppEvent[] = []
    events.on((event) => seen.push(event))
    const manager = createManager({ 'agent-claude': claudeAdapter, 'agent-codex': codexAdapter })
    manager.start()

    await waitFor(() => tasks.get(task.id)?.status === 'done')
    await waitFor(() => recordQueuedChildren(seen, task.id).length > 0)

    const queued = recordQueuedChildren(seen, task.id)
    expect(queued).toHaveLength(1)
    const delegated = queued[0] as Task

    // 新任务的字段：code 类型、父任务关联、目标 Agent、摘要原文与「委派：」标题
    expect(delegated.id).toMatch(UUID_PATTERN)
    expect(delegated.id).not.toBe(task.id)
    expect(delegated.workspaceId).toBe(workspace.id)
    expect(delegated.agentId).toBe('agent-codex')
    expect(delegated.parentTaskId).toBe(task.id)
    expect(delegated.taskType).toBe('code')
    expect(delegated.title).toBe('委派：codex')
    expect(delegated.prompt).toBe(summary)
    expect(delegated.status).toBe('queued')
    expect(delegated.branch).toBeNull()
    expect(delegated.worktreePath).toBeNull()
    expect(delegated.baseRef).toBeNull()
    expect(delegated.exitCode).toBeNull()
    expect(delegated.summary).toBeNull()
    expect(delegated.startedAt).toBeNull()
    expect(delegated.finishedAt).toBeNull()
    expect(new Date(delegated.createdAt).toISOString()).toBe(delegated.createdAt)

    // 任务已落库且只创建一次；v1 只为第一个合格提及创建任务，@gemini 被忽略
    expect(tasks.get(delegated.id)?.parentTaskId).toBe(task.id)
    expect(childrenOf(task.id).map((child) => child.agentId)).toEqual(['agent-codex'])
    await waitFor(() => codexAdapter.runs.length === 1)
    expect(codexAdapter.runs[0]?.prompt).toContain(summary)
    // 委派任务自身成功结束后不会再委派（目标 Agent canDelegate 为 false）
    await waitFor(() => tasks.get(delegated.id)?.status === 'done')
    expect(childrenOf(delegated.id)).toHaveLength(0)
  })

  test('delegation is skipped when canDelegate is false', async () => {
    insertAgent({ id: 'agent-claude', name: 'claude', canDelegate: false })
    insertAgent({ id: 'agent-codex', name: 'codex', canDelegate: false })

    const claudeAdapter = adapterWithSummary('请 @codex 继续')
    const task = insertTask({ title: 'No delegate' })

    const manager = createManager({ 'agent-claude': claudeAdapter })
    manager.start()
    await waitFor(() => tasks.get(task.id)?.status === 'done')

    expect(childrenOf(task.id)).toHaveLength(0)
  })

  test('depth 3 delegation is allowed', async () => {
    insertAgent({ id: 'agent-claude', name: 'claude', canDelegate: true })
    insertAgent({ id: 'agent-codex', name: 'codex', canDelegate: false })

    // root(0) -> d1(1) -> d2(2)：d2 再委派产生深度 3 的任务，应当允许
    const root = insertTask({ title: 'root', status: 'done' })
    const d1 = insertTask({ title: 'd1', status: 'done', parentTaskId: root.id })
    const d2 = insertTask({ title: 'd2', status: 'queued', parentTaskId: d1.id })

    const claudeAdapter = adapterWithSummary('继续 @codex')
    const manager = createManager({ 'agent-claude': claudeAdapter })
    manager.start()

    await waitFor(() => tasks.get(d2.id)?.status === 'done')
    await waitFor(() => childrenOf(d2.id).length === 1)

    const delegated = childrenOf(d2.id)[0] as Task
    expect(delegated.parentTaskId).toBe(d2.id)
    expect(delegated.agentId).toBe('agent-codex')
    await waitFor(() => tasks.get(delegated.id)?.status === 'done')
  })

  test('delegation depth over 3 is rejected', async () => {
    insertAgent({ id: 'agent-claude', name: 'claude', canDelegate: true })
    insertAgent({ id: 'agent-codex', name: 'codex', canDelegate: false })

    // root(0) -> d1(1) -> d2(2) -> d3(3)：d3 再委派会是深度 4，必须拒绝
    const root = insertTask({ title: 'root', status: 'done' })
    const d1 = insertTask({ title: 'd1', status: 'done', parentTaskId: root.id })
    const d2 = insertTask({ title: 'd2', status: 'done', parentTaskId: d1.id })
    const d3 = insertTask({ title: 'd3', status: 'queued', parentTaskId: d2.id })

    const claudeAdapter = adapterWithSummary('继续 @codex')
    const manager = createManager({ 'agent-claude': claudeAdapter })
    manager.start()

    await waitFor(() => tasks.get(d3.id)?.status === 'done')
    expect(childrenOf(d3.id)).toHaveLength(0)
  })

  test('self mention is rejected', async () => {
    insertAgent({ id: 'agent-claude', name: 'claude', canDelegate: true })

    const claudeAdapter = adapterWithSummary('请 @claude 自己继续')
    const task = insertTask({ title: 'Self mention' })

    const manager = createManager({ 'agent-claude': claudeAdapter })
    manager.start()
    await waitFor(() => tasks.get(task.id)?.status === 'done')

    expect(childrenOf(task.id)).toHaveLength(0)
  })

  test('direct A->B->A cycle is rejected', async () => {
    insertAgent({ id: 'agent-claude', name: 'claude', canDelegate: true })
    insertAgent({ id: 'agent-codex', name: 'codex', canDelegate: true })

    // A 已经完成 root，B 在 root 下面执行时再提及 A，会形成 A->B->A 环
    const root = insertTask({ title: 'root', agentId: 'agent-claude', status: 'done' })
    const current = insertTask({
      title: 'current',
      agentId: 'agent-codex',
      parentTaskId: root.id,
      status: 'queued'
    })

    const codexAdapter = adapterWithSummary('交给 @claude 收尾')
    const manager = createManager({ 'agent-codex': codexAdapter })
    manager.start()

    await waitFor(() => tasks.get(current.id)?.status === 'done')
    expect(childrenOf(current.id)).toHaveLength(0)
  })

  test('disabled and missing targets are skipped, later mention is used', async () => {
    insertAgent({ id: 'agent-claude', name: 'claude', canDelegate: true })
    insertAgent({ id: 'agent-codex', name: 'codex', canDelegate: true, enabled: false })
    insertAgent({ id: 'agent-gemini', name: 'gemini', canDelegate: false })

    const claudeAdapter = adapterWithSummary('@nobody 和 @codex 和 @gemini')
    const task = insertTask({ title: 'Skip targets' })

    const manager = createManager({ 'agent-claude': claudeAdapter })
    manager.start()
    await waitFor(() => tasks.get(task.id)?.status === 'done')
    await waitFor(() => childrenOf(task.id).length === 1)

    const delegated = childrenOf(task.id)[0] as Task
    expect(delegated.agentId).toBe('agent-gemini')
    expect(delegated.title).toBe('委派：gemini')
    await waitFor(() => tasks.get(delegated.id)?.status === 'done')
  })

  test('failed tasks never delegate', async () => {
    insertAgent({ id: 'agent-claude', name: 'claude', canDelegate: true })
    insertAgent({ id: 'agent-codex', name: 'codex', canDelegate: false })

    // 即使失败摘要/错误信息里出现提及，失败任务也不能触发委派
    const claudeAdapter = new FakeAdapter({
      steps: [{ event: { type: 'final', summary: '请 @codex 接手' } }],
      error: new AgentRunError('执行失败：@codex 接手', 1)
    })
    const task = insertTask({ title: 'Will fail' })

    const manager = createManager({ 'agent-claude': claudeAdapter })
    manager.start()
    await waitFor(() => tasks.get(task.id)?.status === 'failed')

    expect(childrenOf(task.id)).toHaveLength(0)
  })

  test('cancelled tasks never delegate', async () => {
    insertAgent({ id: 'agent-claude', name: 'claude', canDelegate: true })
    insertAgent({ id: 'agent-codex', name: 'codex', canDelegate: false })

    const claudeAdapter = new FakeAdapter({
      steps: [{ delayMs: 5000, event: { type: 'final', summary: '请 @codex 接手' } }]
    })
    const task = insertTask({ title: 'Cancel me' })

    const manager = createManager({ 'agent-claude': claudeAdapter })
    manager.start()
    await waitFor(() => claudeAdapter.runs.length === 1 && tasks.get(task.id)?.status === 'running')

    await manager.cancel(task.id)
    expect(tasks.get(task.id)?.status).toBe('cancelled')
    expect(childrenOf(task.id)).toHaveLength(0)
  })
})
