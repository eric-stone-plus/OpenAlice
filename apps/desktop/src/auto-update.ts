import { selectRelease, releaseChannelForVersion, type ReleaseDecision, type ClientReleaseObservation, type NativeUpdaterStatus as UpdaterStatus, type UpdaterInstallStage } from '@traderalice/update-lifecycle'
export type { UpdaterInstallStage } from '@traderalice/update-lifecycle'
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, ipcMain, net, shell, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import { resolveAutoUpdateCapability, type AutoUpdateCapability } from './auto-update-policy.js'
import { fetchVerifiedLinuxManifest } from './update-feed.js'
import { verifyDownloadedPackage, type LinuxUpdateManifest } from './update-manifest.js'
import { LINUX_SIGNED_UPDATE_FEED, OPENALICE_APP_ID } from './update-signing-keys.js'

const { autoUpdater } = electronUpdater

type UnsupportedReason = Exclude<AutoUpdateCapability, { enabled: true }>['reason'] | 'feed-unavailable'

type UpdateCheckResult =
  | { supported: true }
  | { supported: false; reason: UnsupportedReason }

/**
 * A locally built Linux package has no published beta feed yet, so
 * electron-updater throws `Cannot find channel "beta-linux-yml"` (HTTP 404).
 * That is an expected capability gap, not a failed update check; report it as
 * unsupported instead of surfacing the raw HttpError in the App details dialog.
 */
function isMissingUpdateFeedError(error: unknown): boolean {
  if (process.platform !== 'linux') return false
  const message = error instanceof Error ? error.message : String(error)
  // Require the Linux beta channel identity as well as a 404/channel error, so
  // an unrelated release-asset 404 is reported as a real update failure. The
  // feed is named `beta-linux.yml`; older electron-updater messages use the
  // hyphenated channel form `beta-linux-yml`.
  return /beta-linux[.-]yml/i.test(message) && /Cannot find channel|HttpError|404/i.test(message)
}

export interface AutoUpdateHooks {
  beforeInstall: (
    version: string,
    report: (stage: Exclude<UpdaterInstallStage, 'preparing' | 'handing-off'>) => void,
  ) => Promise<void>
  executeInstall?: (version: string, prepare: () => Promise<void>, handoff: () => Promise<void>, parentOperationId?: string) => Promise<void>
  onInstallHandoff?: (version: string) => Promise<void> | void
  onInstallFailure?: (error: Error) => Promise<void> | void
}

