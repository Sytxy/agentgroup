/**
 * Claude Code Adapter：以无头模式运行 `claude -p`，把 stream-json 输出统一成 AgentEvent。
 *
 * - 参数由 buildClaudeArgs 按权限档位生成；
 * - 输出按行交给 ClaudeStreamParser：工具调用/中间文本转 progress，result 转 final，
 *   无法解析为 JSON 的行（包括 stderr 文本）转 log；
 * - 非零退出、启动失败或取消时抛 AgentRunError，消息附最近输出；
 * - 正常退出但没有 result 事件时，用最后 20 行输出兜底生成 final。
 */

import { AgentRunError, type AgentAdapter, type AgentEvent } from './adapter'
import { ClaudeStreamParser } from './claude-stream-parser'
import { LineSplitter } from './line-splitter'
import type { ProcessRunner } from './process-runner'
import type { PermissionProfile } from '../../../shared/types'

// 兜底摘要最多保留的输出行数，避免把超长日志整段塞进任务完成消息。
const MAX_SUMMARY_LINES = 20

// 权限档位到 Claude Code CLI --permission-mode 的映射。
const PERMISSION_MODES: Record<PermissionProfile, 'plan' | 'acceptEdits' | 'bypassPermissions'> = {
  'read-only': 'plan',
  'edit-only': 'acceptEdits',
  'edit-and-run': 'bypassPermissions'
}

export function buildClaudeArgs(input: { prompt: string; permission: PermissionProfile }): string[] {
  return [
    '-p',
    input.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    PERMISSION_MODES[input.permission]
  ]
}

export class ClaudeAdapter implements AgentAdapter {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly permission: PermissionProfile
  ) {}

  async *start(input: { prompt: string; cwd: string; signal: AbortSignal }): AsyncIterable<AgentEvent> {
    const handle = this.runner.spawn(
      'claude',
      buildClaudeArgs({ prompt: input.prompt, permission: this.permission }),
      { cwd: input.cwd }
    )

    const parser = new ClaudeStreamParser()
    const splitter = new LineSplitter()
    const queue: AgentEvent[] = []
    const recentLines: string[] = []
    let exitResult: { code: number | null; error?: Error } | null = null
    let aborted = false
    let sawFinal = false
    let wake: (() => void) | null = null

    // 数据与退出事件来自 Node 回调，这里用唤醒函数把它们桥接成异步迭代。
    const wakeUp = () => {
      const resolve = wake
      wake = null
      resolve?.()
    }

    // ProcessHandle 不区分 stdout/stderr，两者都走这里：stream-json 行被解析，
    // 其余文本（典型如 stderr 警告）由解析器原样转成 log。
    handle.onData((chunk) => {
      for (const line of splitter.push(chunk)) {
        recentLines.push(line)
        if (recentLines.length > MAX_SUMMARY_LINES) {
          recentLines.shift()
        }
        queue.push(...parser.pushLine(line))
      }
      wakeUp()
    })

    handle.onExit((code, error) => {
      // 进程结束时可能还有最后一行没有换行符，交给 flush 补发。
      for (const line of splitter.flush()) {
        recentLines.push(line)
        if (recentLines.length > MAX_SUMMARY_LINES) {
          recentLines.shift()
        }
        queue.push(...parser.pushLine(line))
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
        const event = queue.shift()
        if (event !== undefined) {
          if (event.type === 'final') {
            sawFinal = true
          }
          yield event
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

    // 某些版本/中断路径可能退出码为 0 却没有 result 事件，用输出尾部兜底，
    // 保证任务管理器始终能拿到一份可展示的最终摘要。
    if (!sawFinal) {
      yield { type: 'final', summary: tail }
    }
  }
}

function withTail(reason: string, tail: string): string {
  return tail.length > 0 ? `${reason}\n${tail}` : reason
}
