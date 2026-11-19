import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DesktopApi, type IpcChannel } from '../shared/ipc'
import { cleanIpcErrorMessage } from '../shared/ipc-error'
import type { AppEvent } from '../shared/types'

// 只允许渲染进程 invoke 请求/响应通道；events 是主进程单向推送，
// 白名单同时避免渲染进程调用任意 Electron 内部通道。
const invokableChannels = new Set<string>(
  Object.values(IPC).filter((channel) => channel !== IPC.events)
)

const api: DesktopApi = {
  async invoke(channel: IpcChannel, payload?: unknown): Promise<unknown> {
    if (!invokableChannels.has(channel)) {
      throw new Error(`未知 IPC 通道：${channel}`)
    }
    try {
      return await ipcRenderer.invoke(channel, payload)
    } catch (error) {
      // 去掉 Electron 的 remote method 包装和主进程的通道前缀，界面只显示业务错误。
      throw new Error(cleanIpcErrorMessage(channel, error))
    }
  },

  onEvent(callback: (event: AppEvent) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, event: AppEvent): void => {
      callback(event)
    }
    ipcRenderer.on(IPC.events, listener)
    return () => {
      ipcRenderer.removeListener(IPC.events, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
