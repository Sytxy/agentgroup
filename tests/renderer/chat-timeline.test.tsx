// 群聊时间线测试：四类消息渲染差异、实时事件去重、发送结果合并。
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
  AgentConfig,
  AppEvent,
  ChatMessage,
  Task,
  Workspace
} from '../../src/shared/types'
import App from '../../src/renderer/src/App'
import ChatTimeline from '../../src/renderer/src/components/ChatTimeline'

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
  testAgentId: null,
  testTaskTemplate: '运行全部测试',
  lastVerification: 'unknown',
  createdAt: '2026-11-18T00:00:00.000Z'
}

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

function message(
  id: string,
  kind: ChatMessage['kind'],
  content: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    workspaceId: 'w1',
    kind,
    authorType: kind === 'agent' ? 'agent' : kind === 'user' ? 'user' : 'system',
    authorId: null,
    content,
    taskId: null,
    createdAt: '2026-11-18T00:00:00.000Z',
    ...extra
  }
}

function task(id: string, status: Task['status']): Task {
  return {
    id,
    workspaceId: 'w1',
    agentId: 'a1',
    parentTaskId: null,
    taskType: 'code',
    title: '修复登录',
    prompt: '修复登录',
    branch: null,
    worktreePath: null,
    baseRef: null,
    status,
    exitCode: null,
    summary: null,
    createdAt: '2026-11-18T00:00:00.000Z',
    startedAt: null,
    finishedAt: null
  }
}

afterEach(() => {
  cleanup()
})

describe('群聊时间线', () => {
  test('timeline renders user, system and task-card messages differently', () => {
    render(
      <ChatTimeline
        messages={[
          message('m1', 'user', '请修复登录'),
          message('m2', 'agent', '收到，开始处理', { authorId: 'a1' }),
          message('m3', 'system', '已分派 1 个任务'),
          message('m4', 'task-card', '修复登录', { taskId: 't1' })
        ]}
        tasks={[task('t1', 'running')]}
        agents={[agent('a1', 'claude')]}
      />
    )

    const user = screen.getByTestId('message-user')
    expect(user).toHaveClass('message-user')
    expect(user).toHaveTextContent('请修复登录')

    const system = screen.getByTestId('message-system')
    expect(system).toHaveClass('message-system')
    expect(system).toHaveTextContent('已分派 1 个任务')

    const card = screen.getByTestId('message-task-card')
    expect(card).toHaveClass('message-task-card')
    expect(card).toHaveTextContent('修复登录')
    // 任务卡片展示对应任务的当前状态（中文标签）
    expect(card).toHaveTextContent('运行中')

    // Agent 消息展示成员名而不是 id
    const agentMessage = screen.getByTestId('message-agent')
    expect(agentMessage).toHaveTextContent('claude')
    expect(agentMessage).toHaveTextContent('收到，开始处理')
  })

  test('agent message falls back to author id then 已删除的成员', () => {
    render(
      <ChatTimeline
        messages={[
          message('m1', 'agent', '旧成员的消息', { authorId: 'gone' }),
          message('m2', 'agent', '无作者的消息')
        ]}
        tasks={[]}
        agents={[]}
      />
    )

    expect(screen.getByText('gone')).toBeInTheDocument()
    expect(screen.getByText('已删除的成员')).toBeInTheDocument()
  })
})

