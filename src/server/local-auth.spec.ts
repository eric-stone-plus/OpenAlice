import { Hono } from 'hono'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ensureLocalToken,
  hasValidLocalToken,
  localAuthMiddleware,
  localTokenPath,
  readLocalToken,
} from './local-auth.js'

describe('local auth token', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'oa-local-auth-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('provisions one 0600 token and converges concurrent callers', async () => {
    const [a, b] = await Promise.all([ensureLocalToken(home), ensureLocalToken(home)])
    expect(a).toBe(b)
    expect(a).toMatch(/^oa1_[A-Za-z0-9_-]{43}$/)
    expect(await readLocalToken(home)).toBe(a)
    expect((await stat(localTokenPath(home))).mode & 0o777).toBe(0o600)
    expect((await readFile(localTokenPath(home), 'utf8')).trim()).toBe(a)
  })

  it('rejects a malformed token file instead of silently rotating it', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'auth'), { recursive: true })
    await writeFile(localTokenPath(home), 'short\n', { mode: 0o600 })
    await expect(readLocalToken(home)).rejects.toThrow(/malformed/)
  })

  it('requires a matching bearer token and rejects other values', async () => {
    const token = await ensureLocalToken(home)
    const app = new Hono()
    app.use('*', localAuthMiddleware(token))
    app.get('/', (c) => c.text('ok'))
    expect((await app.request('/', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
    expect((await app.request('/', { headers: { authorization: `bearer ${token}` } })).status).toBe(200)
    expect((await app.request('/', { headers: { 'x-openalice-local-token': token } })).status).toBe(200)
    expect((await app.request('/', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await app.request('/')).status).toBe(401)
  })

  it('tightens an existing token restored with group/world permissions', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'auth'), { recursive: true })
    const token = `oa1_${'a'.repeat(43)}`
    await writeFile(localTokenPath(home), `${token}\n`, { mode: 0o644 })
    expect(await ensureLocalToken(home)).toBe(token)
    expect((await stat(localTokenPath(home))).mode & 0o777).toBe(0o600)
  })

  it('accepts a restored 0755 auth directory and tightens it', async () => {
    const { mkdir, chmod } = await import('node:fs/promises')
    const authDir = join(home, 'auth')
    await mkdir(authDir, { recursive: true })
    await chmod(authDir, 0o755)
    const token = `oa1_${'b'.repeat(43)}`
    await writeFile(localTokenPath(home), `${token}\n`, { mode: 0o600 })
    expect(await ensureLocalToken(home)).toBe(token)
    expect((await stat(authDir)).mode & 0o777).toBe(0o700)
  })

  it('rejects a symlinked token path', async () => {
    await mkdir(join(home, 'auth'), { recursive: true })
    const target = join(home, 'outside-token')
    await writeFile(target, `oa1_${'a'.repeat(43)}\n`, { mode: 0o600 })
    await symlink(target, localTokenPath(home))
    await expect(ensureLocalToken(home)).rejects.toThrow(/symlink/)
  })

  it('rejects a symlinked auth directory', async () => {
    const real = join(home, 'real-auth')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'local.token'), `oa1_${'a'.repeat(43)}\n`, { mode: 0o600 })
    await symlink(real, join(home, 'auth'))
    await expect(ensureLocalToken(home)).rejects.toThrow(/symlink/)
  })

  it('compares without throwing on length mismatch', async () => {
    const c = new Hono()
    c.get('/', (ctx) => ctx.text(String(hasValidLocalToken(ctx, 'oa1_expected'))))
    const res = await c.request('/', { headers: { authorization: 'Bearer x' } })
    expect(await res.text()).toBe('false')
  })
})
