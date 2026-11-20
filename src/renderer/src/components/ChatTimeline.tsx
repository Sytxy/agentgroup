// 群聊时间线：按消息类型渲染用户、Agent、系统与任务卡片四类消息。
// 任务的短状态/进度由任务卡片承载；Agent 的长回复渲染成带头像、名称和时间的
// 聊天消息，并把对应任务卡紧凑地收在回复下方，避免群聊被状态胶囊和独立卡片切碎。
import { useEffect, useRef, useState } from 'react'
import type { AgentConfig, ChatMessage, Task } from '../../../shared/types'
import { openAttachment } from '../api'
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
  /** 点击 Agent 消息的“回复”时，把 @成员 预填到输入框。 */
  onReply?: (agentName: string) => void
  /** 点击用户消息的“重新编辑”时，把原文放回输入框。 */
  onEditMessage?: (text: string) => void
}

export default function ChatTimeline({
  messages,
  tasks,
  agents,
  userName = '我',
  progress = {},
  activeResolveByParent = new Map<string, Task>(),
  onReply,
  onEditMessage
}: ChatTimelineProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]))
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  const tasksById = new Map(tasks.map((task) => [task.id, task]))

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) {
        clearTimeout(copyTimer.current)
      }
    }
  }, [])

  const handleCopy = (message: ChatMessage): void => {
    if (navigator.clipboard === undefined) {
      return
    }
    void navigator.clipboard
      .writeText(message.content)
      .then(() => {
        setCopiedId(message.id)
        if (copyTimer.current !== null) {
          clearTimeout(copyTimer.current)
        }
        copyTimer.current = setTimeout(() => setCopiedId(null), 1500)
      })
      .catch(() => {
        // 剪贴板不可用时保持原按钮状态，不打断聊天
      })
  }

  // 每个任务最后一条 Agent 回复 id：任务卡只内嵌在这条回复下面，避免重复展示。
  const lastReplyByTask = new Map<string, string>()
  for (const message of messages) {
    if (message.taskId !== null && isAgentReply(message)) {
      lastReplyByTask.set(message.taskId, message.id)
    }
  }

  // 任务首次出现前的最后一条用户消息，用作 Agent 回复上方的引用。
  const quotedUserByTask = new Map<string, ChatMessage>()
  let lastUserMessage: ChatMessage | undefined
  for (const message of messages) {
    if (message.kind === 'user') {
      lastUserMessage = message
      continue
    }
    if (
      message.kind === 'task-card' &&
      message.taskId !== null &&
      lastUserMessage !== undefined &&
      !quotedUserByTask.has(message.taskId)
    ) {
      quotedUserByTask.set(message.taskId, lastUserMessage)
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
              const blockingTask =
                task.status === 'queued'
                  ? tasks.find(
                      (candidate) =>
                        candidate.id !== task.id &&
                        candidate.agentId === task.agentId &&
                        (candidate.status === 'running' ||
                          candidate.status === 'preparing' ||
                          candidate.status === 'merging')
                    )
                  : undefined
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
                    <span className="message-context">你的 agent</span>
                    {taskAgent !== undefined && (
                      <span className="message-badge">{presetLabel(taskAgent)}</span>
                    )}
                    <span className="message-time">
                      {formatMessageTime(message.createdAt)}
                    </span>
                  </div>
                  <TaskStatusLine
                    task={task}
                    blockingAgentName={
                      blockingTask === undefined
                        ? undefined
                        : (agentsById.get(blockingTask.agentId)?.name ?? '当前成员')
                    }
                  />
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
              const quotedUser =
                inlineTask === undefined ? undefined : quotedUserByTask.get(inlineTask.id)

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
                    <span className="message-context">你的 agent</span>
                    {authorAgent !== undefined && (
                      <span className="message-badge">{presetLabel(authorAgent)}</span>
                    )}
                    <span className="message-time">
                      {formatMessageTime(message.createdAt)}
                    </span>
                    <div className="message-head-actions">
                      {onReply !== undefined && (
                        <button
                          type="button"
                          className="message-reply-action"
                          onClick={() => onReply(authorName)}
                        >
                          ↩ 回复
                        </button>
                      )}
                      <button
                        type="button"
                        className="message-action"
                        aria-label="复制消息"
                        onClick={() => handleCopy(message)}
                      >
                        <CopyIcon />
                        <span>{copiedId === message.id ? '已复制' : '复制'}</span>
                      </button>
                    </div>
                  </div>

                  {quotedUser !== undefined && (
                    <div className="message-reply-quote">
                      <span className="message-reply-author">{userName}:</span>{' '}
                      <span className="message-reply-text">{quotedUser.content}</span>
                    </div>
                  )}

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
                <div className="message-head message-head-user">
                  <span className="message-author">{userName}</span>
                  <span className="message-user-badge">你</span>
                  <span className="message-time">
                    {formatMessageTime(message.createdAt)}
                  </span>
                  <span className="message-avatar message-avatar-user" aria-hidden="true">
                    {agentInitial(userName)}
                  </span>
                </div>
                <div className="message-user-bubble">
                  <MessageContent text={message.content} />
                  {message.attachments !== undefined && message.attachments.length > 0 && (
                    <div className="message-attachments">
                      {message.attachments.map((attachment) => {
                        const image = attachment.mimeType.startsWith('image/')
                        return (
                          <button
                            key={attachment.id}
                            type="button"
                            className={
                              image
                                ? 'message-attachment message-attachment-image'
                                : 'message-attachment message-attachment-file'
                            }
                            aria-label={`打开附件 ${attachment.name}`}
                            title={attachment.name}
                            onClick={() => {
                              void openAttachment(attachment.path).catch(() => {
                                // 文件被移动/删除时保持聊天可用，不弹额外错误
                              })
                            }}
                          >
                            {image ? (
                              <img src={attachment.url} alt={attachment.name} />
                            ) : (
                              <>
                                <AttachmentIcon />
                                <span className="message-attachment-name">
                                  {attachment.name}
                                </span>
                                <span className="message-attachment-size">
                                  {formatBytes(attachment.size)}
                                </span>
                              </>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
                <div className="message-actions message-actions-user">
                  <button
                    type="button"
                    className="message-action"
                    aria-label="复制消息"
                    onClick={() => handleCopy(message)}
                  >
                    <CopyIcon />
                    <span>{copiedId === message.id ? '已复制' : '复制'}</span>
                  </button>
                  {onEditMessage !== undefined && (
                    <button
                      type="button"
                      className="message-action"
                      aria-label="重新编辑消息"
                      onClick={() => onEditMessage(message.content)}
                    >
                      <EditIcon />
                      <span>重新编辑</span>
                    </button>
                  )}
                </div>
              </article>
            )
          })
        )}
      </div>
    </div>
  )
}

/** 复制消息的小图标。 */
function CopyIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  )
}

/** 重新编辑的小图标。 */
function EditIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  )
}

