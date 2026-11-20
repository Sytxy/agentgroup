// 添加 Agent：默认先检测本机已安装的 CLI，检测到的可一键添加；
// 未安装的显示安装命令；也可以切到手动配置接入任意命令。
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentConfig, DetectedAgent, PermissionProfile } from '../../../shared/types'
import { addAgent, detectAgents } from '../api'

interface AddAgentDialogProps {
  workspaceId: string
  /** 已有成员，用于避免一键添加时重名。 */
  existingAgents?: AgentConfig[]
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
  existingAgents = [],
  onAdded,
  onClose
}: AddAgentDialogProps): React.JSX.Element {
  const [mode, setMode] = useState<'gallery' | 'manual'>('gallery')
  const [candidates, setCandidates] = useState<DetectedAgent[] | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [addingId, setAddingId] = useState<string | null>(null)

  // 手动配置表单状态；只有切到手动模式时才会被渲染。
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

  const refresh = useCallback(async (): Promise<void> => {
    setDetecting(true)
    setDetectError(null)
    try {
      setCandidates(await detectAgents())
    } catch (cause) {
      setDetectError(errorMessage(cause))
    } finally {
      setDetecting(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const installedCandidates = candidates?.filter((candidate) => candidate.installed) ?? []
  const installedCount = installedCandidates.length
  const loggedOutCount = installedCandidates.filter(
    (candidate) => candidate.loggedIn === false
  ).length

  const handleAddDetected = async (candidate: DetectedAgent): Promise<void> => {
    setAddingId(candidate.id)
    setDetectError(null)
    try {
      const created = await addAgent({
        id: crypto.randomUUID(),
        workspaceId,
        name: uniqueName(candidate.command, existingAgents),
        preset: candidate.preset,
        command: candidate.command,
        argsTemplate: null,
        rolePrompt: candidate.rolePrompt,
        pathScope: [],
        permissionProfile: 'edit-and-run',
        canDelegate: false,
        enabled: true
      })
      await onAdded(created)
      onClose()
    } catch (cause) {
      setDetectError(errorMessage(cause))
    } finally {
      setAddingId(null)
    }
  }

  return createPortal(
    <div className="dialog-backdrop">
      {mode === 'gallery' ? (
        <section
          className="dialog-card dialog-card-wide agent-gallery-card"
          role="dialog"
          aria-modal="true"
          aria-label="添加 Agent"
        >
          <div className="agent-gallery-head">
            <div>
              <h2 className="dialog-title">添加 Agent</h2>
              <p className="dialog-hint">
                从本机检测到的 CLI 中添加，或手动配置任意命令。
              </p>
            </div>
            <div className="agent-gallery-actions">
              <button
                type="button"
                className="dialog-button"
                disabled={detecting}
                onClick={() => void refresh()}
              >
                {detecting ? '检测中…' : '重新检测'}
              </button>
              <button type="button" className="dialog-button" onClick={onClose}>
                取消
              </button>
            </div>
          </div>

          {detectError !== null && (
            <p className="dialog-error" role="alert">
              检测失败：{detectError}
            </p>
          )}

          {candidates === null ? (
            <p className="panel-empty">
              {detecting ? '正在检测本机 Agent…' : '没有检测结果，可以手动配置。'}
            </p>
          ) : (
            <>
              <p className="agent-gallery-summary">
                已检测到 {installedCount} 个本地 Agent
                {loggedOutCount > 0 ? `，其中 ${loggedOutCount} 个未登录` : ''}
              </p>
              <div className="agent-gallery-grid">
                {candidates.map((candidate) => {
                  const status = candidateStatus(candidate)
                  return (
                    <article className="agent-candidate" key={candidate.id}>
                      <div className="agent-candidate-head">
                        <span
                          className="agent-avatar candidate-avatar"
                          data-preset={candidate.preset}
                          aria-hidden="true"
                        >
                          {agentInitial(candidate.name)}
                        </span>
                        <div className="agent-candidate-title">
                          <h3>{candidate.name}</h3>
                          <p>{candidate.vendor}</p>
                        </div>
                      </div>
                      <div className="agent-candidate-meta">
                        <span className={status.className}>{status.label}</span>
                      </div>
                      <p className="agent-candidate-desc">{candidate.description}</p>
                      {candidate.installed ? (
                        <>
                          <p
                            className="agent-candidate-path"
                            title={candidate.path ?? undefined}
                          >
                            {candidate.version ?? '版本未知'} · {candidate.path}
                          </p>
                          {candidate.loggedIn === false && candidate.loginHint !== null && (
                            <p className="agent-candidate-login">
                              未登录，先在终端运行 <code>{candidate.loginHint}</code>
                            </p>
                          )}
                        </>
                      ) : (
                        <code className="agent-candidate-install">{candidate.installHint}</code>
                      )}
                      <div className="agent-candidate-actions">
                        <button
                          type="button"
                          className="dialog-button dialog-button-primary"
                          disabled={
                            !candidate.installed ||
                            candidate.loggedIn === false ||
                            addingId !== null
                          }
                          title={
                            candidate.loggedIn === false && candidate.loginHint !== null
                              ? `请先在终端运行 ${candidate.loginHint}`
                              : undefined
                          }
                          onClick={() => void handleAddDetected(candidate)}
                        >
                          {!candidate.installed
                            ? '未安装'
                            : candidate.loggedIn === false
                              ? '未登录'
                              : addingId === candidate.id
                                ? '添加中…'
                                : '添加'}
                        </button>
                      </div>
                    </article>
                  )
                })}
              </div>
            </>
          )}

          <div className="agent-gallery-footer">
            <button
              type="button"
              className="agent-manual-link"
              onClick={() => setMode('manual')}
            >
              手动配置自定义 Agent
            </button>
            <p className="dialog-hint">
              检测到的 Agent 默认使用「可编辑并运行命令」；添加后可在成员面板改名或停用。
            </p>
          </div>
        </section>
      ) : (
        <form
          className="dialog-card dialog-card-wide"
          role="dialog"
          aria-modal="true"
          aria-label="手动配置 Agent"
          onSubmit={(event) => void handleManualSubmit(event)}
        >
          <button type="button" className="dialog-back" onClick={() => setMode('gallery')}>
            ← 返回检测列表
          </button>
          <h2 className="dialog-title">手动配置 Agent</h2>
          <p className="dialog-hint">适用于没有被自动检测到的 CLI，或需要自定义参数模板的情况。</p>

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
              警示：Claude Code 的「可编辑并运行命令」使用 bypassPermissions，
              <strong>没有目录沙箱</strong>：Agent 不仅能修改任务 worktree，还能读写
              <strong>整个用户账户</strong>下的文件，并以你的 macOS 账户权限执行任意命令。
              Codex 使用 workspace-write 沙箱，写入限制在任务 worktree 内，但命令仍以你的账户权限运行。
              请只对可信的 CLI 使用此档位。
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
      )}
    </div>,
    document.body
  )

  async function handleManualSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
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

  function handlePresetChange(next: Preset): void {
    setPreset(next)
    setCommand(PRESET_COMMANDS[next])
    setArgsTemplate('')
  }
}

/** 一键添加时避免重名：claude、claude2、claude3… */
function uniqueName(base: string, existing: AgentConfig[]): string {
  const taken = new Set(existing.map((agent) => agent.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) {
    return base
  }
  let suffix = 2
  while (taken.has(`${base}${suffix}`.toLowerCase())) {
    suffix += 1
  }
  return `${base}${suffix}`
}

function agentInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}

/** 候选卡片的登录/安装状态；未登录单独用警示色，避免用户添加后才发现无法运行。 */
function candidateStatus(candidate: DetectedAgent): { label: string; className: string } {
  if (!candidate.installed) {
    return { label: '未检测到', className: 'agent-candidate-status' }
  }
  if (candidate.loggedIn === false) {
    return {
      label: '未登录',
      className: 'agent-candidate-status agent-candidate-blocked'
    }
  }
  return {
    label: candidate.loggedIn === true ? '已登录' : '已安装',
    className: 'agent-candidate-status agent-candidate-ready'
  }
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
