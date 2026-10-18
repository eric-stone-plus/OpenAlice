# Linux desktop build

Built from this checkout on Fedora 44 on 2026-10-18. The official site ships
only macOS/Windows; these are the Linux artifacts produced from source.

## Artifacts

`dist/electron-app-pet/`:

| Artifact | Size | Use |
| --- | --- | --- |
| `OpenAlice-0.95.0-beta.AppImage` | 222M | Portable; on Fedora install `libfuse2` first |
| `open-alice_0.95.0-beta_amd64.deb` | 172M | Debian/Ubuntu |
| `open-alice-0.95.0-beta.x86_64.rpm` | 150M | Fedora — native install path |
| `open-alice-0.95.0-beta.tar.gz` | 211M | Portable archive, no desktop entry |
| `linux-unpacked/` | — | Unpacked app; run `open-alice` directly |

Install on Fedora:

```bash
sudo dnf install ./open-alice-0.95.0-beta.x86_64.rpm
```

or run the unpacked app:

```bash
./dist/electron-app-pet/linux-unpacked/open-alice
```

Rebuild from this checkout:

```bash
pnpm electron:build
apps/desktop/node_modules/.bin/electron-builder --linux AppImage deb rpm tar.gz \
  --projectDir . --config.directories.output=dist/electron-app-pet
```

The packaged desktop entry passes `--ozone-platform=x11`, so Wayland sessions
start under XWayland without a relaunch. Linux keeps software rendering: the
XWayland GPU process can fail with `error_code=1002` and kill the app.

## What changed

- **Welcome-screen Alice** (`ui/src/components/PetLogo.tsx`,
  `ui/src/pages/ChatLandingPage.tsx`): the pet is an in-app animated logo above
  "What should Alice work on?", not a separate window. It uses the transparent
  256px `ui/src/assets/alice-logo.png`, floats at the original 220px pet size
  (`180px` below the `42rem` breakpoint), cycles Carroll quotes on click/Enter,
  and respects `prefers-reduced-motion`. The old companion window, preload,
  geometry/sound modules and preview harness are gone.
- **Quit and restart** (`apps/desktop/src/main.ts`, `shutdown-marker.ts`,
  `runtime-state-cleanup.ts`, `packages/guardian-runtime/src/runtime-lock.ts`,
  `src/main.ts`): Linux window close quits the app, SIGTERM/SIGINT run the same
  shutdown path, a shutdown marker waits out the race, and stale runtime locks
  (including guardian-dead owners and orphaned children) are reclaimed on the
  next launch. A concurrent launch's unpublished `initializing` lock is left
  alone so the cleanup cannot steal a live instance's startup. The data
  location is released; no stale-owner dialog.
- **Settings** (`ui/src/pages/PetSettingsPage.tsx`,
  `ui/src/components/workspace/WorkspaceAIPreferencesPanel.tsx`): removed the
  bottom-left avatar from "Alice's Settings", fixed the Backend row that wrapped
  one character per line, and removed the dead pet/brief controls.
- **Project menu** (`ui/src/components/workspace/HarnessNavigationGroup.tsx`,
  `HarnessWorkspaceEntry.tsx`, `ActivityBar.tsx`): one row per harness, a
  "Projects" section label in all four locales, Studio as a row icon action
  instead of a duplicate child row, and the workspace hint reduced to
  "Choose workspace".
- **opencode-only runtime menus** (`ui/src/lib/agentRuntimeVisibility.ts`,
  `ui/src/contexts/WorkspacesContext.tsx`,
  `ui/src/pages/AgentRuntimesSettingsPage.tsx`,
  `ui/src/pages/AIProviderPage.tsx`,
  `ui/src/pages/IssueSettingsPage.tsx`,
  `ui/src/components/workspace/AgentLaunchControls.tsx`,
  `ui/src/components/workspace/WorkspaceAIPreferencesPanel.tsx`,
  `ui/src/components/IssueDetail.tsx`,
  `ui/src/hooks/useAgentLaunchConfig.ts`): the runtime picker, "All agent
  runtimes" dialog, Agent runtimes settings, AI Provider creation defaults,
  Issue Settings, workspace AI preferences and Issue runtime defaults offer
  only opencode.
  Interactive launches resolve a hidden saved default to opencode, and the
  workspace preferences editor rewrites hidden defaults when it saves. The
  backend keeps the other adapters for non-desktop clients; existing persisted
  headless/scheduled runtime choices are not migrated.

## Verification

- `pnpm test` — 902/904 files passed, 1 skipped; 7788 passed, 6 skipped. The single failure was the supervisor TUI PTY timing test `keeps every visible Command Spine control segment clickable`, which passes alone (29/29) and is unrelated to the desktop delivery.
- `pnpm -F @traderalice/desktop typecheck` — pass
- `pnpm -F @traderalice/guardian-runtime typecheck` — pass
- `npx tsc --noEmit -p ui/tsconfig.json` — pass
- `npx tsc --noEmit -p tsconfig.json` — pass
- `node scripts/assert-desktop-package.mjs --package-root dist/electron-app-pet` — app resources OK
- `node scripts/smoke-packaged-toolchain.mjs --package-root dist/electron-app-pet` — packaged Electron Node, managed Pi 0.83.0, workspace CLI smoke OK
- `desktop-file-validate /usr/share/applications/open-alice.desktop` — VALID

The packaged app was launched through `systemd-run --user --unit=openalice-visual
--collect /opt/OpenAlice/open-alice --ozone-platform=x11`, captured with
`magick import`, and closed with `xdotool windowquit`. After close the unit is
inactive/dead with `Result=success`, `~/.openalice/state` is empty, no `runtime.lock` or
`cli-endpoint.json` remains, and an immediate relaunch opens without a
stale-owner dialog.

## Screenshots

- `ui-final.png` — the welcome screen with the embedded 220px transparent
  Alice logo, the "PROJECTS" label and the opencode-only runtime picker.
