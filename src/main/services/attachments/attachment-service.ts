import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import type { AttachmentInput, ChatAttachment } from '../../../shared/types'

export const MAX_ATTACHMENTS = 8
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * 保存聊天附件。
 *
 * 文件放在 <attachmentsRoot>/<attachmentId>/<safeName>，渲染进程通过
 * agentgroup-attachment://<id>/<name> 显示图片，Agent 则直接读取返回的绝对路径。
 * 只接收 base64 数据并限制数量/大小，文件名不参与目录拼接前的用户控制。
 */
export class AttachmentService {
  constructor(readonly root: string) {}

  async save(inputs: AttachmentInput[]): Promise<ChatAttachment[]> {
    if (inputs.length > MAX_ATTACHMENTS) {
      throw new Error(`一次最多发送 ${MAX_ATTACHMENTS} 个附件`)
    }

    return Promise.all(
      inputs.map(async (input) => {
        const data = Buffer.from(stripDataUrl(input.data), 'base64')
        if (data.length > MAX_ATTACHMENT_BYTES) {
          throw new Error(`附件「${input.name}」超过 20 MB`)
        }

        const id = randomUUID()
        const name = safeFileName(input.name)
        const directory = join(this.root, id)
        await mkdir(directory, { recursive: true })
        const path = join(directory, name)
        await writeFile(path, data)
        return {
          id,
          name,
          mimeType: input.mimeType === '' ? 'application/octet-stream' : input.mimeType,
          size: data.length,
          path,
          url: `agentgroup-attachment://${id}/${encodeURIComponent(name)}`
        }
      })
    )
  }

  /** 只允许打开附件根目录内的文件，避免渲染进程请求任意路径。 */
  owns(path: string): boolean {
    if (!isAbsolute(path)) {
      return false
    }
    const root = resolve(this.root)
    const target = resolve(path)
    return target === root || target.startsWith(`${root}${sep}`)
  }
}

function stripDataUrl(value: string): string {
  const comma = value.indexOf(',')
  return value.startsWith('data:') && comma !== -1 ? value.slice(comma + 1) : value
}

function safeFileName(input: string): string {
  const name = basename(input)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 120)
  if (name === '' || name === '.' || name === '..') {
    return 'attachment'
  }
  return name
}