/** 文件附件的小图标。 */
function AttachmentIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </svg>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
function TaskStatusLine({
  task,
  blockingAgentName
}: {
  task: Task
  blockingAgentName?: string
}): React.JSX.Element {
  const live =
    task.status === 'running' || task.status === 'preparing' || task.status === 'merging'
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!live) {
      return
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live, task.startedAt])

  return (
    <div className="task-status-line">
      {live && <span className="task-active-dot" aria-hidden="true" />}
      <MessageContent text={taskStatusText(task, now, blockingAgentName)} />
    </div>
  )
}

function taskStatusText(
  task: Task,
  now: number = Date.now(),
  blockingAgentName?: string
): string {
  if (task.summary !== null && task.summary !== '') {
    return task.summary
  }
  const elapsed = elapsedText(task, now)
  switch (task.status) {
    case 'queued':
      return blockingAgentName === undefined
        ? '排队中…'
        : `排队中… 等待 ${blockingAgentName} 完成当前任务`
    case 'preparing':
      return `正在准备环境…${elapsed}`
    case 'running':
      return `正在执行…${elapsed}`
    case 'merging':
      return `正在合并…${elapsed}`
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

function elapsedText(task: Task, now: number): string {
  if (task.startedAt === null) {
    return ''
  }
  const started = Date.parse(task.startedAt)
  if (!Number.isFinite(started)) {
    return ''
  }
  const seconds = Math.max(0, Math.floor((now - started) / 1000))
  if (seconds < 60) {
    return ` 已运行 ${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return ` 已运行 ${minutes}m ${seconds % 60}s`
  }
  const hours = Math.floor(minutes / 60)
  return ` 已运行 ${hours}h ${minutes % 60}m`
}

function formatMessageTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
