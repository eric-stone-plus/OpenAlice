import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'

let home: string
let savedHome: string | undefined
let app: Hono

beforeAll(async () => {
  savedHome = process.env['OPENALICE_HOME']
  home = await mkdtemp(join(tmpdir(), 'oa-media-route-'))
  process.env['OPENALICE_HOME'] = home
  vi.resetModules()
  const { createMediaRoutes } = await import('./media.js')
  app = createMediaRoutes()
  const dir = join(home, 'data', 'media', '2026-01-01')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'ace-aim-air.svg'), '<svg><script>alert(1)</script></svg>')
  await writeFile(join(dir, 'ace-aim-air.png'), 'png')
})

afterAll(async () => {
  if (savedHome === undefined) delete process.env['OPENALICE_HOME']
  else process.env['OPENALICE_HOME'] = savedHome
  vi.resetModules()
  await rm(home, { recursive: true, force: true })
})

describe('media route', () => {
  it('serves SVG as a non-inline attachment with a sandbox CSP', async () => {
    const res = await app.request('/2026-01-01/ace-aim-air.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('does not let a decoded path traverse outside data/media', async () => {
    const res = await app.request('/2026-01-01/..%2F..%2Fconfig%2Fai-provider-manager.json')
    expect(res.status).toBe(404)
  })
})
