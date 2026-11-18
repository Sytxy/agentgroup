// 任务卡片与顶部状态测试：按状态渲染操作、调用对应 IPC、展开日志，
// 以及顶部验证状态与"复制合入命令"按钮。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
  AgentConfig,
  AppEvent,
  ChatMessage,
  Task,
  TaskStatus,
  Workspace
} from '../../src/shared/types'
import App from '../../src/renderer/src/App'
import TaskCard from '../../src/renderer/src/components/TaskCard'

function agent(id: string, name: string, enabled = true): AgentConfig {
  return {
    id,
    workspaceId: 'w1',
    name,
    preset: 'claude',
    command: 'claude',
    argsTemplate: null,
    rolePrompt: '',
    pathScope: [],
    permissionProfile: 'edit-only',
    canDelegate: false,
    enabled
  }
}

function makeTask(status: TaskStatus, overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    workspaceId: 'w1',
    agentId: 'a1',
    parentTaskId: null,
    taskType: 'code',
    title: '修复登录',
    prompt: '修复登录',
    branch: 'agent/t1-login',
    worktreePath: '/tmp/worktrees/w1/t1',
    baseRef: 'abc123',
    status,
    exitCode: null,
    summary: null,
    createdAt: '2026-11-18T00:00:00.000Z',
    startedAt: '2026-11-18T00:00:00.000Z',
    finishedAt: null,
    ...overrides
  }
}

type Handler = (payload?: unknown) => unknown

function installApi(handlers: Record<string, Handler>): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    const handler = handlers[channel]
    if (handler === undefined) {
      throw new Error(`未预期的 IPC 通道：${channel}`)
    }
    return handler(payload)
  })
  window.api = {
    invoke,
    onEvent: vi.fn(() => () => {})
  }
  return invoke
}

const taskActions: Record<string, Handler> = {
  'tasks:cancel': () => undefined,
  'tasks:retry': () => undefined,
  'tasks:approve-merge': () => undefined,
  'tasks:abandon': () => undefined,
  'tasks:prepare-resolve': () => '/tmp/worktrees/w1/t1',
  'tasks:open-worktree': () => '/tmp/worktrees/w1/t1',
  'tasks:mark-resolved': () => undefined,
  'tasks:create-resolve': () => makeTask('queued', { id: 'resolve-1' }),
  'tasks:log': () => '第一行日志\n第二行日志'
}

function renderCard(
  status: TaskStatus,
  overrides: Partial<Task> = {}
): ReturnType<typeof installApi> {
  const invoke = installApi(taskActions)
  render(
    <TaskCard
      task={makeTask(status, overrides)}
      agent={agent('a1', 'claude')}
      agents={[agent('a1', 'claude'), agent('a2', 'codex'), agent('a3', '停用成员', false)]}
      progress={['编辑 Login.tsx', '运行 pnpm test']}
    />
  )
  return invoke
}

afterEach(() => {
  cleanup()
})

