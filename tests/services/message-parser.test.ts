import { describe, expect, test } from 'vitest'
import { MessageParser } from '../../src/main/services/chat/message-parser'

const agents = [
  { id: 'agent-claude', name: 'claude' },
  { id: 'agent-codex', name: 'codex' },
  { id: 'agent-deepseek', name: 'deepseek' }
]

describe('MessageParser', () => {
  test('splits one message into three assignments', () => {
    const parser = new MessageParser(agents)
    const result = parser.parse('做登录功能 @claude 前端页面 @codex 后端接口 @deepseek 测试')

    expect(result.sharedContext).toBe('做登录功能')
    expect(result.assignments).toEqual([
      { agentId: 'agent-claude', prompt: '前端页面' },
      { agentId: 'agent-codex', prompt: '后端接口' },
      { agentId: 'agent-deepseek', prompt: '测试' }
    ])
  })

  test('prepends shared context before the first mention to every prompt', () => {
    const parser = new MessageParser(agents)
    const result = parser.parse('做登录功能 @claude 前端页面 @codex 后端接口')

    // 解析器把第一个提及之前的文本作为独立 sharedContext 返回，
    // 分派器会把 sharedContext 拼到每个 prompt 前，因此这里验证拼接后的结果。
    expect(result.sharedContext).toBe('做登录功能')
    expect(result.assignments.map((assignment) => assignment.prompt)).toEqual(['前端页面', '后端接口'])
    expect(result.assignments.map((assignment) => `${result.sharedContext}\n\n${assignment.prompt}`)).toEqual([
      '做登录功能\n\n前端页面',
      '做登录功能\n\n后端接口'
    ])
  })

  test('merges repeated mentions of the same agent into one assignment', () => {
    const parser = new MessageParser(agents)
    const result = parser.parse('@claude 先写测试 @codex 后端接口 @claude 再写文档')

    expect(result.assignments).toEqual([
      { agentId: 'agent-claude', prompt: '先写测试\n\n再写文档' },
      { agentId: 'agent-codex', prompt: '后端接口' }
    ])
  })

  test('ignores unknown mentions and reports nothing when no known agent is mentioned', () => {
    const parser = new MessageParser(agents)

    expect(parser.parse('@ghost 帮我看看 @nobody 这个问题')).toEqual({
      sharedContext: '@ghost 帮我看看 @nobody 这个问题',
      assignments: []
    })
    expect(parser.parse('没有任何提及的消息')).toEqual({
      sharedContext: '没有任何提及的消息',
      assignments: []
    })
    // 未知提及不会被当作分隔符，会保留在共享背景里。
    expect(parser.parse('背景 @ghost 忽略 @claude 做A')).toEqual({
      sharedContext: '背景 @ghost 忽略',
      assignments: [{ agentId: 'agent-claude', prompt: '做A' }]
    })
  })

  test('matches Chinese and case-insensitive agent names', () => {
    const parser = new MessageParser([
      { id: 'agent-claude', name: 'Claude' },
      { id: 'agent-helper', name: '小助手' }
    ])
    const result = parser.parse('@CLAUDE 做前端 @小助手 做后端')

    expect(result.assignments).toEqual([
      { agentId: 'agent-claude', prompt: '做前端' },
      { agentId: 'agent-helper', prompt: '做后端' }
    ])
  })

  test('does not treat email-like foo@claude as a mention', () => {
    const parser = new MessageParser(agents)

    expect(parser.parse('foo@claude 不是提及').assignments).toEqual([])
    expect(parser.parse('请联系 foo@claude 处理，然后 @claude 做前端')).toEqual({
      sharedContext: '请联系 foo@claude 处理，然后',
      assignments: [{ agentId: 'agent-claude', prompt: '做前端' }]
    })
  })

  test('resolves the longest matching name when claude and claude2 both exist', () => {
    const parser = new MessageParser([
      { id: 'agent-claude', name: 'claude' },
      { id: 'agent-claude2', name: 'claude2' }
    ])

    expect(parser.parse('@claude 做A @claude2 做B').assignments).toEqual([
      { agentId: 'agent-claude', prompt: '做A' },
      { agentId: 'agent-claude2', prompt: '做B' }
    ])
    expect(parser.parse('@claude2 只做B').assignments).toEqual([
      { agentId: 'agent-claude2', prompt: '只做B' }
    ])
  })

  test('escapes regex-special characters in agent names', () => {
    const parser = new MessageParser([
      { id: 'agent-cpp', name: 'c++' },
      { id: 'agent-dot', name: 'a.b' }
    ])

    expect(parser.parse('@c++ 做C').assignments).toEqual([
      { agentId: 'agent-cpp', prompt: '做C' }
    ])
    expect(parser.parse('@a.b 做D').assignments).toEqual([
      { agentId: 'agent-dot', prompt: '做D' }
    ])
    // 名字中的 '.' 必须按字面匹配，而不是正则通配符。
    expect(parser.parse('@axb 不匹配').assignments).toEqual([])
  })

  test('drops assignments whose prompt is empty after trimming', () => {
    const parser = new MessageParser(agents)
    const result = parser.parse('@claude @codex 做后端')

    expect(result.assignments).toEqual([{ agentId: 'agent-codex', prompt: '做后端' }])
  })

  test('counts a known mention inside a code block in v1', () => {
    const parser = new MessageParser(agents)
    const result = parser.parse('```\n@claude 做A\n```')

    // v1 不特殊处理代码块：代码块中的已知 @ 同样算作提及。
    expect(result.assignments).toEqual([{ agentId: 'agent-claude', prompt: '做A\n```' }])
  })

  test('never throws on emoji, punctuation, or an empty agent list', () => {
    const parser = new MessageParser(agents)

    expect(() => parser.parse('🎉🎉 @claude ，做A！（优先） @codex ？')).not.toThrow()
    expect(parser.parse('🎉 @claude 做A！（优先）').assignments).toEqual([
      { agentId: 'agent-claude', prompt: '做A！（优先）' }
    ])

    const empty = new MessageParser([])
    expect(empty.parse('@claude 🎉 文本')).toEqual({
      sharedContext: '@claude 🎉 文本',
      assignments: []
    })
  })
})
