import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, shell } from 'electron'
import { IPC } from '../shared/ipc'
import { createAppContext, type AppContext } from './app-context'
import { serveAttachment } from './attachment-protocol'
import { createIpcHandlers } from './ipc-handlers'
import { notifyTaskFinished } from './notifications'
import { mergeUserPath } from './path-env'

// 附件图片走自定义协议，开发模式（http）和打包后的 file:// 都能加载本地图片。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'agentgroup-attachment',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

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

/**
 * 显式安装 macOS 应用菜单。
 * role: 'appMenu' 提供 About / Hide / Quit（Cmd+Q），editMenu 提供复制粘贴快捷键，
 * windowMenu 提供最小化/缩放。没有应用菜单时 Cmd+Q 可能不生效。
 */
function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ])
  )
}

// 创建应用主窗口：开发模式加载 electron-vite 提供的渲染进程地址，
// 生产模式加载构建产物中的 index.html。
function createWindow(): BrowserWindow {  const mainWindow = new BrowserWindow({
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

/**
 * 合并登录 shell 的 PATH。
 *
 * 从 Finder/LaunchServices 启动的 App 继承 launchd 的最小 PATH（通常只有
 * /usr/bin:/bin:/usr/sbin:/sbin），不包含 nvm、Homebrew、pnpm 等写在用户
 * shell profile 里的目录。Claude/Codex 预设按固定命令名启动 `claude`/`codex`，
 * 因此必须在创建任何 Agent 子进程之前补齐 PATH；读取失败时保留继承值，
 * 让任务以明确的“命令不存在”错误失败，而不是阻止整个应用启动。
 */
async function applyLoginShellPath(): Promise<void> {
  const shellPath = await new Promise<string | null>((resolve) => {
    execFile(
      process.env.SHELL || '/bin/zsh',
      ['-ilc', 'printf %s "$PATH"'],
      { timeout: 5000 },
      (error, stdout) => {
        if (error !== null) {
          console.warn('读取登录 shell PATH 失败，沿用当前 PATH', error)
          resolve(null)
          return
        }
        // 交互式登录 shell 可能在 PATH 前打印提示或版本信息，取最后一行非空输出。
        const lines = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
        resolve(lines[lines.length - 1] ?? null)
      }
    )
  })

  if (shellPath !== null && shellPath !== '') {
    process.env.PATH = mergeUserPath(process.env.PATH ?? '', shellPath)
  }
}

void app
  .whenReady()
  .then(async () => {
    // 必须先补齐 PATH，再创建 app context 或启动任何 Agent 子进程。
    await applyLoginShellPath()
    installApplicationMenu()
    const userData = app.getPath('userData')
    const appContext = await createAppContext({
      dbPath: join(userData, 'agentgroup.db'),
      wasmPath: resolveWasmPath(),
      worktreesRoot: join(userData, 'worktrees'),
      logsRoot: join(userData, 'logs'),
      attachmentsRoot: join(userData, 'attachments'),
      openPath: async (path) => {
        // shell.openPath 以空字符串表示成功，非空字符串是系统返回的错误说明。
        const message = await shell.openPath(path)
        if (message !== '') {
          throw new Error(message)
        }
      },
      pickFolder: async () => {
        const options: Electron.OpenDialogOptions = {
          title: '选择 Git 仓库',
          properties: ['openDirectory', 'createDirectory']
        }
        const parent = BrowserWindow.getFocusedWindow()
        const result = parent
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      }
    })
    context = appContext

    protocol.handle('agentgroup-attachment', (request) =>
      serveAttachment(request, appContext.attachmentsRoot)
    )

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

/**
 * 退出前先取消所有运行中的 Agent 任务。
 *
 * 子进程以独立进程组启动，直接退出会让仍在改文件的 Agent 变成孤儿进程。
 * 首次 before-quit 拦住退出，等待 cancelAll() 收尾后再调用 app.quit()；
 * quitting 标记防止第二次 before-quit 再次拦截导致无法退出。
 * 数据库由随后的 will-quit 关闭，保证取消过程中的状态写入仍然持久化。
 */
let quitting = false

app.on('before-quit', (event) => {
  const appContext = context
  if (quitting || appContext === null) {
    return
  }
  event.preventDefault()
  quitting = true
  void appContext.taskManager
    .cancelAll()
    .catch((error: unknown) => {
      console.error('取消运行中的任务失败', error)
    })
    .finally(() => {
      app.quit()
    })
})

// 退出前关闭数据库，避免 sql.js 内存中的状态无谓地留在进程里。
app.on('will-quit', () => {
  context?.db.close()
  context = null
})
