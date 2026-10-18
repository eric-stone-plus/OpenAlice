import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { inspectRuntimeLock, openAliceLockDirs } from '@traderalice/guardian-runtime'

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The guardian's crash safety net: once its children have been stopped, drop
 * runtime locks and the CLI endpoint that still point at a dead process.
 * Alice releases these itself on a clean quit; this path covers a force-kill
 * or a shutdown that overran the guardian's grace window, so the next launch
 * never inherits a lock whose owner no longer exists.
 */
export async function clearStaleRuntimeState(
  home: string,
  launcherRoot: string,
  alicePid?: number,
): Promise<void> {
  for (const lockDir of openAliceLockDirs(home, launcherRoot)) {
    const inspection = await inspectRuntimeLock(lockDir).catch(() => null)
    if (!inspection || inspection.state === 'missing') continue
    // A concurrent launch can be between mkdir and owner publication. That
    // lock is young and has no owner yet; leave it for its acquirer instead
    // of deleting a live instance's initialization lock.
    if (inspection.state === 'initializing') continue
    const ownerPid = inspection.owner?.pid
    if (
      inspection.state !== 'active'
      || ownerPid === undefined
      || ownerPid === alicePid
      || !isPidAlive(ownerPid)
    ) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  const endpointPath = join(home, 'state', 'cli-endpoint.json')
  try {
    const endpoint = JSON.parse(await readFile(endpointPath, 'utf8')) as { pid?: unknown }
    if (typeof endpoint.pid !== 'number' || endpoint.pid === alicePid || !isPidAlive(endpoint.pid)) {
      await rm(endpointPath, { force: true }).catch(() => undefined)
    }
  } catch { /* the endpoint is absent or already gone */ }
}
