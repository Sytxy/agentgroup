// 通知辅助函数测试：只在 merged / failed / conflict 三个终态弹出通知，
// 通过注入假的 Notification 构造器验证标题、正文与调用次数，不依赖 Electron。
import { describe, expect, test } from 'vitest'
import type { Task, TaskStatus } from '../src/shared/types'
import { notifyTaskFinished } from '../src/main/notifications'

function task(status: TaskStatus): Task {
  return {
    id: 't1',
    workspaceId: 'w1',
    agentId: 'a1',
    parentTaskId: null,
    taskType: 'code',
    title: '修复登录',
    prompt: '修复登录',
    branch: 'agent/t1',
    worktreePath: '/tmp/worktrees/w1/t1',
    baseRef: 'abc123',
    status,
    exitCode: null,
    summary: null,
    createdAt: '2026-11-18T00:00:00.000Z',
    startedAt: '2026-11-18T00:01:00.000Z',
    finishedAt: null
  }
}

interface Shown {
  title: string
  body: string
}

/** 收集所有被 show() 的通知内容。 */
function fakeNotification(): {
  create: new (options: { title: string; body: string }) => { show(): void }
  shown: Shown[]
} {
  const shown: Shown[] = []
  class FakeNotification {
    private readonly options: { title: string; body: string }

    constructor(options: { title: string; body: string }) {
      this.options = options
    }

    show(): void {
      shown.push(this.options)
    }
  }
  return { create: FakeNotification, shown }
}

describe('任务完成通知', () => {
  test('notification helper fires for failed and merged only', () => {
    const merged = fakeNotification()
    notifyTaskFinished(task('merged'), merged.create)
    expect(merged.shown).toHaveLength(1)
    expect(merged.shown[0]?.title).toBe('任务完成')
    expect(merged.shown[0]?.body).toContain('修复登录')

    const failed = fakeNotification()
    notifyTaskFinished(task('failed'), failed.create)
    expect(failed.shown).toHaveLength(1)
    expect(failed.shown[0]?.title).toBe('任务失败')
    expect(failed.shown[0]?.body).toContain('修复登录')

    // 冲突同样需要用户处理，也要通知
    const conflict = fakeNotification()
    notifyTaskFinished(task('conflict'), conflict.create)
    expect(conflict.shown).toHaveLength(1)
    expect(conflict.shown[0]?.title).toBe('合并冲突')
    expect(conflict.shown[0]?.body).toContain('修复登录')

    // 其余状态（包括等待确认、已放弃、已取消）都不弹通知
    const otherStatuses: TaskStatus[] = [
      'queued',
      'preparing',
      'running',
      'done',
      'merging',
      'awaiting_approval',
      'cancelled',
      'interrupted',
      'abandoned'
    ]
    for (const status of otherStatuses) {
      const quiet = fakeNotification()
      notifyTaskFinished(task(status), quiet.create)
      expect(quiet.shown).toHaveLength(0)
    }
  })

  test('missing notification constructor is a no-op', () => {
    expect(() => notifyTaskFinished(task('merged'))).not.toThrow()
  })
})
