import { contextBridge } from 'electron'

// 预加载桥占位对象；后续任务会在此暴露类型化的 IPC 调用入口。
const api: Record<string, never> = {}

contextBridge.exposeInMainWorld('api', api)
