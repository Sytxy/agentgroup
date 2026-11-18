// 成员面板测试：忙碌成员禁止删除；支持停用/启用切换。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AgentConfig, Task } from '../../src/shared/types'
import AgentPanel from '../../src/renderer/src/components/AgentPanel'

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

function runningTask(agentId: string): Task {
  return {
    id: `task-${agentId}`,
    workspaceId: 'w1',
    agentId,
    parentTaskId: null,
    taskType: 'code',
    title: '运行中的任务',
    prompt: '运行',
    branch: 'agent/task',
    worktreePath: '/tmp/worktree',
    baseRef: 'abc',
    status: 'running',
    exitCode: null,
    summary: null,
    createdAt: '2026-11-18T00:00:00.000Z',
    startedAt: '2026-11-18T00:00:00.000Z',
    finishedAt: null
  }
}

function installApi(): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    if (channel !== 'agents:update') {
      throw new Error(`未预期的 IPC 通道：${channel}`)
    }
    const input = payload as { agentId: string; patch: { enabled: boolean } }
    return { ...agent(input.agentId, input.agentId), enabled: input.patch.enabled }
  })
  window.api = {
    invoke,
    onEvent: vi.fn(() => () => {})
  }
  return invoke
}

afterEach(() => {
  cleanup()
})

describe('Agent 成员面板', () => {
  test('a busy agent cannot be deleted', () => {
    installApi()
    render(
      <AgentPanel
        workspaceId="w1"
        agents={[agent('a1', 'claude'), agent('a2', 'codex')]}
        tasks={[runningTask('a2')]}
        onChanged={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: '删除 claude' })).toBeEnabled()
    // 运行中的成员仍占据 worktree，删除会让现场失去归属
    expect(screen.getByRole('button', { name: '删除 codex' })).toBeDisabled()
  })

  test('toggling an agent calls agents:update with the inverted enabled flag', async () => {
    const invoke = installApi()
    const onChanged = vi.fn()
    render(
      <AgentPanel
        workspaceId="w1"
        agents={[agent('a1', 'claude'), agent('a2', 'codex', false)]}
        tasks={[]}
        onChanged={onChanged}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '停用 claude' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('agents:update', {
        agentId: 'a1',
        patch: { enabled: false }
      })
    })
    expect(onChanged).toHaveBeenCalled()

    // 已停用的成员显示启用入口
    fireEvent.click(screen.getByRole('button', { name: '启用 codex' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('agents:update', {
        agentId: 'a2',
        patch: { enabled: true }
      })
    })
  })
})
