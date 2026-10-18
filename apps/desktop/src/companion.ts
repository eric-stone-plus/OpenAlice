import { installCompanionActivity } from './companion-activity.js'
import type { ActivitySource } from './activity-controller.js'
import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron'
import { readFileSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { settleCompanion, snapEase, type Rect } from './companion-geometry.js'
import { createCompanionSoundStore, DEFAULT_SOUND, type CompanionSound } from './companion-sound.js'

/** Keep the renderer viewport dimensions stable across native window frames. */
export function resizeCompanionWindow(window: BrowserWindow, width: number, height: number): void {
  if (process.platform === 'win32') window.setContentSize(width, height)
  else window.setSize(width, height)
}

/** Move and size in the same coordinate space used by the renderer. */
export function setCompanionBounds(window: BrowserWindow, bounds: Rect): void {
  if (process.platform === 'win32') window.setContentBounds(bounds)
  else window.setBounds(bounds)
}

function companionBounds(window: BrowserWindow): Rect {
  return process.platform === 'win32' ? window.getContentBounds() : window.getBounds()
}

/**
 * The window is three character-widths wide and reserves the top for the
 * speech bubble; only the middle third (bottom-aligned) is the visible pet.
 * Keep those gutters transparent and out of the placement clamp.
 */
function visualInsets(width: number, height: number) {
  const side = Math.round(width / 3)
  return { left: side, right: side, top: Math.max(0, height - side), bottom: 0 }
}

export interface CompanionHandle {
  readonly window: BrowserWindow
  configureActivity(source: ActivitySource): void
  trayMenuItems(): Electron.MenuItemConstructorOptions[]
}

/**
 * One presentation window belonging to the existing desktop process.
 * Thanks to MeteorNOX's DeepSeek Balance Whale Widget for the interaction model:
 * https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget
 * Press/release, mirroring, bubble timing and snapping follow that MIT project;
 * OpenAlice owns the native lifecycle/IPC adaptation. See companion/NOTICE.md.
 */
export function createCompanion(owner: BrowserWindow): CompanionHandle | undefined {
  if (process.env.OPENALICE_DISABLE_COMPANION === '1') return
  const here = dirname(fileURLToPath(import.meta.url))
  const assets = app.isPackaged
    ? join(process.resourcesPath, 'runtime/ui/dist/companion')
    : resolve(here, '../../ui/public/companion')
  const statePath = join(app.getPath('userData'), 'companion.json')
  let size = 220
  // The desktop pet is opt-in: a fresh profile starts with the companion
  // hidden so it cannot cover the app window. The bottom-left application
  // menu and the tray's Pet submenu show it on demand.
  let enabled = false
  let saved: Partial<Rect> = {}
  let savedOffset = { x: 0, y: 0 }
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8'))
    if ([170, 220, 280].includes(value.size)) size = value.size
    if (typeof value.enabled === 'boolean') enabled = value.enabled
    // Older builds persisted the X11 origin before the first post-map
    // placement, which parks the pet over the app window's top-left corner.
    // Treat (0,0) as "no saved position" and fall back to the bottom-right.
    // The edge offset belongs to the saved position: a discarded origin must
    // not shift the fallback placement.
    const hasSavedPosition = Number.isFinite(value.x) && Number.isFinite(value.y) && (value.x !== 0 || value.y !== 0)
    if (hasSavedPosition) {
      saved = { x: value.x, y: value.y }
      if (Number.isFinite(value.offsetX) && Number.isFinite(value.offsetY)) savedOffset = { x: value.offsetX, y: value.offsetY }
    }
  } catch { /* First launch or damaged launcher preference: use defaults. */ }
  const area = screen.getDisplayMatching(owner.getBounds()).workArea
  const width = Math.round(size * 2.7)
  const height = Math.round(size * 1.65)
  const insets = visualInsets(width, height)
  const visibleWidth = width - insets.left - insets.right
  const initialVirtual = {
    x: (saved.x ?? area.x + area.width - insets.left - visibleWidth - 24) + savedOffset.x,
    y: (saved.y ?? area.y + area.height - height - 24) + savedOffset.y,
    width,
    height,
  }
  // Select the display by the visible character, not by the virtual window:
  // a window shifted left to reach the edge can have a negative origin that
  // getDisplayMatching resolves to the primary display.
  const visibleRect = (bounds: Rect): Rect => {
    const current = visualInsets(bounds.width, bounds.height)
    return {
      x: bounds.x + current.left,
      y: bounds.y + current.top,
      width: bounds.width - current.left - current.right,
      height: bounds.height - current.top - current.bottom,
    }
  }
  const initialArea = screen.getDisplayMatching(visibleRect(initialVirtual)).workArea
  const settled = settleCompanion(initialVirtual, initialArea, false, insets)
  // The position the pet should occupy after the window is mapped. Mutter
  // ignores constructor bounds for a newly mapped window, so both the ready
  // handler and the hidden-at-startup toggle path re-apply this position.
  let intended = { x: settled.x, y: settled.y, area: initialArea }
  // Some WMs clamp a window's left/top edge to the screen. Keep the native
  // window inside the work area and translate the character inside it, so the
  // visible pet can still reach the left and top edges.
  const initialWindowX = Math.round(Math.max(initialArea.x, settled.x))
  const initialWindowY = Math.round(Math.max(initialArea.y, settled.y))
  let visualOffset = { x: settled.x - initialWindowX, y: settled.y - initialWindowY }
  const pet = new BrowserWindow({
    x: initialWindowX, y: initialWindowY, width: settled.width, height: settled.height,
    title: 'Alice', transparent: true, frame: false, hasShadow: false,
    // Frameless transparent Windows windows reserve a native border outside
    // the requested bounds unless their dimensions are content dimensions.
    // Keep macOS on its existing input-coordinate path.
    useContentSize: process.platform === 'win32',
    resizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, show: false,
    ...(process.platform === 'win32' ? { thickFrame: false, type: 'toolbar' } : {}),
    webPreferences: { preload: join(here, 'companion-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, autoplayPolicy: 'no-user-gesture-required' },
  })
  if (process.platform === 'darwin') pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  pet.setIgnoreMouseEvents(true, { forward: true })
  pet.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  pet.webContents.on('will-navigate', event => event.preventDefault())
  let ready = false
  let flipped = settled.flipped
  let reducedMotion = false
  let snapTimer: ReturnType<typeof setInterval> | undefined
  const stopSnap = () => { clearInterval(snapTimer); snapTimer = undefined }
  let drag: { start: Electron.Point; bounds: Rect; offset: { x: number; y: number }; moved: boolean } | undefined
  const petSize = () => ({ width: Math.round(size * 2.7), height: Math.round(size * 1.65) })
  const inPositionRange = (value: number) =>
    Number.isFinite(value) && Math.round(value) >= -2_147_483_648 && Math.round(value) <= 2_147_483_647
  const moveTo = (x: number, y: number): boolean => {
    if (pet.isDestroyed() || !inPositionRange(x) || !inPositionRange(y)) { stopSnap(); return false }
    try {
      setCompanionBounds(pet, { x: Math.round(x), y: Math.round(y), ...petSize() })
      return true
    } catch (error) {
      console.error('[companion] failed to move pet:', error)
      stopSnap()
      return false
    }
  }
  const publishOffset = () => {
    if (!pet.isDestroyed()) pet.webContents.send('openalice:companion:offset', visualOffset)
  }
  const moveVirtual = (virtualX: number, virtualY: number, targetArea: Rect): boolean => {
    const x = Math.round(Math.max(targetArea.x, virtualX))
    const y = Math.round(Math.max(targetArea.y, virtualY))
    const nextOffset = { x: virtualX - x, y: virtualY - y }
    if (nextOffset.x !== visualOffset.x || nextOffset.y !== visualOffset.y) {
      visualOffset = nextOffset
      publishOffset()
    }
    return moveTo(x, y)
  }
  const updateDrag = () => {
    if (!drag) return
    const cursor = screen.getCursorScreenPoint()
    const dx = cursor.x - drag.start.x, dy = cursor.y - drag.start.y
    if (dx * dx + dy * dy >= 9) drag.moved = true
    if (!drag.moved) return
    const virtualX = drag.bounds.x + drag.offset.x + dx
    const virtualY = drag.bounds.y + drag.offset.y + dy
    const targetArea = screen.getDisplayMatching(visibleRect({
      x: virtualX, y: virtualY, width: drag.bounds.width, height: drag.bounds.height,
    })).workArea
    moveVirtual(virtualX, virtualY, targetArea)
  }
  let writeQueue = Promise.resolve()
  const save = () => {
    if (pet.isDestroyed()) return
    const { x, y } = companionBounds(pet)
    const payload = JSON.stringify({ x, y, offsetX: visualOffset.x, offsetY: visualOffset.y, size, enabled })
    writeQueue = writeQueue.then(async () => {
      await writeFile(statePath + '.tmp', payload)
      await rename(statePath + '.tmp', statePath)
    }).catch(error => console.error('[companion] preference save failed:', error.message))
  }
  const settle = (snap = true) => {
    stopSnap()
    if (pet.isDestroyed()) return
    const current = companionBounds(pet)
    // A hidden window can be parked at the origin by the window manager, so a
    // re-settle while hidden starts from the last intended position instead.
    const currentVirtual = pet.isVisible()
      ? { ...current, x: current.x + visualOffset.x, y: current.y + visualOffset.y }
      : { x: intended.x, y: intended.y, width: current.width, height: current.height }
    const targetArea = screen.getDisplayMatching(visibleRect(currentVirtual)).workArea
    const next = settleCompanion(currentVirtual, targetArea, snap, visualInsets(current.width, current.height))
    intended = { x: next.x, y: next.y, area: targetArea }
    flipped = next.flipped
    pet.webContents.send('openalice:companion:flip', flipped)
    if (!snap || reducedMotion) { moveVirtual(next.x, next.y, targetArea); save(); return }
    const start = performance.now()
    const startX = currentVirtual.x, startY = currentVirtual.y
    snapTimer = setInterval(() => {
      const progress = Math.min(1, (performance.now() - start) / 160)
      const ease = snapEase(progress)
      const virtualX = startX + (next.x - startX) * ease
      const virtualY = startY + (next.y - startY) * ease
      if (!moveVirtual(virtualX, virtualY, targetArea)) return
      if (progress === 1) { stopSnap(); moveVirtual(next.x, next.y, targetArea); save() }
    }, 16)
  }
  // Mutter ignores constructor bounds for a newly mapped window. Both show
  // paths (first launch and the hidden-at-startup toggle) re-apply the
  // intended position once the window is mapped.
  const reapplyIntended = () => {
    if (!enabled || drag || pet.isDestroyed()) return
    moveVirtual(intended.x, intended.y, intended.area)
    save()
  }
  const open = () => { if (!owner.isDestroyed()) { if (owner.isMinimized()) owner.restore(); owner.show(); owner.focus() } }
  const toggle = () => {
    if (pet.isDestroyed()) return
    enabled = !enabled
    if (enabled && ready) {
      // Use the last intended position rather than the current hidden-window
      // bounds: Mutter may have parked the unmapped window at the origin.
      moveVirtual(intended.x, intended.y, intended.area)
      pet.showInactive()
      // A pet that starts hidden (the default) never runs the ready handler's
      // post-map move. Mutter places the newly mapped window on the active
      // monitor and ignores the constructor bounds, so re-apply the intended
      // position once it is mapped or the pet lands over the app window.
      setTimeout(reapplyIntended, 150)
    } else pet.hide()
    save()
    if (!owner.isDestroyed()) owner.webContents.send('openalice:companion:visibility', enabled)
  }
  const ownerTrusted = (event: Electron.IpcMainInvokeEvent) =>
    event.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame
  const visibilityChannel = 'openalice:companion:get-visible'
  const toggleChannel = 'openalice:companion:toggle'
  const defaultSound: CompanionSound = {
    ...DEFAULT_SOUND,
    source: {
      name: 'OpenAlice default (Soft double).wav',
      dataUrl: `data:audio/wav;base64,${readFileSync(join(assets, 'click.wav')).toString('base64')}`,
    },
  }
  const sound = createCompanionSoundStore(join(app.getPath('userData'), 'companion-sound.json'), defaultSound)
  const soundGet = 'openalice:companion:sound:get'
  const soundUpdate = 'openalice:companion:sound:update'
  const soundReset = 'openalice:companion:sound:reset'
  const publishSound = (settings: CompanionSound) => {
    for (const window of [owner, pet]) {
      if (!window.isDestroyed()) window.webContents.send('openalice:companion:sound:changed', settings)
    }
  }
  ipcMain.handle(soundGet, event => {
    const petTrusted = event.sender === pet.webContents && event.senderFrame === pet.webContents.mainFrame
    if (!ownerTrusted(event) && !petTrusted) throw new Error('Unauthorized companion access')
    return sound.get()
  })
  ipcMain.handle(soundUpdate, async (event, input: unknown) => {
    if (!ownerTrusted(event)) throw new Error('Unauthorized companion access')
    const settings = await sound.update(input)
    publishSound(settings)
    return settings
  })
  ipcMain.handle(soundReset, async event => {
    if (!ownerTrusted(event)) throw new Error('Unauthorized companion access')
    const settings = await sound.reset()
    publishSound(settings)
    return settings
  })
  ipcMain.handle(visibilityChannel, event => {
    if (!ownerTrusted(event)) throw new Error('Unauthorized companion access')
    return enabled
  })
  ipcMain.handle(toggleChannel, event => {
    if (!ownerTrusted(event)) throw new Error('Unauthorized companion access')
    toggle()
    return enabled
  })
  pet.once('closed', () => {
    ipcMain.removeHandler(visibilityChannel)
    ipcMain.removeHandler(toggleChannel)
    ipcMain.removeHandler(soundGet)
    ipcMain.removeHandler(soundUpdate)
    ipcMain.removeHandler(soundReset)
  })
  const activity = installCompanionActivity(owner, pet)
  const trayMenuItems = (): Electron.MenuItemConstructorOptions[] => [
    { label: enabled ? 'Hide pet' : 'Show pet', click: toggle },
    { label: 'Size', submenu: [170, 220, 280].map(value => ({
      label: value === 170 ? 'Small' : value === 220 ? 'Medium' : 'Large', type: 'radio' as const, checked: size === value,
      click: () => {
        if (pet.isDestroyed()) return
        const old = companionBounds(pet); size = value
        const { width, height } = petSize()
        setCompanionBounds(pet, { x: Math.round(old.x + (old.width - width) / 2), y: old.y + old.height - height, width, height })
        settle(false); save()
      },
    })) },
  ]
  const menu = () => Menu.buildFromTemplate([
    { label: 'Show OpenAlice', click: open },
    ...trayMenuItems(),
    { type: 'separator' },
    { label: 'Quit OpenAlice', click: () => app.quit() },
  ])
  const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => event.sender === pet.webContents && event.senderFrame === pet.webContents.mainFrame
  const listen = (action: string, callback: (input: unknown) => void) => {
    const channel = 'openalice:companion:' + action
    const handler = (event: Electron.IpcMainEvent, input: unknown) => { if (trusted(event)) callback(input) }
    ipcMain.on(channel, handler)
    pet.once('closed', () => ipcMain.removeListener(channel, handler))
  }
  listen('ready', () => {
    ready = true
    pet.webContents.send('openalice:companion:flip', flipped)
    pet.webContents.send('openalice:companion:offset', visualOffset)
    if (!enabled) return
    pet.showInactive()
    // Mutter places a newly mapped window on the active monitor and ignores
    // the bounds passed to the constructor. A post-map move is honored, so
    // re-apply the intended virtual position once the window is visible.
    setTimeout(reapplyIntended, 150)
  })
  listen('reduced-motion', value => { if (typeof value === 'boolean') reducedMotion = value })
  listen('interactive', value => { if (typeof value === 'boolean') pet.setIgnoreMouseEvents(drag ? false : !value, { forward: true }) })
  listen('begin-drag', () => {
    stopSnap()
    drag = {
      start: screen.getCursorScreenPoint(),
      bounds: companionBounds(pet),
      offset: { ...visualOffset },
      moved: false,
    }
    pet.setIgnoreMouseEvents(false)
  })
  listen('move-drag', updateDrag)
  listen('menu', () => menu().popup({ window: pet }))
  listen('open', open)
  const endChannel = 'openalice:companion:end-drag'
  ipcMain.handle(endChannel, (event, cancelled) => {
    if (!trusted(event)) return false
    updateDrag()
    const moved = drag?.moved ?? false
    if (drag && cancelled === true && !pet.isDestroyed()) {
      const virtualX = drag.bounds.x + drag.offset.x
      const virtualY = drag.bounds.y + drag.offset.y
      const targetArea = screen.getDisplayMatching(visibleRect({
        x: virtualX, y: virtualY, width: drag.bounds.width, height: drag.bounds.height,
      })).workArea
      moveVirtual(virtualX, virtualY, targetArea)
    }
    drag = undefined
    if (moved && cancelled !== true) settle()
    return moved
  })
  // Cursor polling recovers hover after native click-through and crosses monitors.
  let lastCursor = ''
  const tick = setInterval(() => {
    if (pet.isDestroyed() || !ready || !pet.isVisible()) return
    const cursor = screen.getCursorScreenPoint()
    updateDrag()
    const box = companionBounds(pet)
    const point = { x: cursor.x - box.x, y: cursor.y - box.y }
    const key = `${point.x},${point.y}`
    if (key !== lastCursor) { lastCursor = key; pet.webContents.send('openalice:companion:cursor', point) }
  }, 50)
  const displayChanged = () => { if (!pet.isDestroyed()) { settle(false); save() } }
  screen.on('display-removed', displayChanged)
  screen.on('display-metrics-changed', displayChanged)
  owner.once('closed', () => { if (!pet.isDestroyed()) pet.destroy() })
  pet.once('closed', () => {
    clearInterval(tick); stopSnap(); ipcMain.removeHandler(endChannel)
    screen.removeListener('display-removed', displayChanged)
    screen.removeListener('display-metrics-changed', displayChanged)
  })
  void pet.loadFile(join(assets, 'index.html')).catch(error => {
    console.error('[companion] load failed:', error.message)
    if (!pet.isDestroyed()) pet.destroy()
  })
  return { window: pet, trayMenuItems, configureActivity: activity.configure }
}
