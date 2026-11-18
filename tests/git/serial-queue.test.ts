import { describe, expect, test } from 'vitest'
import { SerialQueue } from '../../src/main/services/git/serial-queue'

describe('SerialQueue', () => {
  test('serial queue runs jobs one at a time in order', async () => {
    const queue = new SerialQueue()
    const events: string[] = []
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = queue.run(async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
    })
    const second = queue.run(async () => {
      events.push('second:start')
      return 'second-result'
    })

    // 等待若干轮事件循环，确认第一个任务未完成时第二个任务没有开始
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events).toEqual(['first:start'])

    releaseFirst()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBe('second-result')
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
  })

  test('a rejected job does not block the next one', async () => {
    const queue = new SerialQueue()
    const events: string[] = []

    const failing = queue.run(async () => {
      events.push('failing')
      throw new Error('boom')
    })
    const following = queue.run(async () => {
      events.push('following')
      return 'ok'
    })

    await expect(failing).rejects.toThrow('boom')
    await expect(following).resolves.toBe('ok')
    expect(events).toEqual(['failing', 'following'])
  })
})
