import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  acquireRuntimeLock,
  legacyWorkspaceLockDir,
  runtimeLockDir,
} from '@traderalice/guardian-runtime'

import { clearStaleRuntimeState } from './runtime-state-cleanup.js'

let home: string
let launcherRoot: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'openalice-cleanup-'))
  launcherRoot = join(home, 'workspaces')
  await mkdir(launcherRoot, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('clearStaleRuntimeState', () => {
  it('removes a lock whose owner is gone', async () => {
    const lockDir = runtimeLockDir(home)
    const lock = await acquireRuntimeLock(lockDir, { pid: 999_999, heartbeatMs: 0 })

    await clearStaleRuntimeState(home, launcherRoot)

    expect(existsSync(lockDir)).toBe(false)
    await lock.release()
  })

  it('removes the Alice lock after the child was stopped', async () => {
    const lockDir = legacyWorkspaceLockDir(launcherRoot)
    const lock = await acquireRuntimeLock(lockDir, { pid: process.pid, heartbeatMs: 0 })

    await clearStaleRuntimeState(home, launcherRoot, process.pid)

    expect(existsSync(lockDir)).toBe(false)
    await lock.release()
  })

  it('keeps a live owner that is not the stopped Alice child', async () => {
    const lockDir = legacyWorkspaceLockDir(launcherRoot)
    const lock = await acquireRuntimeLock(lockDir, { pid: process.pid, heartbeatMs: 0 })

    await clearStaleRuntimeState(home, launcherRoot, 999_999)

    expect(existsSync(lockDir)).toBe(true)
    await lock.release()
  })

  it('keeps an initializing lock whose owner has not been published yet', async () => {
    const lockDir = runtimeLockDir(home)
    await mkdir(lockDir, { recursive: true })

    await clearStaleRuntimeState(home, launcherRoot)

    expect(existsSync(lockDir)).toBe(true)
  })

  it('removes a CLI endpoint whose process is gone', async () => {
    const stateDir = join(home, 'state')
    await mkdir(stateDir, { recursive: true })
    const endpointPath = join(stateDir, 'cli-endpoint.json')
    await writeFile(endpointPath, JSON.stringify({ pid: 999_999 }), 'utf8')

    await clearStaleRuntimeState(home, launcherRoot)

    expect(existsSync(endpointPath)).toBe(false)
  })
})
