// 新建工作区表单：名称与仓库路径必填，目标分支可选。
// 成功后由父组件负责刷新列表并选中新工作区；失败时在表单内展示可读错误。
import { useState } from 'react'
import type { Workspace } from '../../../shared/types'
import { createWorkspace } from '../api'

interface WorkspaceSetupProps {
  onCreated: (workspace: Workspace) => void | Promise<void>
}

export default function WorkspaceSetup({
  onCreated
}: WorkspaceSetupProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [targetBranch, setTargetBranch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (submitting) {
      return
    }

    const trimmedName = name.trim()
    const trimmedRepoPath = repoPath.trim()
    if (trimmedName === '' || trimmedRepoPath === '') {
      setError('请填写工作区名称和仓库路径')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const branch = targetBranch.trim()
      const created = await createWorkspace({
        name: trimmedName,
        repoPath: trimmedRepoPath,
        // 留空表示交给主进程默认使用仓库当前分支，而不是显式取消比较
        ...(branch === '' ? {} : { targetBranch: branch })
      })
      await onCreated(created)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="setup-screen">
      <form className="setup-card" onSubmit={handleSubmit}>
        <h1 className="setup-title">新建工作区</h1>
        <p className="setup-hint">
          选择一个本地 git 仓库，AgentGroup 会创建集成分支并在其中协作。
        </p>

        <label className="setup-field" htmlFor="workspace-name">
          工作区名称
          <input
            id="workspace-name"
            type="text"
            value={name}
            required
            autoFocus
            placeholder="例如：支付服务重构"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className="setup-field" htmlFor="workspace-repo-path">
          仓库路径
          <input
            id="workspace-repo-path"
            type="text"
            value={repoPath}
            required
            placeholder="/Users/me/work/my-repo"
            onChange={(event) => setRepoPath(event.target.value)}
          />
        </label>

        <label className="setup-field" htmlFor="workspace-target-branch">
          目标分支（可选）
          <input
            id="workspace-target-branch"
            type="text"
            value={targetBranch}
            placeholder="留空则使用仓库当前分支"
            onChange={(event) => setTargetBranch(event.target.value)}
          />
        </label>

        {error !== null && (
          <p className="setup-error" role="alert">
            {error}
          </p>
        )}

        <button className="setup-submit" type="submit" disabled={submitting}>
          {submitting ? '创建中…' : '创建工作区'}
        </button>
      </form>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
