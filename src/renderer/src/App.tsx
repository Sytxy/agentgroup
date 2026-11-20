// 应用外壳：加载工作区列表，选中后拉起初始数据，并渲染三栏布局。
// 初始状态一律通过 IPC 主动拉取，不依赖事件推送（事件可能在订阅前已经发出）。
import { useCallback, useEffect, useState } from 'react'
import type {
  AgentConfig,
  ChatMessage,
  Task,
  TaskStatus,
  VerificationStatus,
  Workspace
} from '../../shared/types'
import {
  getWorkspaceDiff,
  listAgents,
  listMessages,
  listTasks,
  listWorkspaces,
  sendChatMessage,
  type DiffStat
} from './api'
import AgentPanel from './components/AgentPanel'
import ChatTimeline from './components/ChatTimeline'
import Composer from './components/Composer'
import SettingsDialog from './components/SettingsDialog'
import Sidebar from './components/Sidebar'
import WorkspaceSetup from './components/WorkspaceSetup'

const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  unknown: '未验证',
  passed: '测试通过',
  failed: '测试失败'
}

/** 本地显示名：只影响群聊里“我”的署名，不写入工作区数据库。 */
const USER_NAME_KEY = 'agentgroup.userName'
const DEFAULT_USER_NAME = '我'

function readUserName(): string {
  try {
    return window.localStorage.getItem(USER_NAME_KEY)?.trim() || DEFAULT_USER_NAME
  } catch {
    return DEFAULT_USER_NAME
  }
}

/** 任务进入这些状态后不再产生进度，可以清理进度缓存。 */
const PROGRESS_TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'done',
  'merging',
  'merged',
  'conflict',
  'awaiting_approval',
  'failed',
  'cancelled',
  'abandoned',
  'interrupted'
])

/**
 * 主进程会据此改写 lastVerification 的测试任务状态，需与
 * TaskManager.finish / MergeCoordinator 的验证状态规则保持一致：
 * done/merged 为通过，其余为失败；merging/awaiting_approval 尚未出验证结果。
 */
const VERIFICATION_SETTLED_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'done',
  'merged',
  'failed',
  'conflict',
  'cancelled',
  'abandoned',
  'interrupted'
])

/**
 * 仍在占用冲突现场的解决任务状态，需与 MergeCoordinator 的
 * ACTIVE_RESOLVE_CHILD_STATUSES 保持一致。
 */
const ACTIVE_RESOLVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'preparing',
  'running',
  'done',
  'merging'
])

