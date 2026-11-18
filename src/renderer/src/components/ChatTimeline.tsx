// 群聊时间线：按消息类型渲染用户、Agent、系统与任务卡片四类消息。
// 任务卡片从 tasks 中查找对应任务展示当前状态，不做任务操作（属于成员面板/任务面板的职责）。
import { useEffect, useRef } from 'react'
import type { AgentConfig, ChatMessage, Task } from '../../../shared/types'

interface ChatTimelineProps {
  messages: ChatMessage[]
  tasks: Task[]
  agents: AgentConfig[]
}

export default function ChatTimeline({
  messages,
  tasks,
  agents
}: ChatTimelineProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]))
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
                  <p className="message-content">{message.content}</p>
                  {task !== undefined && (
                    <span className="message-task-status" data-testid="task-card-status">
                      任务状态：{task.status}
                    </span>
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