describe('任务卡片', () => {
  test('task card shows status-specific actions for conflict and awaiting_approval', async () => {
    const invoke = renderCard('conflict')

    // 冲突卡片四个操作齐全
    expect(screen.getByRole('button', { name: '指派 Agent 解决' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开 worktree' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '标记已解决并重新合并' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '放弃' })).toBeInTheDocument()

    // 只允许选择启用中的成员
    const select = screen.getByLabelText('选择解决 Agent')
    expect(screen.queryByRole('option', { name: '停用成员' })).not.toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'a2' } })
    fireEvent.click(screen.getByRole('button', { name: '指派 Agent 解决' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('tasks:create-resolve', {
        taskId: 't1',
        agentId: 'a2'
      })
    })

    fireEvent.click(screen.getByRole('button', { name: '打开 worktree' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('tasks:prepare-resolve', { taskId: 't1' })
      expect(invoke).toHaveBeenCalledWith('tasks:open-worktree', { taskId: 't1' })
    })

    fireEvent.click(screen.getByRole('button', { name: '标记已解决并重新合并' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('tasks:mark-resolved', { taskId: 't1' })
    })

    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('tasks:abandon', { taskId: 't1' })
    })

    cleanup()
    const awaiting = renderCard('awaiting_approval')
    expect(screen.getByRole('button', { name: '继续合并' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '放弃' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '继续合并' }))
    await waitFor(() => {
      expect(awaiting).toHaveBeenCalledWith('tasks:approve-merge', { taskId: 't1' })
    })
  })

  test('conflict actions are hidden while a resolve task owns the worktree', () => {
    installApi(taskActions)
    render(
      <TaskCard
        task={makeTask('conflict')}
        activeResolveTask={makeTask('running', {
          id: 'resolve-1',
          taskType: 'resolve',
          parentTaskId: 't1',
          agentId: 'a2'
        })}
        agents={[agent('a1', 'claude'), agent('a2', 'codex')]}
        progress={[]}
      />
    )

    expect(screen.getByTestId('resolve-active')).toHaveTextContent('解决任务进行中')
    // 指派/打开/标记/放弃都会并发操作同一 worktree，必须全部隐藏
    expect(screen.queryByRole('button', { name: '指派 Agent 解决' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开 worktree' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '标记已解决并重新合并' })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '放弃' })).not.toBeInTheDocument()
    // 只读操作（日志）仍可用
    expect(screen.getByRole('button', { name: '展开日志' })).toBeInTheDocument()
  })

  test('App hides conflict actions when a resolve task is still active', async () => {
    const conflict = makeTask('conflict')
    const resolve = makeTask('running', {
      id: 'resolve-1',
      taskType: 'resolve',
      parentTaskId: 't1',
      agentId: 'a2'
    })
    const cardMessage: ChatMessage = {
      id: 'm-card',
      workspaceId: 'w1',
      kind: 'task-card',
      authorType: 'system',
      authorId: null,
      content: '修复登录',
      taskId: 't1',
      createdAt: '2026-11-18T00:00:00.000Z'
    }
    installApi({
      'workspace:list': () => [workspace],
      'chat:history': () => [cardMessage],
      'tasks:list': () => [conflict, resolve],
      'agents:list': () => [agent('a1', 'claude'), agent('a2', 'codex')],
      'workspace:diff': () => ({ files: 0, insertions: 0, deletions: 0 })
    })

    render(<App />)
    expect(await screen.findByTestId('resolve-active')).toHaveTextContent('解决任务进行中')
    expect(screen.queryByRole('button', { name: '指派 Agent 解决' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '放弃' })).not.toBeInTheDocument()
  })

  test('failed, cancelled and interrupted tasks offer retry and abandon', async () => {
    for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
      const invoke = renderCard(status)
      expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '放弃' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('tasks:retry', { taskId: 't1' })
      })
      cleanup()
    }
  })

  test('running task can be cancelled; merged task has no destructive actions', async () => {
    const running = renderCard('running')
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => {
      expect(running).toHaveBeenCalledWith('tasks:cancel', { taskId: 't1' })
    })

    cleanup()
    renderCard('merged')
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '放弃' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '展开日志' })).toBeInTheDocument()
  })

  test('card shows agent, branch, elapsed time, status and recent progress', () => {
    render(
      <TaskCard
        task={makeTask('running', {
          startedAt: '2026-11-18T00:00:00.000Z',
          finishedAt: '2026-11-18T00:02:30.000Z'
        })}
        agent={agent('a1', 'claude')}
        agents={[agent('a1', 'claude')]}
        progress={['编辑 Login.tsx', '运行 pnpm test']}
      />
    )

    expect(screen.getByText('claude')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-status')).toHaveTextContent('运行中')
    expect(screen.getByTestId('task-branch')).toHaveTextContent('agent/t1-login')
    expect(screen.getByTestId('task-elapsed')).toHaveTextContent('耗时 2m 30s')
    expect(screen.getByTestId('task-progress')).toHaveTextContent('编辑 Login.tsx')
    expect(screen.getByTestId('task-progress')).toHaveTextContent('运行 pnpm test')

    cleanup()
    // 成员被删除时回退为固定文案
    render(
      <TaskCard task={makeTask('running')} agents={[]} progress={[]} />
    )
    expect(screen.getByText('已删除的成员')).toBeInTheDocument()
  })

  test('expanding the log loads tasks:log on demand', async () => {
    const invoke = renderCard('running')
    expect(invoke).not.toHaveBeenCalledWith('tasks:log', { taskId: 't1' })

    fireEvent.click(screen.getByRole('button', { name: '展开日志' }))
    expect(await screen.findByTestId('task-log')).toHaveTextContent('第一行日志')
    expect(invoke).toHaveBeenCalledWith('tasks:log', { taskId: 't1' })
    expect(screen.getByRole('button', { name: '收起日志' })).toBeInTheDocument()
  })
})

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
  lastVerification: 'passed',
  createdAt: '2026-11-18T00:00:00.000Z'
}

