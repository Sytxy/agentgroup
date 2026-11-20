/**
 * 解析 `codex exec --json` 的逐行 JSONL 输出。
 *
 * Codex 的事件类型随版本变化，当前版本（0.170.0）的顶层 `type` 为
 * `thread.started` / `turn.started` / `item.completed` 等，具体条目类型
 * 放在 `item.type`（`command_execution`、`mcp_tool_call`、`agent_message` 等）。
 * 为了兼容旧版或未知形态，顶层 `type` 与 `item.type` 都参与识别：
 * - 类型含 command / tool → progress（命令执行、MCP 工具调用）；
 * - 已完成事件中的 agent_message → final 摘要；
 * - 其余 JSON 对象一律忽略，非 JSON 行原样产出 log（stderr 文本也走这条路径）。
 *
 * 解析器保持宽容：任何输入都不抛异常，避免 CLI 输出格式漂移导致任务失败。
 */

import type { AgentEvent } from './adapter'

export class CodexStreamParser {
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

    const item = isRecord(parsed.item) ? parsed.item : null

    // 顶层与条目类型都参与匹配：真实输出把条目类型放在 item.type，
    // 旧版或其他形态可能直接把类型放在顶层。
    const typeMarkers = [parsed.type, item?.type].filter(
      (value): value is string => typeof value === 'string'
    )

    // 命令执行与工具调用属于过程进度，优先于最终摘要判断。
    const progressMarker = typeMarkers.find(
      (marker) => marker.includes('command') || marker.includes('tool')
    )
    if (progressMarker !== undefined) {
      const text = progressText(parsed, item)
      return text.length > 0
        ? [{ type: 'progress', text, signature: `codex:${text}` }]
        : []
    }

    // 只有“已完成”的事件才可能是最终摘要；error / turn.failed 也带 message，
    // 但类型不含 completed，避免把错误信息误当成任务结果。
    if (!typeMarkers.some((marker) => marker.includes('completed'))) {
      return []
    }

    // item.completed 也会包裹 reasoning、error 等条目：reasoning.text 是推理摘要，
    // error.message 是错误信息，都不能当作任务结果。只有 agent_message 才是最终回复。
    if (item !== null) {
      if (item.type !== 'agent_message') {
        return []
      }
    } else if (typeMarkers.some((marker) => NON_FINAL_TOP_LEVEL_TYPES.has(marker))) {
      // 无 item 的旧形态没有 agent_message 标记，只能靠排除已知的非最终类型兜底，
      // 避免把顶层 reasoning / error 等形态误判为 final。
      return []
    }

    const summary = finalText(parsed, item)
    return summary !== null ? [{ type: 'final', summary }] : []
  }
}

// 顶层事件中明确不属于最终摘要的类型（旧形态兼容路径使用）。
const NON_FINAL_TOP_LEVEL_TYPES = new Set([
  'reasoning',
  'error',
  'todo_list',
  'file_change',
  'web_search'
])

/**
 * 生成进度文本：优先展示实际命令或工具名，便于用户在群消息里看懂 Agent 在做什么；
 * 都没有时退回原始类型标记，保证进度非空。
 */
function progressText(parsed: Record<string, unknown>, item: Record<string, unknown> | null): string {
  const source = item ?? parsed
  const label = trimmedString(source.command) ?? trimmedString(source.tool) ?? trimmedString(source.name)
  if (label !== null) {
    return `执行 ${label}`
  }
  const marker = trimmedString(source.type) ?? 'command'
  return `执行 ${marker}`
}

/**
 * 提取最终摘要文本。约定字段为 item.text 或顶层 message，
 * 同时兼容未知形态中可能出现的 item.message。
 */
function finalText(parsed: Record<string, unknown>, item: Record<string, unknown> | null): string | null {
  const candidates = [item?.text, item?.message, parsed.message]
  for (const candidate of candidates) {
    const text = trimmedString(candidate)
    if (text !== null) {
      return text
    }
  }
  return null
}

// 返回去掉首尾空白后的非空字符串，空白文本不产出事件，避免刷屏。
function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
