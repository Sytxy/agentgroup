import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { AgentRunError, type AgentEvent } from '../../src/main/services/agents/adapter'
import { CodexAdapter, buildCodexArgs } from '../../src/main/services/agents/codex-adapter'
import { CodexStreamParser } from '../../src/main/services/agents/codex-stream-parser'
import type { ProcessHandle, ProcessRunner } from '../../src/main/services/agents/process-runner'

const fixturePath = fileURLToPath(new URL('../fixtures/codex-stream.jsonl', import.meta.url))
const fixtureContent = readFileSync(fixturePath, 'utf8')
const fixtureLines = fixtureContent.split('\n').filter((line) => line.length > 0)

const cwd = '/tmp/codex-adapter-test'

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

class ScriptedRunner implements ProcessRunner {
  readonly spawns: Array<{ command: string; args: string[]; cwd: string }> = []

  constructor(
    private readonly chunks: string[],
    private readonly exit: { code: number | null; error?: Error } = { code: 0 }
  ) {}

  spawn(command: string, args: string[], opts: { cwd: string }): ProcessHandle {
    this.spawns.push({ command, args, cwd: opts.cwd })
    const dataCallbacks: Array<(chunk: string) => void> = []
    const exitCallbacks: Array<(code: number | null, error?: Error) => void> = []
    // 异步结束，模拟真实子进程不会在 start() 返回前就退出。
    setTimeout(() => {
      for (const chunk of this.chunks) {
        for (const callback of dataCallbacks) {
          callback(chunk)
        }
      }
      for (const callback of exitCallbacks) {
        callback(this.exit.code, this.exit.error)
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

class HangingRunner implements ProcessRunner {
  killed = false

  private readonly exitCallbacks: Array<(code: number | null, error?: Error) => void> = []

  spawn(): ProcessHandle {
    // 用箭头函数捕获 runner 实例；方法简写里的 this 会指向 ProcessHandle。
    return {
      onData() {},
      onExit: (callback) => {
        this.exitCallbacks.push(callback)
      },
      kill: () => {
        this.killed = true
        for (const callback of this.exitCallbacks) {
          callback(null)
        }
      }
    }
  }
}

describe('buildCodexArgs', () => {
  test('buildCodexArgs uses read-only sandbox for read-only', () => {
    expect(buildCodexArgs({ prompt: 'summarize the repo', permission: 'read-only' })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      'summarize the repo'
    ])
  })

  test('buildCodexArgs uses workspace-write for edit-only and edit-and-run', () => {
    expect(buildCodexArgs({ prompt: 'fix the bug', permission: 'edit-only' })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      'fix the bug'
    ])
    expect(buildCodexArgs({ prompt: 'run the tests', permission: 'edit-and-run' })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      'run the tests'
    ])
  })
})

describe('CodexStreamParser', () => {
  test('parser emits progress for command/tool items and final for completed text', () => {
    const parser = new CodexStreamParser()

    const events = fixtureLines.flatMap((line) => parser.pushLine(line))

    expect(events).toEqual([
      { type: 'progress', text: '执行 pnpm test', signature: 'codex:执行 pnpm test' },
      { type: 'progress', text: '执行 read_file', signature: 'codex:执行 read_file' },
      { type: 'final', summary: 'All done' },
      { type: 'log', text: 'plain text line' }
    ])
  })

  test('parser tolerates unknown JSON shapes and plain text lines', () => {
    const parser = new CodexStreamParser()

    expect(parser.pushLine('{"type":"thread.started","thread_id":"t"}')).toEqual([])
    expect(parser.pushLine('{"type":"turn.completed","usage":{"input_tokens":1}}')).toEqual([])
    expect(parser.pushLine('{"type":"turn.failed","error":{"message":"boom"}}')).toEqual([])
    expect(parser.pushLine('{"type":"item.completed","item":null}')).toEqual([])
    expect(parser.pushLine('{"type":"item.completed","item":{"type":"agent_message","text":"   "}}')).toEqual(
      []
    )
    expect(parser.pushLine('{"type":"unknown_event","payload":1}')).toEqual([])
    expect(parser.pushLine('null')).toEqual([])
    expect(parser.pushLine('')).toEqual([{ type: 'log', text: '' }])
    expect(parser.pushLine('not json at all')).toEqual([{ type: 'log', text: 'not json at all' }])
  })

  test('parser recognizes legacy top-level command and message shapes', () => {
    const parser = new CodexStreamParser()

    expect(parser.pushLine('{"type":"command_execution","command":"ls -la"}')).toEqual([
      { type: 'progress', text: '执行 ls -la', signature: 'codex:执行 ls -la' }
    ])
    expect(parser.pushLine('{"type":"item.completed","message":"done"}')).toEqual([
      { type: 'final', summary: 'done' }
    ])
  })

  test('parser never treats reasoning or item-level error as final', () => {
    const parser = new CodexStreamParser()

    expect(
      parser.pushLine('{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}')
    ).toEqual([])
    expect(
      parser.pushLine('{"type":"item.completed","item":{"type":"error","message":"boom"}}')
    ).toEqual([])
    expect(
      parser.pushLine('{"type":"item.completed","item":{"type":"todo_list","items":[]}}')
    ).toEqual([])
  })

  test('parser still emits final for an agent_message item', () => {
    const parser = new CodexStreamParser()

    expect(
      parser.pushLine('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}')
    ).toEqual([{ type: 'final', summary: 'done' }])
  })
})

describe('CodexAdapter', () => {
  test('spawns codex with the built args and maps the stream', async () => {
    const runner = new ScriptedRunner([fixtureContent])
    const adapter = new CodexAdapter(runner, 'edit-only')

    const events = await collect(
      adapter.start({ prompt: 'fix the bug', cwd, signal: new AbortController().signal })
    )

    expect(runner.spawns).toEqual([
      {
        command: 'codex',
        args: buildCodexArgs({ prompt: 'fix the bug', permission: 'edit-only' }),
        cwd
      }
    ])
    expect(events).toEqual([
      { type: 'progress', text: '执行 pnpm test', signature: 'codex:执行 pnpm test' },
      { type: 'progress', text: '执行 read_file', signature: 'codex:执行 read_file' },
      { type: 'final', summary: 'All done' },
      { type: 'log', text: 'plain text line' }
    ])
  })

  test('throws AgentRunError with the last lines on non-zero exit', async () => {
    const runner = new ScriptedRunner(
      [
        `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'pnpm lint' }
        })}\nboom line\n`
      ],
      { code: 1 }
    )
    const adapter = new CodexAdapter(runner, 'read-only')

    const error = await collectError(
      adapter.start({ prompt: 'do it', cwd, signal: new AbortController().signal })
    )

    expect(error).toBeInstanceOf(AgentRunError)
    expect(error.exitCode).toBe(1)
    expect(error.message).toContain('boom line')
  })

  test('spawn error becomes AgentRunError', async () => {
    const runner = new ScriptedRunner([], { code: null, error: new Error('spawn codex ENOENT') })
    const adapter = new CodexAdapter(runner, 'read-only')

    const error = await collectError(
      adapter.start({ prompt: 'do it', cwd, signal: new AbortController().signal })
    )

    expect(error).toBeInstanceOf(AgentRunError)
    expect(error.exitCode).toBeNull()
    expect(error.message).toContain('spawn codex ENOENT')
  })

  test('aborting the signal kills the process', async () => {
    const runner = new HangingRunner()
    const adapter = new CodexAdapter(runner, 'read-only')
    const controller = new AbortController()

    const iterator = adapter
      .start({ prompt: 'slow task', cwd, signal: controller.signal })
      [Symbol.asyncIterator]()
    const pending = iterator.next()

    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(AgentRunError)
    await expect(pending).rejects.toThrow('取消')
    expect(runner.killed).toBe(true)
  })

  test('reasoning-only run falls back to the output tail instead of using reasoning text', async () => {
    const reasoningLine = JSON.stringify({
      type: 'item.completed',
      item: { type: 'reasoning', text: 'internal reasoning' }
    })
    const runner = new ScriptedRunner([`${reasoningLine}\n`])
    const adapter = new CodexAdapter(runner, 'read-only')

    const events = await collect(
      adapter.start({ prompt: 'do it', cwd, signal: new AbortController().signal })
    )

    expect(events.filter((event) => event.type === 'final')).toEqual([
      { type: 'final', summary: reasoningLine }
    ])
  })

  test('item-level error on non-zero exit throws without yielding it as final', async () => {
    const errorLine = JSON.stringify({
      type: 'item.completed',
      item: { type: 'error', message: 'tool failed' }
    })
    const runner = new ScriptedRunner([`${errorLine}\n`], { code: 2 })
    const adapter = new CodexAdapter(runner, 'read-only')

    const events: AgentEvent[] = []
    let thrown: unknown = null
    try {
      for await (const event of adapter.start({
        prompt: 'do it',
        cwd,
        signal: new AbortController().signal
      })) {
        events.push(event)
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AgentRunError)
    expect((thrown as AgentRunError).exitCode).toBe(2)
    expect((thrown as AgentRunError).message).toContain('tool failed')
    expect(events.some((event) => event.type === 'final')).toBe(false)
  })

  test('falls back to a final summary from the last 20 lines when no final event arrives', async () => {
    const lines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`)
    const runner = new ScriptedRunner([`${lines.join('\n')}\n`])
    const adapter = new CodexAdapter(runner, 'read-only')

    const events = await collect(
      adapter.start({ prompt: 'do it', cwd, signal: new AbortController().signal })
    )

    expect(events.filter((event) => event.type === 'final')).toEqual([
      { type: 'final', summary: lines.slice(5).join('\n') }
    ])
  })
})
