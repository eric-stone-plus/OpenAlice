# Linux desktop build and companion fix

Built from this checkout on Fedora 44 on 2026-10-18. The official site ships
only macOS/Windows; these are the Linux artifacts produced from source.

## Artifacts

`dist/electron-app-pet/`:

| Artifact | Size | Use |
| --- | --- | --- |
| `OpenAlice-0.95.0-beta.AppImage` | 223 MB | Portable; on Fedora install `libfuse2` first |
| `open-alice_0.95.0-beta_amd64.deb` | 174 MB | Debian/Ubuntu |
| `open-alice-0.95.0-beta.x86_64.rpm` | 151 MB | Fedora — native install path |
| `open-alice-0.95.0-beta.tar.gz` | 212 MB | Portable archive, no desktop entry |
| `linux-unpacked/` | — | Unpacked app; run `open-alice` directly |

Install on Fedora:

```bash
sudo dnf install ./open-alice-0.95.0-beta.x86_64.rpm
```

or run the unpacked app:

```bash
./dist/electron-app-pet/linux-unpacked/open-alice
```

On Wayland the app relaunches itself under XWayland; no flag is required.

## What changed

- **Companion placement** (`apps/desktop/src/companion.ts`,
  `companion-geometry.ts`): clamp/snap the visible character box instead of
  the 594x363 window; keep a virtual position and a renderer offset
  (`#offset` + `companion:offset`) so the character can reach the left/top
  edges where Mutter clamps negative window positions; select the display
  with `visibleRect`; re-apply the initial position after the window is
  mapped; persist `offsetX/offsetY` in `companion.json`.
- **Icons** (`apps/desktop/build/icon-pet.png`,
  `apps/desktop/build/icons/`, `apps/desktop/build/tray-pet.png`,
  `ui/src/assets/alice-pet-avatar.png`): the 1024px pet master generates the
  16-512 hicolor set (the theme stops at 512); the 256px copy is the window
  icon, the 64px head crop is resized to 22px for the tray, and the 24px
  avatar stays in the UI. The Linux packages install the pet icon set and the
  `.desktop` entry.
- **UI** (`ui/src/pages/ChatLandingPage.tsx`,
  `ui/src/components/ActivityBarUtilityMenu.tsx`): removed the hero image
  above "What should Alice work on?"; the bottom-left avatar is the pet.
- **Runtime** (`apps/desktop/src/main.ts`, `git-execution.ts`,
  `console-guard.ts`): Wayland -> XWayland relaunch; software rendering on
  Linux (the XWayland GPU process can fail with error_code=1002 and kill the
  app); system git fallback; EPIPE-only console guard.
- `PITFALLS.md` and `docs/tauri-migration-assessment.md` document the traps
  and the Tauri assessment.

## Verification

- `pnpm -F @traderalice/desktop typecheck`
- `vitest run apps/desktop/src/companion-geometry.spec.ts apps/desktop/src/console-guard.spec.ts ui/src/components/ActivityBarUtilityMenu.spec.tsx`
  (16 passed)
- `vitest run ui/src/pages/ChatLandingPage.render.spec.tsx ui/src/pages/ChatLandingPage.spec.ts ui/src/components/ActivityBarUtilityMenu.spec.tsx`
  (70 passed)
- `node scripts/assert-desktop-package.mjs --package-root dist/electron-app-pet`
- `node scripts/smoke-packaged-toolchain.mjs --package-root dist/electron-app-pet`
- `node scripts/desktop-startup-smoke.mjs --app-path dist/electron-app-pet/linux-unpacked/open-alice`
  (Xvfb; the renderer startup smoke passed for both Recent cases)
- `desktop-file-validate /usr/share/applications/open-alice.desktop`
- installed hicolor pet icons match `apps/desktop/build/icons/`; `WM_CLASS` is
  `open-alice`, matching `StartupWMClass`

Real session (packaged build, fresh profile, Huawei DP-1 1080x1920 at +0+0):
the pet was placed at the left edge (window `0,1533`, offset `-198`), the
top-left (window `0,0`, offset `-198,-165`), and the top (window `462,0`);
the saved `companion.json` kept the offset across a restart. The right and
bottom edges are covered by `companion-geometry.spec.ts` and the
window-extension behavior; they were not re-captured in this pass. The
real-mouse drag/selection on this new build is still the user's check; the
previous build's click was confirmed by the user.

The chat-landing visual was not re-captured: the demo harness's demo-only IPC
handlers are incomplete, so the landing was verified by the component tests
and the built asset. The tray icon in the GNOME top bar depends on the
AppIndicator extension; the icon file and the resize path are verified.

## Screenshots

- `pet-top-left.png` — the visible pet at the top-left corner (window `0,0`,
  offset `-198,-165`).
- `pet-left-edge.png` — the left edge (window `0,1533`, offset `-198`).
- `pet-top-edge.png` — the top edge (window `462,0`).
- `startup.png` — the packaged app's startup page.
- `icon-app-48.png`, `icon-tray-22.png`, `avatar-24.png` — icon previews at
  their display sizes.
