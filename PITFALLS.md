# Linux desktop build pitfalls

This file records the failures hit while producing the first Linux desktop
package (AppImage / deb / tar.gz) from this repository. The official release
pipeline only builds macOS and Windows, so none of these paths were exercised
by CI before.

Environment used for the first build:

- Fedora 44 x86_64, GNOME on Wayland (XWayland available)
- Node 22.23.1, pnpm 11.7.0 (`packageManager` pin), Electron 39.8.10
- electron-builder 26.15.2

Artifacts land in `dist/electron-app/`:

- `OpenAlice-<version>.AppImage`
- `open-alice_<version>_amd64.deb`
- `open-alice-<version>.tar.gz` (extract-and-run; no FUSE required)

## 1. There is no Linux target in the electron-builder config

`package.json` `build` only declared `mac`, `win` and `nsis`. Running
electron-builder with `--linux` without a `linux` block falls back to defaults
and produces no desktop entry metadata.

Add a `linux` block (already in `package.json`):

```json
"linux": {
  "target": ["AppImage", "deb", "tar.gz"],
  "category": "Office;Finance",
  "packageCategory": "misc",
  "icon": "apps/desktop/build/icon.png",
  "maintainer": "OpenAlice Contributors <openalice@users.noreply.github.com>",
  "vendor": "OpenAlice Contributors",
  "synopsis": "File-based trading agent workspace",
  "syncDesktopName": true,
  "depends": [
    "libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6",
    "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0", "git"
  ]
}
```

Notes:

- A single 1024x1024 PNG is accepted by electron-builder 26 for Linux; an
  `icons/` directory is not required.
- `deb` requires a maintainer with an email address. The root `author` string
  has no email, so `linux.maintainer` is mandatory.
- Do **not** set `linux.executableName`. The Linux default is the package name
  (`open-alice`), and `scripts/desktop-packaged-smoke.mjs` /
  `scripts/assert-desktop-package.mjs` resolve `linux-unpacked/open-alice`.
  Renaming the binary breaks the repository's own packaged smoke tests.

## 2. Electron 39 defaults to native Wayland, which breaks companion dragging

On a Wayland session Electron 39 starts with the Wayland ozone backend. The
desktop companion moves itself with:

- `screen.getCursorScreenPoint()` — documented as **not supported on Wayland**
- `BrowserWindow.setBounds()` / `setPosition()` — documented as **not supported
  on Wayland**

The result is a visible pet that cannot be dragged: the drag start point is
wrong (or zero) and window moves are ignored.

Diagnosis: run a minimal Electron window and check whether `xdotool` can see
it. On native Wayland the window is invisible to X11 tools; the Electron log
contains `ui/ozone/platform/wayland/...`.

Fix (`apps/desktop/src/main.ts`): when the session provides both
`WAYLAND_DISPLAY` and `DISPLAY` (i.e. XWayland is available), relaunch once
with `--ozone-platform=x11` unless the user passed an explicit ozone switch:

```ts
const ozonePlatformArg = process.argv.find(
  arg => arg === '--ozone-platform'
    || arg.startsWith('--ozone-platform=')
    || arg === '--ozone-platform-hint'
    || arg.startsWith('--ozone-platform-hint='),
)
if (
  process.platform === 'linux'
  && process.env.WAYLAND_DISPLAY
  && process.env.DISPLAY
  && ozonePlatformArg === undefined
) {
  app.relaunch({ args: process.argv.slice(1).concat('--ozone-platform=x11') })
  app.exit(0)
}
```

Do **not** use `app.commandLine.appendSwitch('ozone-platform', 'x11')` here:
Ozone is selected before the main script runs, so the switch is too late. A
minimal probe confirmed the app still used the Wayland backend and `xdotool`
could not see its windows; the relaunch form puts the windows in XWayland.

Trade-off: the whole app runs through XWayland on Wayland sessions. Native
Wayland window positioning is intentionally restricted by the protocol, so
there is no in-process alternative for a draggable always-on-top companion.
Users who explicitly pass `--ozone-platform=wayland` keep native Wayland and
accept that the companion cannot be repositioned.

## 3. Closing the launching terminal crashes the main process with EPIPE

If the app is started from a terminal and that terminal is closed while the
guardian keeps running, the next `console.log` writes to a broken stdout pipe.
Node raises `EPIPE`; Electron reports it as an uncaught main-process exception:

