import type { AppEvent } from '../shared/types'

/**
 * 主进程内的事件总线。
 *
 * 同步广播给所有订阅者，供 IPC 层把群消息、任务状态等推送给渲染进程。
 * `on` 返回退订函数；广播时复制订阅者列表，允许监听器在回调中退订而不影响本次遍历。
 */
export class EventBus {
  private readonly listeners = new Set<(event: AppEvent) => void>()

  on(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: AppEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event)
    }
  }
}
