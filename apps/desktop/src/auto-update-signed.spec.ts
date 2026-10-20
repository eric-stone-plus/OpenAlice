import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers,
    listeners,
    userData: '',
    home: '',
    identity: { dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 },
    manifest: {
      schema: 1,
      product: 'open-alice',
      appId: 'com.traderalice.openalice',
      channel: 'latest',
      version: '0.95.1',
      sequence: 2,
      publishedAt: '2026-10-19T00:00:00.000Z',
      expiresAt: '2026-11-19T00:00:00.000Z',
      fileName: 'open-alice-0.95.1.x86_64.rpm',
      fileSha512: `${'A'.repeat(86)}==`,
      fileSize: 7,
      releaseNotesUrl: 'https://example.test/notes',
    },
    autoUpdater: {
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(async () => []),
      quitAndInstall: vi.fn(),
      installerPath: '',
      on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
        listeners.set(event, listener)
      }),
    },
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.94.1',
    getPath: (name: string) => name === 'userData' ? mocks.userData : mocks.home,
  },
  ipcMain: {
    removeHandler: vi.fn((channel: string) => mocks.handlers.delete(channel)),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }),
  },
  shell: { openExternal: vi.fn(async () => {}) },
}))

vi.mock('electron-updater', () => ({
  default: { autoUpdater: mocks.autoUpdater },
}))

vi.mock('./auto-update-policy.js', () => ({
  resolveAutoUpdateCapability: () => ({ enabled: true, configPath: '/fixture/app-update.yml' }),
}))

vi.mock('./update-signing-keys.js', () => ({
  OPENALICE_APP_ID: 'com.traderalice.openalice',
  LINUX_SIGNED_UPDATE_FEED: {
    feedUrl: 'https://example.test/feed/',
    publicKeyPem: 'test-public-key',
    keyId: 'test-key',
  },
}))

vi.mock('./update-feed.js', () => ({
  fetchVerifiedLinuxManifest: vi.fn(async () => mocks.manifest),
}))

vi.mock('./update-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./update-manifest.js')>()
  return {
    ...actual,
    verifyDownloadedPackage: vi.fn(async () => {}),
    verifyDownloadedPackageWithIdentity: vi.fn(async () => mocks.identity),
  }
})

import { configureAutoUpdate } from './auto-update.js'

describe('signed Linux update handoff', () => {
  let dir: string

  beforeEach(() => {
    mocks.handlers.clear()
    mocks.listeners.clear()
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'oa-signed-update-'))
    mocks.userData = dir
    mocks.home = dir
    mocks.manifest.sequence = 2
    mocks.manifest.expiresAt = '2026-11-19T00:00:00.000Z'
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function readyControls(): Promise<ReturnType<typeof configureAutoUpdate>> {
    const file = join(dir, mocks.manifest.fileName)
    writeFileSync(file, 'payload')
    mocks.autoUpdater.installerPath = file
    const current = statSync(file)
    mocks.identity = {
      dev: current.dev,
      ino: current.ino,
      size: current.size,
      mtimeMs: current.mtimeMs,
      ctimeMs: current.ctimeMs,
    }
    const controls = configureAutoUpdate(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      { beforeInstall: vi.fn(async () => {}) },
      '0.94.1',
    )
    mocks.listeners.get('update-available')?.({
      version: mocks.manifest.version,
      files: [{
        url: mocks.manifest.fileName,
        sha512: mocks.manifest.fileSha512,
        size: mocks.manifest.fileSize,
      }],
    })
    await vi.waitFor(() => expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalled())
    mocks.listeners.get('update-downloaded')?.({
      version: mocks.manifest.version,
      downloadedFile: file,
    })
    await vi.waitFor(() => expect(controls.downloaded()).not.toBeNull())
    return controls
  }

  it('hands off when the package identity still matches', async () => {
    const controls = await readyControls()
    await expect(controls.install()).resolves.toEqual({ ok: true })
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('rejects a package whose identity changed after verification', async () => {
    const controls = await readyControls()
    mocks.identity = { ...mocks.identity, ino: mocks.identity.ino + 1 }
    await expect(controls.install()).rejects.toThrow(/changed after verification/)
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('rejects a replay after another instance advances the high-water mark', async () => {
    const controls = await readyControls()
    writeFileSync(join(dir, 'update-sequence.json'), '{"sequence":3}\n')
    await expect(controls.install()).rejects.toThrow(/replayed an older release sequence/)
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('rejects a manifest that expired while the package downloaded', async () => {
    mocks.manifest.expiresAt = '2026-10-19T12:00:00.000Z'
    const controls = await readyControls()
    await expect(controls.install()).rejects.toThrow(/outside its validity window/)
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('recovers from a crash-truncated trailing record after a valid high-water record', async () => {
    const controls = await readyControls()
    writeFileSync(join(dir, 'update-sequence.json'), '{"sequence":2}\n{"sequence":')
    await expect(controls.install()).resolves.toEqual({ ok: true })
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('rejects a sequence file with no complete record', async () => {
    const controls = await readyControls()
    writeFileSync(join(dir, 'update-sequence.json'), '{"sequence":')
    await expect(controls.install()).rejects.toThrow(/no complete record/)
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('rejects an installer path that differs from the verified package', async () => {
    const controls = await readyControls()
    const other = join(dir, 'other.rpm')
    writeFileSync(other, 'other-payload')
    mocks.autoUpdater.installerPath = other
    await expect(controls.install()).rejects.toThrow(/installer payload does not match/)
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('re-checks the high-water mark after hashing the package', async () => {
    const controls = await readyControls()
    const manifestModule = await import('./update-manifest.js')
    vi.mocked(manifestModule.verifyDownloadedPackageWithIdentity).mockImplementationOnce(async () => {
      writeFileSync(join(dir, 'update-sequence.json'), '{"sequence":3}\n')
      return mocks.identity
    })
    await expect(controls.install()).rejects.toThrow(/replayed an older release sequence/)
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })
})
