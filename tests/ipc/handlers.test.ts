// IPC 处理器测试：用假上下文验证参数转发与错误包装，不启动 Electron。
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { AgentConfig, ChatMessage, Task, Workspace } from '../../src/shared/types'
import { IPC } from '../../src/shared/ipc'
import { AgentRepo } from '../../src/main/db/agent-repo'
import { TaskRepo } from '../../src/main/db/task-repo'
import { createAppContext, type AppContext } from '../../src/main/app-context'
import { createIpcHandlers } from '../../src/main/ipc-handlers'
import { EventBus } from '../../src/main/events'
import { GitService } from '../../src/main/services/git/git'
import { MergeCoordinator } from '../../src/main/services/tasks/merge-coordinator'
import { TaskManager } from '../../src/main/services/tasks/task-manager'
import { Dispatcher } from '../../src/main/services/chat/dispatcher'
import { WorkspaceService } from '../../src/main/services/workspace-service'
import { createTestDb, WASM_PATH } from '../helpers/db'
import { createTempRepo } from '../helpers/temp-repo'

const workspace: Workspace = {
  id: 'w1',
  name: 'demo',
  repoPath: '/repo',
  integrationBranch: 'agentgroup/integration',
  targetBranch: 'main',
  setupCommand: null,
  setupCopy: [],
  setupTimeoutMin: 10,
  taskTimeoutMin: 60,
  autoMerge: true,
  autoTestAfterMerge: false,
  defaultAgentId: null,
  testAgentId: null,
  testTaskTemplate: '运行全部测试',
  lastVerification: 'unknown',
  createdAt: '2026-11-18T00:00:00.000Z'
}

const task: Task = {
  id: 't1',
  workspaceId: 'w1',
  agentId: 'a1',
  parentTaskId: null,
  taskType: 'code',
  title: '改代码',
  prompt: '改代码',
  branch: 'agent/t1',
  worktreePath: '/tmp/worktrees/w1/t1',
  baseRef: 'abc123',
  status: 'queued',
  exitCode: null,
  summary: null,
  createdAt: '2026-11-18T00:00:00.000Z',
  startedAt: null,
  finishedAt: null
}

const message: ChatMessage = {
  id: 'm1',
  workspaceId: 'w1',
  kind: 'user',
  authorType: 'user',
  authorId: null,
  content: 'hi',
  taskId: null,
  createdAt: '2026-11-18T00:00:00.000Z'
}

const agent: AgentConfig = {
  id: 'a1',
  workspaceId: 'w1',
  name: 'Claude',
  preset: 'claude',
  command: 'claude',
  argsTemplate: null,
  rolePrompt: '认真修改代码',
  pathScope: ['src/**'],
  permissionProfile: 'edit-and-run',
  canDelegate: false,
  enabled: true
}

