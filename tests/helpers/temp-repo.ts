import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TempRepo {
  /** 临时根目录，测试创建的 worktree 等产物放在这里 */
  root: string
  /** 已初始化并完成首次提交的 git 仓库目录 */
  path: string
  cleanup: () => Promise<void>
}

/** 测试内部直接执行 git 命令，用于准备/断言仓库状态，避免依赖被测的 GitService */
export function gitRun(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message
        reject(new Error(`git ${args.join(' ')} failed: ${detail}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/** 创建隔离的临时 git 仓库，调用方在测试结束时必须执行 cleanup */
export async function createTempRepo(): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), 'agentgroup-git-'))
  const path = join(root, 'repo')
  await mkdir(path)

  await gitRun(path, ['init'])
  await gitRun(path, ['config', 'user.name', 'AgentGroup Test'])
  await gitRun(path, ['config', 'user.email', 'agentgroup@example.com'])
  await writeFile(join(path, 'README.md'), '# AgentGroup temp repo\n')
  await gitRun(path, ['add', 'README.md'])
  await gitRun(path, ['commit', '-m', 'initial commit'])

  return {
    root,
    path,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    }
  }
}
