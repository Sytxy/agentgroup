import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AgentConfig, ChatMessage, Task, Workspace } from '../../src/shared/types'
import { openDatabase } from '../../src/main/db/database'
import { AgentRepo } from '../../src/main/db/agent-repo'
import { MessageRepo } from '../../src/main/db/message-repo'
import { TaskRepo } from '../../src/main/db/task-repo'
import { WorkspaceRepo } from '../../src/main/db/workspace-repo'
import { createTestDb, WASM_PATH, type TestDb } from '../helpers/db'

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'demo group',
    repoPath: '/tmp/repo',
    integrationBranch: 'agentgroup/integration',
    targetBranch: 'main',
    setupCommand: 'pnpm install',
    setupCopy: ['.env', 'config/*.json'],
    setupTimeoutMin: 5,
    taskTimeoutMin: 30,
    autoMerge: true,
    autoTestAfterMerge: false,
    defaultAgentId: null,
    testAgentId: 'agent-2',
    testTaskTemplate: 'Run the test suite',
    lastVerification: 'unknown',
    createdAt: '2026-11-18T10:00:00.000Z',
    ...overrides
  }
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    workspaceId: 'ws-1',
    name: 'Claude',
    preset: 'claude',
    command: 'claude',
    argsTemplate: '--print {prompt}',
    rolePrompt: 'You are a careful engineer.',
    pathScope: ['src/**', 'tests/**'],
    permissionProfile: 'edit-and-run',
    canDelegate: true,
    enabled: true,
    ...overrides
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    parentTaskId: null,
    taskType: 'code',
    title: 'Add login page',
    prompt: 'Implement the login page',
    branch: 'task/task-1',
    worktreePath: '/tmp/wt/task-1',
    baseRef: 'abc123',
    status: 'queued',
    exitCode: null,
    summary: null,
    createdAt: '2026-11-18T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides
  }
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    workspaceId: 'ws-1',
    kind: 'user',
    authorType: 'user',
    authorId: null,
    content: '@Claude add a login page',
    taskId: null,
    createdAt: '2026-11-18T10:00:00.000Z',
    attachments: [],
    ...overrides
  }
}

