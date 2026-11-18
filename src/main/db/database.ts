// SQLite（sql.js / WASM）连接与持久化。
// sql.js 在内存中操作数据库，写操作后必须显式导出并落盘，读操作不落盘。
import fs from 'node:fs'
import path from 'node:path'
import initSqlJs from 'sql.js'
import { SCHEMA_SQL } from './schema'

export type SqlValue = string | number | Uint8Array | null
export type Row = Record<string, SqlValue>

export class Db {
  private closed = false

  constructor(
    readonly raw: initSqlJs.Database,
    readonly filePath: string
  ) {}

  /** 将内存数据库导出并写入磁盘。所有写操作后由仓储调用。 */
  persist(): void {
    fs.writeFileSync(this.filePath, this.raw.export())
  }

  /** 关闭数据库；重复调用安全，便于测试清理时无需关心是否已关闭。 */
  close(): void {
    if (this.closed) return
    this.raw.close()
    this.closed = true
  }
}

/**
 * 打开（或创建）数据库文件并确保表结构存在。
 * wasmPath 由调用方提供：测试传入 node_modules 中的 wasm，Electron 传入打包路径；
 * 未提供时交给 sql.js 的默认查找逻辑。
 */
export async function openDatabase(filePath: string, wasmPath?: string): Promise<Db> {
  const SQL = await initSqlJs(wasmPath ? { locateFile: () => wasmPath } : undefined)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  // 已存在的数据库文件直接载入，否则创建空库并建表。
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null
  const raw = new SQL.Database(existing)
  raw.run(SCHEMA_SQL)
  return new Db(raw, filePath)
}

/** 执行查询并把结果行转换为以列名为键的对象。 */
export function queryRows(db: Db, sql: string, params: SqlValue[] = []): Row[] {
  const statement = db.raw.prepare(sql)
  try {
    statement.bind(params)
    const rows: Row[] = []
    while (statement.step()) {
      rows.push(statement.getAsObject())
    }
    return rows
  } finally {
    statement.free()
  }
}

// 以下取值函数在列类型与期望不符时抛错，避免把 null/undefined 静默带入领域对象。
export function text(row: Row, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new Error(`expected TEXT value in column "${column}"`)
  }
  return value
}

export function nullableText(row: Row, column: string): string | null {
  const value = row[column]
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new Error(`expected TEXT or NULL value in column "${column}"`)
  }
  return value
}

export function integer(row: Row, column: string): number {
  const value = row[column]
  if (typeof value !== 'number') {
    throw new Error(`expected INTEGER value in column "${column}"`)
  }
  return value
}

export function nullableInteger(row: Row, column: string): number | null {
  const value = row[column]
  if (value === null) return null
  if (typeof value !== 'number') {
    throw new Error(`expected INTEGER or NULL value in column "${column}"`)
  }
  return value
}

export function boolean(row: Row, column: string): boolean {
  const value = integer(row, column)
  if (value !== 0 && value !== 1) {
    throw new Error(`expected 0/1 boolean value in column "${column}"`)
  }
  return value === 1
}

export function jsonStringArray(row: Row, column: string): string[] {
  const parsed: unknown = JSON.parse(text(row, column))
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`expected JSON string array in column "${column}"`)
  }
  return parsed
}
