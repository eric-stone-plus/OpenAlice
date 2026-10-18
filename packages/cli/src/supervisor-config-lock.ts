/** Serialize the entire read/modify/write transaction across CLI/Desktop processes.
 *
 * The lock carries its owner and a token. Acquisition writes the owner to a
 * temporary file and hard-links it into place, so a lock is never observable
 * empty. Reclaim is atomic: the stale lock is renamed to a unique tombstone,
 * re-checked, and only then removed. A release removes the lock only when the
 * token still matches, so a slow writer cannot delete a successor's lock. */
import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

interface LockOwner {
  readonly pid: number
  readonly hostname: string
  readonly acquiredAt: string
  /** Absent on locks written by the previous owner-metadata format. */
  readonly token?: string
}

export interface SupervisorConfigLockOptions {
  /** Total wait for a live writer before failing. */
  readonly timeoutMs?: number
  /** Age after which a lock without a readable owner is treated as abandoned. */
  readonly staleMs?: number
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>
    if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return null
    if (typeof value.hostname !== 'string' || typeof value.acquiredAt !== 'string') return null
    const token = typeof value.token === 'string' && value.token.length > 0 ? value.token : undefined
    return { pid: value.pid, hostname: value.hostname, acquiredAt: value.acquiredAt, ...(token ? { token } : {}) }
  } catch {
    return null
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function lockIsStale(path: string, staleMs: number): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    // The owner released the lock between EEXIST and this read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  const owner = parseOwner(raw)
  if (owner) {
    // A remote owner cannot be probed locally; respect its lock until timeout.
    if (owner.hostname !== hostname()) return false
    return !processIsAlive(owner.pid)
  }
  // Legacy or partially written lock: no owner to probe. Reclaim only after
  // the writer has had much longer than the normal transaction time.
  try {
    const info = await stat(path)
    return Date.now() - info.mtimeMs >= staleMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

/** Create the lock atomically with a fully written owner, never an empty file. */
async function tryAcquire(path: string, owner: LockOwner): Promise<boolean> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(owner), { mode: 0o600 })
  try {
    await link(temp, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await rm(temp, { force: true })
  }
}

/**
 * Move the stale lock aside atomically. Only one reclaimer can win the rename;
 * re-check the moved file so a lock that was replaced by a fresh owner is put
 * back instead of deleted.
 */
async function reclaimStaleLock(path: string, staleMs: number): Promise<void> {
  const tombstone = `${path}.${process.pid}.${randomUUID()}.stale`
  try {
    await rename(path, tombstone)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (await lockIsStale(tombstone, staleMs)) {
    await rm(tombstone, { force: true })
    return
  }
  // A fresh owner replaced the lock between the stale check and the rename.
  // Restore it rather than deleting it. If another owner already holds the
  // path, leave the tombstone in place instead of removing a live lock.
  try {
    await link(tombstone, path)
    await rm(tombstone, { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Remove the lock only while it still belongs to this transaction. */
async function releaseLock(path: string, token: string): Promise<void> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (parseOwner(raw)?.token !== token) return
  await rm(path, { force: true })
}

export async function withSupervisorConfigLock<T>(
  root: string,
  action: () => Promise<T>,
  options: SupervisorConfigLockOptions = {},
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, '.config-write.lock')
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  const staleMs = options.staleMs ?? 30_000
  const token = randomUUID()
  const owner: LockOwner = {
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
    token,
  }
  let acquired = false
  while (!acquired) {
    acquired = await tryAcquire(path, owner)
    if (acquired) break
    if (await lockIsStale(path, staleMs)) {
      await reclaimStaleLock(path, staleMs)
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`Supervisor config is busy. If its writer exited unexpectedly, remove ${path} before retrying.`)
    }
    await delay(20)
  }
  try {
    return await action()
  } finally {
    await releaseLock(path, token)
  }
}
