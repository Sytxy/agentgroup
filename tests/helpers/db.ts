// 测试用数据库助手：每个测试使用独立的临时目录与数据库文件，避免相互污染。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { openDatabase, type Db } from '../../src/main/db/database'

const require = createRequire(import.meta.url)
// sql.js 的 wasm 文件与主入口一起发布在 dist 目录；测试中显式传入，避免依赖默认查找逻辑。
export const WASM_PATH = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')

export interface TestDb {
  db: Db
  filePath: string
  cleanup(): Promise<void>
}

/** 创建临时目录并打开其中的数据库文件。cleanup 会关闭数据库并删除临时目录。 */
export async function createTestDb(): Promise<TestDb> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentgroup-db-'))
  const filePath = path.join(dir, 'agentgroup.db')
  const db = await openDatabase(filePath, WASM_PATH)
  return {
    db,
    filePath,
    async cleanup() {
      db.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
}
