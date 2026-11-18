import type { AgentConfig, PermissionProfile } from '../../shared/types'
import {
  boolean,
  queryRows,
  jsonStringArray,
  nullableText,
  text,
  type Db,
  type Row,
  type SqlValue
} from './database'

export type AgentPatch = Partial<Omit<AgentConfig, 'id'>>

function mapRow(row: Row): AgentConfig {
  return {
    id: text(row, 'id'),
    workspaceId: text(row, 'workspace_id'),
    name: text(row, 'name'),
    preset: text(row, 'preset') as AgentConfig['preset'],
    command: text(row, 'command'),
    argsTemplate: nullableText(row, 'args_template'),
    rolePrompt: text(row, 'role_prompt'),
    pathScope: jsonStringArray(row, 'path_scope_json'),
    permissionProfile: text(row, 'permission_profile') as PermissionProfile,
    canDelegate: boolean(row, 'can_delegate'),
    enabled: boolean(row, 'enabled')
  }
}

export class AgentRepo {
  constructor(private readonly db: Db) {}

  insert(agent: AgentConfig): void {
    this.db.raw.run(
      `INSERT INTO agents (
        id, workspace_id, name, preset, command, args_template, role_prompt,
        path_scope_json, permission_profile, can_delegate, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agent.id,
        agent.workspaceId,
        agent.name,
        agent.preset,
        agent.command,
        agent.argsTemplate,
        agent.rolePrompt,
        JSON.stringify(agent.pathScope),
        agent.permissionProfile,
        agent.canDelegate ? 1 : 0,
        agent.enabled ? 1 : 0
      ]
    )
    this.db.persist()
  }

  get(id: string): AgentConfig | null {
    const [row] = queryRows(this.db, 'SELECT * FROM agents WHERE id = ?', [id])
    return row ? mapRow(row) : null
  }

  listByWorkspace(workspaceId: string): AgentConfig[] {
    return queryRows(
      this.db,
      'SELECT * FROM agents WHERE workspace_id = ? ORDER BY rowid ASC',
      [workspaceId]
    ).map(mapRow)
  }

  update(id: string, patch: AgentPatch): void {
    const assignments: string[] = []
    const params: SqlValue[] = []
    const set = (column: string, value: SqlValue): void => {
      assignments.push(`${column} = ?`)
      params.push(value)
    }
    // 显式字段白名单：SQL 片段只来自这里，不会把任意键拼进语句。
    if (patch.workspaceId !== undefined) set('workspace_id', patch.workspaceId)
    if (patch.name !== undefined) set('name', patch.name)
    if (patch.preset !== undefined) set('preset', patch.preset)
    if (patch.command !== undefined) set('command', patch.command)
    if (patch.argsTemplate !== undefined) set('args_template', patch.argsTemplate)
    if (patch.rolePrompt !== undefined) set('role_prompt', patch.rolePrompt)
    if (patch.pathScope !== undefined) set('path_scope_json', JSON.stringify(patch.pathScope))
    if (patch.permissionProfile !== undefined) {
      set('permission_profile', patch.permissionProfile)
    }
    if (patch.canDelegate !== undefined) set('can_delegate', patch.canDelegate ? 1 : 0)
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0)

    if (assignments.length === 0) return
    this.db.raw.run(`UPDATE agents SET ${assignments.join(', ')} WHERE id = ?`, [...params, id])
    this.db.persist()
  }
}
