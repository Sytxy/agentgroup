// 左侧工作区列表：切换当前工作区，并提供新建项目的入口。
import { APP_NAME } from '../../../shared/constants'
import type { Workspace } from '../../../shared/types'

interface SidebarProps {
  workspaces: Workspace[]
  selectedId: string | null
  onSelect: (workspaceId: string) => void
  onCreate: () => void
}

export default function Sidebar({
  workspaces,
  selectedId,
  onSelect,
  onCreate
}: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark" aria-hidden="true" />
        <span className="sidebar-brand-name">{APP_NAME}</span>
      </div>
      <p className="sidebar-tagline">多 Agent 协作台</p>
      <div className="sidebar-section-head">
        <span>项目</span>
        <span>{workspaces.length}</span>
      </div>
      <button type="button" className="workspace-add" onClick={onCreate}>
        <span aria-hidden="true">＋</span> 新建项目
      </button>
      <nav className="workspace-list" aria-label="项目列表">
        {workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            className={
              workspace.id === selectedId
                ? 'workspace-item workspace-item-active'
                : 'workspace-item'
            }
            aria-current={workspace.id === selectedId ? 'true' : undefined}
            onClick={() => onSelect(workspace.id)}
          >
            <span className="workspace-item-avatar" aria-hidden="true">
              {workspaceInitial(workspace.name)}
            </span>
            <span className="workspace-item-text">
              <span className="workspace-item-name">{workspace.name}</span>
              <span className="workspace-item-path">{workspace.repoPath}</span>
            </span>
          </button>
        ))}
      </nav>
      <footer className="sidebar-footer">
        <span className="sidebar-local-dot" aria-hidden="true" />
        本地运行 · 数据留在本机
      </footer>
    </aside>
  )
}

/** 项目头像用名称首字，中文取第一个字，空名用“项”。 */
function workspaceInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '项'
}
