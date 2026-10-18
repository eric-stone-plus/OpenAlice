import { app, BrowserWindow } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configureWindowChrome, windowChromeOptions } from './window-chrome.js'
import { createCompanion, type CompanionHandle } from './companion.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Alice's app icon, copied to resources/icon.png by the Linux package. */
function resolveWindowIcon(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(here, '../../apps/desktop/build/icons/256x256.png')
}

export interface AppWindow {
  readonly window: BrowserWindow
  readonly companion?: CompanionHandle
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
  let companion: CompanionHandle | undefined
  try { companion = createCompanion(win) } catch (error) { console.error('[companion] startup failed:', error) }
  return { window: win, companion }
}
