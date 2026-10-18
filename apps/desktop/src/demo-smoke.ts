import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Runs inside the real isolated renderer; verifies both native file IPC and app:// requests. */
export async function runDemoSmoke(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`(async () => {
    const assert = (ok, message) => { if (!ok) throw new Error(message) }
    assert(location.protocol === 'app:', 'not an app:// renderer')
    assert(typeof require === 'undefined' && typeof process === 'undefined', 'Node globals exposed')
    assert(window.openAlice?.workspace && window.openAlice?.windowChrome, 'preload missing')
    assert(!navigator.serviceWorker.controller, 'Service Worker bypassed desktop transport')
    const runtime = await window.openAlice.runtime.info()
    assert(runtime.transport === 'electron-ipc' && runtime.ports.web === null, 'wrong transport')
    assert(runtime.userDataHome.includes('openalice-demo-'), 'state not isolated')
    const inbox = await fetch('/api/inbox/history').then(r => r.json())
    const entry = inbox.entries.find(e => e.id === 'demo-inbox-power-research')
    assert(entry, 'power report missing')
    const files = await fetch('/api/inbox/' + entry.id + '/files').then(r => r.json())
    assert(files.files.length === 2, 'report/checklist links missing')
    const report = await fetch(files.files[0].href).then(r => r.text())
    assert(report.includes('From AI demand to power delivery'), 'report fetch failed')
    const nativeFile = await window.openAlice.workspace.readFile({ id: entry.workspaceId, path: files.files[0].path })
    assert(nativeFile.kind === 'ok' && nativeFile.content === report, 'native and API files disagree')
    const escape = await window.openAlice.workspace.readFile({ id: entry.workspaceId, path: '../outside.txt' })
    assert(escape.kind === 'invalid_path', 'native file traversal allowed')
    const chat = await fetch('/api/workspaces/' + entry.workspaceId + '/sessions/' + entry.origin.sessionId + '/web').then(r => r.json())
    assert(chat.snapshot.messages.length >= 8, 'linked conversation missing')
    const missing = await fetch('/api/deliberately-unmocked')
    assert(missing.status === 501, 'unmocked API silently succeeded')
    const auth = await fetch('/api/auth/status').then(r => r.json())
    assert(auth.authed === true, 'demo authentication failed')
    const start = Date.now()
    while (!document.querySelector('button') && Date.now() - start < 15000) await new Promise(r => setTimeout(r, 100))
    assert(document.querySelector('button'), 'React UI failed to mount')
  })()`, true)
  console.log('[electron-demo-smoke] PASS app protocol, preload, isolated state, Inbox, report, native files, conversation, fail-closed API, React mount')

  await win.loadURL('app://openalice/settings/pet')
  await win.webContents.executeJavaScript(`(async () => {
    const start = Date.now()
    while (!document.querySelector('#activity-enabled')) {
      if (Date.now() - start > 10000) throw new Error('Pet settings route missing')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const preferences = await window.openAlice.companion.activity.getPreferences()
    if (!preferences.events.completion || !preferences.events.failure || !preferences.events.action || !preferences.events.news || preferences.events.progress || !preferences.brief) throw new Error('Official notification defaults missing')
    await window.openAlice.companion.activity.updatePreferences({ events: { ...preferences.events, news: false } })
    if ((await window.openAlice.companion.activity.getPreferences()).events.news !== false) throw new Error('Preference save failed')
    await window.openAlice.companion.activity.resetPreferences()
    if ((await window.openAlice.companion.activity.getPreferences()).events.news !== true) throw new Error('Preference reset failed')
    const triggered = await fetch('/api/agent-runtime/sonner-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'success' }),
    })
    if (!triggered.ok) throw new Error('Activity trigger failed')
    const started = Date.now()
    let sawSignal = false
    while (Date.now() - started < 5000) {
      const signals = await window.openAlice.companion.activity.getSignals()
      if (signals.some((signal: { kind: string }) => signal.kind === 'sonner-test-success')) { sawSignal = true; break }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!sawSignal) throw new Error('Activity pipeline did not deliver the sonner-test signal')
  })()`, true)
  writeFileSync(join(app.getPath('userData'), 'notifications-settings.png'), (await win.webContents.capturePage()).toPNG())
  console.log('[electron-demo-smoke] PASS notification defaults/save/reset')
}
