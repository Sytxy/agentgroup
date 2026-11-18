/**
 * 基于 node-pty 的进程运行器。
 *
 * 单独成文件，避免只使用管道模式的测试在导入 process-runner 时加载 node-pty 原生模块。
 * PTY 会把终端控制序列原样输出，调用方需要配合 LineSplitter 使用。
 */

import * as pty from 'node-pty'
import type { ProcessHandle, ProcessRunner } from './process-runner'

export class PtyRunner implements ProcessRunner {
  spawn(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): ProcessHandle {
    // node-pty 要求 env 的值全部是字符串，过滤掉 ProcessEnv 里可能存在的 undefined。
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(opts.env ?? process.env)) {
      if (value !== undefined) {
        env[key] = value
      }
    }

    const terminal = pty.spawn(cmd, args, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: opts.cwd,
      env
    })

    const dataCallbacks: Array<(chunk: string) => void> = []
    const exitCallbacks: Array<(code: number | null, error?: Error) => void> = []
    let exitResult: { code: number | null; error?: Error } | null = null

    terminal.onData((chunk) => {
      for (const callback of dataCallbacks) {
        callback(chunk)
      }
    })

    terminal.onExit(({ exitCode }) => {
      if (exitResult !== null) {
        return
      }
      exitResult = { code: exitCode }
      for (const callback of exitCallbacks) {
        callback(exitCode)
      }
    })

    return {
      onData(callback) {
        dataCallbacks.push(callback)
      },
      onExit(callback) {
        if (exitResult !== null) {
          callback(exitResult.code, exitResult.error)
          return
        }
        exitCallbacks.push(callback)
      },
      kill() {
        if (exitResult !== null) {
          return
        }
        try {
          terminal.kill()
        } catch {
          // PTY 可能已经退出，忽略。
        }
      }
    }
  }
}
