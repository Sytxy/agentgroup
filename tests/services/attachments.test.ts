import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AttachmentService } from '../../src/main/services/attachments/attachment-service'

let root: string | null = null

afterEach(async () => {
  if (root !== null) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

describe('AttachmentService', () => {
  test('saves base64 attachments and only allows owned paths', async () => {
    root = await mkdtemp(join(tmpdir(), 'agentgroup-attachment-'))
    const service = new AttachmentService(root)

    const [attachment] = await service.save([
      {
        name: '../hello.txt',
        mimeType: 'text/plain',
        data: Buffer.from('hi').toString('base64')
      }
    ])
    if (attachment === undefined) {
      throw new Error('attachment missing')
    }

    expect(attachment).toMatchObject({
      name: 'hello.txt',
      mimeType: 'text/plain',
      size: 2,
      path: join(root, attachment.id, 'hello.txt'),
      url: `agentgroup-attachment://${attachment.id}/hello.txt`
    })
    expect(await readFile(attachment.path, 'utf8')).toBe('hi')
    expect(service.owns(attachment.path)).toBe(true)
    expect(service.owns('/etc/passwd')).toBe(false)
  })
})
