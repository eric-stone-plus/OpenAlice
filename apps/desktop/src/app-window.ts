import { app, BrowserWindow } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configureWindowChrome, windowChromeOptions } from './window-chrome.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Alice's app icon, copied to resources/icon.png by the Linux package. */
function resolveWindowIcon(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(here, '../../apps/desktop/build/icons/256x256.png')
}

export interface AppWindow {
  readonly window: BrowserWindow
}

/** Keep dev/demo and installed desktop renderer isolation and chrome identical. */
export function createAppWindow(preload: string, title = 'OpenAlice'): AppWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title,
    ...(process.platform === 'linux' ? { icon: resolveWindowIcon() } : {}),
    ...windowChromeOptions(),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  // Several desktop subsystems subscribe to the main window's lifecycle; the
  // default limit of 10 is below the current combined count.
  win.setMaxListeners(20)
  configureWindowChrome(win)
  installZoomShortcuts(win)
  return { window: win }
}

const ZOOM_STEP = 0.5
const MIN_ZOOM_LEVEL = -3
const MAX_ZOOM_LEVEL = 5

/**
 * The custom chrome replaces the native menu, so Chromium's default zoom
 * accelerators are not installed. Bind Ctrl/Cmd + `+` / `-` / `0` directly on
 * the window; `setZoomLevel` also persists the origin's zoom in the session.
 */
function installZoomShortcuts(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || (!input.control && !input.meta) || input.alt) return
    const contents = win.webContents
    if (input.key === '+' || input.key === '=') {
      event.preventDefault()
      contents.setZoomLevel(Math.min(contents.getZoomLevel() + ZOOM_STEP, MAX_ZOOM_LEVEL))
    } else if (input.key === '-' || input.key === '_') {
      event.preventDefault()
      contents.setZoomLevel(Math.max(contents.getZoomLevel() - ZOOM_STEP, MIN_ZOOM_LEVEL))
    } else if (input.key === '0') {
      event.preventDefault()
      contents.setZoomLevel(0)
    }
  })
}
