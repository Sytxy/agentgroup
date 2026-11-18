import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { AgentRunError, type AgentEvent } from '../../src/main/services/agents/adapter'
import { GenericCliAdapter } from '../../src/main/services/agents/generic-cli-adapter'
import {
  ChildProcessRunner,
  type ProcessHandle,
  type ProcessRunner
} from '../../src/main/services/agents/process-runner'

const fixturePath = fileURLToPath(new URL('../fixtures/fake-agent.js', import.meta.url))
const node = process.execPath
const cwd = process.cwd()

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = []
  for await (const event of events) {
    result.push(event)
  }
  return result
}

async function collectError(events: AsyncIterable<AgentEvent>): Promise<AgentRunError> {
  try {
    await collect(events)
  } catch (error) {
    if (error instanceof AgentRunError) {
      return error
    }
    throw error
  }
  throw new Error('expected the adapter to throw AgentRunError')
}

class RecordingRunner implements ProcessRunner {
  readonly spawns: Array<{ command: string; args: string[]; cwd: string }> = []

  spawn(command: string, args: string[], opts: { cwd: string }): ProcessHandle {
    this.spawns.push({ command, args, cwd: opts.cwd })
    const exitCallbacks: Array<(code: number | null, error?: Error) => void> = []
    // 异步退出，模拟真实子进程不会在 start() 返回前就结束。
    setTimeout(() => {
      for (const callback of exitCallbacks) {
        callback(0)
      }
    }, 0)
    return {
      onData() {},
      onExit(callback) {
        exitCallbacks.push(callback)
      },
      kill() {}
    }
  }
}

class ScriptedRunner implements ProcessRunner {
  constructor(private readonly chunks: string[]) {}

  spawn(): ProcessHandle {
    const dataCallbacks: Array<(chunk: string) => void> = []
    const exitCallbacks: Array<(code: number | null, error?: Error) => void> = []
    setTimeout(() => {
      for (const chunk of this.chunks) {
        for (const callback of dataCallbacks) {
          callback(chunk)
        }
      }
      for (const callback of exitCallbacks) {
        callback(0)
      }
    }, 0)
    return {
      onData(callback) {
        dataCallbacks.push(callback)
      },
      onExit(callback) {
        exitCallbacks.push(callback)
      },
      kill() {}
    }
  }
}

describe('GenericCliAdapter', () => {
  test('generic adapter streams logs and emits the final summary', async () => {
    const adapter = new GenericCliAdapter(new ChildProcessRunner(), {
      command: node,
      argsTemplate: `${fixturePath} {prompt}`
    })

    const events = await collect(
      adapter.start({ prompt: 'say hello', cwd, signal: new AbortController().signal })
    )

    expect(events).toEqual([
      { type: 'log', text: 'fake agent line 1' },
      { type: 'progress', text: 'fake agent line 1' },
      { type: 'log', text: 'fake agent line 2' },
      { type: 'progress', text: 'fake agent line 2' },
      { type: 'final', summary: 'fake agent line 1\nfake agent line 2' }
    ])
  })

  test('generic adapter throws AgentRunError on non-zero exit', async () => {
    const adapter = new GenericCliAdapter(new ChildProcessRunner(), {
      command: node,
      argsTemplate: `${fixturePath} --fail`
    })

    const error = await collectError(
      adapter.start({ prompt: 'fail please', cwd, signal: new AbortController().signal })
    )

    expect(error).toBeInstanceOf(AgentRunError)
    expect(error.exitCode).toBe(1)
    expect(error.message).toContain('fake agent failed')
  })

  test('aborting the signal kills the process', async () => {
    const adapter = new GenericCliAdapter(new ChildProcessRunner(), {
      command: node,
      argsTemplate: `${fixturePath} --slow`
    })
    const controller = new AbortController()
    const startedAt = Date.now()

    const iterator = adapter
      .start({ prompt: 'slow task', cwd, signal: controller.signal })
      [Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.value).toEqual({ type: 'log', text: 'slow line 1' })
    controller.abort()

    let caught: unknown
    try {
      while (!(await iterator.next()).done) {
        // 继续消费，直到进程被终止后适配器抛出错误。
      }
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AgentRunError)
    expect((caught as AgentRunError).message).toContain('取消')
    // SIGTERM 应立即生效，不需要等到 5 秒后的 SIGKILL。
    expect(Date.now() - startedAt).toBeLessThan(3000)
  })

  test('spawn error becomes AgentRunError', async () => {
    const adapter = new GenericCliAdapter(new ChildProcessRunner(), {
      command: 'agentgroup-command-that-does-not-exist',
      argsTemplate: ''
    })

    const error = await collectError(
      adapter.start({ prompt: 'hello', cwd, signal: new AbortController().signal })
    )

    expect(error).toBeInstanceOf(AgentRunError)
    expect(error.exitCode).toBeNull()
    expect(error.message).toContain('agentgroup-command-that-does-not-exist')
  })

  test('a prompt with spaces stays a single argv element', async () => {
    const runner = new RecordingRunner()
    const adapter = new GenericCliAdapter(runner, {
      command: 'agent',
      argsTemplate: '--message {prompt} --quiet'
    })

    await collect(
      adapter.start({ prompt: 'hello world with spaces', cwd: '/tmp', signal: new AbortController().signal })
    )

    expect(runner.spawns).toEqual([
      {
        command: 'agent',
        args: ['--message', 'hello world with spaces', '--quiet'],
        cwd: '/tmp'
      }
    ])
  })

  test('a template without {prompt} appends the prompt as the final argument', async () => {
    const runner = new RecordingRunner()
    const adapter = new GenericCliAdapter(runner, {
      command: 'agent',
      argsTemplate: '--flag'
    })

    await collect(
      adapter.start({ prompt: 'hello world with spaces', cwd: '/tmp', signal: new AbortController().signal })
    )

    expect(runner.spawns[0]?.args).toEqual(['--flag', 'hello world with spaces'])
  })

  test('the final summary keeps only the last 20 lines', async () => {
    const lines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`)
    const adapter = new GenericCliAdapter(new ScriptedRunner([`${lines.join('\n')}\n`]), {
      command: 'agent',
      argsTemplate: ''
    })

    const events = await collect(
      adapter.start({ prompt: 'x', cwd: '/tmp', signal: new AbortController().signal })
    )
    const final = events.at(-1)

    expect(final).toEqual({ type: 'final', summary: lines.slice(5).join('\n') })
  })
})
