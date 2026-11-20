// 领域共享类型。后续所有服务、数据库仓储与渲染进程都以此为契约。
export type PermissionProfile = 'read-only' | 'edit-only' | 'edit-and-run'
export type TaskType = 'code' | 'test' | 'resolve'
export type TaskStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'done'
  | 'merging'
  | 'merged'
  | 'conflict'
  | 'awaiting_approval'
  | 'failed'
  | 'cancelled'
  | 'abandoned'
  | 'interrupted'
export type VerificationStatus = 'unknown' | 'passed' | 'failed'

export interface Workspace {
  id: string
  name: string
  repoPath: string
  integrationBranch: string
  targetBranch: string | null
  setupCommand: string | null
  setupCopy: string[]
  setupTimeoutMin: number
  taskTimeoutMin: number
  autoMerge: boolean
  autoTestAfterMerge: boolean
  /** 消息没有 @ 任何成员时，默认接收任务的 Agent；null 表示不默认分派。 */
  defaultAgentId: string | null
  testAgentId: string | null
  testTaskTemplate: string
  lastVerification: VerificationStatus
  createdAt: string
}

export interface AgentConfig {
  id: string
  workspaceId: string
  name: string
  preset: 'claude' | 'codex' | 'custom'
  command: string
  argsTemplate: string | null
  rolePrompt: string
  pathScope: string[]
  permissionProfile: PermissionProfile
  canDelegate: boolean
  enabled: boolean
}

/** 本机可检测到的 Agent CLI 候选，用于“添加 Agent”画廊。 */
export interface DetectedAgent {
  id: string
  name: string
  vendor: string
  description: string
  command: string
  preset: AgentConfig['preset']
  installHint: string
  rolePrompt: string
  installed: boolean
  version: string | null
  path: string | null
  /** 登录状态；null 表示该 CLI 没有可用的状态探测命令或探测失败。 */
  loggedIn: boolean | null
  /** 未登录时展示的登录命令。 */
  loginHint: string | null
}

export interface Task {
  id: string
  workspaceId: string
  agentId: string
  parentTaskId: string | null
  taskType: TaskType
  title: string
  prompt: string
  branch: string | null
  worktreePath: string | null
  baseRef: string | null
  status: TaskStatus
  exitCode: number | null
  summary: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface ChatMessage {
  id: string
  workspaceId: string
  kind: 'user' | 'agent' | 'system' | 'task-card'
  authorType: 'user' | 'agent' | 'system'
  authorId: string | null
  content: string
  taskId: string | null
  createdAt: string
}

export type AppEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'task-updated'; task: Task }
  | { type: 'task-progress'; taskId: string; lines: string[] }
  | { type: 'agent-status'; agentId: string; status: 'idle' | 'busy' }
