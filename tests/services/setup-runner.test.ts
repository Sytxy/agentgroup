import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { SetupRunner } from '../../src/main/services/tasks/setup-runner'

describe('SetupRunner', () => {
  let root: string
  let repoPath: string
  let worktreePath: string
  let runner: SetupRunner

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentgroup-setup-'))
    repoPath = join(root, 'repo')
    worktreePath = join(root, 'worktree')
    await mkdir(repoPath)
    await mkdir(worktreePath)
    runner = new SetupRunner()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('setup copies files and runs the command in the worktree', async () => {
    await writeFile(join(repoPath, '.env'), 'SECRET=1\n')
    await mkdir(join(repoPath, 'config', 'nested'), { recursive: true })
    await writeFile(join(repoPath, 'config', 'nested', 'app.txt'), 'app config\n')

    const result = await runner.run({
      worktreePath,
      repoPath,
      command: 'test -f .env && test -f config/nested/app.txt && touch ran-marker',
      copy: ['.env', 'config'],
      timeoutMin: 1
    })

    expect(result).toEqual({ ok: true, copiedPaths: ['.env', 'config'] })
    expect(await readFile(join(worktreePath, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(await readFile(join(worktreePath, 'config', 'nested', 'app.txt'), 'utf8')).toBe(
      'app config\n'
    )
    // 命令只有在 worktree 目录下执行并看到复制后的文件时才会创建标记
    expect(existsSync(join(worktreePath, 'ran-marker'))).toBe(true)
  })

  test('missing copy source fails with a readable error', async () => {
    const result = await runner.run({
      worktreePath,
      repoPath,
      command: 'touch should-not-run',
      copy: ['missing.env'],
      timeoutMin: 1
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('missing.env')
      expect(result.error).toContain('不存在')
    }
    // 复制失败时不应继续执行 setup 命令
    expect(existsSync(join(worktreePath, 'should-not-run'))).toBe(false)
  })

  test('failing setup command returns ok:false', async () => {
    const result = await runner.run({
      worktreePath,
      repoPath,
      command: 'echo setup-broke >&2; exit 3',
      copy: [],
      timeoutMin: 1
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('setup-broke')
    }
  })

  test('a timed out setup command returns ok:false', async () => {
    const result = await runner.run({
      worktreePath,
      repoPath,
      command: 'sleep 5',
      copy: [],
      timeoutMin: 0.02
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('超时')
    }
  })
})
