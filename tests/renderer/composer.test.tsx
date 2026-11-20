// 输入框测试：@ 成员补全、Enter 发送 / Shift+Enter 换行、空输入与失败提示。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AgentConfig } from '../../src/shared/types'
import Composer from '../../src/renderer/src/components/Composer'

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

afterEach(() => {
  cleanup()
})

describe('消息输入框', () => {
  test('shows who is posting as', () => {
    render(
      <Composer
        agents={[]}
        userName="张三"
        onSend={vi.fn().mockResolvedValue(undefined)}
      />
    )

    expect(screen.getByText('以「张三」的身份发送')).toBeInTheDocument()
  })

  test('typing @ shows enabled agents and inserts the selected name', () => {
    render(
      <Composer
        agents={[agent('a1', 'claude'), agent('a2', 'codex', false)]}
        onSend={vi.fn().mockResolvedValue(undefined)}
      />
    )
    const input = screen.getByRole('textbox', { name: '消息输入' })

    fireEvent.change(input, { target: { value: '@' } })

    // 只展示启用的成员
    expect(screen.getByRole('option', { name: 'claude' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'codex' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: 'claude' }))

    expect(input).toHaveValue('@claude ')
  })

  test('typing filters suggestions by the mention prefix', () => {
    render(
      <Composer
        agents={[agent('a1', 'claude'), agent('a2', 'codex')]}
        onSend={vi.fn().mockResolvedValue(undefined)}
      />
    )
    const input = screen.getByRole('textbox', { name: '消息输入' })

    fireEvent.change(input, { target: { value: '请 @co' } })

    expect(screen.getByRole('option', { name: 'codex' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'claude' })).not.toBeInTheDocument()
  })

  test('pressing Enter on a suggestion inserts it instead of sending', () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<Composer agents={[agent('a1', 'claude')]} onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: '消息输入' })

    fireEvent.change(input, { target: { value: '@cl' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveValue('@claude ')
    expect(onSend).not.toHaveBeenCalled()
  })

  test('send calls onSend with the text and clears the input', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<Composer agents={[agent('a1', 'claude')]} onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: '消息输入' })

    fireEvent.change(input, { target: { value: '大家好' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('大家好'))
    await waitFor(() => expect(input).toHaveValue(''))
  })

  test('empty input is not sent', () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<Composer agents={[]} onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: '消息输入' })

    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()
  })

  test('Enter during IME composition is ignored, then Enter after composition sends', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<Composer agents={[agent('a1', 'claude')]} onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: '消息输入' })

    // 组字中按 Enter 只应提交候选词：既不选中补全，也不发送
    fireEvent.change(input, { target: { value: '@cl' } })
    expect(screen.getByRole('option', { name: 'claude' })).toBeInTheDocument()
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('@cl')

    // 部分浏览器组字期间只上报 keyCode 229
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('@cl')

    // 组字结束后正常 Enter 发送
    fireEvent.change(input, { target: { value: '你好' } })
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('你好'))
  })

  test('Shift+Enter does not send', () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<Composer agents={[]} onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: '消息输入' })

    fireEvent.change(input, { target: { value: '第一行' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('第一行')
  })

  test('send error is displayed and the input is kept', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('chat:send 失败：项目不存在'))
    render(<Composer agents={[]} onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: '消息输入' })

    fireEvent.change(input, { target: { value: '大家好' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByRole('alert')).toHaveTextContent('项目不存在')
    expect(input).toHaveValue('大家好')
  })
})
