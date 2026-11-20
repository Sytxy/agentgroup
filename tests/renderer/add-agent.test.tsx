// 添加 Agent 对话框测试：预设切换、自定义命令字段、权限档位警示与提交的完整 AgentConfig。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AgentConfig, DetectedAgent } from '../../src/shared/types'
import AddAgentDialog from '../../src/renderer/src/components/AddAgentDialog'

afterEach(() => {
  cleanup()
})

const detected: DetectedAgent[] = [
  {
    id: 'claude',
    name: 'Claude Code CLI',
    vendor: 'Anthropic',
    description: 'Anthropic 官方 CLI。',
    command: 'claude',
    preset: 'claude',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    rolePrompt: '负责编写代码。',
    installed: true,
    version: '2.1.327',
    path: '/nvm/bin/claude'
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    vendor: 'Google',
    description: 'Google 的终端 Agent。',
    command: 'gemini',
    preset: 'custom',
    installHint: 'npm install -g @google/gemini-cli',
    rolePrompt: '负责编写代码。',
    installed: false,
    version: null,
    path: null
  }
]

function installApi(candidates: DetectedAgent[] = detected): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    if (channel === 'agents:detect') {
      return candidates
    }
    return payload as AgentConfig
  })
  window.api = {
    invoke,
    onEvent: vi.fn(() => () => {})
  }
  return invoke
}

function existingAgent(name: string): AgentConfig {
  return {
    id: `agent-${name}`,
    workspaceId: 'w1',
    name,
    preset: 'claude',
    command: 'claude',
    argsTemplate: null,
    rolePrompt: '',
    pathScope: [],
    permissionProfile: 'edit-only',
    canDelegate: false,
    enabled: true
  }
}

describe('添加 Agent 对话框', () => {
  test('检测本机 Agent 并支持一键添加', async () => {
    const invoke = installApi()
    const onAdded = vi.fn()
    const onClose = vi.fn()
    render(
      <AddAgentDialog
        workspaceId="w1"
        existingAgents={[existingAgent('claude')]}
        onAdded={onAdded}
        onClose={onClose}
      />
    )

    expect(await screen.findByText('已检测到 1 个本地 Agent')).toBeInTheDocument()

    const geminiCard = screen.getByText('Gemini CLI').closest('article') as HTMLElement
    expect(within(geminiCard).getByText('未检测到')).toBeInTheDocument()
    expect(within(geminiCard).getByRole('button', { name: '未安装' })).toBeDisabled()

    const claudeCard = screen.getByText('Claude Code CLI').closest('article') as HTMLElement
    expect(within(claudeCard).getByText(/2\.1\.327/)).toBeInTheDocument()
    fireEvent.click(within(claudeCard).getByRole('button', { name: '添加' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'agents:add',
        expect.objectContaining({
          workspaceId: 'w1',
          name: 'claude2',
          preset: 'claude',
          command: 'claude',
          permissionProfile: 'edit-and-run'
        })
      )
    })
    expect(onAdded).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  test('add agent dialog warns for edit-and-run profile', async () => {
    const invoke = installApi()
    const onAdded = vi.fn()
    const onClose = vi.fn()
    render(<AddAgentDialog workspaceId="w1" onAdded={onAdded} onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: '手动配置自定义 Agent' }))

    // Claude 预设默认命令，不可编辑；未选择 edit-and-run 时不显示警示
    const command = screen.getByLabelText('命令')
    expect(command).toHaveValue('claude')
    expect(command).toBeDisabled()
    expect(screen.queryByTestId('permission-warning')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('权限档位'), {
      target: { value: 'edit-and-run' }
    })
    expect(screen.getByTestId('permission-warning')).toHaveTextContent('可编辑并运行命令')
    // Claude 的 edit-and-run 没有目录沙箱，必须明确告知可以访问整个用户账户
    expect(screen.getByTestId('permission-warning')).toHaveTextContent('没有目录沙箱')
    expect(screen.getByTestId('permission-warning')).toHaveTextContent('整个用户账户')
    expect(screen.getByTestId('permission-warning')).toHaveTextContent('macOS 账户权限')
    expect(screen.getByTestId('permission-warning')).toHaveTextContent('workspace-write')

    // 切到自定义预设后命令与参数模板可编辑
    fireEvent.change(screen.getByLabelText('预设'), { target: { value: 'custom' } })
    expect(command).toBeEnabled()
    expect(command).toHaveValue('')

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '测试员' } })
    fireEvent.change(screen.getByLabelText('角色说明'), {
      target: { value: '只修改测试代码' }
    })
    fireEvent.change(command, { target: { value: 'my-cli' } })
    fireEvent.change(screen.getByLabelText('参数模板'), {
      target: { value: '--prompt {prompt}' }
    })
    fireEvent.change(screen.getByLabelText('路径范围'), {
      target: { value: 'tests/**, src/**' }
    })
    fireEvent.click(screen.getByLabelText('允许委派'))
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    return waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'agents:add',
        expect.objectContaining({
          workspaceId: 'w1',
          name: '测试员',
          preset: 'custom',
          command: 'my-cli',
          argsTemplate: '--prompt {prompt}',
          rolePrompt: '只修改测试代码',
          pathScope: ['tests/**', 'src/**'],
          permissionProfile: 'edit-and-run',
          canDelegate: true,
          enabled: true
        })
      )
    }).then(() => {
      const addCall = invoke.mock.calls.find(([channel]) => channel === 'agents:add')
      const payload = addCall?.[1] as AgentConfig
      expect(typeof payload.id).toBe('string')
      expect(payload.id.length).toBeGreaterThan(0)
      expect(onAdded).toHaveBeenCalledWith(payload)
      expect(onClose).toHaveBeenCalled()
    })
  })

  test('requires a name before submitting and cancel closes the dialog', async () => {
    const invoke = installApi()
    const onClose = vi.fn()
    render(<AddAgentDialog workspaceId="w1" onAdded={vi.fn()} onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: '手动配置自定义 Agent' }))

    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByRole('alert')).toHaveTextContent('名称')
    expect(invoke.mock.calls.some(([channel]) => channel === 'agents:add')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalled()
  })
})
