// 工作区设置里的默认 Agent：初始值、可选项与保存 patch。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc'
import type { AgentConfig, Workspace } from '../../src/shared/types'
import SettingsDialog from '../../src/renderer/src/components/SettingsDialog'

afterEach(() => {
  cleanup()
})

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
  defaultAgentId: 'a1',
  testAgentId: null,
  testTaskTemplate: '运行全部测试',
  lastVerification: 'unknown',
  createdAt: '2026-11-18T00:00:00.000Z'
}

describe('工作区设置', () => {
  test('选择默认 Agent 后保存到 workspace:update', async () => {
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel !== IPC.workspaceUpdate) {
        throw new Error(`unexpected channel ${channel}`)
      }
      const patch = (payload as { patch: { defaultAgentId?: string | null } }).patch
      return { ...workspace, defaultAgentId: patch.defaultAgentId ?? null }
    })
    window.api = { invoke, onEvent: vi.fn(() => () => {}) }

    const onSaved = vi.fn()
    const onUserNameSaved = vi.fn()
    const onClose = vi.fn()
    render(
      <SettingsDialog
        workspace={workspace}
        agents={[agent('a1', 'claude'), agent('a2', 'codex')]}
        userName="我"
        onUserNameSaved={onUserNameSaved}
        onSaved={onSaved}
        onClose={onClose}
      />
    )

    const select = screen.getByLabelText('默认 Agent（未 @ 时）') as HTMLSelectElement
    expect(select.value).toBe('a1')
    fireEvent.change(select, { target: { value: 'a2' } })
    fireEvent.change(screen.getByLabelText('我的名字'), { target: { value: '张三' } })
    fireEvent.click(screen.getByText('保存设置'))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC.workspaceUpdate,
        expect.objectContaining({
          workspaceId: 'w1',
          patch: expect.objectContaining({ defaultAgentId: 'a2' })
        })
      )
    })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onUserNameSaved).toHaveBeenCalledWith('张三')
  })

  test('停用的默认 Agent 在表单里显示为不设置', () => {
    window.api = { invoke: vi.fn(), onEvent: vi.fn(() => () => {}) }
    render(
      <SettingsDialog
        workspace={workspace}
        agents={[agent('a1', 'claude', false)]}
        userName="我"
        onUserNameSaved={vi.fn()}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByLabelText('默认 Agent（未 @ 时）')).toHaveValue('')
  })
})
