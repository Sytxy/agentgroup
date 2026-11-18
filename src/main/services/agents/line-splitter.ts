/**
 * 行切分器：把 PTY / 管道输出的任意分块切成完整文本行。
 *
 * - 半行会暂存在内部缓冲区，等下一次 push 补全；
 * - 同时兼容 `\n` 与 `\r\n`（CRLF 的 `\r` 会被去掉）；
 * - 剥离 ANSI CSI 转义序列（颜色、光标控制等），避免日志与进度里出现乱码。
 */

// CSI 序列：ESC [ 参数 中间字节 终止字节，例如 \x1b[31m、\x1b[0m。
const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g

export class LineSplitter {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []

    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      lines.push(this.normalize(rawLine))
      newlineIndex = this.buffer.indexOf('\n')
    }

    // 缓冲区里的半行可能以被分块截断的转义序列结尾，等完整行到达时再统一剥离。
    return lines
  }

  flush(): string[] {
    if (this.buffer.length === 0) {
      return []
    }
    const rawLine = this.buffer
    this.buffer = ''
    return [this.normalize(rawLine)]
  }

  private normalize(rawLine: string): string {
    const withoutCr = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    return withoutCr.replace(ANSI_CSI_PATTERN, '')
  }
}
