import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { WorkspaceRepo } from '../../src/main/db/workspace-repo'
import { GitService } from '../../src/main/services/git/git'
import {
  INTEGRATION_BRANCH,
  WorkspaceService
} from '../../src/main/services/workspace-service'
import { createTestDb, type TestDb } from '../helpers/db'
import { createTempRepo, gitRun, type TempRepo } from '../helpers/temp-repo'

describe('WorkspaceService', () => {
  let tempRepo: TempRepo
  let testDb: TestDb
  let repo: WorkspaceRepo
  let git: GitService
  let service: WorkspaceService

  beforeEach(async () => {
    tempRepo = await createTempRepo()
    testDb = await createTestDb()
    repo = new WorkspaceRepo(testDb.db)
    git = new GitService()
    service = new WorkspaceService({
      repo,
      git,
      worktreesRoot: join(tempRepo.root, 'worktrees')
    })
  })

  afterEach(async () => {
    await testDb.cleanup()
    await tempRepo.cleanup()
  })

  test('create validates a git repo and creates integration branch + worktree', async () => {
    const { stdout: branchOut } = await gitRun(tempRepo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const currentBranch = branchOut.trim()

    const workspace = await service.create({ name: 'Demo', repoPath: tempRepo.path })

    const expectedRoot = await realpath(tempRepo.path)
    expect(workspace.repoPath).toBe(expectedRoot)
    // 未指定目标分支时默认使用仓库当前分支，保证 diff 统计有可比较的基线
    expect(workspace.targetBranch).toBe(currentBranch)
    expect(workspace.integrationBranch).toBe(INTEGRATION_BRANCH)
    expect(workspace).toMatchObject({
      id: expect.any(String),
      name: 'Demo',
      setupCommand: null,
      setupCopy: [],
      setupTimeoutMin: 10,
      taskTimeoutMin: 60,
      autoMerge: true,
      autoTestAfterMerge: false,
      testAgentId: null,
      testTaskTemplate: '运行全部测试并汇总失败用例',
      lastVerification: 'unknown',
      createdAt: expect.any(String)
    })

    expect(await git.branchExists(tempRepo.path, INTEGRATION_BRANCH)).toBe(true)

    const worktreePath = service.integrationWorktreePath(workspace.id)
    expect(existsSync(worktreePath)).toBe(true)
    const { stdout: worktreeBranch } = await gitRun(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(worktreeBranch.trim()).toBe(INTEGRATION_BRANCH)

    expect(repo.get(workspace.id)).toEqual(workspace)
    expect(service.list()).toEqual([workspace])
  })

  test('create rejects a non-git directory with a readable error', async () => {
    const plainDir = await mkdtemp(join(tmpdir(), 'agentgroup-plain-'))
    try {
      await expect(service.create({ name: 'Bad', repoPath: plainDir })).rejects.toThrow(plainDir)
      expect(service.list()).toEqual([])
    } finally {
      await rm(plainDir, { recursive: true, force: true })
    }
  })

  test('create rejects a second workspace for the same repository without side effects', async () => {
    const first = await service.create({ name: 'First', repoPath: tempRepo.path })
    const { stdout: before } = await gitRun(tempRepo.path, ['worktree', 'list', '--porcelain'])

    await expect(service.create({ name: 'Second', repoPath: tempRepo.path })).rejects.toThrow(
      /^该仓库已存在工作区：First$/
    )

    // 失败的第二次创建不能留下额外记录或 git 状态
    expect(service.list()).toEqual([first])
    expect(repo.get(first.id)).toEqual(first)
    const { stdout: after } = await gitRun(tempRepo.path, ['worktree', 'list', '--porcelain'])
    expect(after).toBe(before)
    expect(after.split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(2)
  })

  test('create reuses an existing integration branch', async () => {
    await git.createBranch(tempRepo.path, INTEGRATION_BRANCH, 'HEAD')
    const existingWorktree = join(tempRepo.root, 'existing-integration')
    await git.worktreeAddExisting(tempRepo.path, existingWorktree, INTEGRATION_BRANCH)
    await writeFile(join(existingWorktree, 'INTEGRATION.md'), 'integration work\n')
    await git.commitAll(existingWorktree, 'integration work')
    const existingHead = await git.head(existingWorktree)
    await git.worktreeRemove(tempRepo.path, existingWorktree)

    const workspace = await service.create({ name: 'Reuse', repoPath: tempRepo.path })

    expect(workspace.integrationBranch).toBe(INTEGRATION_BRANCH)
    // 分支未被重建，仍指向之前的提交
    const { stdout: branchHead } = await gitRun(tempRepo.path, [
      'rev-parse',
      INTEGRATION_BRANCH
    ])
    expect(branchHead.trim()).toBe(existingHead)
    expect(existsSync(join(service.integrationWorktreePath(workspace.id), 'INTEGRATION.md'))).toBe(
      true
    )
  })

  test('diffStat compares integration with target branch', async () => {
    const { stdout: branchOut } = await gitRun(tempRepo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const targetBranch = branchOut.trim()
    const workspace = await service.create({
      name: 'Diff',
      repoPath: tempRepo.path,
      targetBranch
    })

    const worktreePath = service.integrationWorktreePath(workspace.id)
    await writeFile(join(worktreePath, 'FEATURE.md'), 'one\ntwo\n')
    await git.commitAll(worktreePath, 'feat: add feature')

    expect(await service.diffStat(workspace)).toEqual({ files: 1, insertions: 2, deletions: 0 })
  })

  test('diffStat returns zero counts when target branch is null', async () => {
    const workspace = await service.create({
      name: 'No target',
      repoPath: tempRepo.path,
      targetBranch: null
    })

    expect(workspace.targetBranch).toBeNull()
    expect(await service.diffStat(workspace)).toEqual({ files: 0, insertions: 0, deletions: 0 })
  })

  test('list returns workspaces in creation order', async () => {
    const otherRepo = await createTempRepo()
    try {
      const first = await service.create({ name: 'First', repoPath: tempRepo.path })
      const second = await service.create({ name: 'Second', repoPath: otherRepo.path })

      expect(service.list()).toEqual([first, second])
    } finally {
      await otherRepo.cleanup()
    }
  })
})