/** 只提供处理器会访问到的字段；未使用的服务字段用最小桩对象占位。 */
function makeFakeContext() {
  const workspaces = {
    get: vi.fn(),
    list: vi.fn(() => []),
    insert: vi.fn(),
    update: vi.fn()
  }
  const agents = {
    get: vi.fn(),
    listByWorkspace: vi.fn(() => []),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
  const tasks = {
    get: vi.fn(),
    listByWorkspace: vi.fn(() => []),
    insert: vi.fn(),
    update: vi.fn()
  }
  const messages = {
    insert: vi.fn(),
    listByWorkspace: vi.fn(() => [])
  }
  const events = { emit: vi.fn(), on: vi.fn() }
  const git = { branchExists: vi.fn() }
  const workspaceService = {
    create: vi.fn(),
    list: vi.fn(() => []),
    diffStat: vi.fn(),
    integrationWorktreePath: vi.fn()
  }
  const taskManager = {
    cancel: vi.fn(),
    retry: vi.fn(),
    approveMerge: vi.fn(),
    abandon: vi.fn(),
    enqueue: vi.fn(),
    start: vi.fn(),
    recoverInterrupted: vi.fn()
  }
  const mergeCoordinator = {
    mergeTask: vi.fn(),
    approve: vi.fn(),
    abandon: vi.fn(),
    createResolveTask: vi.fn(),
    prepareResolveWorktree: vi.fn(),
    markManuallyResolved: vi.fn()
  }
  const dispatcher = { send: vi.fn() }
  const openPath = vi.fn(async () => {})

  const ctx = {
    db: {},
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
    worktreesRoot: '/tmp/worktrees',
    logsRoot: '/tmp/logs',
    openPath
  } as unknown as AppContext

  return {
    ctx,
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
    openPath
  }
}

describe('createIpcHandlers', () => {
  test('chat:send delegates to Dispatcher and returns created tasks', async () => {
    const { ctx, dispatcher } = makeFakeContext()
    dispatcher.send.mockResolvedValue({ message, tasks: [task] })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers[IPC.chatSend]!({ workspaceId: 'w1', text: 'hi @a1' })

    expect(dispatcher.send).toHaveBeenCalledWith('w1', 'hi @a1')
    expect(result).toEqual({ message, tasks: [task] })
  })

  test('tasks:cancel delegates to TaskManager', async () => {
    const { ctx, taskManager } = makeFakeContext()
    const handlers = createIpcHandlers(ctx)

    await handlers[IPC.tasksCancel]!({ taskId: 't1' })

    expect(taskManager.cancel).toHaveBeenCalledWith('t1')
  })

  test('workspace:create returns the workspace', async () => {
    const { ctx, workspaceService } = makeFakeContext()
    workspaceService.create.mockResolvedValue(workspace)
    const handlers = createIpcHandlers(ctx)

    const result = await handlers[IPC.workspaceCreate]!({
      name: 'demo',
      repoPath: '/repo',
      targetBranch: 'main'
    })

    expect(workspaceService.create).toHaveBeenCalledWith({
      name: 'demo',
      repoPath: '/repo',
      targetBranch: 'main'
    })
    expect(result).toBe(workspace)
  })

  test('agents:remove deletes the agent, clears the list and keeps historical tasks', async () => {
    const handle = await createTestDb()
    try {
      const agents = new AgentRepo(handle.db)
      const tasks = new TaskRepo(handle.db)
      agents.insert(agent)
      tasks.insert(task)
      const { ctx } = makeFakeContext()
      // 用真实仓储验证删除落库与历史任务不受影响，其余服务仍为假实现。
      const handlers = createIpcHandlers({
        ...ctx,
        agents,
        tasks
      } as unknown as AppContext)

      const result = await handlers[IPC.agentsRemove]!({ agentId: 'a1' })

      expect(result).toEqual({ ok: true })
      expect(agents.get('a1')).toBeNull()
      expect(agents.listByWorkspace('w1')).toEqual([])
      expect(tasks.get('t1')).toEqual(task)
    } finally {
      await handle.cleanup()
    }
  })

  test('agents:remove rejects an unknown agent with a readable error', async () => {
    const { ctx, agents } = makeFakeContext()
    agents.get.mockReturnValue(null)
    const handlers = createIpcHandlers(ctx)

    await expect(handlers[IPC.agentsRemove]!({ agentId: 'missing' })).rejects.toThrow(
      `${IPC.agentsRemove} 失败：Agent 不存在：missing`
    )
  })

  test('agents:update ignores workspaceId so agents cannot move workspaces', async () => {
    const { ctx, agents } = makeFakeContext()
    agents.get.mockReturnValue(agent)
    const handlers = createIpcHandlers(ctx)

    await handlers[IPC.agentsUpdate]!({
      agentId: 'a1',
      patch: { workspaceId: 'w2', rolePrompt: '新的角色说明' }
    })

    expect(agents.update).toHaveBeenCalledWith('a1', { rolePrompt: '新的角色说明' })
  })

  test('agents:update trims names and rejects blank names', async () => {
    const { ctx, agents } = makeFakeContext()
    agents.get.mockReturnValue(agent)
    const handlers = createIpcHandlers(ctx)

    await handlers[IPC.agentsUpdate]!({ agentId: 'a1', patch: { name: '  主程  ' } })
    expect(agents.update).toHaveBeenCalledWith('a1', { name: '主程' })

    await expect(
      handlers[IPC.agentsUpdate]!({ agentId: 'a1', patch: { name: '   ' } })
    ).rejects.toThrow(`${IPC.agentsUpdate} 失败：成员名称不能为空`)
  })

  test('unknown channel rejects with a readable error', async () => {
    const { ctx } = makeFakeContext()
    const handlers = createIpcHandlers(ctx)

    await expect(handlers['not:a-channel']!(undefined)).rejects.toThrow(
      /未知 IPC 通道：not:a-channel/
    )
  })

  test('workspace:update validates a non-null target branch', async () => {
    const { ctx, workspaces, git } = makeFakeContext()
    workspaces.get.mockReturnValue(workspace)
    const handlers = createIpcHandlers(ctx)

    git.branchExists.mockResolvedValue(false)
    await expect(
      handlers[IPC.workspaceUpdate]!({
        workspaceId: 'w1',
        patch: { targetBranch: 'gone' }
      })
    ).rejects.toThrow(`${IPC.workspaceUpdate} 失败：目标分支不存在：gone`)
    expect(workspaces.update).not.toHaveBeenCalled()

    // 显式置空表示不再比较，不需要校验分支
    await handlers[IPC.workspaceUpdate]!({
      workspaceId: 'w1',
      patch: { targetBranch: null }
    })
    expect(workspaces.update).toHaveBeenCalledWith('w1', { targetBranch: null })
    expect(git.branchExists).toHaveBeenCalledTimes(1)

    git.branchExists.mockResolvedValue(true)
    await handlers[IPC.workspaceUpdate]!({
      workspaceId: 'w1',
      patch: { targetBranch: 'main' }
    })
    expect(git.branchExists).toHaveBeenCalledWith('/repo', 'main')
    expect(workspaces.update).toHaveBeenCalledWith('w1', { targetBranch: 'main' })
  })

  test('workspace:update validates the default agent', async () => {
    const { ctx, workspaces, agents } = makeFakeContext()
    workspaces.get.mockReturnValue(workspace)
    const handlers = createIpcHandlers(ctx)

    agents.get.mockReturnValue(null)
    await expect(
      handlers[IPC.workspaceUpdate]!({ workspaceId: 'w1', patch: { defaultAgentId: 'a1' } })
    ).rejects.toThrow(`${IPC.workspaceUpdate} 失败：默认 Agent 不存在或不属于该项目`)

    agents.get.mockReturnValue({ ...agent, workspaceId: 'w2' })
    await expect(
      handlers[IPC.workspaceUpdate]!({ workspaceId: 'w1', patch: { defaultAgentId: 'a1' } })
    ).rejects.toThrow(`${IPC.workspaceUpdate} 失败：默认 Agent 不存在或不属于该项目`)

    agents.get.mockReturnValue({ ...agent, enabled: false })
    await expect(
      handlers[IPC.workspaceUpdate]!({ workspaceId: 'w1', patch: { defaultAgentId: 'a1' } })
    ).rejects.toThrow(`${IPC.workspaceUpdate} 失败：默认 Agent 已停用，请先启用`)

    agents.get.mockReturnValue(agent)
    await handlers[IPC.workspaceUpdate]!({
      workspaceId: 'w1',
      patch: { defaultAgentId: 'a1' }
    })
    expect(workspaces.update).toHaveBeenCalledWith('w1', { defaultAgentId: 'a1' })
  })

  test('workspace:pick-folder delegates to the injected picker', async () => {
    const { ctx } = makeFakeContext()
    const pickFolder = vi.fn(async () => '/tmp/repo')
    const handlers = createIpcHandlers({ ...ctx, pickFolder } as unknown as AppContext)

    await expect(handlers[IPC.workspacePickFolder]!(undefined)).resolves.toBe('/tmp/repo')
    expect(pickFolder).toHaveBeenCalled()
  })

  test('tasks:create-resolve delegates and leaves task-card creation to the factory', async () => {
    const { ctx, mergeCoordinator, messages, events } = makeFakeContext()
    const resolveTask: Task = {
      ...task,
      id: 't2',
      parentTaskId: 't1',
      taskType: 'resolve',
      title: '解决冲突：改代码'
    }
    mergeCoordinator.createResolveTask.mockReturnValue(resolveTask)
    const handlers = createIpcHandlers(ctx)

    const result = await handlers[IPC.tasksCreateResolve]!({ taskId: 't1', agentId: 'a1' })

    expect(mergeCoordinator.createResolveTask).toHaveBeenCalledWith('t1', 'a1')
    expect(result).toBe(resolveTask)
    // 卡片消息由 TaskFactory 在协调器内部写入，IPC 层不再重复插入
    expect(messages.insert).not.toHaveBeenCalled()
    expect(events.emit).not.toHaveBeenCalled()
  })

  test('tasks:open-worktree calls the injected openPath', async () => {
    const { ctx, tasks, openPath } = makeFakeContext()
    tasks.get.mockReturnValue(task)
    const handlers = createIpcHandlers(ctx)

    const result = await handlers[IPC.tasksOpenWorktree]!({ taskId: 't1' })

    expect(openPath).toHaveBeenCalledWith('/tmp/worktrees/w1/t1')
    expect(result).toBe('/tmp/worktrees/w1/t1')
  })

  test('tasks:open-worktree rejects when the task has no worktree', async () => {
    const { ctx, tasks, openPath } = makeFakeContext()
    tasks.get.mockReturnValue({ ...task, worktreePath: null })
    const handlers = createIpcHandlers(ctx)

    await expect(handlers[IPC.tasksOpenWorktree]!({ taskId: 't1' })).rejects.toThrow(
      /没有可打开的 worktree/
    )
    expect(openPath).not.toHaveBeenCalled()
  })

  test('service errors are wrapped with the channel name', async () => {
    const { ctx, taskManager } = makeFakeContext()
    taskManager.cancel.mockRejectedValue(new Error('任务不存在：t1'))
    const handlers = createIpcHandlers(ctx)

    await expect(handlers[IPC.tasksCancel]!({ taskId: 't1' })).rejects.toThrow(
      `${IPC.tasksCancel} 失败：任务不存在：t1`
    )
  })

  test('every declared IPC channel has a handler', () => {
    const { ctx } = makeFakeContext()
    const handlers = createIpcHandlers(ctx)

    // 用自有键检查：Proxy 会为任意字符串返回“未知通道”处理器，
    // 直接取 handlers[channel] 无法证明通道真的被注册。
    expect(Object.keys(handlers).sort()).toEqual([...Object.values(IPC)].sort())
  })
})

describe('createAppContext', () => {
  test('assembles all services from injected paths without Electron', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentgroup-ctx-'))
    const ctx = await createAppContext({
      dbPath: path.join(dir, 'agentgroup.db'),
      wasmPath: WASM_PATH,
      worktreesRoot: path.join(dir, 'worktrees'),
      logsRoot: path.join(dir, 'logs'),
      openPath: async () => {}
    })

    try {
      expect(ctx.events).toBeInstanceOf(EventBus)
      expect(ctx.git).toBeInstanceOf(GitService)
      expect(ctx.workspaceService).toBeInstanceOf(WorkspaceService)
      expect(ctx.taskManager).toBeInstanceOf(TaskManager)
      expect(ctx.mergeCoordinator).toBeInstanceOf(MergeCoordinator)
      expect(ctx.dispatcher).toBeInstanceOf(Dispatcher)
    } finally {
      ctx.db.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('startup recreates a missing integration worktree', async () => {
    const repo = await createTempRepo()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentgroup-ctx-heal-'))
    const deps = {
      dbPath: path.join(dir, 'agentgroup.db'),
      wasmPath: WASM_PATH,
      worktreesRoot: path.join(dir, 'worktrees'),
      logsRoot: path.join(dir, 'logs'),
      openPath: async () => {}
    }

    const first = await createAppContext(deps)
    let worktreePath = ''
    try {
      const workspace = await first.workspaceService.create({
        name: 'Demo',
        repoPath: repo.path
      })
      worktreePath = first.workspaceService.integrationWorktreePath(workspace.id)
      expect(existsSync(worktreePath)).toBe(true)
    } finally {
      first.db.close()
    }

    // 模拟数据目录被移动/删除：数据库记录还在，worktree 目录已消失
    await fs.rm(worktreePath, { recursive: true, force: true })
    expect(existsSync(worktreePath)).toBe(false)

    const second = await createAppContext(deps)
    try {
      expect(existsSync(worktreePath)).toBe(true)
    } finally {
      second.db.close()
      await repo.cleanup()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
