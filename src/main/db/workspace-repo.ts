import type { VerificationStatus, Workspace } from '../../shared/types'
import {
  boolean,
  queryRows,
  jsonStringArray,
  integer,
  nullableText,
  text,
  type Db,
  type Row,
  type SqlValue
} from './database'

export type WorkspacePatch = Partial<Omit<Workspace, 'id' | 'createdAt'>>

function mapRow(row: Row): Workspace {
  return {
    id: text(row, 'id'),
    name: text(row, 'name'),
    repoPath: text(row, 'repo_path'),
    integrationBranch: text(row, 'integration_branch'),
    targetBranch: nullableText(row, 'target_branch'),
    setupCommand: nullableText(row, 'setup_command'),
    setupCopy: jsonStringArray(row, 'setup_copy_json'),
    setupTimeoutMin: integer(row, 'setup_timeout_min'),
    taskTimeoutMin: integer(row, 'task_timeout_min'),
    autoMerge: boolean(row, 'auto_merge'),
    autoTestAfterMerge: boolean(row, 'auto_test_after_merge'),
    testAgentId: nullableText(row, 'test_agent_id'),
    testTaskTemplate: text(row, 'test_task_template'),
    lastVerification: text(row, 'last_verification') as VerificationStatus,
    createdAt: text(row, 'created_at')
  }
}

export class WorkspaceRepo {
  constructor(private readonly db: Db) {}

  insert(workspace: Workspace): void {
    this.db.raw.run(
      `INSERT INTO workspaces (
        id, name, repo_path, integration_branch, target_branch, setup_command,
        setup_copy_json, setup_timeout_min, task_timeout_min, auto_merge,
        auto_test_after_merge, test_agent_id, test_task_template,
        last_verification, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        workspace.id,
        workspace.name,
        workspace.repoPath,
        workspace.integrationBranch,
        workspace.targetBranch,
        workspace.setupCommand,
        JSON.stringify(workspace.setupCopy),
        workspace.setupTimeoutMin,
        workspace.taskTimeoutMin,
        workspace.autoMerge ? 1 : 0,
        workspace.autoTestAfterMerge ? 1 : 0,
        workspace.testAgentId,
        workspace.testTaskTemplate,
        workspace.lastVerification,
        workspace.createdAt
      ]
    )
    this.db.persist()
  }

  get(id: string): Workspace | null {
    const [row] = queryRows(this.db, 'SELECT * FROM workspaces WHERE id = ?', [id])
    return row ? mapRow(row) : null
  }

  list(): Workspace[] {
    return queryRows(
      this.db,
      'SELECT * FROM workspaces ORDER BY created_at ASC, rowid ASC'
    ).map(mapRow)
  }

  update(id: string, patch: WorkspacePatch): void {
    const assignments: string[] = []
    const params: SqlValue[] = []
    const set = (column: string, value: SqlValue): void => {
      assignments.push(`${column} = ?`)
      params.push(value)
    }
    // 显式字段白名单：SQL 片段只来自这里，不会把任意键拼进语句。
    if (patch.name !== undefined) set('name', patch.name)
    if (patch.repoPath !== undefined) set('repo_path', patch.repoPath)
    if (patch.integrationBranch !== undefined) set('integration_branch', patch.integrationBranch)
    if (patch.targetBranch !== undefined) set('target_branch', patch.targetBranch)
    if (patch.setupCommand !== undefined) set('setup_command', patch.setupCommand)
    if (patch.setupCopy !== undefined) set('setup_copy_json', JSON.stringify(patch.setupCopy))
    if (patch.setupTimeoutMin !== undefined) set('setup_timeout_min', patch.setupTimeoutMin)
    if (patch.taskTimeoutMin !== undefined) set('task_timeout_min', patch.taskTimeoutMin)
    if (patch.autoMerge !== undefined) set('auto_merge', patch.autoMerge ? 1 : 0)
    if (patch.autoTestAfterMerge !== undefined) {
      set('auto_test_after_merge', patch.autoTestAfterMerge ? 1 : 0)
    }
    if (patch.testAgentId !== undefined) set('test_agent_id', patch.testAgentId)
    if (patch.testTaskTemplate !== undefined) set('test_task_template', patch.testTaskTemplate)
    if (patch.lastVerification !== undefined) set('last_verification', patch.lastVerification)

    if (assignments.length === 0) return
    this.db.raw.run(`UPDATE workspaces SET ${assignments.join(', ')} WHERE id = ?`, [
      ...params,
      id
    ])
    this.db.persist()
  }
}
