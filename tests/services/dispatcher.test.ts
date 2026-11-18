import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AgentRepo } from '../../src/main/db/agent-repo'
import { MessageRepo } from '../../src/main/db/message-repo'
import { TaskRepo } from '../../src/main/db/task-repo'
import { EventBus } from '../../src/main/events'
import { Dispatcher } from '../../src/main/services/chat/dispatcher'
import type { AgentConfig, AppEvent, ChatMessage } from '../../src/shared/types'
import { createTestDb, type TestDb } from '../helpers/db'

const WORKSPACE_ID = 'ws-1'
const NOW = new Date('2026-11-18T10:00:00.000Z')

let testDb: TestDb
let agents: AgentRepo
let tasks: TaskRepo
let messages: MessageRepo
let events: EventBus
let enqueue: ReturnType<typeof vi.fn>
let idCounter: number

beforeEach(async () => {
  testDb = await createTestDb()
  agents = new AgentRepo(testDb.db)
  tasks = new TaskRepo(testDb.db)
  messages = new MessageRepo(testDb.db)
  events = new EventBus()
  enqueue = vi.fn()
  idCounter = 0
})

afterEach(async () => {
  await testDb.cleanup()
})

function makeAgent(
  overrides: Partial<AgentConfig> & Pick<AgentConfig, 'id' | 'name'>
): AgentConfig {
  return {
    workspaceId: WORKSPACE_ID,
    preset: 'claude',
    command: 'claude',
    argsTemplate: null,
    rolePrompt: '',
    pathScope: [],
    permissionProfile: 'edit-and-run',
    canDelegate: false,
    enabled: true,
    ...overrides
  }
}

function createDispatcher(): Dispatcher {
  return new Dispatcher({
    agents,
    tasks,
    messages,
    events,
    enqueue,
    newId: () => `id-${++idCounter}`,
    now: () => NOW
  })
}

function messageEvents(seen: AppEvent[]): Array<Extract<AppEvent, { type: 'message' }>> {
  return seen.filter((event): event is Extract<AppEvent, { type: 'message' }> => {
    return event.type === 'message'
  })
}

function taskEvents(seen: AppEvent[]): Array<Extract<AppEvent, { type: 'task-updated' }>> {
  return seen.filter((event): event is Extract<AppEvent, { type: 'task-updated' }> => {
    return event.type === 'task-updated'
  })
}