```
Error: write EPIPE
  at afterWriteDispatched (node:internal/streams/writable:159:15)
  ...
  at console.log (node:internal/console/constructor:405:26)
  at .../dist/electron/main.js:1643:17
```

Fix: `apps/desktop/src/console-guard.ts` installs an `error` listener on
stdout/stderr and wraps `console.log/info/warn/error/debug` so only `EPIPE` is
swallowed. Every other stream or write error still surfaces. It is installed
at the top of `apps/desktop/src/main.ts`, before any console output.
Unit tests: `apps/desktop/src/console-guard.spec.ts`.

## 4. dugite's bundled Linux Git needs libcurl-gnutls, absent on Fedora

The npm `dugite` package downloads an Ubuntu-built Git bundle for linux-x64.
Its `git-remote-https` links against `libcurl-gnutls.so.4`. Fedora 44 ships
`libcurl.so.4` (OpenSSL), not the GnuTLS variant, so every HTTPS clone fails:

```
git-remote-https: error while loading shared libraries:
libcurl-gnutls.so.4: cannot open shared object file: No such file or directory
fatal: remote helper 'https' aborted session
```

This breaks Auto Quant / Auto Prediction workspace creation, which clones
GitHub templates during first-run setup.

Fix (`src/workspaces/git-execution.ts`): on Linux use the existing
`execSystemGit()` path (already used by the Bun standalone) instead of
`dugite`'s `bundledExec`. The managed runtime already treats Linux as
system-Git territory (`scripts/vendor-managed-runtime.mjs` skips managed Git on
Linux), so this matches the rest of the runtime. The app now requires `git` on
`PATH`; set `OPENALICE_SYSTEM_GIT_PATH` to override the binary.

Do not try to satisfy the dependency by symlinking `libcurl.so.4` to
`libcurl-gnutls.so.4`; the ABI is not guaranteed and it affects the whole host.

## 5. electron-builder's fpm needs libcrypt.so.1 on Fedora

Building the `deb` target downloads a bundled Ruby/fpm. On Fedora 44 Ruby fails
with:

```
ruby: error while loading shared libraries: libcrypt.so.1: cannot open shared object file
```

Fedora provides `libcrypt.so.2` (libxcrypt). Install the compatibility package
on the build host:

```bash
sudo dnf install -y libxcrypt-compat
```

This is a build-host prerequisite, not a repository change. Without it,
AppImage and tar.gz still build; only `deb` fails.

## 6. AppImage needs FUSE 2 at runtime; Fedora ships FUSE 3

The generated AppImage is a type-2 image. On Fedora 44 `libfuse.so.2` is not
installed, so executing the AppImage directly fails. Options:

```bash
# no root, extracts to a temporary directory
APPIMAGE_EXTRACT_AND_RUN=1 ./OpenAlice-<version>.AppImage

# or install the compatibility library
sudo dnf install -y fuse-libs
```

For a Fedora-native install without FUSE, use the `tar.gz` artifact:

```bash
tar -xzf open-alice-<version>.tar.gz
./open-alice
```

## 7. Transparent companion is invisible under Xvfb

Xvfb has no compositing manager. A `transparent: true` frameless window is
mapped but renders no visible pixels, and its click-through/alpha hit-testing
cannot be exercised there. This is a test-environment limitation, not a product
bug: the pet renders correctly on GNOME with a compositor. Verify companion
behavior in a real session (or with a compositing WM), not on bare Xvfb.

## 8. Network: Node fetch and Electron downloads ignore https_proxy

`pnpm install` runs dugite's postinstall, which uses Node's built-in `fetch`
(undici). It does not honor `https_proxy` by default, so the install fails
while downloading the Git bundle even though `curl` works through the proxy.

Use Node 22's env-proxy switch for the install, and the Electron-specific flag
for Electron's downloader:

```bash
export https_proxy=http://127.0.0.1:18880
export HTTPS_PROXY=$https_proxy
export NODE_OPTIONS=--use-env-proxy
export ELECTRON_GET_USE_PROXY=1
pnpm install --frozen-lockfile
```

electron-builder's AppImage/fpm helper binaries are downloaded from GitHub on
first use; the same proxy environment must be present when packaging.

## 9. Auto-update has no Linux channel

The packaged app writes an `app-update.yml` pointing at the official generic
feed. On Linux electron-updater requests `beta-linux.yml`, which the official
server does not publish:

```
[updater] update check failed: Error: Cannot find channel "beta-linux.yml"
update info: HttpError: 404 ... https://download.openalice.ai/beta-linux.yml
```

