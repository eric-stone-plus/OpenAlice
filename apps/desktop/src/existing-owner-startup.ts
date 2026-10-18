import { dialog, shell } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  decideExistingOwnerStartup,
  guardianLockDir,
  inspectOpenAliceInstance,
  inspectRuntimeLock,
  ownerLabel,
  probeLoopbackAuthStatus,
  readDiscoveredRuntimeStatus,
  type ExistingOwnerStartupDecision,
  type RuntimeLockInspection,
} from '@traderalice/guardian-runtime'

import { clearShutdownMarker, readShutdownMarker, type ShutdownMarker } from './shutdown-marker.js'

export type ExistingOwnerStartupResult =
  | { readonly action: 'continue'; readonly takeover: boolean }
  | { readonly action: 'quit' }
  | { readonly action: 'choose-another' }

export interface ExistingOwnerStartupDependencies {
  inspectLocks?: typeof inspectOpenAliceInstance
  discoverRuntime?: typeof readDiscoveredRuntimeStatus
  probeAuth?: typeof probeLoopbackAuthStatus
  showMessageBox?: typeof dialog.showMessageBox
  showErrorBox?: typeof dialog.showErrorBox
  openExternal?: typeof shell.openExternal
  shutdownWait?: ShutdownWaitDependencies
}

export interface ShutdownWaitDependencies {
  readonly readMarker?: (home: string) => ShutdownMarker | null
  readonly inspectLock?: (home: string) => Promise<RuntimeLockInspection>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly pollMs?: number
}

/**
 * A relaunch that races a graceful quit must wait for the recorded desktop
 * owner to release its locks instead of reporting "already running". The
 * marker is trusted only while it names the active owner, so a leftover
 * marker from a killed process cannot delay the next launch.
 */
export async function waitForShutdownOwner(
  owner: { readonly pid: number },
  home: string,
  dependencies: ShutdownWaitDependencies = {},
): Promise<boolean> {
  const marker = (dependencies.readMarker ?? readShutdownMarker)(home)
  if (!marker || marker.pid !== owner.pid) return false
  const inspectLock = dependencies.inspectLock
    ?? ((value: string) => inspectRuntimeLock(guardianLockDir(value)))
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = dependencies.now ?? Date.now
  const deadline = now() + (dependencies.timeoutMs ?? 12_000)
  const pollMs = dependencies.pollMs ?? 200
  while (now() < deadline) {
    await sleep(pollMs)
    let state: RuntimeLockInspection
    try {
      state = await inspectLock(home)
    } catch {
      // Cannot confirm the release; fall back to the normal conflict decision
      // instead of aborting startup on a transient inspection failure.
      return false
    }
    if (state.state !== 'active' || state.owner?.pid !== owner.pid) {
      clearShutdownMarker(home)
      return true
    }
  }
  return false
}

export function existingOwnerSmokeMode(
  env: NodeJS.ProcessEnv = process.env,
): 'open-browser' | undefined {
  return env['OPENALICE_ELECTRON_SMOKE_EXISTING_OWNER'] === 'open-browser'
    ? 'open-browser'
    : undefined
}

export async function resolveExistingOwnerStartup(options: {
  readonly userDataHome: string
  readonly launcherRoot: string
  readonly canChooseAnother: boolean
  readonly takeoverRequested: boolean
  readonly dependencies?: ExistingOwnerStartupDependencies
}): Promise<ExistingOwnerStartupResult> {
  if (options.takeoverRequested) return { action: 'continue', takeover: true }

  const inspectLocks = options.dependencies?.inspectLocks ?? inspectOpenAliceInstance
  const discoverRuntime = options.dependencies?.discoverRuntime ?? readDiscoveredRuntimeStatus
  const probeAuth = options.dependencies?.probeAuth ?? probeLoopbackAuthStatus
  const inspections = await inspectLocks({
    userDataHome: options.userDataHome,
    launcherRoot: options.launcherRoot,
  })
  const active = inspections.find((row) => row.state === 'active' && row.owner)
  if (!active?.owner) return { action: 'continue', takeover: false }
  let owner = active
  if (await waitForShutdownOwner({ pid: active.owner.pid }, options.userDataHome, options.dependencies?.shutdownWait)) {
    const refreshed = await inspectLocks({
      userDataHome: options.userDataHome,
      launcherRoot: options.launcherRoot,
    })
    const next = refreshed.find((row) => row.state === 'active' && row.owner)
    if (!next?.owner) return { action: 'continue', takeover: false }
    owner = next
  }

  const discovered = await discoverRuntime({ homeRoot: options.userDataHome })
  const advertised = discovered?.endpoints.web
  const probeOk = advertised ? await probeAuth(advertised) : false
  const decision = decideExistingOwnerStartup({
    home: options.userDataHome,
    lock: owner,
    discovered,
    probeOk,
    canChooseAnother: options.canChooseAnother,
  })
  if (decision.kind === 'continue') return { action: 'continue', takeover: false }

  const smoke = existingOwnerSmokeMode()
  if (smoke === 'open-browser') {
    return takeSmokeHandoff(decision)
  }

  return presentExistingOwnerDialog(decision, options.dependencies)
}

