// 轻量 Markdown 渲染：只覆盖 Agent 输出里常见的段落、列表、行内代码、粗体、
// 代码块和 @ 提及。全部用 React 元素渲染，不使用 innerHTML，避免 Agent 输出
// 携带的 HTML 造成 XSS。
import type { ReactNode } from 'react'

interface ParagraphBlock {
  type: 'paragraph'
  lines: string[]
}

interface ListBlock {
  type: 'list'
  ordered: boolean
  items: string[]
}

interface CodeBlock {
  type: 'code'
  text: string
}

type Block = ParagraphBlock | ListBlock | CodeBlock

export default function MessageContent({ text }: { text: string }): React.JSX.Element {
  return <div className="message-rich">{parseBlocks(text).map(renderBlock)}</div>
}

function renderBlock(block: Block, index: number): ReactNode {
  if (block.type === 'code') {
    return (
      <pre className="message-code-block" key={index}>
        <code>{block.text}</code>
      </pre>
    )
  }

  if (block.type === 'list') {
    const items = block.items.map((item, itemIndex) => (
      <li key={itemIndex}>{renderInline(item, `${index}-${itemIndex}`)}</li>
    ))
    return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
  }

  return (
    <p key={index}>
      {block.lines.map((line, lineIndex) => (
        <span key={lineIndex}>
          {renderInline(line, `${index}-${lineIndex}`)}
          {lineIndex < block.lines.length - 1 && <br />}
        </span>
      ))}
    </p>
  )
}

/** 把文本拆成段落、列表和代码块；空行是块分隔符。 */
function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: ListBlock | null = null

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', lines: paragraph })
      paragraph = []
    }
  }

  const flushList = (): void => {
    if (list !== null) {
      blocks.push(list)
      list = null
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''

    if (line.trimStart().startsWith('```')) {
      flushParagraph()
      flushList()
      const codeLines: string[] = []
      index += 1
      while (
        index < lines.length &&
        !(lines[index] ?? '').trimStart().startsWith('```')
      ) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      blocks.push({ type: 'code', text: codeLines.join('\n') })
      continue
    }

    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet !== null || numbered !== null) {
      flushParagraph()
      const ordered = numbered !== null
      if (list === null || list.ordered !== ordered) {
        flushList()
        list = { type: 'list', ordered, items: [] }
      }
      list.items.push((bullet ?? numbered)?.[1] ?? '')
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }

    flushList()
    paragraph.push(line)
  }

  flushParagraph()
  flushList()
  return blocks
}

/** 行内格式：`代码`、**粗体**、@成员；其余文本原样保留。 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|@[\w一-鿿-]+)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    const key = `${keyPrefix}-${match.index}`
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else {
      nodes.push(
        <span className="message-mention" key={key}>
          {token}
        </span>
      )
    }
    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}