export function configureAutoUpdate(win: BrowserWindow, hooks: AutoUpdateHooks, currentVersion: string): { discover(): Promise<ClientReleaseObservation>; install(expectedVersion?: string, parentOperationId?: string): Promise<{ ok: boolean }>; downloaded(): string | null } {
  let downloadedVersion: string | null = null
  let availableVersion: string | null = null
  let checkedRelease: { version: string; decision: ReleaseDecision } | null = null
  let latestStatus: UpdaterStatus | null = null
  let activeCheck: Promise<UpdateCheckResult> | null = null
  let installInProgress = false
  let installFailureHandled = false
  let missingFeed = false
  let releaseAccept: Promise<void> = Promise.resolve()
  let downloadBusy = false
  const pendingDownloads: Array<{ version: string; downloadedFile: string }> = []
  // A check can overlap a download: key verified state by version instead of
  // replacing one shared manifest, and keep the exact file that was hashed.
  const verifiedManifests = new Map<string, LinuxUpdateManifest>()
  const downloadedFiles = new Map<string, string>()
  const signedFeed = process.platform === 'linux' ? LINUX_SIGNED_UPDATE_FEED : null
  const updateSequencePath = (): string => join(app.getPath('userData'), 'update-sequence.json')
  // Electron's type surface has no `cache` key; on Linux the updater cache is
  // under XDG_CACHE_HOME (default ~/.cache).
  const updateCacheRoot = (): string => process.env['XDG_CACHE_HOME']?.trim() || join(app.getPath('home'), '.cache')

  const readUpdateSequence = async (): Promise<number> => {
    let raw: string
    try {
      raw = await readFile(updateSequencePath(), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      // A malformed or unreadable high-water file must not silently reset the
      // rollback guard to zero.
      throw new Error(`could not read the update sequence: ${error instanceof Error ? error.message : String(error)}`)
    }
    // The file is append-only: one JSON object per line. The max is the
    // high-water mark, so two instances cannot lose an update by racing a
    // read-modify-write. Older single-object files still parse as one line.
    let highWater = 0
    let valid = false
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as { sequence?: unknown }
        if (typeof parsed.sequence === 'number' && Number.isSafeInteger(parsed.sequence) && parsed.sequence > 0) {
          highWater = Math.max(highWater, parsed.sequence)
          valid = true
        }
      } catch {
        // Ignore one damaged line; a later valid line still advances the mark.
      }
    }
    if (!valid && raw.trim() !== '') {
      throw new Error('could not read the update sequence: the file has no valid sequence')
    }
    return highWater
  }

  const persistUpdateSequence = async (sequence: number): Promise<void> => {
    const current = await readUpdateSequence()
    if (sequence < current) throw new Error('The signed update manifest replayed an older release sequence.')
    if (sequence === current) return
    const path = updateSequencePath()
    await mkdir(app.getPath('userData'), { recursive: true })
    // Older files were written as one JSON object; if the last writer omitted
    // the trailing newline, appending directly would concatenate two objects
    // into an unparsable line and trip the fail-closed reader.
    const existing = await readFile(path, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    })
    if (existing !== '' && !existing.endsWith('\n')) {
      await appendFile(path, '\n', { mode: 0o600 })
    }
    // O_APPEND writes of this small line are atomic; no temp+rename race.
    await appendFile(path, `${JSON.stringify({ sequence })}\n`, { mode: 0o600 })
    await chmod(path, 0o600).catch(() => undefined)
  }

  const capability = resolveAutoUpdateCapability({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
    signedLinuxFeed: signedFeed !== null,
  })

  const channel = releaseChannelForVersion(currentVersion)
  const select = (version: string): ReleaseDecision => channel
    ? selectRelease({ channel, version: currentVersion }, { channel, version }, channel)
    : { status: 'unknown', reason: 'invalid-identity' }

  const releaseUrlFor = (version: string): string =>
    `https://github.com/TraderAlice/OpenAlice/releases/tag/v${version}`

  const sendStatus = (status: UpdaterStatus) => {
    latestStatus = status
    if (win.isDestroyed()) return
    if (status.phase === 'downloading' && typeof status.percent === 'number') {
      win.setProgressBar?.(Math.max(0, Math.min(1, status.percent / 100)))
    } else if (status.phase === 'installing') {
      win.setProgressBar?.(2)
    } else {
      win.setProgressBar?.(-1)
    }
    win.webContents.send('openalice:updater:status', status)
  }

  const reportInstallFailure = async (error: Error): Promise<void> => {
    if (installFailureHandled) return
    installFailureHandled = true
    sendStatus({ phase: 'error', message: error.message })
    try {
      await hooks.onInstallFailure?.(error)
    } catch (hookError) {
      console.error('[updater] install failure recovery failed:', hookError)
    }
  }

  const checkForUpdates = (): Promise<UpdateCheckResult> => {
    if (!capability.enabled) {
      return Promise.resolve({ supported: false, reason: capability.reason })
    }
    if (installInProgress) return Promise.resolve({ supported: true })
    if (activeCheck) return activeCheck
    checkedRelease = null
    releaseAccept = Promise.resolve()
    installFailureHandled = false
    missingFeed = false
    sendStatus({ phase: 'checking' })
    activeCheck = autoUpdater.checkForUpdates()
      .then(async () => {
        // checkForUpdates() resolves when the provider responds, not when the
        // async update-available handler finishes verifying the manifest.
        await releaseAccept
        return { supported: true as const }
      })
      .catch((err: unknown) => {
        if (missingFeed || isMissingUpdateFeedError(err)) {
          missingFeed = true
          return { supported: false as const, reason: 'feed-unavailable' as const }
        }
        const message = err instanceof Error ? err.message : String(err)
        if (latestStatus?.phase !== 'error' || latestStatus.message !== message) {
          sendStatus({ phase: 'error', message })
        }
        return { supported: true as const }
      })
      .finally(() => {
        activeCheck = null
      })
    return activeCheck
  }

  ipcMain.removeHandler('openalice:updater:get-status')
  ipcMain.handle('openalice:updater:get-status', () => latestStatus)

  const controls = { install: (expectedVersion?: string, parentOperationId?: string) => install(expectedVersion, parentOperationId), downloaded: () => downloadedVersion, discover: async (): Promise<ClientReleaseObservation> => {
    const result = await checkForUpdates()
    const base = { currentVersion, channel: !app.isPackaged ? 'dev' : channel ?? 'custom' }
    if (!result.supported) return {
      ...base,
      status: 'unsupported',
      message: unsupportedUpdateMessage(result.reason),
    }
    if (latestStatus?.phase === 'error') throw new Error(latestStatus.message)
    if (!checkedRelease) throw new Error('Native updater returned no release identity')
    const manifest = verifiedManifests.get(checkedRelease.version)
    return { ...base, ...checkedRelease.decision,
      latestVersion: checkedRelease.version,
      releaseNotesUrl: manifest?.releaseNotesUrl ?? releaseUrlFor(checkedRelease.version) }
  } }

  const verifyReadyPackage = async (version: string): Promise<void> => {
    if (!signedFeed) return
    const manifest = verifiedManifests.get(version)
    const file = downloadedFiles.get(version)
    if (!manifest || manifest.version !== version || !file) {
      throw new Error('The downloaded update has no verified signed manifest for this version.')
    }
    // Re-hash immediately before the handoff: the updater cache is writable
    // by the same user, and quitAndInstall runs the package as root on Linux.
    await verifyDownloadedPackage(manifest, file, updateCacheRoot())
  }

  const install = async (expectedVersion?: string, parentOperationId?: string) => {
    if (expectedVersion !== undefined && expectedVersion !== downloadedVersion) throw new Error('The downloaded update changed; review the current release before installing')
    if (!downloadedVersion) throw new Error('No downloaded update is ready to install.')
    const version = downloadedVersion
    if ((latestStatus?.phase === 'error' && !installFailureHandled) || select(version).status !== 'available') throw new Error('The downloaded release is not eligible for installation. Check updates again.')
    if (installInProgress) return { ok: true }
    installInProgress = true
    try {
      await verifyReadyPackage(version)
    } catch (error) {
      installInProgress = false
      throw error
    }
    installFailureHandled = false
    try {
      sendStatus({ phase: 'installing', version, stage: 'preparing' })
      // Give the renderer one paint before managed services begin shutting
      // down. Without this yield the last visible frame is still the button.
      await new Promise((resolve) => setTimeout(resolve, 150))
      const prepare = async () => {
      await hooks.beforeInstall(version, (stage) => {
        sendStatus({ phase: 'installing', version, stage })
      })
      }
      const handoff = async () => {
      if (downloadedVersion !== version || select(version).status !== 'available') throw new Error('The downloaded update changed before handoff; review the current release before installing')
      sendStatus({ phase: 'installing', version, stage: 'handing-off' })
      await hooks.onInstallHandoff?.(version)
      // Assisted NSIS updates must be silent or they stop on the installer UI
      // after Electron exits. Force-run restarts the updated app on success.
      if (downloadedVersion !== version) throw new Error('The approved native payload changed during handoff')
      await verifyReadyPackage(version)
      autoUpdater.quitAndInstall(true, true)
      }
      if (hooks.executeInstall) await hooks.executeInstall(version, prepare, handoff, parentOperationId)
      else { await prepare(); await handoff() }
      return { ok: true }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      await reportInstallFailure(normalized)
      installInProgress = false
      throw normalized
    }
  }

  ipcMain.removeHandler('openalice:updater:open-release')
  ipcMain.handle('openalice:updater:open-release', async (_event, version: unknown) => {
    const target = typeof version === 'string' && version.length > 0 ? version : downloadedVersion
    if (!target) {
      await shell.openExternal('https://github.com/TraderAlice/OpenAlice/releases')
      return { ok: true }
    }
    await shell.openExternal(verifiedManifests.get(target)?.releaseNotesUrl ?? releaseUrlFor(target))
    return { ok: true }
  })

  // Keep the renderer IPC contract stable in dev and non-updatable directory
  // packages. Only the updater engine itself depends on packaged metadata.
  if (!capability.enabled) {
    if (capability.reason === 'missing-config') {
      console.info(`[updater] disabled: update metadata not found at ${capability.configPath}`)
    } else if (capability.reason === 'unsigned-linux-feed') {
      console.info('[updater] disabled: Linux auto-update requires a signed manifest and pinned public key')
    }
    return controls
  }

  if (!channel) throw new Error('Native updater requires a supported OpenAlice product release identity')
  const feedChannel = channel === 'stable' ? 'latest' : channel
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = channel === 'beta'
  autoUpdater.channel = channelForVersion(currentVersion, process.platform, process.arch)
  autoUpdater.allowDowngrade = false

  autoUpdater.on('error', (err) => {
    console.error(`[updater] ${installInProgress ? 'install handoff' : 'update check'} failed:`, err)
    const normalized = err instanceof Error ? err : new Error(String(err))
    if (installInProgress) {
      void reportInstallFailure(normalized)
      return
    }
    // Suppress only a missing feed discovered by an active check. A 404 while
    // downloading an accepted release is a real failure and must stay visible.
    if (activeCheck && isMissingUpdateFeedError(normalized)) {
      missingFeed = true
      return
    }
    sendStatus({ phase: 'error', message: normalized.message })
  })

  const acceptRelease = async (info: { version: string; files?: ReadonlyArray<{ url: string; sha512?: string; size?: number }> }, nativeAvailable: boolean) => {
    const version = info.version
    const decision = select(version)
    if (decision.status !== 'available') {
      checkedRelease = { version, decision }
      availableVersion = null
      downloadedVersion = null
      if (decision.status === 'current') sendStatus({ phase: 'current', version: currentVersion })
      else sendStatus({ phase: decision.status, version, reason: decision.reason })
      return
    }
    if (!nativeAvailable) {
      checkedRelease = null
      availableVersion = null
      sendStatus({ phase: 'error', message: 'The native updater did not accept the eligible release payload. Check updates again.' })
      return
    }
    let manifest: LinuxUpdateManifest | undefined
    if (signedFeed) {
      try {
        manifest = await fetchVerifiedLinuxManifest({
          feed: signedFeed,
          channel: feedChannel,
          appId: OPENALICE_APP_ID,
          release: { version, files: info.files ?? [] },
        }, (input, init) => net.fetch(input instanceof URL ? input.href : input, init))
        const highWater = await readUpdateSequence()
        if (manifest.sequence < highWater) {
          throw new Error('The signed update manifest replayed an older release sequence.')
        }
      } catch (error: unknown) {
        checkedRelease = null
        availableVersion = null
        sendStatus({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
        return
      }
      verifiedManifests.set(version, manifest)
    }
    checkedRelease = { version, decision }
    availableVersion = version
    sendStatus({
      phase: 'available',
      version,
      releaseUrl: manifest?.releaseNotesUrl ?? releaseUrlFor(version),
    })
    void autoUpdater.downloadUpdate().catch((error: unknown) => {
      sendStatus({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }
  const runAccept = (info: { version: string; files?: ReadonlyArray<{ url: string; sha512?: string; size?: number }> }, nativeAvailable: boolean) => {
    releaseAccept = acceptRelease(info, nativeAvailable).catch((error: unknown) => {
      checkedRelease = null
      sendStatus({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }
  autoUpdater.on('update-available', info => { runAccept(info, true) })
  autoUpdater.on('update-not-available', info => { runAccept(info, false) })

  autoUpdater.on('download-progress', (progress) => {
    if (!availableVersion || select(availableVersion).status !== 'available') return
    console.log(`[updater] downloading ${progress.percent.toFixed(1)}%`)
    sendStatus({
      phase: 'downloading',
      ...(availableVersion ? { version: availableVersion } : {}),
      percent: progress.percent,
    })
  })

  const handleDownloaded = async (info: { version: string; downloadedFile: string }) => {
    const decision = select(info.version)
    if (decision.status !== 'available') { await acceptRelease(info, false); return }
    if (checkedRelease && checkedRelease.version !== info.version) {
      downloadedVersion = null
      sendStatus({ phase: 'error', message: 'The downloaded update does not match the checked release. Check updates again.' })
      return
    }
    const manifest = signedFeed ? verifiedManifests.get(info.version) : undefined
    if (signedFeed && (!manifest || manifest.version !== info.version)) {
      sendStatus({ phase: 'error', message: 'The downloaded update has no verified signed manifest.' })
      return
    }
    try {
      if (manifest) {
        await verifyDownloadedPackage(manifest, info.downloadedFile, updateCacheRoot())
        await persistUpdateSequence(manifest.sequence)
      }
    } catch (error: unknown) {
      sendStatus({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
      return
    }
    downloadedFiles.set(info.version, info.downloadedFile)
    downloadedVersion = info.version
    availableVersion = info.version
    sendStatus({
      phase: 'downloaded',
      version: info.version,
      releaseUrl: manifest?.releaseNotesUrl ?? releaseUrlFor(info.version),
    })
  }
  const runDownload = async (info: { version: string; downloadedFile: string }): Promise<void> => {
    downloadBusy = true
    try {
      await handleDownloaded(info)
    } catch (error: unknown) {
      sendStatus({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      downloadBusy = false
      const next = pendingDownloads.shift()
      if (next) void runDownload(next)
    }
  }
  autoUpdater.on('update-downloaded', info => {
    // Start the first event synchronously (callers may install immediately),
    // but serialize overlapping downloads so downloadedVersion / availableVersion
    // cannot interleave.
    if (downloadBusy) pendingDownloads.push(info)
    else void runDownload(info)
  })

  // The local lifecycle service owns policy and discovery activation; the
  // native updater remains the download/install effect owner.
  return controls
}

export function channelForVersion(version: string, platform: NodeJS.Platform, arch: string): string {
  const releaseChannel = releaseChannelForVersion(version)
  if (!releaseChannel) throw new Error('Unsupported OpenAlice release channel')
  const channel = releaseChannel === 'stable' ? 'latest' : releaseChannel
  // GenericProvider appends "-mac" to this channel. Intel therefore requests
  // latest-intel-mac.yml / beta-intel-mac.yml, which are compatibility aliases
  // of the public latest-mac-intel.yml / beta-mac-intel.yml feeds.
  return platform === 'darwin' && arch === 'x64' ? `${channel}-intel` : channel
}

function unsupportedUpdateMessage(reason: UnsupportedReason): string {
  if (reason === 'feed-unavailable') return 'No update feed is published for this Linux build.'
  if (reason === 'unsigned-linux-feed') return 'Linux auto-update is disabled until a signed update feed is configured.'
  if (reason === 'not-packaged') return 'Updates are disabled in development builds.'
  if (reason === 'missing-config') return 'This build has no update feed configuration.'
  const unreachable: never = reason
  return unreachable
}