export default function App(): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffStat | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  // 数据加载失败（尤其 diff 失败）后允许用户重试；递增该值重新触发加载 effect
  const [reloadToken, setReloadToken] = useState(0)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<AgentConfig[]>([])
  // task-progress 只保留最近几行，任务进入终态后删除，避免长时间运行时无限增长
  const [progress, setProgress] = useState<Record<string, string[]>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 已有项目时从侧边栏打开“新建项目”整页表单
  const [setupOpen, setSetupOpen] = useState(false)
  // 成员面板默认收起，把宽度让给聊天区；点顶部“成员”再展开。
  const [agentPanelOpen, setAgentPanelOpen] = useState(false)
  const [userName, setUserName] = useState(readUserName)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  // 点击 Agent 消息的“回复”后，向输入框预填 @成员
  const [composerSeed, setComposerSeed] = useState<{
    text: string
    nonce: number
  } | null>(null)

  // 挂载时加载工作区列表，存在工作区则默认选中第一个
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await listWorkspaces()
        if (cancelled) {
          return
        }
        setWorkspaces(list)
        setSelectedId(list[0]?.id ?? null)
      } catch (cause) {
        if (!cancelled) {
          setLoadError(errorMessage(cause))
        }
      } finally {
        if (!cancelled) {
          setLoaded(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 切换工作区时先清空旧数据，避免串台；重试加载不经过这里，界面不会闪空
  useEffect(() => {
    setMessages([])
    setTasks([])
    setAgents([])
    setDiff(null)
    setDiffError(null)
    setProgress({})
    setCopyNotice(null)
    setDetailError(null)
  }, [selectedId])

  // 选中工作区后加载其初始数据。四项请求彼此独立：差异统计失败（例如集成分支
  // 暂不可用、目标分支被删除）只影响顶部展示，不能连消息、任务和成员一起丢掉。
  useEffect(() => {
    if (selectedId === null) {
      return
    }
    let cancelled = false
    void (async () => {
      const [messagesResult, tasksResult, agentsResult, diffResult] = await Promise.allSettled([
        listMessages(selectedId),
        listTasks(selectedId),
        listAgents(selectedId),
        getWorkspaceDiff(selectedId)
      ])
      if (cancelled) {
        return
      }

      const failures: string[] = []

      if (messagesResult.status === 'fulfilled') {
        const nextMessages = messagesResult.value
        // 列表响应只是请求发出时的快照。加载期间可能已有实时事件写入 state，
        // 直接覆盖会丢消息，因此按 id 合并：保留历史顺序，把加载期间到达、
        // 快照中没有的消息追加到末尾。
        setMessages((current) => {
          const historyIds = new Set(nextMessages.map((message) => message.id))
          return [...nextMessages, ...current.filter((message) => !historyIds.has(message.id))]
        })
      } else {
        failures.push(`消息：${errorMessage(messagesResult.reason)}`)
      }

      if (tasksResult.status === 'fulfilled') {
        const nextTasks = tasksResult.value
        // 同 id 时保留 state 中的版本——它来自请求期间到达的 task-updated，
        // 一定是比快照更新的观测；响应只补充 state 中尚不存在的任务。
        setTasks((current) => {
          const responseIds = new Set(nextTasks.map((task) => task.id))
          return [...nextTasks, ...current.filter((task) => !responseIds.has(task.id))]
        })
      } else {
        failures.push(`任务：${errorMessage(tasksResult.reason)}`)
      }

      if (agentsResult.status === 'fulfilled') {
        const nextAgents = agentsResult.value
        // 成员没有推送事件，列表响应是权威快照；只保留响应中缺失的成员
        // （成员可能在加载期间被添加）。
        setAgents((current) => {
          const responseIds = new Set(nextAgents.map((agent) => agent.id))
          return [...nextAgents, ...current.filter((agent) => !responseIds.has(agent.id))]
        })
      } else {
        failures.push(`成员：${errorMessage(agentsResult.reason)}`)
      }

      if (diffResult.status === 'fulfilled') {
        setDiff(diffResult.value)
        setDiffError(null)
      } else {
        setDiff(null)
        setDiffError(errorMessage(diffResult.reason))
      }

      setDetailError(failures.length > 0 ? failures.join('；') : null)
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId, reloadToken])

  // 订阅主进程推送。只合并当前工作区的事件并按 id 去重：
  // 发送响应与推送事件可能同时到达，重复合并会让同一条消息出现两次。
  // 切换工作区时重新订阅，避免把上一个工作区的事件写进当前状态。
  useEffect(() => {
    if (selectedId === null) {
      return
    }
    return window.api.onEvent((event) => {
      if (event.type === 'message') {
        const message = event.message
        if (message.workspaceId !== selectedId) {
          return
        }
        setMessages((current) =>
          current.some((item) => item.id === message.id)
            ? current
            : [...current, message]
        )
        return
      }
      if (event.type === 'task-updated') {
        const task = event.task
        // 测试任务结束即代表一次验证。主进程只更新数据库，不推送工作区事件，
        // 这里按同一规则（done/merged 为通过，其余终态为失败）同步顶部状态。
        // 在过滤工作区之前处理：其他工作区的验证结果也要更新，切换过去时才是新值。
        if (task.taskType === 'test' && VERIFICATION_SETTLED_STATUSES.has(task.status)) {
          const verification: VerificationStatus =
            task.status === 'done' || task.status === 'merged' ? 'passed' : 'failed'
          setWorkspaces((current) =>
            current.map((workspace) =>
              workspace.id === task.workspaceId
                ? { ...workspace, lastVerification: verification }
                : workspace
            )
          )
        }
        if (task.workspaceId !== selectedId) {
          return
        }
        setTasks((current) =>
          current.some((item) => item.id === task.id)
            ? current.map((item) => (item.id === task.id ? task : item))
            : [...current, task]
        )
        // 任务结束后不再有进度推送，释放缓存
        if (PROGRESS_TERMINAL_STATUSES.has(task.status)) {
          setProgress((current) => {
            if (!Object.prototype.hasOwnProperty.call(current, task.id)) {
              return current
            }
            const next = { ...current }
            delete next[task.id]
            return next
          })
        }
        return
      }
      if (event.type === 'task-progress') {
        // 只保留最近 5 行；事件可能属于其他工作区，但 id 全局唯一，留着也不会串台
        setProgress((current) => ({
          ...current,
          [event.taskId]: [...(current[event.taskId] ?? []), ...event.lines].slice(-5)
        }))
        return
      }
      // agent-status 事件不单独跟踪：成员面板直接从 tasks 推导忙碌状态
    })
  }, [selectedId])

  // 创建成功后刷新列表并选中新工作区。刷新失败时至少把返回值并入列表，
  // 避免创建已经成功、界面却回到空状态让用户重复提交。
  const handleCreated = useCallback(async (created: Workspace): Promise<void> => {
    try {
      const list = await listWorkspaces()
      setWorkspaces(
        list.some((workspace) => workspace.id === created.id) ? list : [...list, created]
      )
    } catch {
      setWorkspaces((current) =>
        current.some((workspace) => workspace.id === created.id) ? current : [...current, created]
      )
    }
    setSelectedId(created.id)
  }, [])

  // 成员添加/删除后重新拉取列表；响应是权威快照，直接替换
  const handleAgentsChanged = useCallback(async (): Promise<void> => {
    if (selectedId === null) {
      return
    }
    setAgents(await listAgents(selectedId))
  }, [selectedId])

  // 本地显示名只存 localStorage；空名回退为“我”。
  const handleUserNameSaved = useCallback((name: string): void => {
    const next = name.trim() || DEFAULT_USER_NAME
    try {
      window.localStorage.setItem(USER_NAME_KEY, next)
    } catch {
      // 存储不可用时仍更新当前会话的显示名
    }
    setUserName(next)
  }, [])

  // 发送消息后把返回的消息与任务并入本地状态；错误交给 Composer 展示。
  const handleSend = useCallback(
    async (text: string): Promise<void> => {
      if (selectedId === null) {
        return
      }
      const result = await sendChatMessage(selectedId, text)
      setMessages((current) =>
        current.some((message) => message.id === result.message.id)
          ? current
          : [...current, result.message]
      )
      setTasks((current) => {
        let next = current
        for (const task of result.tasks) {
          next = next.some((item) => item.id === task.id)
            ? next.map((item) => (item.id === task.id ? task : item))
            : [...next, task]
        }
        return next
      })
    },
    [selectedId]
  )

  if (!loaded) {
    return <div className="app-loading">正在加载项目…</div>
  }

  if (loadError !== null) {
    return (
      <div className="app-loading" role="alert">
        加载项目失败：{loadError}
      </div>
    )
  }

  if (workspaces.length === 0) {
    return <WorkspaceSetup onCreated={handleCreated} />
  }

  const selected =
    workspaces.find((workspace) => workspace.id === selectedId) ?? workspaces[0]
  if (selected === undefined) {
    return <div className="app-loading">正在加载项目…</div>
  }

  const mergeCommand = `git merge ${selected.integrationBranch}`

  // 冲突任务被解决任务占用时，卡片必须隐藏会并发修改同一 worktree 的操作。
  // 同一父任务最多只有一个活动解决任务（后端会拒绝重复指派）。
  const activeResolveByParent = new Map<string, Task>()
  for (const task of tasks) {
    if (
      task.taskType === 'resolve' &&
      task.parentTaskId !== null &&
      ACTIVE_RESOLVE_STATUSES.has(task.status)
    ) {
      activeResolveByParent.set(task.parentTaskId, task)
    }
  }

  // 复制失败时把命令直接展示出来，用户仍可手动执行（Electron 某些环境没有剪贴板权限）
  const handleCopyMergeCommand = async (): Promise<void> => {
    try {
      if (navigator.clipboard === undefined) {
        throw new Error('当前环境不支持剪贴板')
      }
      await navigator.clipboard.writeText(mergeCommand)
      setCopyNotice('已复制')
    } catch {
      setCopyNotice(`复制失败，请手动执行：${mergeCommand}`)
    }
  }

  return (
    <div className="app-shell">
      <Sidebar
        workspaces={workspaces}
        selectedId={selected.id}
        onSelect={setSelectedId}
        onCreate={() => setSetupOpen(true)}
      />

      <main className="workspace">
        <header className="workspace-header">
          <div className="workspace-heading">
            <h1 className="workspace-name">{selected.name}</h1>
            <span className="workspace-repo">{selected.repoPath}</span>
          </div>
          <div className="workspace-meta">
            <span className="workspace-branch">
              集成分支：{selected.integrationBranch}
            </span>
            <span className="workspace-branch">
              目标分支：{selected.targetBranch ?? '未设置'}
            </span>
            <span
              className={`verification verification-${selected.lastVerification}`}
              data-testid="verification-status"
            >
              {VERIFICATION_LABELS[selected.lastVerification]}
            </span>
            {diffError !== null ? (
              <span
                className="diff-stat diff-stat-error"
                data-testid="diff-error"
                title={diffError}
              >
                差异不可用
              </span>
            ) : (
              diff !== null && (
                <span className="diff-stat" data-testid="diff-stat">
                  {diff.files} 个文件 · +{diff.insertions} · -{diff.deletions}
                </span>
              )
            )}
          </div>
          <div className="workspace-header-actions">
            {(detailError !== null || diffError !== null) && (
              <button
                type="button"
                className="header-button"
                aria-label="重新加载项目数据"
                onClick={() => setReloadToken((value) => value + 1)}
              >
                重试
              </button>
            )}
            <button
              type="button"
              className="header-button header-button-primary"
              onClick={() => void handleCopyMergeCommand()}
            >
              复制合入命令
            </button>
            <button
              type="button"
              className="header-button"
              aria-expanded={agentPanelOpen}
              aria-controls="agent-panel"
              onClick={() => setAgentPanelOpen((open) => !open)}
            >
              {agentPanelOpen ? '收起成员' : '成员'}
            </button>
            <button
              type="button"
              className="header-button"
              onClick={() => setSettingsOpen(true)}
            >
              设置
            </button>
            {copyNotice !== null && (
              <span className="copy-notice" role="status">
                {copyNotice}
              </span>
            )}
          </div>
          {detailError !== null && (
            <p className="workspace-error" role="alert">
              加载项目数据失败：{detailError}
            </p>
          )}
        </header>

        <div
          className={
            agentPanelOpen ? 'workspace-body workspace-body-agents' : 'workspace-body'
          }
        >
          <section className="chat-column">
            <ChatTimeline
              messages={messages}
              tasks={tasks}
              agents={agents}
              userName={userName}
              progress={progress}
              activeResolveByParent={activeResolveByParent}
              onReply={(agentName) =>
                setComposerSeed({
                  text: `@${agentName} `,
                  nonce: Date.now()
                })
              }
              onEditMessage={(text) =>
                setComposerSeed({
                  text,
                  nonce: Date.now()
                })
              }
            />
            <Composer
              agents={agents}
              userName={userName}
              seed={composerSeed}
              onSend={handleSend}
            />
          </section>

          {agentPanelOpen && (
            <AgentPanel
              workspaceId={selected.id}
              agents={agents}
              tasks={tasks}
              onChanged={handleAgentsChanged}
              onClose={() => setAgentPanelOpen(false)}
            />
          )}
        </div>

        {settingsOpen && (
          <SettingsDialog
            workspace={selected}
            agents={agents}
            userName={userName}
            onUserNameSaved={handleUserNameSaved}
            onSaved={(updated) => {
              setWorkspaces((current) =>
                current.map((workspace) =>
                  workspace.id === updated.id ? updated : workspace
                )
              )
              setSettingsOpen(false)
            }}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </main>

      {setupOpen && (
        <div className="setup-overlay">
          <WorkspaceSetup
            onCreated={async (created) => {
              await handleCreated(created)
              setSetupOpen(false)
            }}
            onCancel={() => setSetupOpen(false)}
          />
        </div>
      )}
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