describe('顶部验证状态', () => {
  test('header shows lastVerification and copies the integration merge command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })

    installApi({
      'workspace:list': () => [workspace],
      'chat:history': () => [] as ChatMessage[],
      'tasks:list': () => [] as Task[],
      'agents:list': () => [agent('a1', 'claude')],
      'workspace:diff': () => ({ files: 0, insertions: 0, deletions: 0 })
    })

    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'demo' })).toBeInTheDocument()
    expect(screen.getByTestId('verification-status')).toHaveTextContent('测试通过')

    fireEvent.click(screen.getByRole('button', { name: '复制合入命令' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('git merge agentgroup/integration')
    })
    expect(await screen.findByText('已复制')).toBeInTheDocument()
  })

  test('copy failure falls back to a readable command', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockRejectedValue(new Error('没有剪贴板权限'))
      },
      configurable: true
    })
    installApi({
      'workspace:list': () => [workspace],
      'chat:history': () => [] as ChatMessage[],
      'tasks:list': () => [] as Task[],
      'agents:list': () => [] as AgentConfig[],
      'workspace:diff': () => ({ files: 0, insertions: 0, deletions: 0 })
    })

    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'demo' })
    fireEvent.click(screen.getByRole('button', { name: '复制合入命令' }))
    expect(
      await screen.findByText('复制失败，请手动执行：git merge agentgroup/integration')
    ).toBeInTheDocument()
  })

  test('header follows test task verification events', async () => {
    let listener: ((event: AppEvent) => void) | null = null
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'workspace:list':
          return [{ ...workspace, lastVerification: 'unknown' as const }]
        case 'chat:history':
        case 'tasks:list':
          return []
        case 'agents:list':
          return []
        case 'workspace:diff':
          return { files: 0, insertions: 0, deletions: 0 }
        default:
          throw new Error(`未预期的 IPC 通道：${channel}`)
      }
    })
    window.api = {
      invoke,
      onEvent: vi.fn((callback: (event: AppEvent) => void) => {
        listener = callback
        return () => {}
      })
    }

    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'demo' })
    expect(screen.getByTestId('verification-status')).toHaveTextContent('未验证')

    const emit = (event: AppEvent): void => {
      act(() => listener?.(event))
    }
    const testTask = makeTask('done', { id: 'test-1', taskType: 'test' })
    emit({ type: 'task-updated', task: testTask })
    expect(screen.getByTestId('verification-status')).toHaveTextContent('测试通过')

    // 等待确认未产生新的验证结论，不应把状态改成失败
    emit({ type: 'task-updated', task: { ...testTask, status: 'awaiting_approval' } })
    expect(screen.getByTestId('verification-status')).toHaveTextContent('测试通过')

    emit({ type: 'task-updated', task: { ...testTask, status: 'conflict' } })
    expect(screen.getByTestId('verification-status')).toHaveTextContent('测试失败')
  })
})
