// 群聊时间线：按消息类型渲染用户、Agent、系统与任务卡片四类消息。
// 任务卡片消息在任务存在时渲染带操作的 TaskCard，否则退回消息文本。
import { useEffect, useRef } from 'react'
import type { AgentConfig, ChatMessage, Task } from '../../../shared/types'
import TaskCard from './TaskCard'

interface ChatTimelineProps {
  messages: ChatMessage[]
  tasks: Task[]
  agents: AgentConfig[]
  /** 任务 id -> 最近几行进度，由 App 从 task-progress 事件累积。 */
  progress?: Record<string, string[]>
}

export default function ChatTimeline({
  messages,
  tasks,
  agents,
  progress = {}
}: ChatTimelineProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]))
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  const tasksById = new Map(tasks.map((task) => [task.id, task]))

  // 新消息到达时滚到底部，保证用户始终看到最新一条
  useEffect(() => {
    const list = listRef.current
    if (list !== null) {
      list.scrollTop = list.scrollHeight
    }
  }, [messages])

  return (
    <div className="chat-timeline" data-testid="chat-timeline">
      <h2 className="panel-title">群聊</h2>
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
              return (
                <article
                  key={message.id}
                  className="message message-task-card"
                  data-testid="message-task-card"
                >
                  {task !== undefined ? (
                    <TaskCard
                      task={task}
                      agent={agentsById.get(task.agentId)}
                      progress={progress[task.id] ?? []}
                      agents={agents}
                    />
                  ) : (
                    <p className="message-content">{message.content}</p>
                  )}
                </article>
              )
            }

            if (message.kind === 'system') {
              return (
                <article
                  key={message.id}
                  className="message message-system"
                  data-testid="message-system"
                >
                  <p className="message-content">{message.content}</p>
                </article>
              )
            }

            if (message.kind === 'agent') {
              // Agent 可能已被删除：优先显示名称，其次保留历史 id 便于追溯
              const authorName =
                message.authorId === null
                  ? '已删除的成员'
                  : (agentNames.get(message.authorId) ?? message.authorId)
              return (
                <article
                  key={message.id}
                  className="message message-agent"
                  data-testid="message-agent"
                >
                  <span className="message-author">{authorName}</span>
                  <p className="message-content">{message.content}</p>
                </article>
              )
            }

            return (
              <article
                key={message.id}
                className="message message-user"
                data-testid="message-user"
              >
                <span className="message-author">我</span>
                <p className="message-content">{message.content}</p>
              </article>
            )
          })
        )}
      </div>
    </div>
  )
}
