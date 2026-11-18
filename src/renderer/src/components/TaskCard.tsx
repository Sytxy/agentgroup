// 任务卡片：展示状态、成员、分支、耗时、最近进度，并按状态提供操作按钮。
// 所有 IPC 调用都经由 ../api，卡片本身只负责收集用户意图与展示错误。
import { useState } from 'react'
import type { AgentConfig, Task, TaskStatus } from '../../../shared/types'
import {
  abandonTask,
  approveMerge,
  cancelTask,
  createResolveTask,
  getTaskLog,
  markTaskResolved,
  openTaskWorktree,
  prepareResolveWorktree,
  retryTask
} from '../api'

interface TaskCardProps {
  task: Task
  /** 任务所属成员；成员已被删除时省略。 */
  agent?: AgentConfig
  /** 最近几行进度；父组件已截断到约 5 行。 */
  progress: string[]
  /** 当前工作区的全部成员，用于冲突卡片选择解决 Agent。 */
  agents: AgentConfig[]
  /**
   * 该冲突任务当前仍在进行的解决任务（queued/preparing/running/done/merging）。
   * 解决任务与父任务共享同一 worktree，存在时父任务卡片不能提供
   * 指派/打开/标记/放弃操作，避免两个操作同时修改同一现场。
   */
  activeResolveTask?: Task
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: '排队中',
  preparing: '准备环境',
  running: '运行中',
  done: '已完成，等待合并',
  merging: '合并中',
  merged: '已合并',
  conflict: '合并冲突',
  awaiting_approval: '等待确认',
  failed: '失败',
  cancelled: '已取消',
  abandoned: '已放弃',
  interrupted: '已中断'
}

/** 取消只对尚未结束的任务有意义。 */
const CANCELLABLE: ReadonlySet<TaskStatus> = new Set(['queued', 'preparing', 'running'])

/** 可重试的任务：与 TaskManager.retry 允许的状态一致。 */
const RETRYABLE: ReadonlySet<TaskStatus> = new Set(['failed', 'cancelled', 'interrupted'])

/** 仍在执行的任务即使暂无输出，也保留进度区，让用户知道它在工作。 */
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'preparing',
  'running',
  'merging'
])

