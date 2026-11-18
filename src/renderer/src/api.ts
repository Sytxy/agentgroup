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
