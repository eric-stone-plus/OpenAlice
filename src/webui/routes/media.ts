import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { resolveMediaPath } from '../../core/media-store.js'

/**
 * Media routes: GET /:date/:name — serves persisted tool-result media
 * (e.g. browser screenshots) from data/media/. Mounted at /api/media.
 *
 * Relocated out of the now-deleted chat route module; the media surface
 * is independent of the legacy chat path and stays.
 */
export function createMediaRoutes() {
  const app = new Hono()

  const MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  }

  app.get('/:date/:name', async (c) => {
    const { date, name } = c.req.param()
    let filePath: string
    try {
      filePath = resolveMediaPath(join(date, name))
    } catch {
      return c.notFound()
    }

    try {
      const buf = await readFile(filePath)
      const ext = extname(name).toLowerCase()
      const mime = MIME[ext] ?? 'application/octet-stream'
      // SVG is a document format: a directly navigated SVG can execute script
      // in the app:// origin. Never serve it inline; the CSP is defense in
      // depth for every other document-shaped media type.
      const headers: Record<string, string> = {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Cache-Control': 'private, max-age=300',
      }
      if (ext === '.svg') headers['Content-Disposition'] = 'attachment; filename="media.svg"'
      return c.body(buf, { headers })
    } catch {
      return c.notFound()
    }
  })

  return app
}