The failure is caught and logged; it does not block startup or the UI. A local
Linux build has no update channel until the release pipeline publishes Linux
metadata. Do not treat the 404 as a build failure.

## 10. Managed fd/rg and Git are intentionally absent on Linux

`scripts/vendor-managed-runtime.mjs` only vendors managed `fd`/`rg` for
darwin/win32 and managed Git for Windows. On Linux it logs
`managed fd/rg skipped` and `assert-desktop-package.mjs` does not require those
manifest entries. Full search/tool features therefore rely on host tools
(`rg`, `fd`, `git`). If a Linux package must be self-contained, extending the
vendor script with linux-x64/arm64 assets is a separate change with its own
checksum maintenance.

## 11. Desktop name / WM_CLASS warning

Without a top-level `desktopName`, electron-builder warns that Electron's
`app_id` / `WM_CLASS` will not match the `.desktop` entry. Set both:

```json
"desktopName": "open-alice.desktop"
```

and `linux.syncDesktopName: true` (see the `linux` block above). This keeps the
installed desktop file, icon and window association consistent.

## 12. GNOME app-grid, dock and tray icons

The Linux app icon is the transparent pet character from
`ui/public/companion/alice.png` (the same image the desktop pet uses), not the
older face-only `icon.png` and not a background plate: the launcher and dock
show only the character. `apps/desktop/build/icon-pet.png` is the 1024x1024
transparent master; `apps/desktop/build/icons/` holds the 16-512 hicolor set.
`apps/desktop/build/tray-pet.png` is a 64x64 head crop on a light circular
badge; at 22x22 the full-body image was unreadable and the black bow vanished
against a dark panel.