describe('实时事件与发送', () => {
  type Handler = (payload?: unknown) => unknown

  /** 安装 window.api mock，并保留事件回调以便测试主动推送。 */
  function installApi(handlers: Record<string, Handler>): {
    invoke: ReturnType<typeof vi.fn>
    emit: (event: AppEvent) => void
    unsubscribe: ReturnType<typeof vi.fn>
  } {
    let listener: ((event: AppEvent) => void) | null = null
    const unsubscribe = vi.fn()
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      const handler = handlers[channel]
      if (!handler) {
        throw new Error(`未预期的 IPC 通道：${channel}`)
      }
      return handler(payload)
    })
    window.api = {
      invoke,
      onEvent: vi.fn((callback: (event: AppEvent) => void) => {
        listener = callback
        return unsubscribe
      })
    }
    return {
      invoke,
      emit: (event) => {
        listener?.(event)
      },
      unsubscribe
    }
  }

  function initialHandlers(history: ChatMessage[]): Record<string, Handler> {
    return {
      'workspace:list': () => [workspace],
      'chat:history': () => history,
      'tasks:list': () => [],
      'agents:list': () => [agent('a1', 'claude')],
      'workspace:diff': () => ({ files: 0, insertions: 0, deletions: 0 })
    }
  }

  test('live message event is appended once even if emitted twice', async () => {
    const history = message('h1', 'user', '历史消息')
    const { emit, unsubscribe } = installApi(initialHandlers([history]))

    const view = render(<App />)
    expect(await screen.findByText('历史消息')).toBeInTheDocument()
    await waitFor(() => expect(window.api.onEvent).toHaveBeenCalled())

    const live = message('live1', 'user', '实时消息')
    act(() => emit({ type: 'message', message: live }))
    act(() => emit({ type: 'message', message: live }))

    expect(screen.getAllByText('实时消息')).toHaveLength(1)
    expect(screen.getAllByTestId('message-user')).toHaveLength(2)

    // 卸载时退订，避免窗口销毁后仍收到事件
    view.unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  test('live message arriving during initial history load is kept', async () => {
    let resolveHistory: ((messages: ChatMessage[]) => void) | null = null
    const pendingHistory = new Promise<ChatMessage[]>((resolve) => {
      resolveHistory = resolve
    })
    const historyMessage = message('h1', 'user', '历史消息')
    const { emit } = installApi({
      ...initialHandlers([]),
      'chat:history': () => pendingHistory
    })

    render(<App />)
    // 订阅建立时 chat:history 仍处于挂起状态
    await waitFor(() => expect(window.api.onEvent).toHaveBeenCalled())

    const live = message('live-load', 'user', '加载期间的实时消息')
    act(() => emit({ type: 'message', message: live }))
    expect(screen.getByText('加载期间的实时消息')).toBeInTheDocument()

    // 历史响应不含实时消息，合并时不能把它覆盖掉
    await act(async () => {
      resolveHistory?.([historyMessage])
    })

    const rendered = await screen.findAllByTestId('message-user')
    expect(rendered.map((item) => item.textContent)).toEqual([
      expect.stringContaining('历史消息'),
      expect.stringContaining('加载期间的实时消息')
    ])
    expect(screen.getAllByText('加载期间的实时消息')).toHaveLength(1)
  })

  test('chat:send merges the returned message without duplicating the event', async () => {
    const sent = message('s1', 'user', '大家好')
    let emitEvent: ((event: AppEvent) => void) | null = null
    const api = installApi({
      ...initialHandlers([]),
      'chat:send': () => ({ message: sent, tasks: [] })
    })
    // 包一层 onEvent，便于模拟主进程在返回响应前先推送 message 事件
    vi.mocked(window.api.onEvent).mockImplementation((callback) => {
      emitEvent = callback
      return () => {}
    })

    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'demo' })
    await waitFor(() => expect(window.api.onEvent).toHaveBeenCalled())

    const input = screen.getByRole('textbox', { name: '消息输入' })
    fireEvent.change(input, { target: { value: '大家好' } })
    act(() => emitEvent?.({ type: 'message', message: sent }))
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('chat:send', {
        workspaceId: 'w1',
        text: '大家好'
      })
    })
    expect(await screen.findByText('大家好')).toBeInTheDocument()
    // 事件先到、响应后到，按 id 去重后只保留一条
    expect(screen.getAllByTestId('message-user')).toHaveLength(1)
  })
})
