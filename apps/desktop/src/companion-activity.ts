import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { createActivityPreferenceStore } from './activity-preferences.js'
import { ActivityController, type ActivitySource } from './activity-controller.js'

/**
 * Activity notifications live in the main window. The desktop pet used to be a
 * second native window; it is now the welcome-screen logo. `pet` stays optional
 * so a future surface can subscribe without reworking the controller.
 */
export function installCompanionActivity(owner: BrowserWindow, pet?: BrowserWindow) {
  const store = createActivityPreferenceStore(join(app.getPath('userData'), 'activity-notifications.json'))
  let source: ActivitySource | undefined
  // A window can outlive its webContents (renderer crash, navigation teardown).
  // Sending to the dead renderer trips a Chromium CHECK in the main process, so
  // every push path checks both objects.
  const alive = (target: BrowserWindow | undefined): target is BrowserWindow =>
    target !== undefined && !target.isDestroyed() && !target.webContents.isDestroyed()
  const foreground = () => !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized()
  const petAlive = () => pet !== undefined && !pet.isDestroyed()
  const controller = new ActivityController({ identity: () => source?.identity() ?? null, read: (query, signal) => {
    if (!source) throw new Error('No activity source')
    return source.read(query, signal)
  } }, {
    signals: signals => { if (alive(owner)) owner.webContents.send('openalice:activity:signals', signals) },
    foreground, petVisible: () => petAlive() && pet!.isVisible(),
    send: (surface, event) => {
      const window = surface === 'main' ? owner : pet
      if (alive(window)) window.webContents.send('openalice:activity:display', event)
    },
    open: context => {
      if (owner.isDestroyed()) return
      if (owner.isMinimized()) owner.restore()
      owner.show(); owner.focus()
      if (alive(owner)) owner.webContents.send('openalice:activity:open', context)
    },
  }, store.get())
  const trusted = (event: Electron.IpcMainInvokeEvent, window: BrowserWindow) =>
    !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
  const handlers: string[] = []
  const handle = (name: string, callback: (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown) => {
    const channel = 'openalice:activity:' + name; handlers.push(channel); ipcMain.handle(channel, callback)
  }
  handle('preferences', event => { if (!trusted(event, owner)) throw new Error('Unauthorized activity access'); return store.get() })
  const publish = (settings: ReturnType<typeof store.get>) => {
    controller.setPreferences(settings)
    if (alive(owner)) owner.webContents.send('openalice:activity:preferences-changed', settings)
    return settings
  }
  handle('update-preferences', async (event, input) => { if (!trusted(event, owner)) throw new Error('Unauthorized activity access'); return publish(await store.update(input)) })
  handle('reset-preferences', async event => { if (!trusted(event, owner)) throw new Error('Unauthorized activity access'); return publish(await store.reset()) })
  handle('signals', event => { if (!trusted(event, owner)) throw new Error('Unauthorized activity access'); return controller.signalSnapshot() })
  handle('snapshot', event => { if (!trusted(event, owner)) throw new Error('Unauthorized activity access'); return controller.snapshot() })
  for (const action of ['open', 'dismiss'] as const) handle(action, (event, input) => {
    let surface: 'main' | 'pet' | null = null
    if (trusted(event, owner)) surface = 'main'
    else if (pet && trusted(event, pet)) surface = 'pet'
    if (!surface) throw new Error('Unauthorized activity access')
    return controller[action](input, surface)
  })
  const transition = () => controller.transition()
  owner.on('show', transition); owner.on('hide', transition); owner.on('minimize', transition); owner.on('restore', transition)
  pet?.on('hide', transition)
  // Native main timer continues while the main renderer is minimized/throttled.
  const timer = setInterval(() => { void controller.poll() }, 4_000)
  owner.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) transition() })
  const dispose = () => {
    clearInterval(timer); controller.stop()
    for (const channel of handlers) ipcMain.removeHandler(channel)
    owner.removeListener('show', transition); owner.removeListener('hide', transition); owner.removeListener('minimize', transition); owner.removeListener('restore', transition)
    pet?.removeListener('hide', transition)
  }
  if (pet) pet.once('closed', dispose)
  else owner.once('closed', dispose)
  return { configure(value: ActivitySource) { source = value; void controller.poll() } }
}
