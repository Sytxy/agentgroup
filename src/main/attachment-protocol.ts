import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip'
}

/**
 * 为 agentgroup-attachment://<id>/<name> 提供文件内容。
 * id/name 都来自服务端生成的元数据；这里仍做路径穿越校验，避免被伪造 URL 读取任意文件。
 */
export async function serveAttachment(request: Request, root: string): Promise<Response> {
  const url = new URL(request.url)
  const id = url.hostname
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''))

  if (
    !/^[A-Za-z0-9-]+$/.test(id) ||
    name === '' ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..'
  ) {
    return new Response('Not found', { status: 404 })
  }

  try {
    const data = await readFile(join(root, id, name))
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type':
          MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
      }
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}
