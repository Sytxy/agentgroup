// 把 Electron IPC 的原始错误整理成可直接展示的文案。
//
// ipcRenderer.invoke 会把主进程的拒绝包装成
// `Error invoking remote method '<channel>': Error: <原始消息>`；
// 主进程 handler 还会再加一层 `<channel> 失败：`。两层都去掉，
// 界面只显示真正的业务错误（例如“无法在 xxx 打开 git 仓库”）。
const REMOTE_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/

export function cleanIpcErrorMessage(channel: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const withoutRemote = raw.replace(REMOTE_PREFIX, '')
  const escapedChannel = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return withoutRemote.replace(new RegExp(`^${escapedChannel} 失败：`), '')
}
