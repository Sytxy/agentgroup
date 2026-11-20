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

interface HeadingBlock {
  type: 'heading'
  level: number
  text: string
}

interface TableBlock {
  type: 'table'
  header: string[]
  rows: string[][]
}

interface QuoteBlock {
  type: 'quote'
  lines: string[]
}

interface RuleBlock {
  type: 'rule'
}

type Block =
  | ParagraphBlock
  | ListBlock
  | CodeBlock
  | HeadingBlock
  | TableBlock
  | QuoteBlock
  | RuleBlock

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

  if (block.type === 'heading') {
    const level = Math.min(block.level, 6)
    const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
    return <Tag key={index}>{renderInline(block.text, `${index}-heading`)}</Tag>
  }

  if (block.type === 'table') {
    return (
      <div className="message-table-wrap" key={index}>
        <table>
          <thead>
            <tr>
              {block.header.map((cell, cellIndex) => (
                <th key={cellIndex}>{renderInline(cell, `${index}-th-${cellIndex}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>
                    {renderInline(cell, `${index}-${rowIndex}-${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (block.type === 'quote') {
    return (
      <blockquote key={index}>
        {block.lines.map((line, lineIndex) => (
          <span key={lineIndex}>
            {renderInline(line, `${index}-quote-${lineIndex}`)}
            {lineIndex < block.lines.length - 1 && <br />}
          </span>
        ))}
      </blockquote>
    )
  }

  if (block.type === 'rule') {
    return <hr key={index} />
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

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      flushList()
      blocks.push({
        type: 'heading',
        level: (heading[1] ?? '#').length,
        text: heading[2] ?? ''
      })
      continue
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'rule' })
      continue
    }

    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1] ?? '')
    ) {
      flushParagraph()
      flushList()
      const header = parseTableCells(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length) {
        const rowLine = lines[index] ?? ''
        if (rowLine.trim() === '' || !rowLine.includes('|')) {
          break
        }
        if (!isTableSeparator(rowLine)) {
          rows.push(parseTableCells(rowLine))
        }
        index += 1
      }
      blocks.push({ type: 'table', header, rows })
      index -= 1
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null) {
      flushParagraph()
      flushList()
      const quoteLines: string[] = [quote[1] ?? '']
      while (index + 1 < lines.length) {
        const next = /^\s*>\s?(.*)$/.exec(lines[index + 1] ?? '')
        if (next === null) {
          break
        }
        quoteLines.push(next[1] ?? '')
        index += 1
      }
      blocks.push({ type: 'quote', lines: quoteLines })
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

/** 解析 Markdown 表格的一行；去掉首尾竖线后按 | 切分。 */
function parseTableCells(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) {
    return []
  }
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/** 表格分隔行，例如 | --- | :---: |。 */
function isTableSeparator(line: string): boolean {
  const cells = parseTableCells(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

/** 行内格式：`代码`、**粗体**、@成员；其余文本原样保留。 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {  const nodes: ReactNode[] = []
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
