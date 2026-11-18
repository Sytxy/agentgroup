import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Notification, shell } from 'electron'
import { IPC } from '../shared/ipc'
import { createAppContext, type AppContext } from './app-context'
import { createIpcHandlers } from './ipc-handlers'
import { notifyTaskFinished } from './notifications'

/** 应用上下文在 whenReady 后创建；will-quit 时用来关闭数据库。 */
let context: AppContext | null = null

/**
 * 定位 sql.js 的 wasm 文件。
 * 开发模式用依赖包内路径；打包后优先用 electron-builder 复制到 resources 的副本，
 * 两者都不存在时返回 undefined，交给 sql.js 的默认查找逻辑。
 */
function resolveWasmPath(): string | undefined {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'sql-wasm.wasm')
    if (existsSync(packaged)) {
      return packaged
    }
  }
  try {
    return require.resolve('sql.js/dist/sql-wasm.wasm')
  } catch {
    console.warn('未能定位 sql.js wasm 文件，交给 sql.js 默认查找')
    return undefined
  }
}

// 创建应用主窗口：开发模式加载 electron-vite 提供的渲染进程地址，
// 生产模式加载构建产物中的 index.html。
function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'AgentGroup',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

/**
 * 把 EventBus 事件转发到所有窗口。
 * 每个 webContents.send 单独 try/catch：某个窗口已销毁或渲染进程异常时，
 * 不能让异常冒泡回 EventBus，否则会中断 Dispatcher/任务管理器的正常流程。
 */
function forwardEvents(appContext: AppContext): void {
  appContext.events.on((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        window.webContents.send(IPC.events, event)
      } catch (error) {
        console.error('推送事件到渲染进程失败', error)
      }
    }
  })
}

/**
 * 任务终态的系统通知。
 * 通知失败（系统权限、窗口销毁等）只记录日志，不能冒泡回 EventBus 影响任务编排。
 */
function subscribeTaskNotifications(appContext: AppContext): void {
  if (!Notification.isSupported()) {
    return
  }
  appContext.events.on((event) => {
    if (event.type !== 'task-updated') {
      return
    }
    try {
      notifyTaskFinished(event.task, Notification)
    } catch (error) {
      console.error('发送任务通知失败', error)
    }
  })
}

void app
  .whenReady()
  .then(async () => {
    const userData = app.getPath('userData')
    const appContext = await createAppContext({
      dbPath: join(userData, 'agentgroup.db'),
      wasmPath: resolveWasmPath(),
      worktreesRoot: join(userData, 'worktrees'),
      logsRoot: join(userData, 'logs'),
      openPath: async (path) => {
        // shell.openPath 以空字符串表示成功，非空字符串是系统返回的错误说明。
        const message = await shell.openPath(path)
        if (message !== '') {
          throw new Error(message)
        }
      }
    })
    context = appContext

    for (const [channel, handler] of Object.entries(createIpcHandlers(appContext))) {
      ipcMain.handle(channel, (_event, payload) => handler(payload))
    }

    forwardEvents(appContext)
    subscribeTaskNotifications(appContext)
    createWindow()

    // 恢复顺序：先把上次未合并的 done 任务重新交给合并协调器，再启动调度。
    // 两者都依赖 onTaskDone 已在 createAppContext 中绑定。
    appContext.taskManager.recoverInterrupted()
    appContext.taskManager.start()

    // macOS 点击 Dock 图标且没有窗口时重新创建窗口。
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((error: unknown) => {
    console.error('AgentGroup 启动失败', error)
    app.quit()
  })

// macOS 习惯：关闭全部窗口后不退出应用，由用户显式退出。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 退出前关闭数据库，避免 sql.js 内存中的状态无谓地留在进程里。
app.on('will-quit', () => {
  context?.db.close()
  context = null
})
