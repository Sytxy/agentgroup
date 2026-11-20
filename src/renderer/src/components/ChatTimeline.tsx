// 群聊时间线：按消息类型渲染用户、Agent、系统与任务卡片四类消息。
// 任务的短状态/进度由任务卡片承载；Agent 的长回复渲染成带头像、名称和时间的
// 聊天消息，并把对应任务卡紧凑地收在回复下方，避免群聊被状态胶囊和独立卡片切碎。
import { useEffect, useRef } from 'react'
import type { AgentConfig, ChatMessage, Task } from '../../../shared/types'
import MessageContent from './MessageContent'
import TaskCard from './TaskCard'

interface ChatTimelineProps {
  messages: ChatMessage[]
  tasks: Task[]
  agents: AgentConfig[]
  /** 用户消息的署名；默认“我”，可在设置里修改。 */
  userName?: string
  /** 任务 id -> 最近几行进度，由 App 从 task-progress 事件累积。 */
  progress?: Record<string, string[]>
  /**
   * 父任务 id -> 仍在占用该冲突现场的解决任务。
   * 冲突卡片据此隐藏会并发操作同一 worktree 的按钮。
   */
  activeResolveByParent?: Map<string, Task>
}

export default function ChatTimeline({
  messages,
  tasks,
  agents,
  userName = '我',
  progress = {},
  activeResolveByParent = new Map<string, Task>()
}: ChatTimelineProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]))
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  const tasksById = new Map(tasks.map((task) => [task.id, task]))

  // 每个任务最后一条 Agent 回复 id：任务卡只内嵌在这条回复下面，避免重复展示。
  const lastReplyByTask = new Map<string, string>()
  for (const message of messages) {
    if (message.taskId !== null && isAgentReply(message)) {
      lastReplyByTask.set(message.taskId, message.id)
    }
  }

  // 新消息到达时滚到底部，保证用户始终看到最新一条
  useEffect(() => {
    const list = listRef.current
    if (list !== null) {
      list.scrollTop = list.scrollHeight
    }
  }, [messages])

  return (
    <div className="chat-timeline" data-testid="chat-timeline">
      <div className="panel-heading">
        <h2 className="panel-title">群聊</h2>
        <span className="panel-count">{messages.length} 条消息</span>
      </div>
      <div
        className="timeline-list"
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="群聊消息"
      >
        {messages.length === 0 ? (
          <p className="panel-empty">还没有消息，@ 成员开始协作。</p>
        ) : (
          messages.map((message) => {
            const task = message.taskId === null ? undefined : tasksById.get(message.taskId)

            if (message.kind === 'task-card') {
              // 已有 Agent 回复的任务，任务卡跟随回复渲染；这里跳过独立卡片
              if (message.taskId !== null && lastReplyByTask.has(message.taskId)) {
                return null
              }
              if (task === undefined) {
                return (
                  <article
                    key={message.id}
                    className="message message-task-card"
                    data-testid="message-task-card"
                  >
                    <p className="message-content">{message.content}</p>
                  </article>
                )
              }

              // 还没有最终回复的任务也用聊天消息呈现，避免运行中又出现一张大卡片
              const taskAgent = agentsById.get(task.agentId)
              return (
                <article
                  key={message.id}
                  className="message message-agent message-task-card"
                  data-testid="message-task-card"
                >
                  <div className="message-head">
                    <span
                      className="message-avatar"
                      data-preset={taskAgent?.preset ?? 'custom'}
                      aria-hidden="true"
                    >
                      {agentInitial(taskAgent?.name ?? '?')}
                    </span>
                    <span className="message-author">
                      {taskAgent?.name ?? '已删除的成员'}
                    </span>
                    {taskAgent !== undefined && (
                      <span className="message-badge">{presetLabel(taskAgent)}</span>
                    )}
                    <span className="message-time">
                      {formatMessageTime(message.createdAt)}
                    </span>
                  </div>
                  <MessageContent text={taskStatusText(task)} />
                  <TaskCard
                    task={task}
                    agent={taskAgent}
                    progress={progress[task.id] ?? []}
                    agents={agents}
                    activeResolveTask={activeResolveByParent.get(task.id)}
                    compact
                  />
                </article>
              )
            }

            if (isAgentReply(message)) {
              const authorId = message.authorId ?? task?.agentId ?? null
              const authorAgent =
                authorId === null ? undefined : agentsById.get(authorId)
              const authorName =
                authorId === null
                  ? '已删除的成员'
                  : (agentNames.get(authorId) ?? authorId)
              const inlineTask =
                task !== undefined &&
                message.taskId !== null &&
                lastReplyByTask.get(message.taskId) === message.id
                  ? task
                  : undefined

              return (
                <article
                  key={message.id}
                  className="message message-agent"
                  data-testid="message-agent"
                >
                  <div className="message-head">
                    <span
                      className="message-avatar"
                      data-preset={authorAgent?.preset ?? 'custom'}
                      aria-hidden="true"
                    >
                      {agentInitial(authorAgent?.name ?? authorName)}
                    </span>
                    <span className="message-author">{authorName}</span>
                    {authorAgent !== undefined && (
                      <span className="message-badge">{presetLabel(authorAgent)}</span>
                    )}
                    <span className="message-time">
                      {formatMessageTime(message.createdAt)}
                    </span>
                  </div>
                  <MessageContent text={message.content} />
                  {inlineTask !== undefined && (
                    <TaskCard
                      task={inlineTask}
                      agent={authorAgent}
                      progress={progress[inlineTask.id] ?? []}
                      agents={agents}
                      activeResolveTask={activeResolveByParent.get(inlineTask.id)}
                      compact
                    />
                  )}
                </article>
              )
            }

            if (message.kind === 'system') {
              // 任务运行中的短状态和进度由任务卡片展示，分派结果也由用户消息与
              // Agent 回复体现，不再往群聊刷重复胶囊
              if (
                message.taskId !== null ||
                isRoutineSystemNotice(message.content)
              ) {
                return null
              }
              const long = isLongSystemMessage(message.content)
              return (
                <article
                  key={message.id}
                  className={
                    long
                      ? 'message message-system message-system-long'
                      : 'message message-system'
                  }
                  data-testid="message-system"
                >
                  {long ? (
                    <MessageContent text={message.content} />
                  ) : (
                    <p className="message-content">{message.content}</p>
                  )}
                </article>
              )
            }

            return (
              <article
                key={message.id}
                className="message message-user"
                data-testid="message-user"
              >
                <div className="message-head">
                  <span className="message-avatar message-avatar-user" aria-hidden="true">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5" />
                    </svg>
                  </span>
                  <span className="message-author">{userName}</span>
                  <span className="message-time">
                    {formatMessageTime(message.createdAt)}
                  </span>
                </div>
                <MessageContent text={message.content} />
              </article>
            )
          })
        )}
      </div>
    </div>
  )
}

