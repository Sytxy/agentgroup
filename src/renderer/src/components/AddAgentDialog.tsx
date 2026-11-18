// 添加 Agent 对话框：三个预设、权限档位、路径范围与委派开关。
// 提交时构造完整的 AgentConfig（id 由渲染进程生成），交给 agents:add 落库。
import { useState } from 'react'
import type { AgentConfig, PermissionProfile } from '../../../shared/types'
import { addAgent } from '../api'

interface AddAgentDialogProps {
  workspaceId: string
  onAdded: (agent: AgentConfig) => void | Promise<void>
  onClose: () => void
}

type Preset = AgentConfig['preset']

const PRESET_LABELS: Record<Preset, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  custom: '自定义'
}

/** 预设对应的默认命令；自定义时由用户填写。 */
const PRESET_COMMANDS: Record<Preset, string> = {
  claude: 'claude',
  codex: 'codex',
  custom: ''
}

const PERMISSION_LABELS: Record<PermissionProfile, string> = {
  'read-only': '只读',
  'edit-only': '仅编辑',
  'edit-and-run': '可编辑并运行命令'
}

export default function AddAgentDialog({
  workspaceId,
  onAdded,
  onClose
}: AddAgentDialogProps): React.JSX.Element {
  const [preset, setPreset] = useState<Preset>('claude')
  const [name, setName] = useState('')
  const [rolePrompt, setRolePrompt] = useState('')
  const [command, setCommand] = useState(PRESET_COMMANDS.claude)
  const [argsTemplate, setArgsTemplate] = useState('')
  const [pathScope, setPathScope] = useState('')
  const [permissionProfile, setPermissionProfile] =
    useState<PermissionProfile>('edit-only')
  const [canDelegate, setCanDelegate] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 切换预设时同步默认命令；自定义预设让命令与参数模板完全由用户填写
  const handlePresetChange = (next: Preset): void => {
    setPreset(next)
    setCommand(PRESET_COMMANDS[next])
    setArgsTemplate('')
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (submitting) {
      return
    }
    const trimmedName = name.trim()
    if (trimmedName === '') {
      setError('请填写成员名称')
      return
    }
    const trimmedCommand = command.trim()
    if (trimmedCommand === '') {
      setError('请填写 Agent 命令')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const created = await addAgent({
        id: crypto.randomUUID(),
        workspaceId,
        name: trimmedName,
        preset,
        command: trimmedCommand,
        // 参数模板只对自定义命令生效；预设适配器自行拼接参数
        argsTemplate:
          preset === 'custom' && argsTemplate.trim() !== '' ? argsTemplate.trim() : null,
        rolePrompt,
        pathScope: parsePathScope(pathScope),
        permissionProfile,
        canDelegate,
        enabled: true
      })
      await onAdded(created)
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="dialog-backdrop">
      <form
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label="添加 Agent"
        onSubmit={handleSubmit}
      >
        <h2 className="dialog-title">添加 Agent</h2>

        <label className="dialog-field" htmlFor="agent-preset">
          预设
          <select
            id="agent-preset"
            value={preset}
            onChange={(event) => handlePresetChange(event.target.value as Preset)}
          >
            {(['claude', 'codex', 'custom'] as const).map((value) => (
              <option key={value} value={value}>
                {PRESET_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="dialog-field" htmlFor="agent-name">
          名称
          <input
            id="agent-name"
            type="text"
            value={name}
            autoFocus
            placeholder="例如：claude"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className="dialog-field" htmlFor="agent-role-prompt">
          角色说明
          <textarea
            id="agent-role-prompt"
            rows={3}
            value={rolePrompt}
            placeholder="写进每个任务 prompt 的角色说明，例如：负责前端页面与样式"
            onChange={(event) => setRolePrompt(event.target.value)}
          />
        </label>

        <label className="dialog-field" htmlFor="agent-command">
          命令
          <input
            id="agent-command"
            type="text"
            value={command}
            disabled={preset !== 'custom'}
            placeholder="例如：my-agent-cli"
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>

        {preset === 'custom' && (
          <label className="dialog-field" htmlFor="agent-args-template">
            参数模板
            <input
              id="agent-args-template"
              type="text"
              value={argsTemplate}
              placeholder="参数模板，使用 {prompt} 占位，例如：--prompt {prompt}"
              onChange={(event) => setArgsTemplate(event.target.value)}
            />
          </label>
        )}

        <label className="dialog-field" htmlFor="agent-path-scope">
          路径范围
          <input
            id="agent-path-scope"
            type="text"
            value={pathScope}
            placeholder="逗号分隔，例如：web/**, server/**"
            onChange={(event) => setPathScope(event.target.value)}
          />
        </label>

        <label className="dialog-field" htmlFor="agent-permission">
          权限档位
          <select
            id="agent-permission"
            value={permissionProfile}
            onChange={(event) => setPermissionProfile(event.target.value as PermissionProfile)}
          >
            {(['read-only', 'edit-only', 'edit-and-run'] as const).map((value) => (
              <option key={value} value={value}>
                {PERMISSION_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        {permissionProfile === 'edit-and-run' && (
          <p className="dialog-warning" data-testid="permission-warning" role="alert">
            警示：「可编辑并运行命令」允许 Agent 修改文件并执行任意命令（构建、测试、安装依赖），
            命令以你的 macOS 账户权限运行。请只对可信的 CLI 使用此档位。
          </p>
        )}

        <label className="dialog-checkbox">
          <input
            type="checkbox"
            aria-label="允许委派"
            checked={canDelegate}
            onChange={(event) => setCanDelegate(event.target.checked)}
          />
          允许委派（输出中的 @ 提及会创建后续任务）
        </label>

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
            添加
          </button>
        </div>
      </form>
    </div>
  )
}

/** 逗号分隔的路径范围：去空白、去空项。 */
function parsePathScope(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
