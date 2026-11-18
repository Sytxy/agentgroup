/**
 * IPC 处理器映射。
 *
 * 只负责参数校验、错误包装与把调用转发给应用服务；业务逻辑都在服务层。
 * 本文件不依赖 Electron，主进程注册 ipcMain.handle 时逐项绑定。
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type {
  AgentConfig,
  ChatMessage,
  PermissionProfile,
  Task,
  Workspace
} from '../shared/types'
import type { AppContext } from './app-context'
import type { AgentPatch } from './db/agent-repo'
import type { WorkspacePatch } from './db/workspace-repo'

export type IpcHandler = (payload: unknown) => Promise<unknown>

/** 任务 id 直接参与日志文件路径，只允许安全字符，避免 ../ 穿越出 logsRoot。 */
const SAFE_TASK_ID = /^[A-Za-z0-9_-]+$/

const PRESETS: ReadonlySet<string> = new Set(['claude', 'codex', 'custom'])
const PERMISSION_PROFILES: ReadonlySet<string> = new Set([
  'read-only',
  'edit-only',
  'edit-and-run'
])

export function createIpcHandlers(ctx: AppContext): Record<string, IpcHandler> {
  const handlers: Record<string, IpcHandler> = {}

  /** 包装单个通道：统一补上通道名，让渲染进程拿到可读的失败原因。 */
  const define = (
    channel: string,
    run: (payload: unknown) => unknown | Promise<unknown>
  ): void => {
    handlers[channel] = async (payload) => {
      try {
        return await run(payload)
      } catch (error) {
        throw new Error(`${channel} 失败：${errorMessage(error)}`)
      }
    }
  }

  const requireWorkspace = (workspaceId: string): Workspace => {
    const workspace = ctx.workspaces.get(workspaceId)
    if (workspace === null) {
      throw new Error(`工作区不存在：${workspaceId}`)
    }
    return workspace
  }

  const requireTask = (taskId: string): Task => {
    const task = ctx.tasks.get(taskId)
    if (task === null) {
      throw new Error(`任务不存在：${taskId}`)
    }
    return task
  }

  // ---- 工作区 ----

  define(IPC.workspaceCreate, async (payload) => {
    const input = record(payload)
    return ctx.workspaceService.create({
      name: requiredString(input, 'name'),
      repoPath: requiredString(input, 'repoPath'),
      targetBranch: optionalNullableString(input, 'targetBranch')
    })
  })

  define(IPC.workspaceList, () => ctx.workspaceService.list())

  define(IPC.workspaceUpdate, async (payload) => {
    const input = record(payload)
    const workspaceId = requiredString(input, 'workspaceId')
    requireWorkspace(workspaceId)
    ctx.workspaces.update(workspaceId, workspaceSettingsPatch(input['patch']))
    return ctx.workspaces.get(workspaceId)
  })

  define(IPC.workspaceDiff, async (payload) => {
    const input = record(payload)
    return ctx.workspaceService.diffStat(requireWorkspace(requiredString(input, 'workspaceId')))
  })

  // ---- Agent ----

  define(IPC.agentsList, (payload) => {
    const input = record(payload)
    return ctx.agents.listByWorkspace(requiredString(input, 'workspaceId'))
  })

  define(IPC.agentsAdd, (payload) => {
    const agent = agentConfig(payload)
    // Agent 所属工作区必须已存在，否则成员面板会显示一个无法使用的悬空成员。
    requireWorkspace(agent.workspaceId)
    ctx.agents.insert(agent)
    return agent
  })

  define(IPC.agentsUpdate, (payload) => {
    const input = record(payload)
    const agentId = requiredString(input, 'agentId')
    if (ctx.agents.get(agentId) === null) {
      throw new Error(`Agent 不存在：${agentId}`)
    }
    ctx.agents.update(agentId, agentUpdatePatch(input['patch']))
    return ctx.agents.get(agentId)
  })

  define(IPC.agentsRemove, (payload) => {
    const input = record(payload)
    const agentId = requiredString(input, 'agentId')
    if (ctx.agents.get(agentId) === null) {
      throw new Error(`Agent 不存在：${agentId}`)
    }
    // 真正删除成员。任务/消息只以 TEXT 保存 agent id，历史记录不受影响；
    // 需要保留成员但停止接活时，调用方应使用 agents:update { enabled: false }。
    ctx.agents.delete(agentId)
    return { ok: true }
  })

  // ---- 群聊 ----

  define(IPC.chatSend, (payload) => {
    const input = record(payload)
    return ctx.dispatcher.send(requiredString(input, 'workspaceId'), requiredString(input, 'text'))
  })

  define(IPC.chatHistory, (payload) => {
    const input = record(payload)
    return ctx.messages.listByWorkspace(requiredString(input, 'workspaceId'))
  })

  // ---- 任务 ----

  define(IPC.tasksList, (payload) => {
    const input = record(payload)
    return ctx.tasks.listByWorkspace(requiredString(input, 'workspaceId'))
  })

  define(IPC.tasksCancel, (payload) => ctx.taskManager.cancel(taskIdOf(payload)))

  define(IPC.tasksRetry, (payload) => ctx.taskManager.retry(taskIdOf(payload)))

  define(IPC.tasksApproveMerge, (payload) => ctx.taskManager.approveMerge(taskIdOf(payload)))

  define(IPC.tasksAbandon, (payload) => ctx.taskManager.abandon(taskIdOf(payload)))

  define(IPC.tasksOpenWorktree, async (payload) => {
    const task = requireTask(taskIdOf(payload))
    if (task.worktreePath === null) {
      throw new Error(`任务没有可打开的 worktree：${task.id}`)
    }
    await ctx.openPath(task.worktreePath)
    return task.worktreePath
  })

  define(IPC.tasksPrepareResolve, (payload) =>
    ctx.mergeCoordinator.prepareResolveWorktree(taskIdOf(payload))
  )

  define(IPC.tasksMarkResolved, (payload) =>
    ctx.mergeCoordinator.markManuallyResolved(taskIdOf(payload))
  )

  define(IPC.tasksCreateResolve, (payload) => {
    const input = record(payload)
    const resolveTask = ctx.mergeCoordinator.createResolveTask(
      requiredString(input, 'taskId'),
      requiredString(input, 'agentId')
    )
    // 解决任务由 IPC 触发（而非 Dispatcher），这里补一条任务卡片消息，
    // 让群聊时间线与普通分派任务保持一致，并通知所有窗口刷新。
    const message: ChatMessage = {
      id: randomUUID(),
      workspaceId: resolveTask.workspaceId,
      kind: 'task-card',
      authorType: 'system',
      authorId: null,
      content: resolveTask.title,
      taskId: resolveTask.id,
      createdAt: new Date().toISOString()
    }
    ctx.messages.insert(message)
    ctx.events.emit({ type: 'message', message })
    return resolveTask
  })

  define(IPC.tasksLog, async (payload) => {
    const taskId = taskIdOf(payload)
    if (!SAFE_TASK_ID.test(taskId)) {
      throw new Error(`非法的任务 id：${taskId}`)
    }
    try {
      return await readFile(join(ctx.logsRoot, `${taskId}.log`), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return ''
      }
      throw error
    }
  })

  // events 是主进程 → 渲染进程的单向推送通道，渲染进程不能 invoke。
  define(IPC.events, () => {
    throw new Error('events 是主进程推送通道，不能被渲染进程调用')
  })

  // 未知通道同样返回一个拒绝的处理器，而不是 undefined：
  // 调用方（尤其是渲染进程）总能拿到可读的错误信息。
  return new Proxy(handlers, {
    get(target, property, receiver) {
      if (typeof property === 'string') {
        // 只认自有属性，避免 toString/constructor 等原型方法被当成通道处理器。
        if (Object.prototype.hasOwnProperty.call(target, property)) {
          return target[property]
        }
        // 不能让该对象被误判为 thenable，否则 await 处理器映射会永远挂起。
        if (property === 'then') {
          return undefined
        }
        return async () => {
          throw new Error(`未知 IPC 通道：${property}`)
        }
      }
      return Reflect.get(target, property, receiver)
    }
  })
}

