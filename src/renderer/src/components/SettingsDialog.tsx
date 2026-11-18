// 工作区设置对话框：合并策略、自动测试、setup 命令/复制、目标分支与超时。
// 保存时只提交 workspace:update 白名单内的字段，成功后把服务端返回的工作区交回父组件。
import { useState } from 'react'
import type { AgentConfig, Workspace } from '../../../shared/types'
import { updateWorkspace, type WorkspaceSettingsPatch } from '../api'

interface SettingsDialogProps {
  workspace: Workspace
  agents: AgentConfig[]
  onSaved: (workspace: Workspace) => void
  onClose: () => void
}

export default function SettingsDialog({
  workspace,
  agents,
  onSaved,
  onClose
}: SettingsDialogProps): React.JSX.Element {
  const [autoMerge, setAutoMerge] = useState(workspace.autoMerge)
  const [autoTestAfterMerge, setAutoTestAfterMerge] = useState(workspace.autoTestAfterMerge)
  const [setupCommand, setSetupCommand] = useState(workspace.setupCommand ?? '')
  const [setupCopy, setSetupCopy] = useState(workspace.setupCopy.join('\n'))
  const [targetBranch, setTargetBranch] = useState(workspace.targetBranch ?? '')
  const [taskTimeoutMin, setTaskTimeoutMin] = useState(String(workspace.taskTimeoutMin))
  const [setupTimeoutMin, setSetupTimeoutMin] = useState(String(workspace.setupTimeoutMin))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enabledAgents = agents.filter((agent) => agent.enabled)
  // 默认/测试 Agent 已删除或停用时视为未设置，避免把失效 id 写回
  const initialDefaultAgent =
    workspace.defaultAgentId !== null &&
    enabledAgents.some((agent) => agent.id === workspace.defaultAgentId)
      ? workspace.defaultAgentId
      : ''
  const [defaultAgentId, setDefaultAgentId] = useState(initialDefaultAgent)
  const initialTestAgent =
    workspace.testAgentId !== null &&
    enabledAgents.some((agent) => agent.id === workspace.testAgentId)
      ? workspace.testAgentId
      : ''
  const [testAgentId, setTestAgentId] = useState(initialTestAgent)

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (submitting) {
      return
    }

    const taskTimeout = Number(taskTimeoutMin)
    if (!Number.isFinite(taskTimeout) || taskTimeout <= 0) {
      setError('任务超时必须大于 0 分钟')
      return
    }
    const setupTimeout = Number(setupTimeoutMin)
    if (!Number.isFinite(setupTimeout) || setupTimeout <= 0) {
      setError('setup 超时必须大于 0 分钟')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const patch: WorkspaceSettingsPatch = {
        autoMerge,
        autoTestAfterMerge,
        defaultAgentId: defaultAgentId === '' ? null : defaultAgentId,
        testAgentId: testAgentId === '' ? null : testAgentId,
        setupCommand: setupCommand.trim() === '' ? null : setupCommand.trim(),
        setupCopy: parseList(setupCopy),
        targetBranch: targetBranch.trim() === '' ? null : targetBranch.trim(),
        taskTimeoutMin: taskTimeout,
        setupTimeoutMin: setupTimeout
      }
      const updated = await updateWorkspace(workspace.id, patch)
      onSaved(updated)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="dialog-backdrop">
      <form
        className="dialog-card dialog-card-wide"
        role="dialog"
        aria-modal="true"
        aria-label="工作区设置"
        onSubmit={handleSubmit}
      >
        <h2 className="dialog-title">工作区设置</h2>

        <label className="dialog-checkbox">
          <input
            type="checkbox"
            checked={autoMerge}
            onChange={(event) => setAutoMerge(event.target.checked)}
          />
          任务完成后自动合并（关闭后需在任务卡片确认）
        </label>

        <label className="dialog-checkbox">
          <input
            type="checkbox"
            checked={autoTestAfterMerge}
            onChange={(event) => setAutoTestAfterMerge(event.target.checked)}
          />
          每次代码任务合并后自动创建测试任务
        </label>

        <label className="dialog-field" htmlFor="settings-default-agent">
          默认 Agent（未 @ 时）
          <select
            id="settings-default-agent"
            value={defaultAgentId}
            onChange={(event) => setDefaultAgentId(event.target.value)}
          >
            <option value="">不设置</option>
            {enabledAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <p className="dialog-hint">
          消息里没有 @ 任何人时，整条消息会交给这个成员。
        </p>

        <label className="dialog-field" htmlFor="settings-test-agent">
          测试 Agent
          <select
            id="settings-test-agent"
            value={testAgentId}
            onChange={(event) => setTestAgentId(event.target.value)}
          >
            <option value="">不设置</option>
            {enabledAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>

        <label className="dialog-field" htmlFor="settings-setup-command">
          setup 命令
          <input
            id="settings-setup-command"
            type="text"
            value={setupCommand}
            placeholder="例如：pnpm install"
            onChange={(event) => setSetupCommand(event.target.value)}
          />
        </label>

        <label className="dialog-field" htmlFor="settings-setup-copy">
          setup 复制文件
          <textarea
            id="settings-setup-copy"
            rows={3}
            value={setupCopy}
            placeholder="相对仓库根路径，逗号或换行分隔，例如：.env, config/local.json"
            onChange={(event) => setSetupCopy(event.target.value)}
          />
        </label>

        <label className="dialog-field" htmlFor="settings-target-branch">
          目标分支
          <input
            id="settings-target-branch"
            type="text"
            value={targetBranch}
            placeholder="留空表示不设置"
            onChange={(event) => setTargetBranch(event.target.value)}
          />
        </label>

        <div className="dialog-row">
          <label className="dialog-field" htmlFor="settings-task-timeout">
            任务超时（分钟）
            <input
              id="settings-task-timeout"
              type="number"
              min={1}
              value={taskTimeoutMin}
              onChange={(event) => setTaskTimeoutMin(event.target.value)}
            />
          </label>
          <label className="dialog-field" htmlFor="settings-setup-timeout">
            setup 超时（分钟）
            <input
              id="settings-setup-timeout"
              type="number"
              min={1}
              value={setupTimeoutMin}
              onChange={(event) => setSetupTimeoutMin(event.target.value)}
            />
          </label>
        </div>

        {error !== null && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" className="dialog-button" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="dialog-button dialog-button-primary"
            disabled={submitting}
          >
            保存设置
          </button>
        </div>
      </form>
    </div>
  )
}

/** setup 复制列表：兼容逗号与换行分隔，去掉空白项。 */
function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
