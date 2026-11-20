/**
 * 任务创建工厂。
 *
 * 群聊时间线只从 `task-card` 消息渲染任务卡片；如果某个入口只插入 tasks 记录
 * 而不写卡片消息，该任务（以及它的日志、重试、取消按钮）在 UI 中不可见。
 * 所有任务入口（用户分派、自动测试、委派、冲突解决）统一走这里，保证：
 * - 任务与 task-card 消息成对落库；
 * - 同时广播 task-updated 与 message，群聊无需等待下一次刷新；
 * - 需要“父任务合并后才启动”的子任务可以延迟入队（deferEnqueue）。
 */
import { randomUUID } from 'node:crypto'
import type { ChatMessage, Task, TaskType } from '../../../shared/types'
import type { MessageRepo } from '../../db/message-repo'
import type { TaskRepo } from '../../db/task-repo'
import type { EventBus } from '../../events'

export interface TaskFactoryDeps {
  tasks: TaskRepo
  messages: MessageRepo
  events: EventBus
  /** 任务创建后交给 TaskManager 入队；延迟入队的任务不会调用该函数。 */
  enqueue: (taskId: string) => void
  newId?: () => string
  now?: () => Date
}

export interface CreateTaskInput {
  workspaceId: string
  agentId: string
  parentTaskId: string | null
  taskType: TaskType
  title: string
  prompt: string
  branch?: string | null
  worktreePath?: string | null
  baseRef?: string | null
  /**
   * 只落库、不立即入队。用于父任务完成后创建、但必须等父任务合并才能启动的
   * 委派任务；由 enqueueDeferredChildren 在父任务 merged 后统一入队。
   */
  deferEnqueue?: boolean
}

export class TaskFactory {
  private readonly tasks: TaskRepo
  private readonly messages: MessageRepo
  private readonly events: EventBus
  private readonly enqueue: (taskId: string) => void
  private readonly newId: () => string
  private readonly now: () => Date

  constructor(deps: TaskFactoryDeps) {
    this.tasks = deps.tasks
    this.messages = deps.messages
    this.events = deps.events
    this.enqueue = deps.enqueue
    this.newId = deps.newId ?? (() => randomUUID())
    this.now = deps.now ?? (() => new Date())
  }

  create(input: CreateTaskInput): Task {
    const createdAt = this.now().toISOString()
    const task: Task = {
      id: this.newId(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      parentTaskId: input.parentTaskId,
      taskType: input.taskType,
      title: input.title,
      prompt: input.prompt,
      branch: input.branch ?? null,
      worktreePath: input.worktreePath ?? null,
      baseRef: input.baseRef ?? null,
      status: 'queued',
      exitCode: null,
      summary: null,
      createdAt,
      startedAt: null,
      finishedAt: null
    }
    this.tasks.insert(task)

    // 任务与卡片消息使用相同时间戳，保证群聊顺序稳定；先广播任务状态，
    // 再广播卡片消息，渲染进程收到任一事件都能重建正确视图。
    const message: ChatMessage = {
      id: this.newId(),
      workspaceId: task.workspaceId,
      kind: 'task-card',
      authorType: 'system',
      authorId: null,
      content: task.title,
      taskId: task.id,
      createdAt,
      attachments: []
    }
    this.messages.insert(message)
    this.events.emit({ type: 'task-updated', task })
    this.events.emit({ type: 'message', message })

    if (input.deferEnqueue !== true) {
      this.enqueue(task.id)
    }
    return task
  }

  /**
   * 父任务合入 integration 后启动它的委派子任务。
   *
   * 只处理仍为 queued 的 code 子任务：委派任务创建时父任务尚未合并，
   * 过早启动会让子 Agent 基于缺少父任务改动的代码工作。返回本次入队的任务 id，
   * 便于调用方记录或测试。
   */
  enqueueDeferredChildren(parentTaskId: string): string[] {
    const parent = this.tasks.get(parentTaskId)
    if (parent === null) {
      return []
    }
    const children = this.tasks
      .listByWorkspace(parent.workspaceId)
      .filter(
        (task) =>
          task.parentTaskId === parentTaskId && task.taskType === 'code' && task.status === 'queued'
      )
      // listByWorkspace 按时间倒序；委派任务可能同时间戳创建，用 id 保持稳定顺序
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) {
          return a.createdAt < b.createdAt ? -1 : 1
        }
        return a.id < b.id ? -1 : 1
      })

    for (const child of children) {
      this.enqueue(child.id)
    }
    return children.map((child) => child.id)
  }
}