describe('sqlite repositories', () => {
  let handle: TestDb
  let workspaces: WorkspaceRepo
  let agents: AgentRepo
  let tasks: TaskRepo
  let messages: MessageRepo

  beforeEach(async () => {
    handle = await createTestDb()
    workspaces = new WorkspaceRepo(handle.db)
    agents = new AgentRepo(handle.db)
    tasks = new TaskRepo(handle.db)
    messages = new MessageRepo(handle.db)
  })

  afterEach(async () => {
    await handle.cleanup()
  })

  test('workspace insert/get/list roundtrip', () => {
    const withValues = makeWorkspace()
    const withNulls = makeWorkspace({
      id: 'ws-2',
      name: 'nulls',
      targetBranch: null,
      setupCommand: null,
      setupCopy: [],
      autoMerge: false,
      autoTestAfterMerge: true,
      testAgentId: null,
      lastVerification: 'passed',
      createdAt: '2026-11-18T11:00:00.000Z'
    })

    workspaces.insert(withValues)
    workspaces.insert(withNulls)

    expect(workspaces.get('ws-1')).toEqual(withValues)
    expect(workspaces.get('ws-2')).toEqual(withNulls)
    expect(workspaces.get('missing')).toBeNull()
    expect(workspaces.list()).toEqual([withValues, withNulls])
  })

  test('workspace update applies allowlisted fields', () => {
    const workspace = makeWorkspace()
    workspaces.insert(workspace)

    workspaces.update('ws-1', {
      name: 'renamed',
      targetBranch: null,
      setupCopy: ['only.txt'],
      autoMerge: false,
      autoTestAfterMerge: true,
      lastVerification: 'failed'
    })

    expect(workspaces.get('ws-1')).toEqual({
      ...workspace,
      name: 'renamed',
      targetBranch: null,
      setupCopy: ['only.txt'],
      autoMerge: false,
      autoTestAfterMerge: true,
      lastVerification: 'failed'
    })
  })

  test('agent insert/get/listByWorkspace roundtrip', () => {
    const claude = makeAgent()
    const codex = makeAgent({
      id: 'agent-2',
      name: 'Codex',
      preset: 'codex',
      argsTemplate: null,
      pathScope: [],
      permissionProfile: 'read-only',
      canDelegate: false,
      enabled: false
    })
    const other = makeAgent({ id: 'agent-3', workspaceId: 'ws-2', name: 'Other' })

    agents.insert(claude)
    agents.insert(codex)
    agents.insert(other)

    expect(agents.get('agent-1')).toEqual(claude)
    expect(agents.get('agent-2')).toEqual(codex)
    expect(agents.get('missing')).toBeNull()
    expect(agents.listByWorkspace('ws-1')).toEqual([claude, codex])
    expect(agents.listByWorkspace('ws-2')).toEqual([other])
  })

  test('agent delete removes the row and keeps historical task references', () => {
    const claude = makeAgent()
    agents.insert(claude)
    tasks.insert(makeTask())

    agents.delete('agent-1')

    expect(agents.get('agent-1')).toBeNull()
    expect(agents.listByWorkspace('ws-1')).toEqual([])
    // 任务表的 agent_id 是普通 TEXT、没有外键，删除成员不影响历史任务记录。
    expect(tasks.get('task-1')).toEqual(makeTask())
  })

  test('task update status and list newest first', () => {
    const older = makeTask({ createdAt: '2026-11-18T10:00:00.000Z' })
    const newer = makeTask({
      id: 'task-2',
      createdAt: '2026-11-18T12:00:00.000Z'
    })
    // 相同 createdAt 时依靠 rowid DESC 保证后插入的排前面。
    const newerTie = makeTask({
      id: 'task-3',
      createdAt: '2026-11-18T12:00:00.000Z'
    })
    const otherWorkspace = makeTask({ id: 'task-4', workspaceId: 'ws-2' })

    tasks.insert(older)
    tasks.insert(newer)
    tasks.insert(newerTie)
    tasks.insert(otherWorkspace)

    expect(tasks.listByWorkspace('ws-1').map((t) => t.id)).toEqual([
      'task-3',
      'task-2',
      'task-1'
    ])

    tasks.update('task-1', {
      status: 'done',
      exitCode: 0,
      summary: 'Implemented',
      startedAt: '2026-11-18T10:01:00.000Z',
      finishedAt: '2026-11-18T10:05:00.000Z'
    })

    expect(tasks.get('task-1')).toEqual({
      ...older,
      status: 'done',
      exitCode: 0,
      summary: 'Implemented',
      startedAt: '2026-11-18T10:01:00.000Z',
      finishedAt: '2026-11-18T10:05:00.000Z'
    })
  })

  test('messages list ascending by createdAt', () => {
    const first = makeMessage({ id: 'msg-1', createdAt: '2026-11-18T10:00:00.000Z' })
    const second = makeMessage({ id: 'msg-2', createdAt: '2026-11-18T10:05:00.000Z' })
    const tie = makeMessage({ id: 'msg-3', createdAt: '2026-11-18T10:05:00.000Z' })
    const otherWorkspace = makeMessage({ id: 'msg-4', workspaceId: 'ws-2' })

    messages.insert(first)
    messages.insert(second)
    messages.insert(tie)
    messages.insert(otherWorkspace)

    expect(messages.get('msg-1')).toEqual(first)
    expect(messages.listByWorkspace('ws-1')).toEqual([first, second, tie])
  })

  test('reopening the database file preserves rows', async () => {
    const workspace = makeWorkspace()
    workspaces.insert(workspace)
    tasks.insert(makeTask())
    tasks.update('task-1', { status: 'done', exitCode: 0, summary: 'Finished' })
    handle.db.close()

    const reopened = await openDatabase(handle.filePath, WASM_PATH)
    try {
      expect(new WorkspaceRepo(reopened).get('ws-1')).toEqual(workspace)
      expect(new TaskRepo(reopened).get('task-1')).toEqual({
        ...makeTask(),
        status: 'done',
        exitCode: 0,
        summary: 'Finished'
      })
    } finally {
      reopened.close()
    }
  })

  test('persist writes atomically and keeps the previous generation readable', async () => {
    workspaces.insert(makeWorkspace())
    expect(fs.existsSync(`${handle.filePath}.tmp`)).toBe(false)
    const firstGeneration = fs.readFileSync(handle.filePath)

    workspaces.insert(makeWorkspace({ id: 'ws-2', name: 'second' }))

    // 临时文件在成功写入后必须消失；备份保留上一代完整文件
    expect(fs.existsSync(`${handle.filePath}.tmp`)).toBe(false)
    expect(fs.existsSync(`${handle.filePath}.bak`)).toBe(true)
    expect(fs.readFileSync(`${handle.filePath}.bak`)).toEqual(firstGeneration)
    expect(fs.statSync(handle.filePath).size).toBeGreaterThan(0)

    // 目标文件始终是完整数据库，可以直接重新打开
    handle.db.close()
    const reopened = await openDatabase(handle.filePath, WASM_PATH)
    try {
      expect(new WorkspaceRepo(reopened).list().map((row) => row.id)).toEqual(['ws-1', 'ws-2'])
    } finally {
      reopened.close()
    }
  })

  test('openDatabase adds default_agent_id to an existing legacy database', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'agentgroup-migrate-'))
    const file = join(dir, 'legacy.db')
    try {
      // 模拟旧版本数据库：workspaces 表没有 default_agent_id 列
      const SQL = await initSqlJs({ locateFile: () => WASM_PATH })
      const legacy = new SQL.Database()
      legacy.run(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
          integration_branch TEXT NOT NULL, target_branch TEXT, setup_command TEXT,
          setup_copy_json TEXT NOT NULL, setup_timeout_min INTEGER NOT NULL,
          task_timeout_min INTEGER NOT NULL, auto_merge INTEGER NOT NULL,
          auto_test_after_merge INTEGER NOT NULL, test_agent_id TEXT,
          test_task_template TEXT NOT NULL, last_verification TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `)
      fs.writeFileSync(file, Buffer.from(legacy.export()))
      legacy.close()

      const db = await openDatabase(file, WASM_PATH)
      try {
        const repo = new WorkspaceRepo(db)
        repo.insert(makeWorkspace({ id: 'ws-migrated' }))
        expect(repo.get('ws-migrated')?.defaultAgentId).toBeNull()
      } finally {
        db.close()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
