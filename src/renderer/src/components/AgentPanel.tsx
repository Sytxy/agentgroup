// Agent 成员面板：成员列表、运行状态点、添加与删除。
// 忙碌状态由任务列表推导（preparing/running），删除成员会真正删除记录，
// 历史任务与消息只保存 id，不受影响。
import { useState } from 'react'
import type { AgentConfig, Task } from '../../../shared/types'
import { removeAgent } from '../api'
import AddAgentDialog from './AddAgentDialog'

interface AgentPanelProps {
  workspaceId: string
  agents: AgentConfig[]
  tasks: Task[]
  /** 添加/删除成功后由父组件重新拉取成员列表。 */
  onChanged: () => void | Promise<void>
}

export default function AgentPanel({
  workspaceId,
  agents,
  tasks,
  onChanged
}: AgentPanelProps): React.JSX.Element {
  const [addOpen, setAddOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  // 同一 Agent 同一时间只运行一个任务；存在执行中的任务即视为忙碌
  const busyAgentIds = new Set(
    tasks
      .filter((task) => task.status === 'preparing' || task.status === 'running')
      .map((task) => task.agentId)
  )

  const handleRemove = async (agent: AgentConfig): Promise<void> => {
    // 删除不可撤销：先让用户确认；历史任务记录仍会保留
    const confirmed = window.confirm(
      `确定删除成员「${agent.name}」吗？历史任务与消息会保留，但不能再向该成员分派任务。`
    )
    if (!confirmed) {
      return
    }
    setRemovingId(agent.id)
    setError(null)
    try {
      await removeAgent(agent.id)
      await onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <aside className="agent-column" data-testid="agent-panel">
      <div className="agent-panel-header">
        <h2 className="panel-title">Agent 成员</h2>
        <button
          type="button"
          className="agent-add-button"
          onClick={() => setAddOpen(true)}
        >
          + 添加 Agent
        </button>
      </div>

      {agents.length === 0 ? (
        <p className="panel-empty">还没有成员，先添加一个 Agent 再开始协作。</p>
      ) : (
        <ul className="agent-list">
          {agents.map((agent) => {
            const busy = busyAgentIds.has(agent.id)
            const stateLabel = !agent.enabled ? '已停用' : busy ? '运行中' : '空闲'
            return (
              <li key={agent.id} className="agent-item" data-testid={`agent-${agent.id}`}>
                <span
                  className={
                    agent.enabled
                      ? busy
                        ? 'agent-dot agent-dot-busy'
                        : 'agent-dot agent-dot-idle'
                      : 'agent-dot agent-dot-disabled'
                  }
                  aria-label={stateLabel}
                  title={stateLabel}
                />
                <span className="agent-name">{agent.name}</span>
                <span className="agent-state">{stateLabel}</span>
                <button
                  type="button"
                  className="agent-remove-button"
                  aria-label={`删除 ${agent.name}`}
                  disabled={removingId === agent.id}
                  onClick={() => void handleRemove(agent)}
                >
                  删除
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {error !== null && (
        <p className="agent-panel-error" role="alert">
          {error}
        </p>
      )}

      <p className="panel-meta">已加载 {agents.length} 位成员</p>

      {addOpen && (
        <AddAgentDialog
          workspaceId={workspaceId}
          onAdded={() => onChanged()}
          onClose={() => setAddOpen(false)}
        />
      )}
    </aside>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
