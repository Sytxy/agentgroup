import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AgentRepo } from '../../src/main/db/agent-repo'
import { MessageRepo } from '../../src/main/db/message-repo'
import { TaskRepo } from '../../src/main/db/task-repo'
import { WorkspaceRepo } from '../../src/main/db/workspace-repo'
import { EventBus } from '../../src/main/events'
import { AgentRunError, type AgentAdapter } from '../../src/main/services/agents/adapter'
import { GitService } from '../../src/main/services/git/git'
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
  Workspace
} from '../../src/shared/types'
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

function createManager(adapter: AgentAdapter): TaskManager {
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
    logsRoot
  })
  return manager
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

/** 收集事件总线上某个任务的状态变化顺序 */
function recordStatuses(seen: AppEvent[], taskId: string): string[] {
  return seen
    .filter(
      (event): event is Extract<AppEvent, { type: 'task-updated' }> =>
        event.type === 'task-updated' && event.task.id === taskId
    )
    .map((event) => event.task.status)
}

describe('TaskManager', () => {
  test('task goes queued -> preparing -> running -> done and commits changes', async () => {
    insertAgent()
    const task = insertTask({ title: 'Implement login', prompt: '实现登录页' })
    const integrationHead = (await gitRun(tempRepo.path, ['rev-parse', INTEGRATION_BRANCH])).stdout.trim()

    const adapter = new FakeAdapter({
      steps: [
        {
          before: async (cwd) => {
            await writeFile(join(cwd, 'LOGIN.md'), 'login page\n')
          },
          event: { type: 'log', text: 'editing login page' }
        },
        { event: { type: 'progress', text: '编辑 Login.tsx' } },
        { event: { type: 'final', summary: '登录页完成' } }
      ]
    })

    const seen: AppEvent[] = []
    events.on((event) => seen.push(event))
    const manager = createManager(adapter)
    manager.start()

    await waitFor(() => tasks.get(task.id)?.status === 'done')

    const stored = tasks.get(task.id) as Task
    expect(stored.status).toBe('done')
    expect(stored.exitCode).toBe(0)
    expect(stored.summary).toBe('登录页完成')
    expect(stored.startedAt).toEqual(expect.any(String))
    expect(stored.finishedAt).toEqual(expect.any(String))

    // 分支与 worktree 规则：agent/<taskId>-<slug>，路径 <worktreesRoot>/<workspaceId>/<taskId>
    expect(stored.branch).toBe(`agent/${task.id}-implement-login`)
    expect(stored.worktreePath).toBe(join(worktreesRoot, workspace.id, task.id))
    // baseRef 记录任务启动时 integration 分支的确切提交
    expect(stored.baseRef).toBe(integrationHead)

    expect(recordStatuses(seen, task.id)).toEqual(['preparing', 'running', 'done'])

    expect(existsSync(join(stored.worktreePath as string, 'LOGIN.md'))).toBe(true)
    // 任务成功后保留 worktree，等 Task 12 合并成功后再删除
    expect(existsSync(stored.worktreePath as string)).toBe(true)

    expect(await git.branchExists(tempRepo.path, stored.branch as string)).toBe(true)
    const { stdout: commitMessage } = await gitRun(stored.worktreePath as string, [
      'log',
      '-1',
      '--pretty=%s'
    ])
    expect(commitMessage.trim()).toBe('agent(claude): Implement login')

    // 进度通过 task-progress 实时推送，同时落一条节流后的系统消息
    const progressEvents = seen.filter(
      (event): event is Extract<AppEvent, { type: 'task-progress' }> =>
        event.type === 'task-progress'
    )
    expect(progressEvents).toEqual([
      { type: 'task-progress', taskId: task.id, lines: ['编辑 Login.tsx'] }
    ])

    const storedMessages = messages.listByWorkspace(workspace.id)
    const contents = storedMessages.map((message) => message.content)
    expect(contents).toContain('开始执行任务：Implement login')
    expect(contents.some((content) => content.includes('任务完成：Implement login'))).toBe(true)
    expect(contents).toContain('编辑 Login.tsx')
    expect(storedMessages.every((message) => message.taskId === task.id)).toBe(true)

    // log 事件写入 <logsRoot>/<taskId>.log
    const log = await readFile(join(logsRoot, `${task.id}.log`), 'utf8')
    expect(log).toContain('editing login page')
  })

  test('setup files are present before the adapter starts', async () => {
    workspaces.update(workspace.id, {
      setupCopy: ['.env'],
      setupCommand: 'cat .env > setup-copied.txt'
    })
    await writeFile(join(tempRepo.path, '.env'), 'TOKEN=abc\n')
    insertAgent()

    let setupObserved = false
    const adapter = new FakeAdapter({
      steps: [
        {
          before: async (cwd) => {
            setupObserved =
              existsSync(join(cwd, '.env')) && existsSync(join(cwd, 'setup-copied.txt'))
            await writeFile(join(cwd, 'OUT.md'), 'done\n')
          },
          event: { type: 'final', summary: '完成' }
        }
      ]
    })

    const task = insertTask({ title: 'With setup' })
    const manager = createManager(adapter)
    manager.start()
    await waitFor(() => tasks.get(task.id)?.status === 'done')

    expect(setupObserved).toBe(true)
    const worktreePath = tasks.get(task.id)?.worktreePath as string
    expect(existsSync(join(worktreePath, '.env'))).toBe(true)
    expect(await readFile(join(worktreePath, 'setup-copied.txt'), 'utf8')).toBe('TOKEN=abc\n')
  })

  test('a setup_copy target that is not gitignored fails the task', async () => {
    workspaces.update(workspace.id, { setupCopy: ['secrets.txt'] })
    await writeFile(join(tempRepo.path, 'secrets.txt'), 'should not be committed\n')
    insertAgent()

    const adapter = new FakeAdapter()
    const task = insertTask({ title: 'Unignored copy' })

    const manager = createManager(adapter)
    manager.start()
    await waitFor(() => tasks.get(task.id)?.status === 'failed')

    const stored = tasks.get(task.id) as Task
    expect(stored.status).toBe('failed')
    expect(stored.summary).toBe('setup_copy 目标未被 .gitignore 忽略：secrets.txt')
    // 失败保留 worktree 现场
    expect(existsSync(stored.worktreePath as string)).toBe(true)
    // 校验发生在启动适配器之前
    expect(adapter.runs).toHaveLength(0)
  })

  test('an ignored setup_copy target is not committed into the agent branch', async () => {
    workspaces.update(workspace.id, {
      setupCopy: ['.env'],
      setupCommand: 'cat .env > setup-copied.txt'
    })
    await writeFile(join(tempRepo.path, '.env'), 'TOKEN=abc\n')
    insertAgent()

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

    const task = insertTask({ title: 'Ignored copy' })
    const manager = createManager(adapter)
    manager.start()
    await waitFor(() => tasks.get(task.id)?.status === 'done')

    const stored = tasks.get(task.id) as Task
    const changed = await git.changedFiles(
      stored.worktreePath as string,
      stored.baseRef as string
    )
    expect(changed).toContain('OUT.md')
    // setup 复制的 .env 与 setup 命令生成的文件都不应进入提交
    expect(changed).not.toContain('.env')
    expect(changed).not.toContain('setup-copied.txt')
  })

  test('cancel during setup marks the task cancelled without starting the adapter', async () => {
    workspaces.update(workspace.id, {
      setupCommand: 'touch setup-started && sleep 5 && touch setup-finished'
    })
    insertAgent()

    const adapter = new FakeAdapter()
    const task = insertTask({ title: 'Cancel during setup' })

    const manager = createManager(adapter)
    const startedAt = Date.now()
    manager.start()

    // 等待 setup 命令真正开始执行，再模拟用户取消
    await waitFor(() => {
      const worktreePath = tasks.get(task.id)?.worktreePath
      return worktreePath !== null && worktreePath !== undefined && existsSync(join(worktreePath, 'setup-started'))
    })

    await manager.cancel(task.id)
    const elapsed = Date.now() - startedAt

    const stored = tasks.get(task.id) as Task
    expect(stored.status).toBe('cancelled')
    expect(stored.summary).toContain('取消')
    // 取消应立即生效，而不是等 setup 超时或 sleep 结束
    expect(elapsed).toBeLessThan(3000)
    // setup 阶段取消时从未启动适配器，也不应发出“开始执行任务”消息
    expect(adapter.runs).toHaveLength(0)
    const contents = messages.listByWorkspace(workspace.id).map((message) => message.content)
    expect(contents.some((content) => content.includes('开始执行任务'))).toBe(false)

    // setup 进程被终止，后续的 touch setup-finished 不会执行
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(existsSync(join(stored.worktreePath as string, 'setup-finished'))).toBe(false)
  })

  test('only one task per agent runs at a time', async () => {
    insertAgent()

    // 同一个 FakeAdapter 实例被两个任务复用，记录到的最大并发数即调度结果
    const adapter = new FakeAdapter({
      steps: [
        { delayMs: 40, event: { type: 'progress', text: 'working' } },
        { event: { type: 'final', summary: '完成' } }
      ]
    })
    const first = insertTask({
      title: 'First',
      prompt: '第一个任务',
      createdAt: '2026-11-18T10:00:00.000Z'
    })
    const second = insertTask({
      title: 'Second',
      prompt: '第二个任务',
      createdAt: '2026-11-18T10:00:01.000Z'
    })

    const manager = createManager(adapter)
    manager.start()
    await waitFor(
      () =>
        tasks.get(first.id)?.status === 'done' && tasks.get(second.id)?.status === 'done'
    )

    expect(adapter.maxActive).toBe(1)
    expect(adapter.runs).toHaveLength(2)
    expect(adapter.runs[0]?.prompt).toContain('第一个任务')
    expect(adapter.runs[1]?.prompt).toContain('第二个任务')
  })

  test('timeout marks the task failed and kills the adapter', async () => {
    // 任务超时按分钟配置；使用小数分钟让测试在亚秒级完成
    workspaces.update(workspace.id, { taskTimeoutMin: 0.002 })
    insertAgent()

    const adapter = new FakeAdapter({
      steps: [{ delayMs: 5000, event: { type: 'final', summary: '不会到达' } }]
    })
    const task = insertTask({ title: 'Slow' })

    const seen: AppEvent[] = []
    events.on((event) => seen.push(event))
    const manager = createManager(adapter)

    const startedAt = Date.now()
    manager.start()
    await waitFor(() => tasks.get(task.id)?.status === 'failed')
    const elapsed = Date.now() - startedAt

    const stored = tasks.get(task.id) as Task
    expect(stored.status).toBe('failed')
    expect(stored.summary).toContain('超时')
    expect(stored.finishedAt).toEqual(expect.any(String))
    // 适配器确实收到了取消信号，而不是自然结束
    expect(adapter.runs[0]?.signal.aborted).toBe(true)
    expect(adapter.active).toBe(0)
    expect(elapsed).toBeLessThan(3000)
    expect(recordStatuses(seen, task.id)).toEqual(['preparing', 'running', 'failed'])
  })

  test('cancel marks the task cancelled', async () => {
    insertAgent()
    const adapter = new FakeAdapter({
      steps: [{ delayMs: 5000, event: { type: 'final', summary: '不会到达' } }]
    })
    const task = insertTask({ title: 'Cancel me' })

    const manager = createManager(adapter)
    manager.start()
    await waitFor(() => adapter.runs.length === 1 && tasks.get(task.id)?.status === 'running')

    await manager.cancel(task.id)

    const stored = tasks.get(task.id) as Task
    expect(stored.status).toBe('cancelled')
    expect(stored.summary).toContain('取消')
    expect(stored.finishedAt).toEqual(expect.any(String))
    expect(adapter.runs[0]?.signal.aborted).toBe(true)
    expect(adapter.active).toBe(0)
  })

  test('cancelAll aborts every active task and resolves promptly', async () => {
    insertAgent({ id: 'agent-claude', name: 'claude' })
    insertAgent({ id: 'agent-codex', name: 'codex' })
    const adapter = new FakeAdapter({
      steps: [{ delayMs: 5000, event: { type: 'final', summary: '不会到达' } }]
    })
    const first = insertTask({
      title: 'First',
      agentId: 'agent-claude',
      createdAt: '2026-11-18T10:00:00.000Z'
    })
    const second = insertTask({
      title: 'Second',
      agentId: 'agent-codex',
      createdAt: '2026-11-18T10:00:01.000Z'
    })
    // 同一 Agent 的第三个任务只能排队；取消收尾时不能被重新调度启动
    const queued = insertTask({
      title: 'Queued',
      agentId: 'agent-claude',
      createdAt: '2026-11-18T10:00:02.000Z'
    })

    const manager = createManager(adapter)
    manager.start()
    await waitFor(
      () =>
        adapter.runs.length === 2 &&
        tasks.get(first.id)?.status === 'running' &&
        tasks.get(second.id)?.status === 'running'
    )

    const startedAt = Date.now()
    await manager.cancelAll()
    const elapsed = Date.now() - startedAt

    // 退出前必须同时结束所有 Agent，而不是只取消第一个
    expect(tasks.get(first.id)?.status).toBe('cancelled')
    expect(tasks.get(second.id)?.status).toBe('cancelled')
    expect(tasks.get(queued.id)?.status).toBe('queued')
    expect(adapter.runs).toHaveLength(2)
    expect(adapter.runs.every((run) => run.signal.aborted)).toBe(true)
    expect(adapter.active).toBe(0)
    // 两个适配器都在等待 5 秒；cancelAll 应在取消信号后立即返回
    expect(elapsed).toBeLessThan(3000)
  })

  test('adapter failure marks the task failed with its message', async () => {
    insertAgent()
    const adapter = new FakeAdapter({
      steps: [{ event: { type: 'log', text: 'trying' } }],
      error: new AgentRunError('模型调用失败', 2)
    })
    const task = insertTask({ title: 'Will fail' })

    const seen: AppEvent[] = []
    events.on((event) => seen.push(event))
    const manager = createManager(adapter)
    manager.start()

    await waitFor(() => tasks.get(task.id)?.status === 'failed')

    const stored = tasks.get(task.id) as Task
    expect(stored.summary).toBe('模型调用失败')
    expect(stored.exitCode).toBe(2)
    expect(recordStatuses(seen, task.id)).toEqual(['preparing', 'running', 'failed'])
  })

  test('prompt includes role, path scope and task text', async () => {
    insertAgent({
      rolePrompt: '你是前端专家',
      pathScope: ['web/**', 'tests/**']
    })
    const adapter = new FakeAdapter()
    const task = insertTask({ title: 'Prompt', prompt: '实现按钮' })

    const manager = createManager(adapter)
    manager.start()
    await waitFor(() => tasks.get(task.id)?.status === 'done')

    expect(adapter.runs[0]?.prompt).toBe(
      '你是前端专家\n\n你的修改范围：web/**、tests/**；为空表示不限\n\n实现按钮'
    )
    // 没有产生改动时提交为空，摘要标记为无代码改动
    expect(tasks.get(task.id)?.summary).toBe('无代码改动')
  })
})
