import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DesktopApi, type IpcChannel } from '../shared/ipc'
import type { AppEvent } from '../shared/types'

// 只允许渲染进程 invoke 请求/响应通道；events 是主进程单向推送，
// 白名单同时避免渲染进程调用任意 Electron 内部通道。
const invokableChannels = new Set<string>(
  Object.values(IPC).filter((channel) => channel !== IPC.events)
)

const api: DesktopApi = {
  invoke(channel: IpcChannel, payload?: unknown): Promise<unknown> {
    if (!invokableChannels.has(channel)) {
      return Promise.reject(new Error(`未知 IPC 通道：${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
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
