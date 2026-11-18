/**
 * 串行队列：合并等不允许并发的操作按提交顺序逐个执行。
 * 任务失败只会让该任务自己的 Promise reject，不会中断后续任务的执行。
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(job: () => Promise<T>): Promise<T> {
    // 接在链尾执行；catch 仅用于吞掉链路上的失败，避免污染下一个任务，
    // 失败本身通过返回的 result 继续抛给调用方。
    const result = this.tail.then(() => job())
    this.tail = result.catch(() => undefined)
    return result
  }
}
