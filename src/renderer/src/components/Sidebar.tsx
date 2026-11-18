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
      <div className="sidebar-brand">{APP_NAME}</div>
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
    </aside>
  )
}
