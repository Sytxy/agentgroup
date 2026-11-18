// 渲染进程对 window.api 的类型化封装。
// 所有 IPC 调用都集中在这里，组件不直接接触通道字符串，
// 返回类型与主进程 ipc-handlers.ts 的参数/返回值保持一致。
import { IPC, type DesktopApi } from '../../shared/ipc'
import type { AgentConfig, ChatMessage, Task, Workspace } from '../../shared/types'

/** 与主进程 git 服务的 diff 统计结构一致。 */
export type DiffStat = { files: number; insertions: number; deletions: number }

/** workspace:update 允许修改的字段，与主进程 ipc-handlers.ts 的白名单一致。 */
export interface WorkspaceSettingsPatch {
  autoMerge?: boolean
  autoTestAfterMerge?: boolean
  testAgentId?: string | null
  setupCommand?: string | null
  setupCopy?: string[]
  targetBranch?: string | null
  taskTimeoutMin?: number
  setupTimeoutMin?: number
}

export interface WorkspaceCreateInput {
  name: string
  repoPath: string
  /** 省略时主进程使用仓库当前分支；传 null 表示不与任何分支比较 */
  targetBranch?: string | null
}

declare global {
  interface Window {
    api: DesktopApi
  }
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return (await window.api.invoke(IPC.workspaceList)) as Workspace[]
}

export async function createWorkspace(input: WorkspaceCreateInput): Promise<Workspace> {
  return (await window.api.invoke(IPC.workspaceCreate, input)) as Workspace
}

export async function updateWorkspace(
  workspaceId: string,
  patch: WorkspaceSettingsPatch
): Promise<Workspace> {
  return (await window.api.invoke(IPC.workspaceUpdate, {
    workspaceId,
    patch
  })) as Workspace
}

export async function getWorkspaceDiff(workspaceId: string): Promise<DiffStat> {
  return (await window.api.invoke(IPC.workspaceDiff, { workspaceId })) as DiffStat
}

export async function listMessages(workspaceId: string): Promise<ChatMessage[]> {
  return (await window.api.invoke(IPC.chatHistory, { workspaceId })) as ChatMessage[]
}

export async function listTasks(workspaceId: string): Promise<Task[]> {
  return (await window.api.invoke(IPC.tasksList, { workspaceId })) as Task[]
}

export async function listAgents(workspaceId: string): Promise<AgentConfig[]> {
  return (await window.api.invoke(IPC.agentsList, { workspaceId })) as AgentConfig[]
}

/** chat:send 的返回结构，与主进程 Dispatcher.send 一致。 */
export interface ChatSendResult {
  /** 本次写入数据库的用户消息。 */
  message: ChatMessage
  /** 按提及顺序创建的任务；无提及时为空数组。 */
  tasks: Task[]
}

export async function sendChatMessage(
  workspaceId: string,
  text: string
): Promise<ChatSendResult> {
  return (await window.api.invoke(IPC.chatSend, {
    workspaceId,
    text
  })) as ChatSendResult
}

// ---- 任务操作 ----

export async function cancelTask(taskId: string): Promise<void> {
  await window.api.invoke(IPC.tasksCancel, { taskId })
}

export async function retryTask(taskId: string): Promise<void> {
  await window.api.invoke(IPC.tasksRetry, { taskId })
}

export async function approveMerge(taskId: string): Promise<void> {
  await window.api.invoke(IPC.tasksApproveMerge, { taskId })
}

export async function abandonTask(taskId: string): Promise<void> {
  await window.api.invoke(IPC.tasksAbandon, { taskId })
}

/** 在系统文件管理器中打开任务的 worktree，返回实际打开的路径。 */
export async function openTaskWorktree(taskId: string): Promise<string> {
  return (await window.api.invoke(IPC.tasksOpenWorktree, { taskId })) as string
}

/** 重新准备冲突任务的 worktree 现场（目录被清理时会重新检出），返回路径。 */
export async function prepareResolveWorktree(taskId: string): Promise<string> {
  return (await window.api.invoke(IPC.tasksPrepareResolve, { taskId })) as string
}

export async function markTaskResolved(taskId: string): Promise<void> {
  await window.api.invoke(IPC.tasksMarkResolved, { taskId })
}

/** 为冲突任务创建 resolve 任务并指派给指定 Agent。 */
export async function createResolveTask(taskId: string, agentId: string): Promise<Task> {
  return (await window.api.invoke(IPC.tasksCreateResolve, {
    taskId,
    agentId
  })) as Task
}

/** 读取任务完整日志；日志不存在时主进程返回空字符串。 */
export async function getTaskLog(taskId: string): Promise<string> {
  return (await window.api.invoke(IPC.tasksLog, { taskId })) as string
}

// ---- 成员管理 ----

export async function addAgent(input: AgentConfig): Promise<AgentConfig> {
  return (await window.api.invoke(IPC.agentsAdd, input)) as AgentConfig
}

export async function removeAgent(agentId: string): Promise<void> {
  await window.api.invoke(IPC.agentsRemove, { agentId })
}

/** 启用/停用成员。停用后不再向其分派任务，历史任务与消息保留。 */
export async function setAgentEnabled(agentId: string, enabled: boolean): Promise<AgentConfig> {
  return (await window.api.invoke(IPC.agentsUpdate, {
    agentId,
    patch: { enabled }
  })) as AgentConfig
}
