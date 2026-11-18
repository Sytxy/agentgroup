/**
 * 群消息 @ 提及解析器。
 *
 * 纯文本解析：不读写数据库、不依赖 Electron，供消息分派服务直接调用。
 * 解析规则：
 * - 只有位于消息开头或空白之后的 `@name` 才算提及，`foo@claude` 这类邮箱式文本不算；
 * - Agent 名字大小写不敏感，多个名字时优先匹配更长的名字，
 *   避免 `@claude2` 被拆成 `@claude` + `2`；
 * - 第一个已知提及之前的文本是 sharedContext；每个提及到下一个已知提及之间的文本
 *   是该 Agent 的 prompt；同一 Agent 多次被提及时按首次提及顺序用空行合并；
 * - 未知提及会被忽略，不会创建 assignment；
 * - v1 不特殊处理代码块：代码块中的已知 `@name` 同样算作提及。
 */

export interface ParserAgent {
  id: string
  name: string
}

export interface ParsedAssignment {
  agentId: string
  prompt: string
}

export interface ParseResult {
  sharedContext: string
  assignments: ParsedAssignment[]
}

interface Mention {
  agentId: string
  // `@` 字符在原文中的位置（不含前导空白）。
  start: number
  // 提及结束位置（名字之后的第一个字符）。
  end: number
}

export class MessageParser {
  private readonly agentsByName: Map<string, ParserAgent>
  private readonly mentionPattern: RegExp | null

  constructor(agents: Array<{ id: string; name: string }>) {
    this.agentsByName = new Map()
    for (const agent of agents) {
      // 空名字会匹配任意单独的 `@`，直接忽略；同名时以名单中靠前的 Agent 为准。
      if (agent.name.length === 0) {
        continue
      }
      const key = agent.name.toLowerCase()
      if (!this.agentsByName.has(key)) {
        this.agentsByName.set(key, agent)
      }
    }

    // 按名字长度降序排列，保证正则交替分支优先命中更长的名字。
    const names = [...new Set(agents.map((agent) => agent.name))]
      .filter((name) => name.length > 0)
      .sort((a, b) => b.length - a.length)
      .map((name) => escapeRegExp(name))

    // 无可用 Agent 时没有可匹配的提及，保留 null 以避免构造出匹配空串的正则。
    this.mentionPattern =
      names.length === 0 ? null : new RegExp(`(^|\\s)@(${names.join('|')})`, 'gi')
  }

  parse(text: string): ParseResult {
    const mentions = this.findMentions(text)
    const first = mentions[0]
    if (!first) {
      return { sharedContext: text.trim(), assignments: [] }
    }

    // 第一个已知提及之前的内容是共享背景，由分派器拼到每个任务提示前。
    const sharedContext = text.slice(0, first.start).trim()

    // 用 Map 记录每个 Agent 的合并 prompt；assignmentOrder 保留首次提及顺序。
    const promptsByAgent = new Map<string, string>()
    const assignmentOrder: string[] = []

    for (let i = 0; i < mentions.length; i += 1) {
      const mention = mentions[i]
      if (!mention) {
        continue
      }
      const next = mentions[i + 1]
      const segmentEnd = next ? next.start : text.length
      const prompt = text.slice(mention.end, segmentEnd).trim()

      if (!promptsByAgent.has(mention.agentId)) {
        assignmentOrder.push(mention.agentId)
        promptsByAgent.set(mention.agentId, prompt)
        continue
      }

      // 同一 Agent 的后续提及：空段落不产生多余的分隔符。
      if (prompt.length === 0) {
        continue
      }
      const existing = promptsByAgent.get(mention.agentId) ?? ''
      promptsByAgent.set(
        mention.agentId,
        existing.length === 0 ? prompt : `${existing}\n\n${prompt}`
      )
    }

    const assignments: ParsedAssignment[] = []
    for (const agentId of assignmentOrder) {
      const prompt = promptsByAgent.get(agentId) ?? ''
      // prompt 只有空白时该 assignment 没有实际任务内容，丢弃。
      if (prompt.length > 0) {
        assignments.push({ agentId, prompt })
      }
    }

    return { sharedContext, assignments }
  }

  private findMentions(text: string): Mention[] {
    const pattern = this.mentionPattern
    if (!pattern) {
      return []
    }

    const mentions: Mention[] = []
    // 正则对象带 g 标志会保留 lastIndex，每次解析前重置，避免影响后续调用。
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const prefix = match[1] ?? ''
      const rawName = match[2] ?? ''
      const agent = this.agentsByName.get(rawName.toLowerCase())
      // 正则只包含已知名字，这里仍做防御性判断，保证未知名字不会产生 assignment。
      if (agent) {
        mentions.push({
          agentId: agent.id,
          start: match.index + prefix.length,
          end: match.index + match[0].length
        })
      }
    }
    return mentions
  }
}

/** 转义名字中的正则特殊字符，让 Agent 名按字面参与匹配。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
