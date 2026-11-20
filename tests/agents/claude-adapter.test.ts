import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AgentRunError, type AgentEvent } from '../../src/main/services/agents/adapter'
import { ClaudeAdapter, buildClaudeArgs } from '../../src/main/services/agents/claude-adapter'
import { ClaudeStreamParser } from '../../src/main/services/agents/claude-stream-parser'
import type { ProcessHandle, ProcessRunner } from '../../src/main/services/agents/process-runner'

const fixturePath = fileURLToPath(new URL('../fixtures/claude-stream.jsonl', import.meta.url))
const fixtureContent = readFileSync(fixturePath, 'utf8')
const fixtureLines = fixtureContent.split('\n').filter((line) => line.length > 0)

const cwd = '/tmp/claude-adapter-test'

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
  readonly spawns: Array<{
    command: string
    args: string[]
    cwd: string
    env?: NodeJS.ProcessEnv
  }> = []

  constructor(
    private readonly chunks: string[],
    private readonly exit: { code: number | null; error?: Error } = { code: 0 }
  ) {}

  spawn(
    command: string,
    args: string[],
    opts: { cwd: string; env?: NodeJS.ProcessEnv }
  ): ProcessHandle {
    this.spawns.push({ command, args, cwd: opts.cwd, env: opts.env })
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

describe('buildClaudeArgs', () => {
  test('buildClaudeArgs uses plan mode for read-only', () => {
    expect(buildClaudeArgs({ prompt: 'summarize the repo', permission: 'read-only' })).toEqual([
      '-p',
      'summarize the repo',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'plan'
    ])
  })

  test('buildClaudeArgs uses acceptEdits for edit-only', () => {
    expect(buildClaudeArgs({ prompt: 'fix the bug', permission: 'edit-only' }).at(-1)).toBe(
      'acceptEdits'
    )
  })

  test('buildClaudeArgs uses bypassPermissions for edit-and-run', () => {
    expect(buildClaudeArgs({ prompt: 'run the tests', permission: 'edit-and-run' }).at(-1)).toBe(
      'bypassPermissions'
    )
  })
})

describe('ClaudeStreamParser', () => {
  test('parser maps tool_use to progress and result to final', () => {
    const parser = new ClaudeStreamParser()

    const events = fixtureLines.flatMap((line) => parser.pushLine(line))

    expect(events).toEqual([
      { type: 'progress', text: '执行 Read' },
      { type: 'progress', text: 'hello from claude' },
      { type: 'final', summary: 'All done' },
      { type: 'log', text: 'not json at all' }
    ])
  })

  test('parser ignores unknown event types and malformed JSON', () => {
    const parser = new ClaudeStreamParser()

    expect(parser.pushLine('{"type":"system","subtype":"init"}')).toEqual([])
    expect(parser.pushLine('{"type":"mystery","value":1}')).toEqual([])
    expect(parser.pushLine('{"type":"assistant","message":null}')).toEqual([])
    expect(parser.pushLine('{"type":"assistant","message":{"content":[{"type":"text","text":"   "}]}}')).toEqual([])
    expect(parser.pushLine('{"type":"result","result":42}')).toEqual([])
    expect(parser.pushLine('null')).toEqual([])
    expect(parser.pushLine('plain text')).toEqual([{ type: 'log', text: 'plain text' }])
  })
})

describe('ClaudeAdapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('spawns claude with the built args and maps the stream', async () => {
    const runner = new ScriptedRunner([fixtureContent])
    const adapter = new ClaudeAdapter(runner, 'edit-only')

    const events = await collect(
      adapter.start({ prompt: 'fix the bug', cwd, signal: new AbortController().signal })
    )

    expect(runner.spawns).toHaveLength(1)
    expect(runner.spawns[0]).toMatchObject({
      command: 'claude',
      args: buildClaudeArgs({ prompt: 'fix the bug', permission: 'edit-only' }),
      cwd
    })
    expect(events).toEqual([
      { type: 'progress', text: '执行 Read' },
      { type: 'progress', text: 'hello from claude' },
      { type: 'final', summary: 'All done' },
      { type: 'log', text: 'not json at all' }
    ])
  })

  test('strips host Claude Code environment from the task process', async () => {
    // 模拟 AgentGroup 从 Claude Code 宿主中启动：父进程带 BASE_URL 和模型变量，
    // 但没有 token。子进程必须只按自己的 ~/.claude/settings.json 运行。
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:15721')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'host-token')
    vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', 'claude-sonnet-5')
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'host-session')
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'claude-desktop-3p')

    const runner = new ScriptedRunner([fixtureContent])
    const adapter = new ClaudeAdapter(runner, 'edit-only')
    await collect(
      adapter.start({ prompt: 'fix the bug', cwd, signal: new AbortController().signal })
    )

    const env = runner.spawns[0]?.env
    expect(env?.['ANTHROPIC_BASE_URL']).toBeUndefined()
    expect(env?.['ANTHROPIC_AUTH_TOKEN']).toBeUndefined()
    expect(env?.['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBeUndefined()
    expect(env?.['CLAUDE_CODE_SESSION_ID']).toBeUndefined()
    expect(env?.['CLAUDE_CODE_ENTRYPOINT']).toBeUndefined()
    // 普通环境变量仍需保留，CLI 依赖 HOME 找到自己的 settings.json
    expect(env?.['HOME']).toBe(process.env.HOME)
    expect(env?.['PATH']).toBe(process.env.PATH)
  })

  test('throws AgentRunError with the last lines on non-zero exit', async () => {
    const runner = new ScriptedRunner(
      [
        `${JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash' }] }
        })}\nboom line\n`
      ],
      { code: 1 }
    )
    const adapter = new ClaudeAdapter(runner, 'read-only')

    const error = await collectError(
      adapter.start({ prompt: 'do it', cwd, signal: new AbortController().signal })
    )

    expect(error).toBeInstanceOf(AgentRunError)
    expect(error.exitCode).toBe(1)
    expect(error.message).toContain('boom line')
  })

  test('spawn error becomes AgentRunError', async () => {
    const runner = new ScriptedRunner([], { code: null, error: new Error('spawn claude ENOENT') })
    const adapter = new ClaudeAdapter(runner, 'read-only')

    const error = await collectError(
      adapter.start({ prompt: 'do it', cwd, signal: new AbortController().signal })
    )

    expect(error).toBeInstanceOf(AgentRunError)
    expect(error.exitCode).toBeNull()
    expect(error.message).toContain('spawn claude ENOENT')
  })

  test('aborting the signal kills the process', async () => {
    const runner = new HangingRunner()
    const adapter = new ClaudeAdapter(runner, 'read-only')
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

  test('falls back to a final summary from the last 20 lines when no result event arrives', async () => {
    const lines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`)
    const runner = new ScriptedRunner([`${lines.join('\n')}\n`])
    const adapter = new ClaudeAdapter(runner, 'read-only')

    const events = await collect(
      adapter.start({ prompt: 'do it', cwd, signal: new AbortController().signal })
    )

    expect(events.filter((event) => event.type === 'final')).toEqual([
      { type: 'final', summary: lines.slice(5).join('\n') }
    ])
  })
})
