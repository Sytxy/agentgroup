// 左侧工作区列表：切换当前工作区。v1 只登记一个工作区，但列表结构为多工作区预留。
import { APP_NAME } from '../../../shared/constants'
import type { Workspace } from '../../../shared/types'

interface SidebarProps {
  workspaces: Workspace[]
  selectedId: string | null
  onSelect: (workspaceId: string) => void
}

export default function Sidebar({
  workspaces,
  selectedId,
  onSelect
}: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark" aria-hidden="true" />
        <span className="sidebar-brand-name">{APP_NAME}</span>
      </div>
      <p className="sidebar-tagline">多 Agent 协作台</p>
      <nav className="workspace-list" aria-label="工作区列表">
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
            <span className="workspace-item-name">{workspace.name}</span>
            <span className="workspace-item-path">{workspace.repoPath}</span>
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
