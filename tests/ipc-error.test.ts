import { describe, expect, test } from 'vitest'
import { cleanIpcErrorMessage } from '../src/shared/ipc-error'

describe('cleanIpcErrorMessage', () => {
  test('strips the Electron remote prefix and the channel wrapper', () => {
    const error = new Error(
      "Error invoking remote method 'workspace:create': Error: workspace:create 失败：无法打开 git 仓库"
    )

    expect(cleanIpcErrorMessage('workspace:create', error)).toBe('无法打开 git 仓库')
  })

  test('keeps a plain error message unchanged', () => {
    expect(cleanIpcErrorMessage('chat:send', new Error('网络错误'))).toBe('网络错误')
  })

  test('handles non-Error values', () => {
    expect(cleanIpcErrorMessage('tasks:cancel', 'boom')).toBe('boom')
  })
})
