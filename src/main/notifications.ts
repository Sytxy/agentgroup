/**
 * 任务终态通知。
 *
 * 只在 merged / failed / conflict 三种需要用户关注的终态弹出通知，其余状态静默。
 * 本模块不依赖 Electron：Notification 构造器由调用方注入（生产环境传 Electron 的
 * Notification，测试传假构造器），避免主进程测试被迫加载 Electron 运行时。
 */
import type { Task, TaskStatus } from '../shared/types'

export interface NotificationPayload {
  title: string
  body: string
}

export interface NotificationInstance {
  show(): void
}

export type NotificationFactory = new (options: NotificationPayload) => NotificationInstance

/** 需要通知的状态 -> 通知标题。冲突同样需要用户处理，因此也通知。 */
const NOTIFY_TITLES: Partial<Record<TaskStatus, string>> = {
  merged: '任务完成',
  failed: '任务失败',
  conflict: '合并冲突'
}

/**
 * 为任务终态发送系统通知。
 * @param task 进入终态的任务
 * @param createNotification 通知构造器；未提供时什么也不做（例如测试或通知不可用的环境）
 */
export function notifyTaskFinished(task: Task, createNotification?: NotificationFactory): void {
  const title = NOTIFY_TITLES[task.status]
  if (title === undefined || createNotification === undefined) {
    return
  }
  const notification = new createNotification({ title, body: notificationBody(task) })
  notification.show()
}

function notificationBody(task: Task): string {
  switch (task.status) {
    case 'merged':
      return `「${task.title}」已合入集成分支。`
    case 'failed':
      return `「${task.title}」执行失败，请查看任务卡片中的日志。`
    case 'conflict':
      return `「${task.title}」合并冲突，请在任务卡片中指派解决或手动处理。`
    default:
      return task.title
  }
}