function taskIdOf(payload: unknown): string {
  return requiredString(record(payload), 'taskId')
}

// ---- 参数校验 ----

function record(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('参数必须是对象')
  }
  return payload as Record<string, unknown>
}

function requiredString(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`参数 ${field} 必须是非空字符串`)
  }
  return value
}

function stringValue(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string') {
    throw new Error(`参数 ${field} 必须是字符串`)
  }
  return value
}

function nullableString(input: Record<string, unknown>, field: string): string | null {
  const value = input[field]
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new Error(`参数 ${field} 必须是字符串或 null`)
  }
  return value
}

/** 区分“未提供”与“显式 null”：前者交给服务取默认值，后者表示明确不设置。 */
function optionalNullableString(
  input: Record<string, unknown>,
  field: string
): string | null | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }
  return nullableString(input, field)
}

function booleanValue(input: Record<string, unknown>, field: string): boolean {
  const value = input[field]
  if (typeof value !== 'boolean') {
    throw new Error(`参数 ${field} 必须是布尔值`)
  }
  return value
}

function numberValue(input: Record<string, unknown>, field: string): number {
  const value = input[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`参数 ${field} 必须是数字`)
  }
  return value
}

function stringArrayValue(input: Record<string, unknown>, field: string): string[] {
  const value = input[field]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`参数 ${field} 必须是字符串数组`)
  }
  return value as string[]
}

