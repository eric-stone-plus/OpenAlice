import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Written at the start of a graceful quit so a relaunch can wait it out. */
export interface ShutdownMarker {
  readonly pid: number
  readonly startedAt: string
}

export function shutdownMarkerPath(home: string): string {
  return join(home, 'state', 'desktop-shutdown.json')
}

/** Best effort: a quit must never be blocked by marker bookkeeping. */
export function writeShutdownMarker(home: string, pid: number = process.pid, now: Date = new Date()): void {
  try {
    const path = shutdownMarkerPath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ pid, startedAt: now.toISOString() })}\n`, 'utf8')
  } catch { /* the lock inspection still handles a missing marker */ }
}

export function readShutdownMarker(home: string): ShutdownMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(shutdownMarkerPath(home), 'utf8')) as Record<string, unknown>
    const pid = parsed['pid']
    const startedAt = parsed['startedAt']
    if (typeof pid !== 'number' || typeof startedAt !== 'string') return null
    return { pid, startedAt }
  } catch {
    return null
  }
}

export function clearShutdownMarker(home: string): void {
  try {
    rmSync(shutdownMarkerPath(home), { force: true })
  } catch { /* best effort */ }
}
