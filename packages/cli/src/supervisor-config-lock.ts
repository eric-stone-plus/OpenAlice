/** Serialize the entire read/modify/write transaction across CLI/Desktop processes.
 *
 * The lock carries its owner so a killed writer cannot wedge the supervisor
 * forever. A live owner is never stolen: only the timeout decides. A lock with
 * a dead local PID is reclaimed immediately; a legacy empty/malformed lock is
 * reclaimed after `staleMs`, which is far longer than the tiny JSON transaction
 * this lock protects. */
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

interface LockOwner {
  readonly pid: number
  readonly hostname: string
  readonly acquiredAt: string
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
    return { pid: value.pid, hostname: value.hostname, acquiredAt: value.acquiredAt }
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

export async function withSupervisorConfigLock<T>(
  root: string,
  action: () => Promise<T>,
  options: SupervisorConfigLockOptions = {},
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, '.config-write.lock')
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  const staleMs = options.staleMs ?? 30_000
  let lock
  while (!lock) {
    try {
      lock = await open(path, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await lockIsStale(path, staleMs)) {
        await rm(path, { force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`Supervisor config is busy. If its writer exited unexpectedly, remove ${path} before retrying.`)
      }
      await delay(20)
    }
  }
  const owner: LockOwner = {
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
  }
  try {
    await lock.writeFile(JSON.stringify(owner))
  } catch (error) {
    await lock.close()
    await rm(path, { force: true })
    throw error
  }
  try {
    return await action()
  } finally {
    await lock.close()
    await rm(path, { force: true })
  }
}
