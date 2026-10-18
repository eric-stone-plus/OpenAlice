# Tauri migration assessment

Status: **assessment only** — no migration has been started. Replacing the
desktop shell is a product/architecture decision that belongs to the project
owner, not a packaging change an agent should make unilaterally.

Date: 2026-10-18

## Question

OpenAlice's desktop GUI is Electron. Can the shell be replaced with Tauri?

## Short answer

Technically yes, but it is a rewrite of the desktop main process, not a
"swap the runtime" change. The React/Vite UI can be reused. The Electron main
process, preload bridge, native integrations, companion window, tray, updates
and packaging all need a Rust/Tauri implementation. A realistic estimate for
one experienced engineer is **4–8 weeks**, plus platform testing, and the
result would not automatically fix the Wayland companion-drag problem.

## What is reusable

- `ui/` — React + Vite renderer, components, styles, state.
- The local web relay protocol and the Alice/UTA/connector services, which are
  separate Node processes today.
- The workspace/runtime data model and CLI.

## What must be rewritten

| Electron component | Current location | Tauri replacement |
| --- | --- | --- |
| Main process / guardian | `apps/desktop/src/main.ts` (~1,800 lines) | Rust `tauri::Builder`, process supervision, port probing, runtime locks |
| Preload / IPC bridge | `apps/desktop/src/preload.ts`, `ipc.ts` | Tauri commands + events, capability-scoped permissions |
| Companion window | `companion.ts`, `companion-preload.ts`, `ui/public/companion` | Tauri window + WebView, native hit-testing/click-through, tray menu |
| Tray / menus | `createTray` in `main.ts` | Tauri tray API |
| Window chrome | `window-chrome.ts` | Tauri window decorations / platform APIs |
| Auto-update | `auto-update.ts`, `update-lifecycle.ts` | Tauri updater (different signing/feed format) |
| Terminal | `node-pty` | Rust PTY crate or keep a Node sidecar |
| Bundled Git / Pi runtime | `vendor/`, `managed-runtime.ts` | Rust process management or sidecar |
| Packaging | electron-builder config | Tauri bundler (deb/rpm/AppImage) |
| Desktop integration | `linux` block in `package.json` | Tauri bundle config + `.desktop` assets |

## Wayland caveat

Tauri on Linux uses WebKitGTK and the compositor's native window protocol.
Wayland deliberately does not let a client place its own windows at arbitrary
global coordinates. The companion's drag/snap behavior relies on
`screen.getCursorScreenPoint()` and `BrowserWindow.setBounds()`, which are
already unsupported on native Wayland in Electron. A Tauri port would face the
same restriction; it would still need XWayland or a compositor-specific
protocol (e.g. wlr-layer-shell) to implement a freely draggable always-on-top
pet. Migrating to Tauri therefore does **not** remove the need for the
`--ozone-platform=x11` workaround on Wayland.

## Options

| Option | Effort | Risk | When it makes sense |
| --- | --- | --- | --- |
| A. Keep Electron, ship the Linux build | hours | low | Immediate need: a working Linux desktop now |
| B. Tauri spike: shell + UI + companion prototype | 1–2 days | medium | Validate WebKitGTK rendering, tray, window behavior before committing |
| C. Full Tauri migration | 4–8 weeks | high | Bundle size / memory / security is a strategic requirement and the team owns Rust |

## Recommendation

Ship the Electron Linux package first. It is already built and verified, and
the companion/EPIPE/system-Git fixes are small and testable. Before committing
to a Tauri rewrite, run option B: load the existing `ui/dist` in a Tauri
window, implement one native command and the companion window, and measure
WebKitGTK rendering, tray support, and Wayland behavior. Only then decide
whether the 4–8 week rewrite is justified.

## Open questions for the project owner

1. What is the primary driver for Tauri: installer size, memory use, security
   surface, or something else?
2. Is WebKitGTK acceptable as the Linux renderer for the existing UI (CSS/JS
   compatibility, charts, fonts)?
3. Is a 4–8 week rewrite (plus ongoing dual-platform maintenance) acceptable?
4. Who owns the Rust code and the release pipeline after migration?
5. Would a Node sidecar for the agent runtime/PTY be acceptable, or must the
   whole backend be Rust?
6. Is the Wayland companion behavior a hard requirement, or can it stay
   XWayland-only?

Until these are answered, the Electron shell remains the supported desktop
implementation.
