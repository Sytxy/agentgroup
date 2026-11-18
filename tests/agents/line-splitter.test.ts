import { describe, expect, test } from 'vitest'
import { LineSplitter } from '../../src/main/services/agents/line-splitter'

describe('LineSplitter', () => {
  test('line splitter handles partial lines, CRLF and ANSI codes', () => {
    const splitter = new LineSplitter()

    // 半行先留在缓冲区，不产出。
    expect(splitter.push('\x1b[31mhel')).toEqual([])

    // 补全后连同 ANSI 颜色码和 CRLF 一起处理。
    expect(splitter.push('lo\x1b[0m\r\nsecond')).toEqual(['hello'])
    expect(splitter.push(' line\nthird line\n')).toEqual(['second line', 'third line'])

    // 所有行都以换行结尾时没有剩余内容。
    expect(splitter.flush()).toEqual([])
  })

  test('flush returns the remaining partial line and clears the buffer', () => {
    const splitter = new LineSplitter()

    expect(splitter.push('\x1b[32mtail')).toEqual([])
    expect(splitter.flush()).toEqual(['tail'])
    expect(splitter.flush()).toEqual([])
  })
})
