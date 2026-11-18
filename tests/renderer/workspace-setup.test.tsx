// 渲染进程外壳测试：mock window.api.invoke，验证空状态、创建流程、错误提示与初始数据加载。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AgentConfig, ChatMessage, Task, Workspace } from '../../src/shared/types'
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
  testAgentId: null,
  testTaskTemplate: '运行全部测试',
  lastVerification: 'unknown',
  createdAt: '2026-11-18T00:00:00.000Z'
}

type Handler = (payload?: unknown) => unknown

/** 安装一个按通道分发的 window.api mock，未声明的通道视为测试配置遗漏。 */
function installApi(handlers: Record<string, Handler>): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    const handler = handlers[channel]
    if (!handler) {
      throw new Error(`未预期的 IPC 通道：${channel}`)
    }
    return handler(payload)
  })
  window.api = { invoke, onEvent: vi.fn(() => () => {}) }
  return invoke
}

/** 工作区已存在时，App 会在挂载后立即加载这些初始数据。 */
function initialHandlers(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'workspace:list': () => [workspace],
    'chat:history': (): ChatMessage[] => [],
    'tasks:list': (): Task[] => [],
    'agents:list': (): AgentConfig[] => [],
    'workspace:diff': () => ({ files: 2, insertions: 5, deletions: 1 }),
    ...overrides
  }
}

afterEach(() => {
  cleanup()
})

describe('工作区外壳', () => {
  test('空状态显示创建工作区表单', async () => {
    installApi({ 'workspace:list': () => [] })

    render(<App />)

    expect(await screen.findByRole('heading', { name: '新建工作区' })).toBeInTheDocument()
    expect(screen.getByLabelText('工作区名称')).toBeInTheDocument()
    expect(screen.getByLabelText('仓库路径')).toBeInTheDocument()
    expect(screen.getByLabelText('目标分支（可选）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建工作区' })).toBeInTheDocument()
  })

  test('提交表单调用 workspace:create 并渲染工作区', async () => {
    let created = false
    const invoke = installApi({
      'workspace:list': () => (created ? [workspace] : []),
      'workspace:create': () => {
        created = true
        return workspace
      },
      'chat:history': () => [],
      'tasks:list': () => [],
      'agents:list': () => [],
      'workspace:diff': () => ({ files: 2, insertions: 5, deletions: 1 })
    })

    render(<App />)

    fireEvent.change(await screen.findByLabelText('工作区名称'), {
      target: { value: 'demo' }
    })
    fireEvent.change(screen.getByLabelText('仓库路径'), {
      target: { value: '/repo' }
    })
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('workspace:create', {
        name: 'demo',
        repoPath: '/repo'
      })
    })

    expect(
      await screen.findByRole('heading', { level: 1, name: 'demo' })
    ).toBeInTheDocument()
    expect(screen.getByTestId('chat-timeline')).toBeInTheDocument()
    expect(screen.getByTestId('agent-panel')).toBeInTheDocument()
  })

  test('创建失败时显示错误且不崩溃', async () => {
    installApi({
      'workspace:list': () => [],
      'workspace:create': () => {
        throw new Error('workspace:create 失败：该仓库已存在工作区：demo')
      }
    })

    render(<App />)

    fireEvent.change(await screen.findByLabelText('工作区名称'), {
      target: { value: 'demo' }
    })
    fireEvent.change(screen.getByLabelText('仓库路径'), {
      target: { value: '/repo' }
    })
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('该仓库已存在工作区：demo')
    // 出错后表单仍在，用户可以修改后重新提交
    expect(screen.getByLabelText('工作区名称')).toBeInTheDocument()
  })

  test('存在工作区时初始加载历史、任务、成员与 diff', async () => {
    const invoke = installApi(initialHandlers())

    render(<App />)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'demo' })
    ).toBeInTheDocument()

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('chat:history', { workspaceId: 'w1' })
      expect(invoke).toHaveBeenCalledWith('tasks:list', { workspaceId: 'w1' })
      expect(invoke).toHaveBeenCalledWith('agents:list', { workspaceId: 'w1' })
      expect(invoke).toHaveBeenCalledWith('workspace:diff', { workspaceId: 'w1' })
    })

    // 顶部展示工作区名、仓库路径、集成分支与 diff 统计
    await screen.findByTestId('diff-stat')
    const main = screen.getByRole('main')
    expect(within(main).getByRole('heading', { level: 1, name: 'demo' })).toBeInTheDocument()
    expect(within(main).getByText('/repo')).toBeInTheDocument()
    expect(within(main).getByText(/agentgroup\/integration/)).toBeInTheDocument()
    expect(within(main).getByTestId('diff-stat')).toHaveTextContent(
      '2 个文件 · +5 · -1'
    )

    // 三栏布局中的两个占位区域
    expect(screen.getByTestId('chat-timeline')).toBeInTheDocument()
    expect(screen.getByTestId('agent-panel')).toBeInTheDocument()
  })
})
