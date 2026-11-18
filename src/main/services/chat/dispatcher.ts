import { randomUUID } from 'node:crypto'
import type { ChatMessage, Task } from '../../../shared/types'
import type { AgentRepo } from '../../db/agent-repo'
import type { MessageRepo } from '../../db/message-repo'
import type { TaskRepo } from '../../db/task-repo'
import type { EventBus } from '../../events'
import { MessageParser } from './message-parser'

export interface DispatcherDeps {
  agents: AgentRepo
  tasks: TaskRepo
  messages: MessageRepo
  events: EventBus
  /** 任务创建后交给 TaskManager 入队；分派器本身不启动任务。 */
  enqueue: (taskId: string) => void
  newId?: () => string
  now?: () => Date
}

export interface DispatchResult {
  /** 本次写入数据库的用户消息。 */
  message: ChatMessage
  /** 按提及顺序创建的任务；无提及时为空数组。 */
  tasks: Task[]
}

/**
 * 把一条群消息分派为持久化消息与排队任务。
 *
 * 仅使用工作区中启用的 Agent 解析提及；被禁用的 Agent 等同于未知提及。
 * 无 assignment 时不创建任务：只有存在未知 `@name` 时补一条系统提示，
 * 避免用户以为消息已分派。所有插入的消息与任务都通过 EventBus 广播。
 */
export class Dispatcher {
  private readonly agents: AgentRepo
  private readonly tasks: TaskRepo
  private readonly messages: MessageRepo
  private readonly events: EventBus
  private readonly enqueue: (taskId: string) => void
  private readonly newId: () => string
  private readonly now: () => Date

  constructor(deps: DispatcherDeps) {
    this.agents = deps.agents
    this.tasks = deps.tasks
    this.messages = deps.messages
    this.events = deps.events
    this.enqueue = deps.enqueue
    this.newId = deps.newId ?? (() => randomUUID())
    this.now = deps.now ?? (() => new Date())
  }

  async send(workspaceId: string, text: string): Promise<DispatchResult> {
    const createdAt = this.now().toISOString()

    // 插入消息并同步广播；本次分派的所有记录共用同一时间戳，测试可完全确定。
    const insertMessage = (
      fields: Pick<ChatMessage, 'kind' | 'authorType' | 'authorId' | 'content' | 'taskId'>
    ): ChatMessage => {
      const message: ChatMessage = {
        id: this.newId(),
        workspaceId,
        ...fields,
        createdAt
      }
      this.messages.insert(message)
      this.events.emit({ type: 'message', message })
      return message
    }

    // 先保存用户消息：即使后续解析没有任何 assignment，群聊里也保留原始输入。
    const userMessage = insertMessage({
      kind: 'user',
      authorType: 'user',
      authorId: null,
      content: text,
      taskId: null
    })

    const enabledAgents = this.agents
      .listByWorkspace(workspaceId)
      .filter((agent) => agent.enabled)
    const parsed = new MessageParser(enabledAgents).parse(text)

    if (parsed.assignments.length === 0) {
      const unknownMentions = findUnknownMentions(text, enabledAgents)
      if (unknownMentions.length > 0) {
        insertMessage({
          kind: 'system',
          authorType: 'system',
          authorId: null,
          content: `未找到 Agent：${unknownMentions.map((name) => `@${name}`).join('、')}`,
          taskId: null
        })
      }
      return { message: userMessage, tasks: [] }
    }

    const agentsById = new Map(enabledAgents.map((agent) => [agent.id, agent]))
    const createdTasks: Task[] = []

    for (const assignment of parsed.assignments) {
      const agent = agentsById.get(assignment.agentId)
      // parser 只由 enabledAgents 构造，正常不会出现未知 id；抛出以免静默丢任务。
      if (!agent) {
        throw new Error(`Dispatcher: 未找到已启用的 Agent ${assignment.agentId}`)
      }

      // 共享背景只拼一次到任务提示前，空背景不产生多余空行。
      const prompt =
        parsed.sharedContext.length > 0
          ? `${parsed.sharedContext}\n\n${assignment.prompt}`
          : assignment.prompt
      // 标题按 Unicode 码点截断，避免把 emoji 等代理对截成半个字符。
      const title = Array.from(prompt).slice(0, 40).join('')

      const task: Task = {
        id: this.newId(),
        workspaceId,
        agentId: agent.id,
        parentTaskId: null,
        taskType: 'code',
        title,
        prompt,
        branch: null,
        worktreePath: null,
        baseRef: null,
        status: 'queued',
        exitCode: null,
        summary: null,
        createdAt,
        startedAt: null,
        finishedAt: null
      }
      this.tasks.insert(task)
      createdTasks.push(task)
      this.events.emit({ type: 'task-updated', task })

      // 每个任务对应一张卡片消息，群聊据此渲染任务状态。
      insertMessage({
        kind: 'task-card',
        authorType: 'system',
        authorId: null,
        content: title,
        taskId: task.id
      })
    }

    insertMessage({
      kind: 'system',
      authorType: 'system',
      authorId: null,
      content: `已分派 ${createdTasks.length} 个任务：${createdTasks
        .map((task) => agentsById.get(task.agentId)?.name ?? task.agentId)
        .join('、')}`,
      taskId: null
    })

    // 消息与任务全部落库后再入队，TaskManager 可以安全地立即读取任务。
    for (const task of createdTasks) {
      this.enqueue(task.id)
    }

    return { message: userMessage, tasks: createdTasks }
  }
}

/**
 * 扫描消息中形如 `@token` 的提及，返回其中不属于已启用 Agent 的名字。
 *
 * 只用于无 assignment 时的系统提示：解析器会忽略未知提及，若不提示，
 * 用户会误以为消息已分派。token 允许 Unicode 字母、数字及 `_.+#-`，
 * 与常见 Agent 名（如 claude、小助手、c++）一致；仅识别开头或空白后的 `@`，
 * 避免把邮箱 `foo@bar` 当成提及。结果按首次出现顺序去重（大小写不敏感）。
 */
function findUnknownMentions(text: string, enabledAgents: Array<{ name: string }>): string[] {
  const knownNames = new Set(enabledAgents.map((agent) => agent.name.toLowerCase()))
  const seen = new Set<string>()
  const unknown: string[] = []

  for (const match of text.matchAll(/(?:^|\s)@([\p{L}\p{N}_.+#-]+)/gu)) {
    const name = match[1]
    if (!name) continue
    const key = name.toLowerCase()
    if (knownNames.has(key) || seen.has(key)) continue
    seen.add(key)
    unknown.push(name)
  }

  return unknown
}
