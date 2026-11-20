import { randomUUID } from 'node:crypto'
import type { ChatAttachment, ChatMessage, Task } from '../../../shared/types'
import type { AgentRepo } from '../../db/agent-repo'
import type { MessageRepo } from '../../db/message-repo'
import type { EventBus } from '../../events'
import type { TaskFactory } from '../tasks/task-factory'
import { MessageParser } from './message-parser'

export interface DispatcherDeps {
  agents: AgentRepo
  messages: MessageRepo
  events: EventBus
  /** 统一创建任务 + task-card 消息，保证群聊里每个任务都有卡片 */
  factory: TaskFactory
  /** 消息没有 @ 任何人时使用的默认 Agent；返回 null 表示不默认分派。 */
  defaultAgentIdFor?: (workspaceId: string) => string | null
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
  private readonly messages: MessageRepo
  private readonly events: EventBus
  private readonly factory: TaskFactory
  private readonly defaultAgentIdFor: (workspaceId: string) => string | null
  private readonly enqueue: (taskId: string) => void
  private readonly newId: () => string
  private readonly now: () => Date

  constructor(deps: DispatcherDeps) {
    this.agents = deps.agents
    this.messages = deps.messages
    this.events = deps.events
    this.factory = deps.factory
    this.defaultAgentIdFor = deps.defaultAgentIdFor ?? (() => null)
    this.enqueue = deps.enqueue
    this.newId = deps.newId ?? (() => randomUUID())
    this.now = deps.now ?? (() => new Date())
  }

  async send(
    workspaceId: string,
    text: string,
    attachments: ChatAttachment[] = []
  ): Promise<DispatchResult> {
    const createdAt = this.now().toISOString()

    // 插入消息并同步广播；本次分派的所有记录共用同一时间戳，测试可完全确定。
    const insertMessage = (
      fields: Pick<
        ChatMessage,
        'kind' | 'authorType' | 'authorId' | 'content' | 'taskId'
      > & { attachments?: ChatMessage['attachments'] }
    ): ChatMessage => {
      const message: ChatMessage = {
        id: this.newId(),
        workspaceId,
        ...fields,
        attachments: fields.attachments ?? [],
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
      taskId: null,
      attachments
    })

    // 附件保存为绝对路径后写进任务提示词，Agent 可以直接读取。
    const attachmentSection =
      attachments.length === 0
        ? ''
        : `\n\n附件（请直接读取这些本地文件）：\n${attachments
            .map((attachment) => `- ${attachment.path}（${attachment.name}，${attachment.mimeType}）`)
            .join('\n')}`

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
        return { message: userMessage, tasks: [] }
      }

      // 只有整条消息完全没有 @ 时才走默认 Agent。@ 了已知成员但没写任务内容时，
      // 说明用户意图是提及而不是默认分派，保持原来的“只显示消息”行为。
      if (hasAnyMention(text)) {
        return { message: userMessage, tasks: [] }
      }

      const defaultAgentId = this.defaultAgentIdFor(workspaceId)
      if (defaultAgentId === null) {
        return { message: userMessage, tasks: [] }
      }
      const defaultAgent = enabledAgents.find((agent) => agent.id === defaultAgentId)
      if (defaultAgent === undefined) {
        insertMessage({
          kind: 'system',
          authorType: 'system',
          authorId: null,
          content: '默认 Agent 已停用或不存在，消息未分派',
          taskId: null
        })
        return { message: userMessage, tasks: [] }
      }

      const promptText = text.trim()
      if (promptText === '' && attachments.length === 0) {
        return { message: userMessage, tasks: [] }
      }
      const basePrompt = promptText === '' ? '请查看附件' : promptText
      const prompt = `${basePrompt}${attachmentSection}`
      const title = Array.from(basePrompt).slice(0, 40).join('')
      const task = this.factory.create({
        workspaceId,
        agentId: defaultAgent.id,
        parentTaskId: null,
        taskType: 'code',
        title,
        prompt,
        deferEnqueue: true
      })
      insertMessage({
        kind: 'system',
        authorType: 'system',
        authorId: null,
        content: `未 @ 成员，已交给默认 Agent：${defaultAgent.name}`,
        taskId: null
      })
      this.enqueue(task.id)
      return { message: userMessage, tasks: [task] }
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
      const assignmentPrompt =
        parsed.sharedContext.length > 0
          ? `${parsed.sharedContext}\n\n${assignment.prompt}`
          : assignment.prompt
      const basePrompt =
        assignmentPrompt.trim() === '' && attachments.length > 0
          ? '请查看附件'
          : assignmentPrompt
      const prompt = `${basePrompt}${attachmentSection}`
      // 标题按 Unicode 码点截断，避免把 emoji 等代理对截成半个字符。
      const title = Array.from(basePrompt === '' ? '附件' : basePrompt)
        .slice(0, 40)
        .join('')

      // 先只落库任务与卡片消息，等系统分派消息也写入后再统一入队，
      // 避免任务启动产生的系统消息插到“已分派”之前。
      const task = this.factory.create({
        workspaceId,
        agentId: agent.id,
        parentTaskId: null,
        taskType: 'code',
        title,
        prompt,
        deferEnqueue: true
      })
      createdTasks.push(task)
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

/** 消息里是否出现了任何 `@token`；用于区分“没 @ 任何人”和“@ 了但没写内容”。 */
function hasAnyMention(text: string): boolean {
  return /(?:^|\s)@[\p{L}\p{N}_.+#-]+/u.test(text)
}
