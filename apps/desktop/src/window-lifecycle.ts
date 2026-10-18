import type { App, BrowserWindow } from 'electron'

/** Restore the same window from the tray or the macOS Dock. */
export function showAppWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Closing the window keeps the desktop runtime alive where the OS exposes a
 * tray or Dock entry. Linux desktops frequently ship without an AppIndicator
 * host, so a hidden window would leave no way back and no way to quit: there a
 * close is a full quit.
 */
export function configureWindowLifecycle(
  app: App,
  win: BrowserWindow,
  isQuitting: () => boolean,
  closeAction: 'hide' | 'quit' = 'hide',
): void {
  win.on('close', event => {
    if (isQuitting()) return
    event.preventDefault()
    if (closeAction === 'quit') {
      // Keep the window visible until the quit is accepted: a cancelled quit
      // must not leave a hidden window behind on a desktop without a tray.
      app.quit()
      return
    }
    win.hide()
  })

  const activate = () => {
    if (!isQuitting()) showAppWindow(win)
  }
  app.on('activate', activate)
  win.once('closed', () => app.removeListener('activate', activate))
}
