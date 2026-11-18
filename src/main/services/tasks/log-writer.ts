/**
 * 任务完整日志写入器。
 *
 * 数据库只保存任务摘要，Agent 的逐行输出写入 <logsRoot>/<taskId>.log 供任务卡片展开查看。
 * 每次任务启动先重置文件，重试时不会混入上一次运行的输出。
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export class LogWriter {
  private readonly filePath: string
  /** 目录只需创建一次，避免每行输出都触发 mkdir */
  private directoryReady = false

  constructor(logsRoot: string, taskId: string) {
    this.filePath = join(logsRoot, `${taskId}.log`)
  }

  /** 任务开始时清空旧日志并确保目录存在 */
  async reset(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, '')
    this.directoryReady = true
  }

  async append(text: string): Promise<void> {
    if (!this.directoryReady) {
      await mkdir(dirname(this.filePath), { recursive: true })
      this.directoryReady = true
    }
    await appendFile(this.filePath, text)
  }
}
