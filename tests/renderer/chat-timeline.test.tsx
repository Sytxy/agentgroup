// 群聊时间线测试：四类消息渲染差异、实时事件去重、发送结果合并。
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  defaultAgentId: null,
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
  test('uses the configured display name for user messages', () => {
    render(
      <ChatTimeline
        messages={[message('m1', 'user', '你好')]}
        tasks={[]}
        agents={[]}
        userName="张三"
      />
    )

    const user = screen.getByTestId('message-user')
    expect(user).toHaveTextContent('张三')
    expect(user).not.toHaveTextContent('我')
  })

  test('timeline renders user, system and task-card messages differently', () => {
    render(
      <ChatTimeline
        messages={[
          message('m1', 'user', '请修复登录'),
          message('m2', 'agent', '收到，开始处理', { authorId: 'a1' }),
          message('m3', 'system', '未找到 Agent：@unknown'),
          message('m4', 'task-card', '修复登录', { taskId: 't1' })
        ]}
        tasks={[task('t1', 'running')]}
        agents={[agent('a1', 'claude')]}
      />
    )

    const user = screen.getByTestId('message-user')
    expect(user).toHaveClass('message-user')
    expect(user).toHaveTextContent('请修复登录')
    expect(user).toHaveTextContent('我')

    const system = screen.getByTestId('message-system')
    expect(system).toHaveClass('message-system')
    expect(system).not.toHaveClass('message-system-long')
    expect(system).toHaveTextContent('未找到 Agent：@unknown')

    const card = screen.getByTestId('message-task-card')
    expect(card).toHaveClass('message-task-card')
    expect(card).toHaveClass('message-agent')
    expect(card).toHaveTextContent('claude')
    expect(card).toHaveTextContent('正在执行')
    // 运行中只保留取消操作，不再展示分支、耗时和工具调用进度
    expect(within(card).getByRole('button', { name: '取消' })).toBeInTheDocument()
    expect(within(card).queryByTestId('task-card-status')).not.toBeInTheDocument()
    expect(within(card).queryByTestId('task-progress')).not.toBeInTheDocument()

    // Agent 消息展示成员名而不是 id
    const agentMessage = screen.getByTestId('message-agent')
    expect(agentMessage).toHaveTextContent('claude')
    expect(agentMessage).toHaveTextContent('你的 agent')
    expect(agentMessage).toHaveTextContent('收到，开始处理')
    expect(user).toHaveTextContent('你')
  })

  test('已发送消息可以复制，用户消息可以重新编辑', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
    const onEditMessage = vi.fn()

    render(
      <ChatTimeline
        messages={[
          message('u1', 'user', '请修复登录'),
          message('a1', 'agent', '收到，开始处理', { authorId: 'a1' })
        ]}
        tasks={[]}
        agents={[agent('a1', 'claude')]}
        onEditMessage={onEditMessage}
      />
    )

    const user = screen.getByTestId('message-user')
    fireEvent.click(within(user).getByRole('button', { name: '复制消息' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('请修复登录'))
    await waitFor(() => expect(within(user).getByText('已复制')).toBeInTheDocument())

    fireEvent.click(within(user).getByRole('button', { name: '重新编辑消息' }))
    expect(onEditMessage).toHaveBeenCalledWith('请修复登录')

    const agentMessage = screen.getByTestId('message-agent')
    expect(
      within(agentMessage).getByRole('button', { name: '复制消息' })
    ).toBeInTheDocument()
  })

  test('长 Agent 输出不再套系统胶囊框', () => {
    render(
      <ChatTimeline
        messages={[
          message(
            'm1',
            'system',
            '我没有收到具体任务。\n\n我这边的情况：\n- 工作目录：/tmp/repo\n- 分支：agent/task\n\n请告诉我需要做什么。'
          )
        ]}
        tasks={[]}
        agents={[]}
      />
    )

    const system = screen.getByTestId('message-system')
    expect(system).toHaveClass('message-system-long')
    expect(system).toHaveTextContent('请告诉我需要做什么')
  })

  test('任务卡跟随 Agent 长回复展示，并隐藏重复的短状态', () => {
    const longReply =
      '我是负责本工作区的执行代理。\n\n当前情况：\n- 工作区干净\n- 分支 agent/task\n\n请告诉我需要做什么。'
    const onReply = vi.fn()
    render(
      <ChatTimeline
        messages={[
          message('u1', 'user', '@claude 你是谁？'),
          message('assigned', 'system', '已分派 1 个任务：claude'),
          message('card', 'task-card', '你是谁？', { taskId: 't1' }),
          message('start', 'system', '开始执行任务：你是谁？', { taskId: 't1' }),
          message('reply', 'agent', longReply, { taskId: 't1', authorId: 'a1' }),
          message('done', 'system', '任务完成：你是谁？\n无代码改动', { taskId: 't1' })
        ]}
        tasks={[task('t1', 'merged')]}
        agents={[agent('a1', 'claude')]}
        onReply={onReply}
      />
    )

    // 任务的短状态消息不再刷屏
    expect(screen.queryByText(/开始执行任务/)).not.toBeInTheDocument()
    expect(screen.queryByText(/任务完成/)).not.toBeInTheDocument()
    expect(screen.queryByText(/已分派/)).not.toBeInTheDocument()
    // 独立任务卡不再出现，而是收在 Agent 回复下方
    expect(screen.queryByTestId('message-task-card')).not.toBeInTheDocument()

    const agentMessage = screen.getByTestId('message-agent')
    expect(agentMessage).toHaveTextContent('claude')
    expect(agentMessage).toHaveTextContent('我是负责本工作区')
    // 引用用户原消息，并提供回复入口
    expect(agentMessage).toHaveTextContent('@claude 你是谁？')
    fireEvent.click(within(agentMessage).getByRole('button', { name: /回复/ }))
    expect(onReply).toHaveBeenCalledWith('claude')
    const inlineCard = within(agentMessage).getByTestId('task-card')
    expect(inlineCard).toHaveClass('task-card-inline')
    expect(inlineCard).toHaveTextContent('已合并')
  })

  test('没有最终回复的任务也以聊天消息展示摘要和紧凑状态', () => {
    render(
      <ChatTimeline
        messages={[message('card', 'task-card', '分析项目', { taskId: 't1' })]}
        tasks={[{ ...task('t1', 'merged'), summary: '这是项目分析结果' }]}
        agents={[agent('a1', 'claude')]}
      />
    )

    const card = screen.getByTestId('message-task-card')
    expect(card).toHaveClass('message-agent')
    expect(card).toHaveTextContent('claude')
    expect(card).toHaveTextContent('这是项目分析结果')
    expect(within(card).getByTestId('task-card')).toHaveClass('task-card-inline')
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
