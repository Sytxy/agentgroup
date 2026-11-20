import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import MessageContent from '../../src/renderer/src/components/MessageContent'

afterEach(() => {
  cleanup()
})

describe('MessageContent', () => {
  test('renders paragraphs, lists, inline code, bold and mentions', () => {
    render(
      <MessageContent
        text={'第一段 **重点**，@claude 看一下。\n\n- 列表项 `src/app.ts`\n- 第二项'}
      />
    )

    expect(screen.getByText('重点').tagName).toBe('STRONG')
    expect(screen.getByText('@claude')).toHaveClass('message-mention')
    expect(screen.getByText('src/app.ts').tagName).toBe('CODE')
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  test('renders fenced code blocks without interpreting inner markdown', () => {
    render(<MessageContent text={'说明：\n\n```ts\nconst value = `**not bold**`\n```'} />)

    const code = screen.getByText('const value = `**not bold**`')
    expect(code.tagName).toBe('CODE')
    expect(code.closest('pre')).not.toBeNull()
    expect(screen.queryByText('not bold')).not.toBeInTheDocument()
  })
})
