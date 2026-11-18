// SQLite（sql.js / WASM）连接与持久化。
// sql.js 在内存中操作数据库，写操作后必须显式导出并落盘，读操作不落盘。
import fs from 'node:fs'
import path from 'node:path'
import initSqlJs from 'sql.js'
import { SCHEMA_SQL } from './schema'

export type SqlValue = string | number | Uint8Array | null
export type Row = Record<string, SqlValue>

/** 清理持久化失败时留下的临时文件；清理失败不能掩盖原始错误 */
function removeIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch {
    // 文件可能尚未创建或已被删除，无需处理
  }
}

export class Db {
  private closed = false

  constructor(
    readonly raw: initSqlJs.Database,
    readonly filePath: string
  ) {}

  /**
   * 将内存数据库导出并原子地写入磁盘。所有写操作后由仓储调用。
   *
   * 直接写目标文件时，进程在 write 中途崩溃会把整个数据库截断。这里先把新内容
   * 写入 `<file>.tmp` 并 fsync，把上一代文件复制为 `<file>.bak`，最后用 rename
   * 原子替换目标文件：任何时刻目标路径要么是完整旧文件，要么是完整新文件。
   * 写入/替换失败时清理临时文件并向上抛出，不静默吞掉持久化错误。
   */
  persist(): void {
    const data = this.raw.export()
    const tmpPath = `${this.filePath}.tmp`
    const backupPath = `${this.filePath}.bak`

    const fd = fs.openSync(tmpPath, 'w')
    try {
      try {
        fs.writeFileSync(fd, data)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    } catch (error) {
      removeIfExists(tmpPath)
      throw error
    }

    try {
      if (fs.existsSync(this.filePath)) {
        fs.copyFileSync(this.filePath, backupPath)
      }
      fs.renameSync(tmpPath, this.filePath)
    } catch (error) {
      // rename 失败时旧文件仍在原位置，删除临时文件后把错误交给调用方
      removeIfExists(tmpPath)
      throw error
    }
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
