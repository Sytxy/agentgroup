/**
 * 全流程集成测试。
 *
 * 使用真实的 sql.js 数据库、临时 git 仓库与真实 worktree，装配真实的
 * Dispatcher/TaskManager/MergeCoordinator/WorkspaceService，只用脚本化
 * FakeAdapter 替代 Agent CLI，验证单元测试覆盖不到的链路：
 * 并行 worktree 合并、冲突解决任务、越界审批闸门。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { INTEGRATION_BRANCH } from '../../src/main/services/workspace-service'
import type { Task } from '../../src/shared/types'
import { gitRun } from '../helpers/temp-repo'
import {
  createTestContext,
  waitForTaskStatus,
  type TestContext
} from '../helpers/test-context'

/** 单条场景涉及多次 git 子进程调用，留足余量；等待逻辑本身最多 10 秒。 */
const E2E_TIMEOUT_MS = 60_000

let ctx: TestContext | undefined

afterEach(async () => {
  await ctx?.cleanup()
  ctx = undefined
})

/** 在 Agent 的 worktree 内写入文件，自动创建父目录 */
async function writeFileIn(cwd: string, file: string, content: string): Promise<void> {
  const target = join(cwd, file)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

/** 按 Agent 名称从本次分派结果中定位任务 */
function taskOf(context: TestContext, agentName: string, tasks: Task[]): Task {
  const agent = context.agent(agentName)
  const task = tasks.find((candidate) => candidate.agentId === agent.id)
  if (task === undefined) {
    throw new Error(`未找到 Agent ${agentName} 的任务`)
  }
  return task
}

/** 等待指定 Agent 的任一任务合入 integration，用于稳定控制合并先后顺序 */
async function waitAgentMerged(context: TestContext, agentName: string): Promise<void> {
  const agent = context.agent(agentName)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const merged = context.tasks
      .listByWorkspace(context.workspace.id)
      .some((task) => task.agentId === agent.id && task.status === 'merged')
    if (merged) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Agent ${agentName} 的任务未在 10 秒内合并`)
}

describe('full flow', () => {
  test(
    'three agents edit disjoint files in parallel and all merge',
    async () => {
      ctx = await createTestContext({
        agents: [
          {
            name: 'claude',
            preset: 'claude',
            run: (cwd) => writeFileIn(cwd, 'docs/a.md', 'claude content\n')
          },
          {
            name: 'codex',
            preset: 'codex',
            run: (cwd) => writeFileIn(cwd, 'docs/b.md', 'codex content\n')
          },
          {
            name: 'deepseek',
            preset: 'custom',
            run: (cwd) => writeFileIn(cwd, 'docs/c.md', 'deepseek content\n')
          }
        ]
      })

      const dispatched = await ctx.dispatcher.send(
        ctx.workspace.id,
        '@claude 写 a @codex 写 b @deepseek 写 c'
      )
      expect(dispatched.tasks).toHaveLength(3)

      const mergedTasks: Task[] = []
      for (const name of ['claude', 'codex', 'deepseek']) {
        mergedTasks.push(
          await waitForTaskStatus(ctx.tasks, taskOf(ctx, name, dispatched.tasks).id, 'merged')
        )
      }
      // 每个任务使用各自的 worktree，证明三条分支是并行修改后独立合并的
      expect(new Set(mergedTasks.map((task) => task.worktreePath)).size).toBe(3)

      expect(await readFile(join(ctx.integrationPath, 'docs/a.md'), 'utf8')).toBe(
        'claude content\n'
      )
      expect(await readFile(join(ctx.integrationPath, 'docs/b.md'), 'utf8')).toBe(
        'codex content\n'
      )
      expect(await readFile(join(ctx.integrationPath, 'docs/c.md'), 'utf8')).toBe(
        'deepseek content\n'
      )
    },
    E2E_TIMEOUT_MS
  )

  test(
    'two agents editing the same file produce a conflict then resolve task merges',
    async () => {
      const resolvedReadme = '# AgentGroup temp repo\n\nalpha line\nbeta line\n'
      // context 在 dispatch 之后才被脚本读取；脚本只会在任务真正启动时执行。
      let context!: TestContext
      context = await createTestContext({
        agents: [
          {
            name: 'alpha',
            run: (cwd) => writeFileIn(cwd, 'README.md', 'alpha line\n')
          },
          {
            name: 'beta',
            run: async (cwd) => {
              await writeFileIn(cwd, 'README.md', 'beta line\n')
              // 等 alpha 先合入再结束，使 beta 的合并稳定地产生冲突。
              await waitAgentMerged(context, 'alpha')
            }
          },
          {
            name: 'resolver',
            run: async (cwd) => {
              // 复现 Agent 解决冲突的完整动作：把 integration 合入当前分支、
              // 改写冲突文件、add 并提交。
              await gitRun(cwd, ['merge', '--no-ff', INTEGRATION_BRANCH]).catch(() => undefined)
              await writeFileIn(cwd, 'README.md', resolvedReadme)
              await gitRun(cwd, ['add', 'README.md'])
              await gitRun(cwd, ['commit', '-m', 'resolve README conflict'])
            }
          }
        ]
      })
      ctx = context

      const dispatched = await ctx.dispatcher.send(
        ctx.workspace.id,
        '@alpha 改 README @beta 改 README'
      )
      const alphaTask = taskOf(ctx, 'alpha', dispatched.tasks)
      const betaTask = taskOf(ctx, 'beta', dispatched.tasks)

      await waitForTaskStatus(ctx.tasks, alphaTask.id, 'merged')
      const conflict = await waitForTaskStatus(ctx.tasks, betaTask.id, 'conflict')
      expect(conflict.summary).toContain('README.md')
      // 冲突未合入：integration 保持 alpha 的内容
      expect(await readFile(join(ctx.integrationPath, 'README.md'), 'utf8')).toBe('alpha line\n')

      const resolver = ctx.agent('resolver')
      const resolveTask = ctx.coordinator.createResolveTask(conflict.id, resolver.id)

      await waitForTaskStatus(ctx.tasks, resolveTask.id, 'merged')
      // 解决任务合入后，父冲突任务一并收敛为 merged
      await waitForTaskStatus(ctx.tasks, conflict.id, 'merged')
      expect(await readFile(join(ctx.integrationPath, 'README.md'), 'utf8')).toBe(resolvedReadme)
    },
    E2E_TIMEOUT_MS
  )

  test(
    'out-of-scope change waits for approval and merges after approve',
    async () => {
      ctx = await createTestContext({
        agents: [
          {
            name: 'claude',
            pathScope: ['src/**'],
            run: (cwd) => writeFileIn(cwd, 'README.md', 'approved content\n')
          }
        ]
      })

      const dispatched = await ctx.dispatcher.send(ctx.workspace.id, '@claude 修改 README')
      const task = taskOf(ctx, 'claude', dispatched.tasks)

      await waitForTaskStatus(ctx.tasks, task.id, 'awaiting_approval')
      // 越界修改未获批前不能进入 integration
      expect(await readFile(join(ctx.integrationPath, 'README.md'), 'utf8')).toBe(
        '# AgentGroup temp repo\n'
      )

      await ctx.coordinator.approve(task.id)
      await waitForTaskStatus(ctx.tasks, task.id, 'merged')
      expect(await readFile(join(ctx.integrationPath, 'README.md'), 'utf8')).toBe(
        'approved content\n'
      )
    },
    E2E_TIMEOUT_MS
  )

  test(
    'a message without mentions goes to the workspace default agent',
    async () => {
      ctx = await createTestContext({
        agents: [
          {
            name: 'claude',
            run: (cwd) => writeFileIn(cwd, 'DEFAULT.md', 'default content\n')
          }
        ]
      })
      const claude = ctx.agent('claude')
      ctx.workspaces.update(ctx.workspace.id, { defaultAgentId: claude.id })

      const dispatched = await ctx.dispatcher.send(ctx.workspace.id, '把默认任务做完')

      expect(dispatched.tasks).toHaveLength(1)
      expect(dispatched.tasks[0]?.agentId).toBe(claude.id)
      await waitForTaskStatus(ctx.tasks, dispatched.tasks[0]!.id, 'merged')
      expect(await readFile(join(ctx.integrationPath, 'DEFAULT.md'), 'utf8')).toBe(
        'default content\n'
      )
    },
    E2E_TIMEOUT_MS
  )
})
