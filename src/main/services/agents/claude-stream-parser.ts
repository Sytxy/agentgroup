/**
 * 解析 `claude -p --output-format stream-json --verbose` 的逐行 JSON 输出。
 *
 * 只保留对任务日志与进度有用的信息：
 * - assistant 消息里的 tool_use → progress（`执行 <工具名>`），text → progress（中间文本）；
 * - result → final 摘要；
 * - system、未知 type 以及其他畸形结构一律忽略；
 * - 无法解析为 JSON 的行原样产出 log（stderr 文本也由这条路径进入日志）。
 *
 * 上游 CLI 的字段可能随版本变化，解析器保持宽容：任何输入都不抛异常。
 */

import type { AgentEvent } from './adapter'

export class ClaudeStreamParser {
  pushLine(line: string): AgentEvent[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // 非 JSON 行无法识别，按原始日志输出，便于用户看到 stderr 等文本。
      return [{ type: 'log', text: line }]
    }

    if (!isRecord(parsed)) {
      return []
    }

    if (parsed.type === 'assistant') {
      return parseAssistantMessage(parsed.message)
    }

    if (parsed.type === 'result') {
      // result 只在是字符串时作为最终摘要；其他形态视为畸形数据忽略。
      return typeof parsed.result === 'string' ? [{ type: 'final', summary: parsed.result }] : []
    }

    // system 初始化事件与未知事件类型不产生用户可见事件。
    return []
  }
}

function parseAssistantMessage(message: unknown): AgentEvent[] {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return []
  }

  const events: AgentEvent[] = []
  for (const block of message.content) {
    if (!isRecord(block)) {
      continue
    }
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      events.push({
        type: 'progress',
        text: `执行 ${block.name}`,
        signature: toolSignature(block.name, block.input)
      })
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      // 中间文本可能只有空白，去掉后为空则不产出进度，避免刷屏。
      const text = block.text.trim()
      if (text.length > 0) {
        events.push({ type: 'progress', text })
      }
    }
  }
  return events
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 工具名 + 输入的稳定指纹；空白折叠，避免同一命令因格式差异绕过重复检测。 */
function toolSignature(name: string, input: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(input) ?? ''
  } catch {
    serialized = String(input)
  }
  return `${name}:${serialized.replace(/\s+/g, ' ').trim()}`
}