async function takeSmokeHandoff(
  decision: ExistingOwnerStartupDecision,
): Promise<ExistingOwnerStartupResult> {
  if (!decision.allowOpenBrowser || !decision.url) {
    throw new Error(
      `existing-owner smoke expected browser handoff, got ${decision.kind}: ${decision.reason}`,
    )
  }
  const receiptPath = process.env['OPENALICE_ELECTRON_SMOKE_EXISTING_OWNER_RECEIPT']?.trim()
  if (receiptPath) {
    await mkdir(dirname(receiptPath), { recursive: true })
    await writeFile(receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      action: 'open-browser',
      url: decision.url,
      pid: decision.pid,
    }, null, 2)}\n`, 'utf8')
  }
  console.log(`[guardian] existing-owner handoff → ${decision.url} pid=${decision.pid}`)
  return { action: 'quit' }
}

async function presentExistingOwnerDialog(
  decision: ExistingOwnerStartupDecision,
  dependencies: ExistingOwnerStartupDependencies | undefined,
): Promise<ExistingOwnerStartupResult> {
  const showMessageBox = dependencies?.showMessageBox ?? dialog.showMessageBox
  const showErrorBox = dependencies?.showErrorBox ?? dialog.showErrorBox
  const openExternal = dependencies?.openExternal ?? shell.openExternal
  const buttons = dialogButtons(decision)
  const { response } = await showMessageBox({
    type: decision.heartbeatStale ? 'warning' : 'question',
    title: 'OpenAlice is already running',
    message: dialogMessage(decision),
    detail: dialogDetail(decision),
    buttons,
    defaultId: dialogDefaultId(decision, buttons),
    cancelId: dialogCancelId(decision, buttons),
    noLink: true,
  })
  const chosen = buttons[response] ?? buttons[0]!

  if (chosen === 'Open in browser') {
    try {
      await openExternal(decision.url!)
      console.log(`[guardian] existing-owner handoff → ${decision.url} pid=${decision.pid}`)
      return { action: 'quit' }
    } catch (error) {
      showErrorBox(
        'OpenAlice — could not open the existing Runtime',
        `${error instanceof Error ? error.message : String(error)}\n\nThe original AliceProject was left running.`,
      )
      return presentExistingOwnerDialog(decision, dependencies)
    }
  }
  if (chosen === 'Choose another data location') return { action: 'choose-another' }
  if (chosen === 'Stop the other AliceProject and start this one'
    || chosen === 'Stop it and start this AliceProject') {
    return { action: 'continue', takeover: true }
  }
  return { action: 'quit' }
}

export function dialogButtons(decision: ExistingOwnerStartupDecision): string[] {
  const takeover = decision.kind === 'handoff'
    ? 'Stop the other AliceProject and start this one'
    : 'Stop it and start this AliceProject'
  const buttons: string[] = []
  if (decision.allowOpenBrowser) buttons.push('Open in browser')
  // Keep a real cancel path even when browser handoff is the recommended
  // action. Electron maps window close/Escape to cancelId; pointing that at
  // Open in browser would turn dismissal into an unexpected side effect.
  buttons.push('Keep existing AliceProject')
  if (decision.allowChooseAnother) buttons.push('Choose another data location')
  if (decision.allowTakeover) buttons.push(takeover)
  return buttons
}

export function dialogDefaultId(
  decision: ExistingOwnerStartupDecision,
  buttons: readonly string[] = dialogButtons(decision),
): number {
  if (decision.defaultAction === 'open-browser') return Math.max(0, buttons.indexOf('Open in browser'))
  if (decision.defaultAction === 'takeover') {
    return Math.max(0, buttons.findIndex((button) => button.startsWith('Stop ')))
  }
  return Math.max(0, buttons.indexOf('Keep existing AliceProject'))
}

export function dialogCancelId(
  decision: ExistingOwnerStartupDecision,
  buttons: readonly string[] = dialogButtons(decision),
): number {
  const keep = buttons.indexOf('Keep existing AliceProject')
  if (keep >= 0) return keep
  return Math.max(0, buttons.indexOf('Open in browser'))
}

function dialogMessage(decision: ExistingOwnerStartupDecision): string {
  if (decision.kind === 'handoff') {
    return `A ${ownerLabel(decision.surface)} is already using this data location.`
  }
  return `Another AliceProject (${decision.surface}) is using this data.`
}

function dialogDetail(decision: ExistingOwnerStartupDecision): string {
  const lines = [
    `PID ${decision.pid}`,
    `Data: ${decision.home}`,
  ]
  if (decision.url) lines.push(`Web: ${decision.url}`)
  lines.push('', decision.reason)
  if (decision.kind === 'handoff') {
    lines.push('Open the existing Runtime in your browser instead of replacing it.')
  }
  if (decision.heartbeatStale) {
    lines.push('', 'The process is still present, but its health heartbeat is stale.')
  }
  return lines.join('\n')
}
