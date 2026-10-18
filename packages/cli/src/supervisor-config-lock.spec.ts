import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { withSupervisorConfigLock } from './supervisor-config-lock.ts'

describe('withSupervisorConfigLock', () => {
  let root: string
  let lockPath: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openalice-config-lock-'))
    lockPath = join(root, '.config-write.lock')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes its owner, runs the transaction, and releases the lock', async () => {
    const seen: string[] = []
    await withSupervisorConfigLock(root, async () => {
      seen.push(await readFile(lockPath, 'utf8'))
    })
    expect(JSON.parse(seen[0] ?? '{}')).toMatchObject({ pid: process.pid, hostname: hostname() })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims a lock owned by a dead local process', async () => {
    await writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_646,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    }))
    let ran = false
    await withSupervisorConfigLock(root, async () => { ran = true }, { timeoutMs: 500 })
    expect(ran).toBe(true)
  })

  it('reclaims a legacy empty lock after the stale window', async () => {
    await writeFile(lockPath, '')
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)
    let ran = false
    await withSupervisorConfigLock(root, async () => { ran = true }, { timeoutMs: 500, staleMs: 30_000 })
    expect(ran).toBe(true)
  })

  it('does not steal a live owner lock before the timeout', async () => {
    const owner = JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    })
    await writeFile(lockPath, owner)
    await expect(withSupervisorConfigLock(root, async () => {}, { timeoutMs: 100 }))
      .rejects.toThrow(/Supervisor config is busy/)
    expect(await readFile(lockPath, 'utf8')).toBe(owner)
  })

  it('does not remove a successor lock when releasing', async () => {
    const successor = JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      token: 'successor-token',
    })
    await withSupervisorConfigLock(root, async () => {
      // Simulate the lock being replaced while the transaction runs.
      await writeFile(lockPath, successor)
    })
    expect(await readFile(lockPath, 'utf8')).toBe(successor)
  })
})
