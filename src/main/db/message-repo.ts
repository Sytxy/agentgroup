import type { ChatMessage } from '../../shared/types'
import {
  nullableText,
  queryRows,
  text,
  type Db,
  type Row,
  type SqlValue
} from './database'

export type MessagePatch = Partial<Omit<ChatMessage, 'id' | 'createdAt'>>

function mapRow(row: Row): ChatMessage {
  return {
    id: text(row, 'id'),
    workspaceId: text(row, 'workspace_id'),
    kind: text(row, 'kind') as ChatMessage['kind'],
    authorType: text(row, 'author_type') as ChatMessage['authorType'],
    authorId: nullableText(row, 'author_id'),
    content: text(row, 'content'),
    taskId: nullableText(row, 'task_id'),
    createdAt: text(row, 'created_at')
  }
}

export class MessageRepo {
  constructor(private readonly db: Db) {}

  insert(message: ChatMessage): void {
    this.db.raw.run(
      `INSERT INTO messages (
        id, workspace_id, kind, author_type, author_id, content, task_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.workspaceId,
        message.kind,
        message.authorType,
        message.authorId,
        message.content,
        message.taskId,
        message.createdAt
      ]
    )
    this.db.persist()
  }

  get(id: string): ChatMessage | null {
    const [row] = queryRows(this.db, 'SELECT * FROM messages WHERE id = ?', [id])
    return row ? mapRow(row) : null
  }

  /** 群聊按时间正序展示；同一时间戳下用 rowid ASC 保持插入顺序。 */
  listByWorkspace(workspaceId: string): ChatMessage[] {
    return queryRows(
      this.db,
      'SELECT * FROM messages WHERE workspace_id = ? ORDER BY created_at ASC, rowid ASC',
      [workspaceId]
    ).map(mapRow)
  }

  update(id: string, patch: MessagePatch): void {
    const assignments: string[] = []
    const params: SqlValue[] = []
    const set = (column: string, value: SqlValue): void => {
      assignments.push(`${column} = ?`)
      params.push(value)
    }
    // 显式字段白名单：SQL 片段只来自这里，不会把任意键拼进语句。
    if (patch.workspaceId !== undefined) set('workspace_id', patch.workspaceId)
    if (patch.kind !== undefined) set('kind', patch.kind)
    if (patch.authorType !== undefined) set('author_type', patch.authorType)
    if (patch.authorId !== undefined) set('author_id', patch.authorId)
    if (patch.content !== undefined) set('content', patch.content)
    if (patch.taskId !== undefined) set('task_id', patch.taskId)

    if (assignments.length === 0) return
    this.db.raw.run(`UPDATE messages SET ${assignments.join(', ')} WHERE id = ?`, [...params, id])
    this.db.persist()
  }
}
