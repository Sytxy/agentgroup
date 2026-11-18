import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

// 创建应用主窗口：开发模式加载 electron-vite 提供的渲染进程地址，
// 生产模式加载构建产物中的 index.html。
function createWindow(): void {
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
}

void app.whenReady().then(() => {
  createWindow()

  // macOS 点击 Dock 图标且没有窗口时重新创建窗口。
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// macOS 习惯：关闭全部窗口后不退出应用，由用户显式退出。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
