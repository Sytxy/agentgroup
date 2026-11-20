// 初始加载容错测试：差异统计失败不能把消息、任务和成员一起隐藏，
// 并提供可重试入口。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AgentConfig, AppEvent, ChatMessage, Task, Workspace } from '../../src/shared/types'
import App from '../../src/renderer/src/App'

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

const agent: AgentConfig = {
  id: 'a1',
  workspaceId: 'w1',
  name: 'claude',
  preset: 'claude',
  command: 'claude',
  argsTemplate: null,
  rolePrompt: '',
  pathScope: [],
  permissionProfile: 'edit-only',
  canDelegate: false,
  enabled: true
}

const task: Task = {
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
  status: 'running',
  exitCode: null,
  summary: null,
  createdAt: '2026-11-18T00:00:00.000Z',
  startedAt: '2026-11-18T00:00:00.000Z',
  finishedAt: null
}

const historyMessage: ChatMessage = {
  id: 'm1',
  workspaceId: 'w1',
  kind: 'user',
  authorType: 'user',
  authorId: null,
  content: '请修复登录',
  taskId: null,
  createdAt: '2026-11-18T00:00:00.000Z'
}

const cardMessage: ChatMessage = {
  id: 'm2',
  workspaceId: 'w1',
  kind: 'task-card',
  authorType: 'system',
  authorId: null,
  content: '修复登录',
  taskId: 't1',
  createdAt: '2026-11-18T00:00:00.000Z'
}

afterEach(() => {
  cleanup()
})

describe('初始加载容错', () => {
  test('diff 失败时消息、任务、成员仍然渲染，并可以重试', async () => {
    let diffCalls = 0
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'workspace:list':
          return [workspace]
        case 'chat:history':
          return [historyMessage, cardMessage]
        case 'tasks:list':
          return [task]
        case 'agents:list':
          return [agent]
        case 'workspace:diff':
          diffCalls += 1
          if (diffCalls === 1) {
            throw new Error('integration worktree 不存在')
          }
          return { files: 2, insertions: 10, deletions: 3 }
        default:
          throw new Error(`未预期的 IPC 通道：${channel}`)
      }
    })
    window.api = {
      invoke,
      onEvent: vi.fn((_callback: (event: AppEvent) => void) => () => {})
    }

    render(<App />)

    // 消息、任务卡片和成员面板照常显示（成员面板默认收起）
    expect(await screen.findByText('请修复登录')).toBeInTheDocument()
    expect(await screen.findByTestId('task-card')).toHaveTextContent('取消')
    fireEvent.click(screen.getByRole('button', { name: '成员' }))
    expect(screen.getByTestId('agent-a1')).toHaveTextContent('claude')
    // 差异统计单独降级为头部提示，不产生整页错误
    expect(screen.getByTestId('diff-error')).toHaveTextContent('差异不可用')
    expect(screen.queryByText(/加载项目数据失败/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重新加载项目数据' }))

    await waitFor(() => expect(diffCalls).toBe(2))
    expect(await screen.findByTestId('diff-stat')).toHaveTextContent('2 个文件 · +10 · -3')
    expect(screen.queryByTestId('diff-error')).not.toBeInTheDocument()
    // 重试不会清空已经加载的内容
    expect(screen.getByText('请修复登录')).toBeInTheDocument()
    expect(screen.getByTestId('agent-a1')).toHaveTextContent('claude')
  })
})
