// 消息输入框：受控 textarea，Enter 发送、Shift+Enter 换行，输入 @ 触发成员补全。
// 发送成功后才清空输入，失败保留原文并在框内提示，避免用户重复输入。
import { useEffect, useRef, useState } from 'react'
import type { AgentConfig } from '../../../shared/types'

interface ComposerProps {
  agents: AgentConfig[]
  disabled?: boolean
  onSend: (text: string) => Promise<void>
}

/** 光标前的 `@token` 提及；start 为 `@` 的位置，query 为已输入的名字前缀。 */
interface MentionContext {
  start: number
  query: string
}

/**
 * 从“光标前的文本”解析正在输入的提及。
 * 只识别开头或空白后的 `@`，避免把邮箱等中间出现的 `@` 当成提及；
 * token 字符集与主进程 Dispatcher 的提及解析保持一致。
 */
function mentionAt(value: string, caret: number): MentionContext | null {
  const before = value.slice(0, caret)
  const match = /(?:^|\s)@([\p{L}\p{N}_.+#-]*)$/u.exec(before)
  if (match === null) {
    return null
  }
  const query = match[1] ?? ''
  return { start: caret - query.length - 1, query }
}

export default function Composer({
  agents,
  disabled = false,
  onSend
}: ComposerProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [caret, setCaret] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [completionDismissed, setCompletionDismissed] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)

  // 补全插入后把光标定位到插入内容之后；不能在渲染期间直接操作 DOM
  useEffect(() => {
    if (pendingCaret.current === null) {
      return
    }
    const textarea = textareaRef.current
    if (textarea !== null) {
      textarea.focus()
      textarea.setSelectionRange(pendingCaret.current, pendingCaret.current)
    }
    pendingCaret.current = null
  }, [value])

  const mention = mentionAt(value, caret)
  const suggestions =
    mention === null
      ? []
      : agents.filter(
          (agent) =>
            agent.enabled &&
            agent.name.toLowerCase().startsWith(mention.query.toLowerCase())
        )
  const showSuggestions =
    !disabled && !sending && !completionDismissed && suggestions.length > 0
  const selectedIndex = Math.min(activeIndex, suggestions.length - 1)

  const insertSuggestion = (agent: AgentConfig): void => {
    const context = mentionAt(value, caret)
    if (context === null) {
      return
    }
    const inserted = `@${agent.name} `
    const nextValue = value.slice(0, context.start) + inserted + value.slice(caret)
    const nextCaret = context.start + inserted.length
    pendingCaret.current = nextCaret
    setValue(nextValue)
    setCaret(nextCaret)
    setActiveIndex(0)
  }

  const submit = async (): Promise<void> => {
    // 仅按空白判断是否为空，正文保留用户原始换行与空格
    if (value.trim() === '' || sending || disabled) {
      return
    }
    setSending(true)
    setError(null)
    try {
      await onSend(value)
      setValue('')
      setCaret(0)
      setActiveIndex(0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (showSuggestions) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((current) => (current + 1) % suggestions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex(
          (current) => (current - 1 + suggestions.length) % suggestions.length
        )
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        // 补全打开时 Enter 先选成员，第二次 Enter 才发送
        event.preventDefault()
        const suggestion = suggestions[selectedIndex]
        if (suggestion !== undefined) {
          insertSuggestion(suggestion)
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        // 关闭补全但不改动正文，@token 作为普通文本保留
        setCompletionDismissed(true)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <div className="composer">
      {showSuggestions && (
        <ul className="composer-suggestions" role="listbox" aria-label="成员补全">
          {suggestions.map((agent, index) => (
            <li
              key={agent.id}
              role="option"
              aria-selected={index === selectedIndex}
              className={
                index === selectedIndex
                  ? 'composer-suggestion composer-suggestion-active'
                  : 'composer-suggestion'
              }
              // 阻止 mousedown 抢走 textarea 的焦点与光标位置
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertSuggestion(agent)}
            >
              {agent.name}
            </li>
          ))}
        </ul>
      )}

      <textarea
        ref={textareaRef}
        className="composer-input"
        aria-label="消息输入"
        placeholder="输入消息，@ 成员分派任务（Enter 发送，Shift+Enter 换行）"
        rows={3}
        value={value}
        disabled={disabled || sending}
        onChange={(event) => {
          setValue(event.target.value)
          setCaret(event.target.selectionStart ?? event.target.value.length)
          setActiveIndex(0)
          setCompletionDismissed(false)
          setError(null)
        }}
        onKeyDown={handleKeyDown}
      />

      <div className="composer-actions">
        {error !== null && (
          <p className="composer-error" role="alert">
            发送失败：{error}
          </p>
        )}
        <button
          type="button"
          className="composer-send"
          disabled={disabled || sending || value.trim() === ''}
          onClick={() => void submit()}
        >
          发送
        </button>
      </div>
    </div>
  )
}
