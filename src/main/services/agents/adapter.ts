/**
 * Agent 运行适配器的公共接口与错误类型。
 *
 * 适配器把具体 CLI（Claude、Codex、用户自定义命令）的原始输出统一成 AgentEvent 流，
 * 供任务管理器写入日志、回群进度与生成最终摘要。不依赖 Electron。
 */

export type AgentEvent =
  | { type: 'log'; text: string } // 原始输出行（已剥离 ANSI 控制码），写入任务日志
  | {
      type: 'progress'
      text: string
      /** 工具调用的稳定指纹，用于发现 Agent 反复重试同一命令；普通文本进度没有。 */
      signature?: string
    }
  | { type: 'final'; summary: string } // 进程正常结束后的最终摘要

export interface AgentAdapter {
  start(input: { prompt: string; cwd: string; signal: AbortSignal }): AsyncIterable<AgentEvent>
}

export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null
  ) {
    super(message)
    this.name = 'AgentRunError'
  }
}
