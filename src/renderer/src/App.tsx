// 应用外壳：加载工作区列表，选中后拉起初始数据，并渲染三栏布局。
// 初始状态一律通过 IPC 主动拉取，不依赖事件推送（事件可能在订阅前已经发出）。
import { useCallback, useEffect, useState } from 'react'
import type { AgentConfig, ChatMessage, Task, Workspace } from '../../shared/types'
import {
  getWorkspaceDiff,
  listAgents,
  listMessages,
  listTasks,
  listWorkspaces,
  sendChatMessage,
  type DiffStat
} from './api'
import ChatTimeline from './components/ChatTimeline'
import Composer from './components/Composer'
import Sidebar from './components/Sidebar'
import WorkspaceSetup from './components/WorkspaceSetup'

export default function App(): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffStat | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<AgentConfig[]>([])

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

  // 选中工作区后加载其初始数据；切换工作区时先清空旧数据，避免串台
  useEffect(() => {
    if (selectedId === null) {
      return
    }
    let cancelled = false
    setMessages([])
    setTasks([])
    setAgents([])
    setDiff(null)
    setDetailError(null)
    void (async () => {
      try {
        const [nextMessages, nextTasks, nextAgents, nextDiff] = await Promise.all([
          listMessages(selectedId),
          listTasks(selectedId),
          listAgents(selectedId),
          getWorkspaceDiff(selectedId)
        ])
        if (cancelled) {
          return
        }
        setMessages(nextMessages)
        setTasks(nextTasks)
        setAgents(nextAgents)
        setDiff(nextDiff)
      } catch (cause) {
        if (!cancelled) {
          setDetailError(errorMessage(cause))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId])

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
        if (task.workspaceId !== selectedId) {
          return
        }
        setTasks((current) =>
          current.some((item) => item.id === task.id)
            ? current.map((item) => (item.id === task.id ? task : item))
            : [...current, task]
        )
      }
      // task-progress / agent-status 供后续任务面板与成员面板使用，这里暂不处理
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
    return <div className="app-loading">正在加载工作区…</div>
  }

  if (loadError !== null) {
    return (
      <div className="app-loading" role="alert">
        加载工作区失败：{loadError}
      </div>
    )
  }

  if (workspaces.length === 0) {
    return <WorkspaceSetup onCreated={handleCreated} />
  }

  const selected =
    workspaces.find((workspace) => workspace.id === selectedId) ?? workspaces[0]
  if (selected === undefined) {
    return <div className="app-loading">正在加载工作区…</div>
  }

  return (
    <div className="app-shell">
      <Sidebar
        workspaces={workspaces}
        selectedId={selected.id}
        onSelect={setSelectedId}
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
            {diff !== null && (
              <span className="diff-stat" data-testid="diff-stat">
                {diff.files} 个文件 · +{diff.insertions} · -{diff.deletions}
              </span>
            )}
          </div>
          {detailError !== null && (
            <p className="workspace-error" role="alert">
              加载工作区数据失败：{detailError}
            </p>
          )}
        </header>

        <div className="workspace-body">
          <section className="chat-column">
            <ChatTimeline messages={messages} tasks={tasks} agents={agents} />
            <Composer agents={agents} onSend={handleSend} />
          </section>

          <aside className="agent-column" data-testid="agent-panel">
            <h2 className="panel-title">Agent 成员</h2>
            <p className="panel-empty">成员面板将在这里显示。</p>
            <p className="panel-meta">已加载 {agents.length} 位成员</p>
          </aside>
        </div>
      </main>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