/** workspace:update 只允许设置对话框会修改的字段，其余字段（id/createdAt 等）不可经 IPC 改动。 */
function workspaceSettingsPatch(payload: unknown): WorkspacePatch {
  const input = record(payload)
  const patch: WorkspacePatch = {}
  if (input['autoMerge'] !== undefined) {
    patch.autoMerge = booleanValue(input, 'autoMerge')
  }
  if (input['autoTestAfterMerge'] !== undefined) {
    patch.autoTestAfterMerge = booleanValue(input, 'autoTestAfterMerge')
  }
  if (input['testAgentId'] !== undefined) {
    patch.testAgentId = nullableString(input, 'testAgentId')
  }
  if (input['setupCommand'] !== undefined) {
    patch.setupCommand = nullableString(input, 'setupCommand')
  }
  if (input['setupCopy'] !== undefined) {
    patch.setupCopy = stringArrayValue(input, 'setupCopy')
  }
  if (input['targetBranch'] !== undefined) {
    patch.targetBranch = nullableString(input, 'targetBranch')
  }
  if (input['taskTimeoutMin'] !== undefined) {
    patch.taskTimeoutMin = numberValue(input, 'taskTimeoutMin')
  }
  if (input['setupTimeoutMin'] !== undefined) {
    patch.setupTimeoutMin = numberValue(input, 'setupTimeoutMin')
  }
  return patch
}

function agentConfig(payload: unknown): AgentConfig {
  const input = record(payload)
  const preset = requiredString(input, 'preset')
  if (!PRESETS.has(preset)) {
    throw new Error(`未知的 Agent 预设：${preset}`)
  }
  const permissionProfile = requiredString(input, 'permissionProfile')
  if (!PERMISSION_PROFILES.has(permissionProfile)) {
    throw new Error(`未知的权限档位：${permissionProfile}`)
  }
  return {
    id: requiredString(input, 'id'),
    workspaceId: requiredString(input, 'workspaceId'),
    name: requiredString(input, 'name'),
    preset: preset as AgentConfig['preset'],
    command: requiredString(input, 'command'),
    argsTemplate: nullableString(input, 'argsTemplate'),
    rolePrompt: stringValue(input, 'rolePrompt'),
    pathScope: stringArrayValue(input, 'pathScope'),
    permissionProfile: permissionProfile as PermissionProfile,
    canDelegate: booleanValue(input, 'canDelegate'),
    enabled: booleanValue(input, 'enabled')
  }
}

/** agent:update 的白名单与 AgentConfig 字段一致，同样防止任意键写入数据库。 */
function agentUpdatePatch(payload: unknown): AgentPatch {
  const input = record(payload)
  const patch: AgentPatch = {}
  // workspaceId 不在白名单内：Agent 必须留在创建时所属的工作区，避免历史任务
  // 与本工作区的成员列表、测试 Agent 配置出现跨工作区引用。
  if (input['name'] !== undefined) {
    patch.name = requiredString(input, 'name')
  }
  if (input['preset'] !== undefined) {
    const preset = requiredString(input, 'preset')
    if (!PRESETS.has(preset)) {
      throw new Error(`未知的 Agent 预设：${preset}`)
    }
    patch.preset = preset as AgentConfig['preset']
  }
  if (input['command'] !== undefined) {
    patch.command = requiredString(input, 'command')
  }
  if (input['argsTemplate'] !== undefined) {
    patch.argsTemplate = nullableString(input, 'argsTemplate')
  }
  if (input['rolePrompt'] !== undefined) {
    patch.rolePrompt = stringValue(input, 'rolePrompt')
  }
  if (input['pathScope'] !== undefined) {
    patch.pathScope = stringArrayValue(input, 'pathScope')
  }
  if (input['permissionProfile'] !== undefined) {
    const permission = requiredString(input, 'permissionProfile')
    if (!PERMISSION_PROFILES.has(permission)) {
      throw new Error(`未知的权限档位：${permission}`)
    }
    patch.permissionProfile = permission as PermissionProfile
  }
  if (input['canDelegate'] !== undefined) {
    patch.canDelegate = booleanValue(input, 'canDelegate')
  }
  if (input['enabled'] !== undefined) {
    patch.enabled = booleanValue(input, 'enabled')
  }
  return patch
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