/** 头像用名称首字符，中文取第一个字，空名用问号。 */
function agentInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}

/**
 * 多行或较长的系统消息是 Agent 的实际输出，不是简短状态通知。
 * 如果继续套胶囊样式，长文本会被撑成一个巨大的圆角框；这类内容改为普通段落展示。
 */
function isLongSystemMessage(content: string): boolean {
  return content.length > 160 || content.split('\n').length > 3
}

/** Agent 消息是唯一会进入群聊的回复来源；任务进度由任务卡片的进度区展示。 */
function isAgentReply(message: ChatMessage): boolean {
  return message.kind === 'agent'
}

/** “已分派 N 个任务”只是分派回执，任务本身和 Agent 回复已经足够表达。 */
function isRoutineSystemNotice(content: string): boolean {
  return /^已分派 \d+ 个任务/.test(content)
}

function presetLabel(agent: AgentConfig): string {
  return agent.preset === 'claude'
    ? 'Claude Code'
    : agent.preset === 'codex'
      ? 'Codex'
      : '自定义'
}

/** 没有最终 Agent 回复时，任务行的正文显示当前状态或已有摘要。 */
function taskStatusText(task: Task): string {
  if (task.summary !== null && task.summary !== '') {
    return task.summary
  }
  switch (task.status) {
    case 'queued':
      return '等待执行…'
    case 'preparing':
      return '正在准备环境…'
    case 'running':
      return '正在执行…'
    case 'merging':
      return '正在合并…'
    case 'merged':
      return '无代码改动'
    case 'done':
      return '任务完成，等待合并'
    case 'awaiting_approval':
      return '等待确认合并'
    case 'conflict':
      return '等待解决合并冲突'
    case 'failed':
      return '任务失败'
    case 'cancelled':
      return '任务已取消'
    case 'abandoned':
      return '任务已放弃'
    case 'interrupted':
      return '任务已中断'
    default:
      return '任务状态更新'
  }
}

function formatMessageTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
