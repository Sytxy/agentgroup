import type { Task, TaskStatus, TaskType } from '../../shared/types'
import {
  nullableInteger,
  nullableText,
  queryRows,
  text,
  type Db,
  type Row,
  type SqlValue
} from './database'

export type TaskPatch = Partial<Omit<Task, 'id' | 'createdAt'>>

function mapRow(row: Row): Task {
  return {
    id: text(row, 'id'),
    workspaceId: text(row, 'workspace_id'),
    agentId: text(row, 'agent_id'),
    parentTaskId: nullableText(row, 'parent_task_id'),
    taskType: text(row, 'task_type') as TaskType,
    title: text(row, 'title'),
    prompt: text(row, 'prompt'),
    branch: nullableText(row, 'branch'),
    worktreePath: nullableText(row, 'worktree_path'),
    baseRef: nullableText(row, 'base_ref'),
    status: text(row, 'status') as TaskStatus,
    exitCode: nullableInteger(row, 'exit_code'),
    summary: nullableText(row, 'summary'),
    createdAt: text(row, 'created_at'),
    startedAt: nullableText(row, 'started_at'),
    finishedAt: nullableText(row, 'finished_at')
  }
}

export class TaskRepo {
  constructor(private readonly db: Db) {}

  insert(task: Task): void {
    this.db.raw.run(
      `INSERT INTO tasks (
        id, workspace_id, agent_id, parent_task_id, task_type, title, prompt,
        branch, worktree_path, base_ref, status, exit_code, summary,
        created_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.workspaceId,
        task.agentId,
        task.parentTaskId,
        task.taskType,
        task.title,
        task.prompt,
        task.branch,
        task.worktreePath,
        task.baseRef,
        task.status,
        task.exitCode,
        task.summary,
        task.createdAt,
        task.startedAt,
        task.finishedAt
      ]
    )
    this.db.persist()
  }

  get(id: string): Task | null {
    const [row] = queryRows(this.db, 'SELECT * FROM tasks WHERE id = ?', [id])
    return row ? mapRow(row) : null
  }

  /** 同一时间戳下用 rowid DESC 保证后插入的任务排前面，测试与 UI 顺序确定。 */
  listByWorkspace(workspaceId: string): Task[] {
    return queryRows(
      this.db,
      'SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC',
      [workspaceId]
    ).map(mapRow)
  }

  update(id: string, patch: TaskPatch): void {
    const assignments: string[] = []
    const params: SqlValue[] = []
    const set = (column: string, value: SqlValue): void => {
      assignments.push(`${column} = ?`)
      params.push(value)
    }
    // 显式字段白名单：SQL 片段只来自这里，不会把任意键拼进语句。
    if (patch.workspaceId !== undefined) set('workspace_id', patch.workspaceId)
    if (patch.agentId !== undefined) set('agent_id', patch.agentId)
    if (patch.parentTaskId !== undefined) set('parent_task_id', patch.parentTaskId)
    if (patch.taskType !== undefined) set('task_type', patch.taskType)
    if (patch.title !== undefined) set('title', patch.title)
    if (patch.prompt !== undefined) set('prompt', patch.prompt)
    if (patch.branch !== undefined) set('branch', patch.branch)
    if (patch.worktreePath !== undefined) set('worktree_path', patch.worktreePath)
    if (patch.baseRef !== undefined) set('base_ref', patch.baseRef)
    if (patch.status !== undefined) set('status', patch.status)
    if (patch.exitCode !== undefined) set('exit_code', patch.exitCode)
    if (patch.summary !== undefined) set('summary', patch.summary)
    if (patch.startedAt !== undefined) set('started_at', patch.startedAt)
    if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt)

    if (assignments.length === 0) return
    this.db.raw.run(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = ?`, [...params, id])
    this.db.persist()
  }
}
