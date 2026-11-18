import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { GitService } from '../../src/main/services/git/git'
import { createTempRepo, gitRun, type TempRepo } from '../helpers/temp-repo'

describe('GitService', () => {
  let repo: TempRepo
  let git: GitService

  beforeEach(async () => {
    repo = await createTempRepo()
    git = new GitService()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  test('assertRepo returns the repository root', async () => {
    const expectedRoot = await realpath(repo.path)
    expect(await git.assertRepo(repo.path)).toBe(expectedRoot)

    const subdir = join(repo.path, 'nested', 'dir')
    await mkdir(subdir, { recursive: true })
    expect(await git.assertRepo(subdir)).toBe(expectedRoot)
  })

  test('worktreeAdd creates branch and directory', async () => {
    const worktreePath = join(repo.root, 'wt-feature')
    await git.worktreeAdd(repo.path, worktreePath, 'feat-a', 'HEAD')

    expect(await git.branchExists(repo.path, 'feat-a')).toBe(true)
    expect(await git.branchExists(repo.path, 'missing-branch')).toBe(false)
    expect(await readFile(join(worktreePath, 'README.md'), 'utf8')).toContain('AgentGroup temp repo')

    const { stdout } = await gitRun(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(stdout.trim()).toBe('feat-a')

    await git.worktreeRemove(repo.path, worktreePath)
    expect(existsSync(worktreePath)).toBe(false)
  })

  test('worktreeAddExisting checks out an existing branch', async () => {
    await git.createBranch(repo.path, 'existing', 'HEAD')
    const worktreePath = join(repo.root, 'wt-existing')

    await git.worktreeAddExisting(repo.path, worktreePath, 'existing')

    const { stdout } = await gitRun(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(stdout.trim()).toBe('existing')

    await git.worktreeRemove(repo.path, worktreePath)
    expect(existsSync(worktreePath)).toBe(false)
  })

  test('commitAll returns null when nothing changed', async () => {
    expect(await git.commitAll(repo.path, 'empty commit')).toBeNull()

    await writeFile(join(repo.path, 'NOTES.md'), 'one\n')
    const hash = await git.commitAll(repo.path, 'add notes')

    expect(hash).toMatch(/^[0-9a-f]{40}$/)
    expect(hash).toBe(await git.head(repo.path))

    const { stdout: message } = await gitRun(repo.path, ['log', '-1', '--pretty=%s'])
    expect(message.trim()).toBe('add notes')

    const { stdout: status } = await gitRun(repo.path, ['status', '--porcelain'])
    expect(status.trim()).toBe('')
  })

  test('changedFiles and diffStat reflect committed changes', async () => {
    const base = await git.head(repo.path)
    await appendFile(join(repo.path, 'README.md'), 'extra line\n')
    await writeFile(join(repo.path, 'NOTES.md'), 'one\ntwo\n')
    await git.commitAll(repo.path, 'make changes')

    const files = await git.changedFiles(repo.path, base)
    expect(files.sort()).toEqual(['NOTES.md', 'README.md'])
    expect(await git.diffStat(repo.path, base)).toEqual({ files: 2, insertions: 3, deletions: 0 })
  })

  test('merge reports conflict files and mergeAbort leaves clean status', async () => {
    const { stdout: branchOut } = await gitRun(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const defaultBranch = branchOut.trim()

    await git.createBranch(repo.path, 'feature', 'HEAD')

    await writeFile(join(repo.path, 'README.md'), 'main version\n')
    await git.commitAll(repo.path, 'main change')

    await gitRun(repo.path, ['checkout', 'feature'])
    await writeFile(join(repo.path, 'README.md'), 'feature version\n')
    await git.commitAll(repo.path, 'feature change')

    await gitRun(repo.path, ['checkout', defaultBranch])
    const result = await git.merge(repo.path, 'feature')

    expect(result).toEqual({ status: 'conflict', conflicts: ['README.md'] })

    await git.mergeAbort(repo.path)
    const { stdout: status } = await gitRun(repo.path, ['status', '--porcelain'])
    expect(status.trim()).toBe('')
  })

  test('merge reports merged for a clean merge', async () => {
    const { stdout: branchOut } = await gitRun(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const defaultBranch = branchOut.trim()

    await git.createBranch(repo.path, 'feature', 'HEAD')
    await gitRun(repo.path, ['checkout', 'feature'])
    await writeFile(join(repo.path, 'FEATURE.md'), 'feature\n')
    await git.commitAll(repo.path, 'feature work')
    await gitRun(repo.path, ['checkout', defaultBranch])

    expect(await git.merge(repo.path, 'feature')).toEqual({ status: 'merged' })
    expect(existsSync(join(repo.path, 'FEATURE.md'))).toBe(true)
  })
})
