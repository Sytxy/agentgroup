/**
 * 测试用脚本化 AgentAdapter。
 *
 * 按预设顺序产出事件，可在每个事件前执行副作用（例如在 worktree 中写文件），
 * 也可配置事件间的等待时长与最终抛出的错误，用来覆盖超时、取消、并发与失败路径。
 * 等待过程响应 AbortSignal：超时/取消时立即结束，模拟真实适配器被杀进程的行为。
 */
import type { AgentAdapter, AgentEvent } from '../../src/main/services/agents/adapter'

export interface FakeAdapterStep {
  /** 发出事件前执行的副作用，可模拟 Agent 在 worktree 中修改文件 */
  before?: (cwd: string) => void | Promise<void>
  /** 本步发出的事件 */
  event: AgentEvent
  /** 发出事件前等待的毫秒数；用于让运行持续足够长，以测试并发、超时与取消 */
  delayMs?: number
}

export interface FakeAdapterScript {
  steps?: FakeAdapterStep[]
  /** 全部步骤结束后抛出的错误，模拟进程非零退出或启动失败 */
  error?: Error
}

export interface FakeAdapterRun {
  prompt: string
  cwd: string
  signal: AbortSignal
}

export class FakeAdapter implements AgentAdapter {
  /** 每次 start 的入参，测试据此断言 prompt、cwd 与取消信号 */
  readonly runs: FakeAdapterRun[] = []
  /** 当前同时进行的运行数 */
  active = 0
  /** 观察到的最大并发数，用于验证同一 Agent 不会并行执行任务 */
  maxActive = 0

  constructor(private readonly script: FakeAdapterScript = {}) {}

  async *start(input: FakeAdapterRun): AsyncIterable<AgentEvent> {
    this.runs.push(input)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)

    try {
      for (const step of this.script.steps ?? []) {
        if (step.delayMs !== undefined) {
          await delay(step.delayMs, input.signal)
        }
        if (input.signal.aborted) {
          throw new Error('aborted')
        }
        await step.before?.(input.cwd)
        yield step.event
      }
      if (this.script.error) {
        throw this.script.error
      }
    } finally {
      this.active -= 1
    }
  }
}

/** 可被 AbortSignal 打断的等待；中断时以错误结束，模拟适配器退出 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(new Error('aborted'))
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}
