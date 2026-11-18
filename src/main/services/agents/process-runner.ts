/**
 * 进程运行器抽象：Adapter 只依赖 ProcessRunner，不直接依赖 child_process / node-pty，
 * 便于测试时替换成假实现，也便于在管道与 PTY 两种模式下复用同一套 Adapter。
 */

import { spawn } from 'node:child_process'

export interface ProcessHandle {
  /** 注册输出回调；stdout 与 stderr 都会通过该回调送入。 */
  onData(callback: (chunk: string) => void): void
  /**
   * 注册退出回调。spawn 失败（例如命令不存在）时会以 code=null 加 error 报告，
   * 由上层转换成 AgentRunError。
   */
  onExit(callback: (code: number | null, error?: Error) => void): void
  /** 终止进程；重复调用或进程已退出时为空操作。 */
  kill(): void
}

export interface ProcessRunner {
  spawn(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): ProcessHandle
}

// SIGTERM 后等待进程自行退出的时间，超时再发 SIGKILL 强制结束。
const KILL_GRACE_MS = 5000

export class ChildProcessRunner implements ProcessRunner {
  spawn(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): ProcessHandle {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      // 不提供 stdin，避免 Agent 等待用户输入而挂起。
      stdio: ['ignore', 'pipe', 'pipe'],
      // 独立进程组：kill 时连同 Agent 启动的子进程一起终止。
      detached: true
    })

    const dataCallbacks: Array<(chunk: string) => void> = []
    const exitCallbacks: Array<(code: number | null, error?: Error) => void> = []
    let exitResult: { code: number | null; error?: Error } | null = null
    let killRequested = false
    let killTimer: NodeJS.Timeout | null = null

    // setEncoding 让 Node 处理多字节字符被分块截断的情况。
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const callback of dataCallbacks) {
        callback(chunk)
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      for (const callback of dataCallbacks) {
        callback(chunk)
      }
    })

    const finish = (code: number | null, error?: Error) => {
      // error 与 close 可能先后触发（spawn 失败时），只报告一次退出结果。
      if (exitResult !== null) {
        return
      }
      exitResult = { code, error }
      if (killTimer !== null) {
        clearTimeout(killTimer)
        killTimer = null
      }
      for (const callback of exitCallbacks) {
        callback(code, error)
      }
    }

    // spawn 失败（如 ENOENT）只会触发 error 事件，此时没有退出码。
    child.on('error', (error) => finish(null, error))
    // close 在 stdio 全部关闭后触发，保证退出回调之前输出已经交给 onData。
    child.on('close', (code) => finish(code))

    return {
      onData(callback) {
        dataCallbacks.push(callback)
      },
      onExit(callback) {
        // 若退出事件早于回调注册，立即补发，避免调用方永远等待。
        if (exitResult !== null) {
          callback(exitResult.code, exitResult.error)
          return
        }
        exitCallbacks.push(callback)
      },
      kill() {
        if (exitResult !== null || killRequested || child.pid === undefined) {
          return
        }
        killRequested = true
        const pid = child.pid

        try {
          // 负 pid 表示向整个进程组发信号。
          process.kill(-pid, 'SIGTERM')
        } catch {
          // 进程可能已经退出（ESRCH），无需再处理。
        }

        killTimer = setTimeout(() => {
          killTimer = null
          if (exitResult !== null) {
            return
          }
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            // 同上：进程已退出。
          }
        }, KILL_GRACE_MS)
        // 计时器不应阻止进程/应用退出。
        killTimer.unref()
      }
    }
  }
}