describe('Dispatcher', () => {
  beforeEach(() => {
    agents.insert(makeAgent({ id: 'agent-claude', name: 'claude' }))
    agents.insert(makeAgent({ id: 'agent-codex', name: 'codex', preset: 'codex' }))
    agents.insert(makeAgent({ id: 'agent-deepseek', name: 'deepseek', preset: 'custom' }))
  })

  test('creates one queued task per mentioned agent and a system dispatch message', async () => {
    const dispatcher = createDispatcher()

    const result = await dispatcher.send(
      WORKSPACE_ID,
      '做登录功能 @claude 前端页面 @codex 后端接口 @deepseek 测试'
    )

    expect(result.message).toEqual({
      id: 'id-1',
      workspaceId: WORKSPACE_ID,
      kind: 'user',
      authorType: 'user',
      authorId: null,
      content: '做登录功能 @claude 前端页面 @codex 后端接口 @deepseek 测试',
      taskId: null,
      createdAt: '2026-11-18T10:00:00.000Z'
    })
    expect(result.tasks).toHaveLength(3)
    expect(result.tasks.map((task) => task.agentId)).toEqual([
      'agent-claude',
      'agent-codex',
      'agent-deepseek'
    ])
    for (const task of result.tasks) {
      expect(task.status).toBe('queued')
      expect(task.taskType).toBe('code')
      expect(task.workspaceId).toBe(WORKSPACE_ID)
      expect(task.parentTaskId).toBeNull()
      expect(task.branch).toBeNull()
      expect(task.worktreePath).toBeNull()
      expect(task.baseRef).toBeNull()
      expect(task.exitCode).toBeNull()
      expect(task.summary).toBeNull()
      expect(task.startedAt).toBeNull()
      expect(task.finishedAt).toBeNull()
      expect(task.createdAt).toBe('2026-11-18T10:00:00.000Z')
    }

    // 每个任务都已入队，且入队参数就是持久化的任务 id。
    expect(enqueue).toHaveBeenCalledTimes(3)
    expect(enqueue.mock.calls.map(([taskId]) => taskId)).toEqual(
      result.tasks.map((task) => task.id)
    )

    // 数据库中的消息顺序：用户消息、三个任务卡片、系统分派消息。
    const stored = messages.listByWorkspace(WORKSPACE_ID)
    expect(stored.map((message) => message.kind)).toEqual([
      'user',
      'task-card',
      'task-card',
      'task-card',
      'system'
    ])
    const cards = stored.filter((message) => message.kind === 'task-card')
    expect(cards.map((card) => card.taskId)).toEqual(result.tasks.map((task) => task.id))
    expect(cards.map((card) => card.content)).toEqual(result.tasks.map((task) => task.title))

    const system = stored.at(-1) as ChatMessage
    expect(system.authorType).toBe('system')
    expect(system.authorId).toBeNull()
    expect(system.taskId).toBeNull()
    expect(system.content).toBe('已分派 3 个任务：claude、codex、deepseek')

    expect(tasks.listByWorkspace(WORKSPACE_ID)).toHaveLength(3)
  })

  test('shared context is prepended to every task prompt', async () => {
    const dispatcher = createDispatcher()

    const result = await dispatcher.send(
      WORKSPACE_ID,
      '做登录功能 @claude 前端页面 @codex 后端接口'
    )

    expect(result.tasks.map((task) => task.prompt)).toEqual([
      '做登录功能\n\n前端页面',
      '做登录功能\n\n后端接口'
    ])
  })

  test('message without mentions creates no tasks', async () => {
    const dispatcher = createDispatcher()

    const result = await dispatcher.send(WORKSPACE_ID, '今天天气不错')

    expect(result.tasks).toEqual([])
    expect(enqueue).not.toHaveBeenCalled()
    const stored = messages.listByWorkspace(WORKSPACE_ID)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toEqual(result.message)
    expect(stored[0]?.kind).toBe('user')
  })

  test('all-unknown mentions create a system warning and no tasks', async () => {
    const dispatcher = createDispatcher()

    const result = await dispatcher.send(WORKSPACE_ID, '@ghost 看一下 @nobody 这个问题')

    expect(result.tasks).toEqual([])
    expect(enqueue).not.toHaveBeenCalled()
    const stored = messages.listByWorkspace(WORKSPACE_ID)
    expect(stored.map((message) => message.kind)).toEqual(['user', 'system'])
    expect(stored[1]?.authorType).toBe('system')
    expect(stored[1]?.content).toBe('未找到 Agent：@ghost、@nobody')
  })

  test('task title is the first 40 characters of the prompt', async () => {
    const dispatcher = createDispatcher()
    const longPrompt = '😀'.repeat(45)

    const result = await dispatcher.send(WORKSPACE_ID, `@claude ${longPrompt}`)

    expect(result.tasks[0]?.prompt).toBe(longPrompt)
    expect(result.tasks[0]?.title).toBe('😀'.repeat(40))
    expect(Array.from(result.tasks[0]?.title ?? '')).toHaveLength(40)
  })

  test('disabled agents are not assigned and are reported as unknown', async () => {
    agents.update('agent-codex', { enabled: false })
    const dispatcher = createDispatcher()

    // codex 被禁用后，其提及文本留在 claude 的 prompt 里，不产生 codex 任务。
    const mixed = await dispatcher.send(WORKSPACE_ID, '@claude 做A @codex 做B')
    expect(mixed.tasks).toHaveLength(1)
    expect(mixed.tasks[0]?.agentId).toBe('agent-claude')
    expect(mixed.tasks[0]?.prompt).toBe('做A @codex 做B')
    expect(enqueue).toHaveBeenCalledTimes(1)

    // 只提及被禁用的 Agent 时按未知提及处理：不建任务，只发系统提示。
    const onlyDisabled = await dispatcher.send(WORKSPACE_ID, '@codex 做B')
    expect(onlyDisabled.tasks).toEqual([])
    // 第一条系统消息来自上一次分派，第二条才是本次的未知提及提示。
    const systemMessages = messages
      .listByWorkspace(WORKSPACE_ID)
      .filter((message) => message.kind === 'system')
    expect(systemMessages.map((message) => message.content)).toEqual([
      '已分派 1 个任务：claude',
      '未找到 Agent：@codex'
    ])
  })

  test('emits a message event per inserted message and a task-updated event per task', async () => {
    const seen: AppEvent[] = []
    const unsubscribe = events.on((event) => seen.push(event))
    const dispatcher = createDispatcher()

    const result = await dispatcher.send(
      WORKSPACE_ID,
      '做登录功能 @claude 前端页面 @codex 后端接口'
    )
    unsubscribe()

    const messageList = messageEvents(seen)
    const taskList = taskEvents(seen)
    expect(messageList).toHaveLength(4)
    expect(taskList).toHaveLength(2)
    expect(messageList[0]?.message).toEqual(result.message)
    expect(taskList.map((event) => event.task)).toEqual(result.tasks)

    const stored = messages.listByWorkspace(WORKSPACE_ID)
    expect(messageList.map((event) => event.message)).toEqual(stored)

    // 退订后不再收到事件。
    events.emit({ type: 'agent-status', agentId: 'agent-claude', status: 'idle' })
    expect(seen).toHaveLength(6)
  })
})
