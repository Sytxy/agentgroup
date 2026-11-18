/**
 * 从文本中提取已知 Agent 的 @ 提及，供 Agent 间委派使用。
 *
 * 与 MessageParser 保持同一套匹配规则（不读写数据库、不依赖 Electron）：
 * - 只有位于文本开头或空白之后的 `@name` 才算提及，`foo@claude` 这类邮箱式文本不算；
 * - Agent 名称大小写不敏感，多个名称时优先匹配更长的名称，
 *   避免 `@claude2` 被拆成 `@claude` + `2`；
 * - 名称中的正则特殊字符按字面转义；
 * - 未知名称直接忽略；结果按首次提及顺序去重。
 *
 * 与解析器不同，这里只关心“提到了谁”，不关心每个提及时后面的任务文本，
 * 因此末尾提及（其后没有内容）同样会返回。
 */

/** 返回文本中首次提及的 Agent id 列表（去重、保持首次提及顺序）。 */
export function extractMentionIds(
  text: string,
  agents: Array<{ id: string; name: string }>
): string[] {
  const idsByName = new Map<string, string>()
  for (const agent of agents) {
    // 空名字会匹配任意单独的 `@`，直接忽略；同名时以名单中靠前的 Agent 为准。
    if (agent.name.length === 0) {
      continue
    }
    const key = agent.name.toLowerCase()
    if (!idsByName.has(key)) {
      idsByName.set(key, agent.id)
    }
  }

  // 按名字长度降序排列，保证正则交替分支优先命中更长的名字。
  const names = [...new Set(agents.map((agent) => agent.name))]
    .filter((name) => name.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((name) => escapeRegExp(name))

  // 无可用 Agent 时没有可匹配的提及，保留 null 以避免构造出匹配空串的正则。
  if (names.length === 0) {
    return []
  }

  const pattern = new RegExp(`(^|\\s)@(${names.join('|')})`, 'gi')
  const ids: string[] = []
  const seen = new Set<string>()

  // 正则带 g 标志会保留 lastIndex；每次调用新建正则，不存在跨调用污染。
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const rawName = match[2] ?? ''
    const id = idsByName.get(rawName.toLowerCase())
    // 正则只包含已知名字，这里仍做防御性判断，保证未知名字不会产生提及。
    if (id === undefined || seen.has(id)) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }

  return ids
}

/** 转义名字中的正则特殊字符，让 Agent 名按字面参与匹配。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
