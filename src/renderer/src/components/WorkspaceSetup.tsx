// 新建工作区表单：名称与仓库路径必填，目标分支可选。
// 成功后由父组件负责刷新列表并选中新工作区；失败时在表单内展示可读错误。
import { useState } from 'react'
import type { Workspace } from '../../../shared/types'
import { createWorkspace, pickFolder } from '../api'

interface WorkspaceSetupProps {
  onCreated: (workspace: Workspace) => void | Promise<void>
  /** 已有项目时从侧边栏进入，需要提供取消返回；首次创建没有可返回的界面。 */
  onCancel?: () => void
}

export default function WorkspaceSetup({
  onCreated,
  onCancel
}: WorkspaceSetupProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [picking, setPicking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 选择本机目录；项目名为空时用文件夹名作为默认项目名。 */
  const handlePickFolder = async (): Promise<void> => {
    setPicking(true)
    setError(null)
    try {
      const picked = await pickFolder()
      if (picked === null) {
        return
      }
      setRepoPath(picked)
      if (name.trim() === '') {
        setName(folderName(picked))
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPicking(false)
    }
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (submitting) {
      return
    }

    const trimmedName = name.trim()
    const trimmedRepoPath = repoPath.trim()
    if (trimmedName === '' || trimmedRepoPath === '') {
      setError('请填写项目名称和仓库路径')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const created = await createWorkspace({
        name: trimmedName,
        repoPath: trimmedRepoPath
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
      <aside className="setup-aside">
        <p className="setup-aside-brand">AgentGroup</p>
        <div className="setup-aside-copy">
          <p className="setup-aside-title">
            把多个 Agent，
            <br />
            放进同一个群。
          </p>
          <p className="setup-aside-lead">
            Claude Code、Codex 和你的自定义 CLI，在同一个仓库里并行工作。
            <br />
            进度、冲突和合并结果回到同一个对话。
          </p>
          <ul className="setup-points">
            <li>一条消息拆成多个任务</li>
            <li>每个任务独立 worktree</li>
            <li>结果合入 agentgroup/integration</li>
          </ul>
          <div className="setup-agents" aria-hidden="true">
            <span className="setup-agent">
              <span className="setup-agent-avatar" data-preset="claude">
                C
              </span>
              Claude
            </span>
            <span className="setup-agent">
              <span className="setup-agent-avatar" data-preset="codex">
                C
              </span>
              Codex
            </span>
            <span className="setup-agent">
              <span className="setup-agent-avatar" data-preset="custom">
                D
              </span>
              DeepSeek
            </span>
          </div>
        </div>
        <p className="setup-aside-foot">本地运行 · 数据留在本机</p>
      </aside>

      <form className="setup-card" onSubmit={handleSubmit}>
        <h1 className="setup-title">添加项目</h1>
        <p className="setup-hint">
          选择一个本地 git 仓库作为项目，AgentGroup 会创建集成分支并在其中协作。
        </p>

        <label className="setup-field" htmlFor="workspace-name">
          项目名称
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

        <div className="setup-field">
          <label htmlFor="workspace-repo-path">仓库路径</label>
          <div className="setup-path-row">
            <svg
              className="setup-path-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            </svg>
            <input
              id="workspace-repo-path"
              type="text"
              value={repoPath}
              required
              placeholder="/Users/me/work/my-repo"
              onChange={(event) => setRepoPath(event.target.value)}
            />
            <button
              type="button"
              className="setup-path-pick"
              disabled={picking || submitting}
              onClick={() => void handlePickFolder()}
            >
              {picking ? '选择中…' : '选择文件夹'}
            </button>
          </div>
        </div>
        <p className="setup-note">
          点击「选择文件夹」从本机选择，也可以直接粘贴路径。创建后会自动使用仓库当前分支作为差异对比基线，可在项目设置里修改。
        </p>

        {error !== null && (
          <p className="setup-error" role="alert">
            {error}
          </p>
        )}

        <div className="setup-actions">
          <button className="setup-submit" type="submit" disabled={submitting}>
            {submitting ? '添加中…' : '添加项目'}
          </button>
          {onCancel !== undefined && (
            <button
              className="setup-cancel"
              type="button"
              disabled={submitting}
              onClick={onCancel}
            >
              取消
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从目录路径取最后一级名称；结尾斜杠会被忽略。 */
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? '项目'
}
