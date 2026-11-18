// IPC 通道常量。Task 16 会在此基础上补充请求/响应类型与主进程处理器。
export const IPC = {
  workspaceCreate: 'workspace:create',
  workspaceList: 'workspace:list',
  workspaceUpdate: 'workspace:update',
  workspaceDiff: 'workspace:diff',
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
  tasksLog: 'tasks:log',
  events: 'events'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