export default function TaskCard({
  task,
  agent,
  progress,
  agents,
  activeResolveTask
}: TaskCardProps): React.JSX.Element {
  const [resolveAgentId, setResolveAgentId] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const [log, setLog] = useState<string | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const enabledAgents = agents.filter((item) => item.enabled)
  const recentProgress = progress.slice(-5)
  // 终态任务通常没有进度缓存；空白的“暂无进度”只会把工单撑高，直接收起。
  const showProgress = recentProgress.length > 0 || ACTIVE_STATUSES.has(task.status)
  // 冲突现场正被解决任务占用：隐藏所有会并发操作同一 worktree 的按钮
  const resolveInProgress = task.status === 'conflict' && activeResolveTask !== undefined

  /** 统一处理操作按钮：执行期间禁用其他按钮，失败时展示可读错误。 */
  const runAction = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    setPendingAction(name)
    setActionError(null)
    try {
      await action()
    } catch (cause) {
      setActionError(errorMessage(cause))
    } finally {
      setPendingAction(null)
    }
  }

  // 日志按需加载：首次展开时请求，收起后保留已加载内容，避免重复读取。
  const handleToggleLog = async (): Promise<void> => {
    if (logOpen) {
      setLogOpen(false)
      return
    }
    setLogOpen(true)
    if (log !== null || logLoading) {
      return
    }
    setLogLoading(true)
    setLogError(null)
    try {
      setLog(await getTaskLog(task.id))
    } catch (cause) {
      setLogError(errorMessage(cause))
    } finally {
      setLogLoading(false)
    }
  }

  const handleOpenWorktree = (): void => {
    void runAction('open-worktree', async () => {
      // 目录可能已随现场清理被删除，先确保 worktree 存在再打开
      await prepareResolveWorktree(task.id)
      await openTaskWorktree(task.id)
    })
  }

  return (
    <section className="task-card" data-testid="task-card" data-status={task.status}>
      <header className="task-card-header">
        <div className="task-card-heading">
          <span
            className="task-card-avatar"
            data-preset={agent?.preset ?? 'custom'}
            aria-hidden="true"
          >
            {agentInitial(agent?.name ?? '?')}
          </span>
          <div className="task-card-heading-text">
            <span className="task-card-agent" data-testid="task-card-agent">
              {agent?.name ?? '已删除的成员'}
            </span>
            <span className="task-card-title">{task.title}</span>
          </div>
        </div>
        <span className="task-card-status" data-testid="task-card-status">
          {STATUS_LABELS[task.status]}
        </span>
      </header>

      <div className="task-card-meta">
        <span data-testid="task-branch">分支：{task.branch ?? '—'}</span>
        <span data-testid="task-elapsed">耗时 {formatElapsed(task)}</span>
      </div>

      {task.summary !== null && task.summary !== '' && (
        <p className="task-card-summary">{task.summary}</p>
      )}

      {resolveInProgress && (
        <p className="task-card-note" data-testid="resolve-active">
          解决任务进行中
        </p>
      )}

      {showProgress && (
        <div className="task-card-progress">
          <span className="task-card-section-label">最近进度</span>
          {recentProgress.length === 0 ? (
            <p className="task-card-empty">等待输出…</p>
          ) : (
            <ul className="task-card-progress-lines" data-testid="task-progress">
              {recentProgress.map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {actionError !== null && (
        <p className="task-card-error" role="alert">
          {actionError}
        </p>
      )}

      <div className="task-card-actions">
        {CANCELLABLE.has(task.status) && (
          <button
            type="button"
            className="task-card-button"
            disabled={pendingAction !== null}
            onClick={() => void runAction('cancel', () => cancelTask(task.id))}
          >
            取消
          </button>
        )}

        {task.status === 'conflict' && !resolveInProgress && (
          <>
            <label className="task-card-resolve">
              解决 Agent
              <select
                aria-label="选择解决 Agent"
                value={resolveAgentId}
                onChange={(event) => setResolveAgentId(event.target.value)}
              >
                <option value="">选择 Agent</option>
                {enabledAgents.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="task-card-button task-card-button-primary"
              disabled={resolveAgentId === '' || pendingAction !== null}
              onClick={() =>
                void runAction('create-resolve', () =>
                  createResolveTask(task.id, resolveAgentId)
                )
              }
            >
              指派 Agent 解决
            </button>
            <button
              type="button"
              className="task-card-button"
              disabled={pendingAction !== null}
              onClick={handleOpenWorktree}
            >
              打开 worktree
            </button>
            <button
              type="button"
              className="task-card-button"
              disabled={pendingAction !== null}
              onClick={() => void runAction('mark-resolved', () => markTaskResolved(task.id))}
            >
              标记已解决并重新合并
            </button>
          </>
        )}

        {task.status === 'awaiting_approval' && (
          <button
            type="button"
            className="task-card-button task-card-button-primary"
            disabled={pendingAction !== null}
            onClick={() => void runAction('approve-merge', () => approveMerge(task.id))}
          >
            继续合并
          </button>
        )}

        {RETRYABLE.has(task.status) && (
          <button
            type="button"
            className="task-card-button task-card-button-primary"
            disabled={pendingAction !== null}
            onClick={() => void runAction('retry', () => retryTask(task.id))}
          >
            重试
          </button>
        )}

        {!resolveInProgress &&
          (task.status === 'conflict' ||
            task.status === 'awaiting_approval' ||
            RETRYABLE.has(task.status)) && (
            <button
              type="button"
              className="task-card-button task-card-button-danger"
              disabled={pendingAction !== null}
              onClick={() => void runAction('abandon', () => abandonTask(task.id))}
            >
              放弃
            </button>
          )}

        <button
          type="button"
          className="task-card-button task-card-log-toggle"
          onClick={() => void handleToggleLog()}
        >
          {logOpen ? '收起日志' : '展开日志'}
        </button>
      </div>

      {logOpen && (
        <div className="task-card-log">
          {logLoading && <p className="task-card-empty">正在读取日志…</p>}
          {logError !== null && (
            <p className="task-card-error" role="alert">
              {logError}
            </p>
          )}
          {!logLoading && logError === null && (
            <pre className="task-card-log-content" data-testid="task-log">
              {log === null || log === '' ? '暂无日志' : log}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * 任务耗时：从开始时间到结束时间；仍在运行时算到当前时刻。
 * 未开始的任务显示占位符，避免把排队时间误算进执行时间。
 */
function formatElapsed(task: Task): string {
  if (task.startedAt === null) {
    return '—'
  }
  // 中断/取消等终态可能没有结束时间；继续按当前时刻计算会显示一个不断增长的值。
  if (task.finishedAt === null && !ACTIVE_STATUSES.has(task.status)) {
    return '—'
  }
  const started = Date.parse(task.startedAt)
  const ended = task.finishedAt === null ? Date.now() : Date.parse(task.finishedAt)
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) {
    return '0s'
  }
  const totalSeconds = Math.floor((ended - started) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 头像用名称首字符，中文取第一个字，空名用问号。 */
function agentInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}