`linux.icon` points at the generated `apps/desktop/build/icons/` set (16-512;
hicolor's index stops at 512, so the 1024 master is not shipped) and the
desktop entry uses `Icon=open-alice`. `extraResources` copies the 256px icon to
`resources/icon.png` (the BrowserWindow icon) and the tray crop to
`resources/tray.png`. `app-window.ts` sets `BrowserWindow.icon` from
`resources/icon.png` on Linux, and `resolveTrayIconPath` uses
`resources/tray.png`, resized to 22x22 with `quality: 'best'`. macOS/Windows
keep the existing full-body companion image.

## 13. Linux GPU process crash (SIGTRAP)

Electron 39's GPU process fails to launch under XWayland on Fedora 44
(`GPU process launch failed: error_code=1002`); Chromium then hits
`FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:415: GPU process
isn't usable. Goodbye.` and the main process dies with SIGTRAP. The app can
survive long enough for a startup smoke to pass, so reproduce it in the real
session. Call `app.disableHardwareAcceleration()` on Linux before
`app.whenReady()`; the desktop UI renders in software.

The Quick Start header no longer renders the `aliceWave` hero image. The
bottom-left application-menu button carries the “Alice’s Settings” label and an
ellipsis icon; its circular avatar was removed because the crop never aligned
cleanly at rail sizes.

For Fedora, the `rpm` target is the native install path; it needs `rpmbuild`
(`sudo dnf install rpm-build`). The built RPM
(`open-alice-0.95.0-beta.x86_64.rpm`) installs `/opt/OpenAlice/open-alice`,
`/usr/share/applications/open-alice.desktop`
(`Icon=open-alice`, `StartupWMClass=open-alice`, `Categories=Office;Finance;`)
and the 1024px pet icon; its `Requires` include `gtk3`, `nss`,
`libXScrnSaver`, `at-spi2-core`, `git`. The deb and AppImage embed the same
icon (sha256 matches `icon-pet.png`); the deb's `.desktop` uses the same fields.
The `deb` cannot be installed on Fedora, and the `tar.gz` ships no installer.
An unpacked run still gets the pet window icon, but GNOME's app grid needs a
`.desktop` entry (RPM or AppImage integration).

## 13. Companion placement: the transparent-gutter "air wall"

The companion window is `size * 2.7` wide and `size * 1.65` tall; the visible
character is only the middle third, bottom-aligned. The side thirds and the top
are reserved for speech bubbles. The original `settleCompanion` clamped the
**whole window** to the work area, so visible Alice always stopped about one
third of a window (≈198px at the default size) short of every screen edge — the
"transparent air wall".

`settleCompanion` now takes the visible insets and clamps/snaps the visible box,
allowing the transparent gutters to extend off-screen. `companion.ts` derives
the insets with `visualInsets(width, height)` (side = width/3, top = height -
side). At the default size the visible box is 198x198 at the bottom-center of
the 594x363 window. The initial placement also uses the visible box, so the pet
starts 24px from the bottom-right edge with the window partially off-screen.

Mutter (XWayland) allows a window to extend past the right/bottom edge but
clamps a negative left/top to the work area: `xdotool windowmove <pet> -198 1533`
lands at `0 1533`. A negative window position alone therefore cannot put the
character on the left/top edge. `companion.ts` keeps the native window at
`area.x/area.y` and stores a visual offset; `moveVirtual` sends it to the
renderer, and the `#offset` wrapper translates the character inside the window.
Drag and settle operate on a virtual position (window + offset), split into a
WM-safe window position plus the remaining offset. `companion.json` stores
`offsetX/offsetY`, so an edge placement survives a restart.

Two multi-monitor details matter:

- `screen.getDisplayMatching` on a virtual window with a negative origin can
  resolve to the primary display. Select the display from the visible
  character rectangle (`visibleRect`) instead; otherwise a pet saved at the
  left edge of a secondary display restores on the primary.
- Mutter places a newly mapped window on the active monitor and ignores the
  constructor bounds. The `ready` handler shows the pet, then re-applies the
  intended virtual position 150ms later with `moveVirtual`; the toggle path
  does the same because a pet that starts hidden never runs the ready
  handler's move. Without either move a fresh profile's pet lands at the
  primary work-area origin and covers the app window.
- The companion is opt-in: `enabled` defaults to false, so a fresh profile
  starts without a desktop pet. The bottom-left application menu and the
  tray's Pet submenu show it on demand. A persisted `(0,0)` position is the
  legacy pre-placement origin, not a user drag; treat it as "no saved
  position" and restore the default bottom-right corner.

The unit tests in `apps/desktop/src/companion-geometry.spec.ts` cover the
portrait-screen edges: the visible left/top/right/bottom reach the work-area
edges while the window bounds may be negative or past the screen.

## 14. Linux window close quits the runtime

Windows and macOS keep the guardian alive when the last window closes and
restore it from the tray or Dock. GNOME and most Linux desktops do not host an
AppIndicator by default, so the same behavior left the process running with no
visible window, no tray entry, and no quit affordance; relaunching then hit the
“OpenAlice is already running” owner dialog. On Linux a window close now calls
`app.quit()`, which runs `before-quit` → `shutdown()`: stop children (SIGTERM,
5s grace, then SIGKILL), close the relay, release the guardian/runtime locks,
and exit.

A relaunch that lands inside that grace window used to see the still-alive
owner and show the conflict dialog. `shutdown()` now writes
`<home>/state/desktop-shutdown.json` before stopping children, and
`resolveExistingOwnerStartup` waits up to 12s for that exact pid's guardian
lock to disappear before deciding. The marker is trusted only while it names
the active owner, and it is cleared after the locks are released, so a stale
marker cannot delay a normal launch. SIGTERM/SIGINT run the same shutdown;
repeated signals are absorbed while cleanup is in progress.

## 15. Recommended build sequence

```bash
cd /path/to/openalice
export https_proxy=http://127.0.0.1:18880 HTTPS_PROXY=$https_proxy
export NODE_OPTIONS=--use-env-proxy ELECTRON_GET_USE_PROXY=1

pnpm install --frozen-lockfile
pnpm electron:build
pnpm vendor:runtime

# AppImage + deb + RPM in one invocation.
npx pnpm@11.7.0 -F @traderalice/desktop exec electron-builder \
  --projectDir ../.. --publish never --linux AppImage deb rpm --x64

# tar.gz separately: 7za -mx=9 takes minutes and is easy to interrupt.
npx pnpm@11.7.0 -F @traderalice/desktop exec electron-builder \
  --projectDir ../.. --publish never --linux tar.gz --x64
```

`rpm` needs `rpmbuild` on the build host (`sudo dnf install rpm-build`). The
RPM's default dependencies are Fedora names; `build.rpm.depends` adds `git`
because Linux now runs the system git.

Verify the packaged tree before shipping:

```bash
node scripts/assert-desktop-package.mjs
node scripts/smoke-packaged-toolchain.mjs
```

The repository's `desktop:smoke:packaged` only launches the GUI on macOS unless
`--workspace-acceptance` / `--credential-pi` is passed; on Linux use those
modes or a real-session launch check.
