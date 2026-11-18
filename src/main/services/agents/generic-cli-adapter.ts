/**
 * 通用 CLI Adapter：执行用户自定义的命令与参数模板。
 *
 * - 参数模板按空白切分，token 中的 `{prompt}` 会被替换成任务提示；
 *   提示里即使包含空格也只作为单个 argv 元素传递；
 * - 模板里没有 `{prompt}` 时，把提示追加为最后一个参数；
 * - 每一行输出都产出 log，非空行同时产出 progress（节流由任务管理器负责）；
 * - 进程正常结束（退出码 0）时，用最后 20 行输出作为 final 摘要；
 * - 非零退出、启动失败或取消时抛出 AgentRunError，消息里附带输出尾部。
 */

import { AgentRunError, type AgentAdapter, type AgentEvent } from './adapter'
import { LineSplitter } from './line-splitter'
import type { ProcessRunner } from './process-runner'

// final 摘要最多保留的输出行数，避免把超长日志整段塞进任务完成消息。
const MAX_SUMMARY_LINES = 20

export class GenericCliAdapter implements AgentAdapter {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly opts: { command: string; argsTemplate: string }
  ) {}

  /** 把参数模板展开成 argv，保证含空格的提示只占一个参数。 */
  private buildArgs(prompt: string): string[] {
    const tokens = this.opts.argsTemplate.split(/\s+/).filter((token) => token.length > 0)
    let replaced = false

    const args = tokens.map((token) => {
      if (!token.includes('{prompt}')) {
        return token
      }
      replaced = true
      return token.replaceAll('{prompt}', prompt)
    })

    // 模板没有声明提示位置时，按约定追加到参数末尾。
    if (!replaced) {
      args.push(prompt)
    }
    return args
  }

  async *start(input: { prompt: string; cwd: string; signal: AbortSignal }): AsyncIterable<AgentEvent> {
    const handle = this.runner.spawn(this.opts.command, this.buildArgs(input.prompt), {
      cwd: input.cwd
    })

    const splitter = new LineSplitter()
    const queue: string[] = []
    const recentLines: string[] = []
    let exitResult: { code: number | null; error?: Error } | null = null
    let aborted = false
    let wake: (() => void) | null = null

    // 数据与退出事件来自 Node 回调，这里用唤醒函数把它们桥接成异步迭代。
    const wakeUp = () => {
      const resolve = wake
      wake = null
      resolve?.()
    }

    handle.onData((chunk) => {
      for (const line of splitter.push(chunk)) {
        queue.push(line)
      }
      wakeUp()
    })

    handle.onExit((code, error) => {
      // 进程结束时可能还有最后一行没有换行符，交给 flush 补发。
      for (const line of splitter.flush()) {
        queue.push(line)
      }
      exitResult = { code, error }
      wakeUp()
    })

    const onAbort = () => {
      aborted = true
      handle.kill()
    }
    if (input.signal.aborted) {
      // 启动前就已经取消：立即结束进程，不再等待输出。
      onAbort()
    } else {
      input.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      while (true) {
        const line = queue.shift()
        if (line !== undefined) {
          recentLines.push(line)
          if (recentLines.length > MAX_SUMMARY_LINES) {
            recentLines.shift()
          }
          yield { type: 'log', text: line }

          const progress = line.trim()
          if (progress.length > 0) {
            yield { type: 'progress', text: progress }
          }
          continue
        }

        if (exitResult !== null) {
          break
        }

        // 等待下一块输出或退出事件；回调在同一个事件循环内只会唤醒一次。
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    } finally {
      input.signal.removeEventListener('abort', onAbort)
    }

    // TypeScript 不追踪回调里的赋值，这里显式断言退出结果；
    // 循环只会在 exitResult 非空时退出。
    const exit = exitResult as { code: number | null; error?: Error } | null
    if (exit === null) {
      return
    }

    const tail = recentLines.join('\n').trim()

    if (aborted) {
      throw new AgentRunError(withTail('Agent 运行已取消', tail), exit.code)
    }
    if (exit.error !== undefined) {
      throw new AgentRunError(withTail(`Agent 进程启动失败：${exit.error.message}`, tail), null)
    }
    if (exit.code !== 0) {
      throw new AgentRunError(withTail(`Agent 进程以退出码 ${exit.code ?? 'null'} 结束`, tail), exit.code)
    }

    yield { type: 'final', summary: tail }
  }
}

function withTail(reason: string, tail: string): string {
  return tail.length > 0 ? `${reason}\n${tail}` : reason
}
