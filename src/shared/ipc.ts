// IPC 通道常量与渲染进程可见的桥接口。
// 通道名是主进程/预加载/渲染进程共享的契约，所有调用都必须使用这里的常量。
import type { AppEvent } from './types'

export const IPC = {
  workspaceCreate: 'workspace:create',
  workspaceList: 'workspace:list',
  workspaceUpdate: 'workspace:update',
  workspaceDiff: 'workspace:diff',
  workspacePickFolder: 'workspace:pick-folder',
  agentsList: 'agents:list',
  agentsAdd: 'agents:add',
  agentsUpdate: 'agents:update',
  agentsRemove: 'agents:remove',
  chatSend: 'chat:send',
  chatHistory: 'chat:history',
  tasksList: 'tasks:list',
  tasksCancel: 'tasks:cancel',
  tasksRetry: 'tasks:retry',
  tasksApproveMerge: 'tasks:approve-merge',
  tasksAbandon: 'tasks:abandon',
  tasksOpenWorktree: 'tasks:open-worktree',
  tasksPrepareResolve: 'tasks:prepare-resolve',
  tasksMarkResolved: 'tasks:mark-resolved',
  tasksCreateResolve: 'tasks:create-resolve',
  tasksLog: 'tasks:log',
  events: 'events'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** preload 通过 contextBridge 暴露到 window.api 的接口。 */
export interface DesktopApi {
  invoke(channel: IpcChannel, payload?: unknown): Promise<unknown>
  /** 订阅主进程推送的应用事件；返回退订函数。 */
  onEvent(callback: (event: AppEvent) => void): () => void
}
