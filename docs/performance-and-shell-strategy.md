# Desktop shell and performance strategy

Status: analysis + first refactor. No shell migration has been started.
Date: 2026-10-18.

This document answers two questions that were previously mixed together:

1. Is Tauri 2 a better desktop shell than Electron for OpenAlice?
2. Which parts of OpenAlice should be replaced with Rust for performance?

They have different answers. Tauri is a **shell** decision; Rust is a **hot-path**
decision. Bundling them would make both worse.

## TL;DR

- Tauri 2 is technically viable, but it is a shell rewrite, not a runtime swap.
  Its wins are shell-level: installer size, idle shell memory, security surface,
  startup without Chromium, and mobile reach.
- OpenAlice's measured memory is dominated by the Node backend, not the shell.
  On the currently running build: Electron shell ~453 MB PSS, OpenAlice backend
  ~3,169 MB PSS. The shell is ~12.5% of the measured total.
- The repository pins Electron 39.8.5, which is outside Electron's support
  window. The current stable is 44.9.0. "Electron is old" is true for this pin,
  not for the framework. Upgrading Electron is the cheapest fix and should be
  evaluated before any shell rewrite.
- The first performance refactor found a real algorithmic bug, not a language
  problem: `MACD` recomputed each EMA from every prefix (O(n²)). On 10,000 bars
  it took **237.07 ms** per call; after the O(n) rewrite it takes **0.76 ms**
  (~312x). 58 indicator tests pass, including a new parity test.
- Rust candidates, in order: indicator/backtest math (only if still hot after
  the algorithmic fix), terminal snapshot/ANSI parsing, IBKR binary decoding,
  file indexing, worker-pool memory. The whole backend and the web relay are not
  good Rust candidates for this app.
- Recommendation: upgrade Electron, add a measurement harness, fix algorithmic
  hot spots, then introduce Rust through N-API for the one path that survives
  profiling. Keep Tauri as a separate shell decision gated by a 1-2 day
  WebKitGTK spike, not as a performance project.

## Measured baseline

### Running desktop build

Measured on 2026-10-18 from the running packaged build
`dist/electron-app/linux-unpacked` (PID 188347, profile
`/tmp/opencode/openalice-final2`). PSS is read from `/proc/<pid>/smaps_rollup`.

| Group | Processes | PSS |
| --- | --- | --- |
| Electron shell | main, 2 renderers, zygote, GPU/utility | ~453 MB |
| OpenAlice backend | server, 5 NUQ workers, queue, extract, reconciler, API | ~3,169 MB |

Largest single processes: the server at ~728 MB; five NUQ workers at ~327 MB
each; the queue worker at ~343 MB; the extract worker at ~328 MB; the
reconciler at ~326 MB; the API process at ~132 MB.

Caveat: this is the **old packaged build**, and its worker pool is not present
in the current `src/services` tree. The new build
(`dist/electron-app-pet/linux-unpacked`) has not been re-measured. Treat the
numbers as a ratio, not as a claim about the current source: the shell is a
minority of the app's memory, and the backend is the dominant consumer.

### MACD before/after

Synthetic benchmark: 10,000 bars, 5 iterations after 2 warm-up runs, Node 22 via
`tsx`, same machine.

| Implementation | Average per call |
| --- | --- |
| Prefix-recompute EMA (O(n²)) | 237.07 ms |
| Incremental EMA series (O(n)) | 0.76 ms |

The new `emaSeries` in
`src/domain/analysis/indicator/functions/statistics.ts` computes each EMA once;
`MACD` in `technical.ts` consumes the two series. The new
`technical.spec.ts` compares the result with a deliberately naive per-prefix
reference at 10 decimal places.

## Tauri 2 vs Electron for OpenAlice

### Facts

- Tauri 2.12.4 is the current stable (released 2026-10-14). Tauri 3 exists only
  as an alpha line and is not relevant to a production decision.
- Electron 44.9.0 is the current stable (released 2026-10-17). The repository
  pins `electron@^39.8.5` in `apps/desktop/package.json`; Electron supports the
  latest three stable majors, so 39 is outside the support window.
- Wails v3 is still a prerelease line: v3.0.0-beta.30 was published 2026-10-15.
  Wails v2 is stable but is a different architecture and ecosystem.
- Flutter desktop multi-window is still not a stable framework feature; the
  single-window workaround is the documented recommendation for floating
  windows. OpenAlice needs a main window plus an independent transparent pet
  window, so Flutter would require either a third-party multi-engine plugin or
  a UI rewrite.
- Tauri 2 exposes the window primitives the pet needs: transparent windows,
  decorations off, always-on-top, skip-taskbar, focusable, position, monitor
  enumeration with `workArea`, `setIgnoreCursorEvents`, `startDragging`, tray
  icons and menus, Node sidecars, an updater, and deb/rpm/AppImage bundling.
- Tauri's Linux webview is WebKitGTK 4.1, not Chromium. The UI uses
  `@xterm/addon-webgl`, `lightweight-charts`, `recharts`, Tiptap, and a large
  Tailwind surface; WebKitGTK compatibility is a real unknown and must be
  tested with the actual `ui/dist`, not a hello-world page.
- Tauri tray events on Linux do not emit click/double-click/enter/leave; the
  context menu still works. OpenAlice's Linux tray path already uses a context
  menu (`tray.setContextMenu`), so this is a minor regression, not a blocker.
- Tauri's built-in updater on Linux updates **AppImage only**. The current
  `electron-updater` feed lists AppImage, deb, and RPM
  (`dist/electron-app-pet/beta-linux.yml`), and the app exposes those as native
  update paths. Moving to Tauri would require a custom deb/RPM update path.
- Tauri does not remove the Wayland positioning restriction. Wayland does not
  let a client place a window at arbitrary global coordinates; the current app
  already forces XWayland (`--ozone-platform=x11`) and uses a render-layer
  offset to reach the left/top edges. A Tauri port would keep that workaround.
- The pet interaction model is portable: the main process polls
  `screen.getCursorScreenPoint()` every 50 ms, hit-tests in the renderer, and
  toggles click-through. A Tauri port would poll `cursor_position()` in Rust and
  call `set_ignore_cursor_events`; it does not depend on Electron's native
  mouse forwarding.

### What Tauri wins

| Area | Why it matters | Limit for OpenAlice |
| --- | --- | --- |
| Installer size | No bundled Chromium | The Node runtime, Pi, and UI remain; the saving is the shell layer, not the whole 223 MB AppImage |
| Idle shell memory | WebKitGTK is lighter than Chromium | The measured backend is ~7x the shell; the shell saving does not fix the backend |
| Security surface | Capability-scoped IPC, smaller trusted core | The Node backend still runs with full user privileges; the gain is partial |
| Startup | No Chromium cold start | The backend spawn, migrations, and worker pool may dominate; needs measurement |
| Mobile | Tauri 2 supports mobile targets | OpenAlice is desktop-first today |

### What Tauri costs here

| Area | Cost |
| --- | --- |
| UI compatibility | WebKitGTK rendering/WebGL/IME/font differences across distros; the existing complex UI must be tested |
| Linux integration | No tray click events; AppImage-only updater; system WebKitGTK version fragmentation |
| Wayland | Same XWayland workaround; no free positioning |
| Engineering | ~2,200 lines of desktop main/preload plus updater, packaging, and native integrations rewritten in Rust |
| Maintenance | Rust ownership and dual-platform release engineering; the Electron shell cannot be kept forever |
| Migration | The prior assessment estimated 4-8 weeks for one experienced engineer; this document does not revise that estimate |

### Verdict

Tauri is the strongest alternative if the goal is a smaller, more modern shell.
It is not a performance optimization for OpenAlice. The measured shell is a
minority of memory, the backend is the dominant consumer, and the Tauri port
would inherit the Wayland workaround while adding a WebKitGTK compatibility
risk and an updater regression for deb/RPM users.

The cheapest "Electron is old" fix is an Electron 44 upgrade. It keeps the
mature shell, the Chromium rendering consistency, the existing updater, and the
existing tray behavior. It still needs a native-module/ABI check
(`node-pty`, `dugite`) and a smoke pass, but it is days, not weeks.

If the shell decision is strategic (size/security/mobile), run the 1-2 day
spike first: load the real `ui/dist` in a Tauri window, create the transparent
pet window, exercise the tray menu, and build one deb/RPM/AppImage. Only then
commit to the 4-8 week rewrite.

## Rust replacement candidates

The ranking is by expected impact per unit of risk, not by novelty.

### 1. Indicator and backtest math

`src/domain/analysis/indicator/` and `simulate.ts` are CPU-bound and
data-parallel. The MACD fix shows the first-order win is algorithmic, not
linguistic: 237 ms -> 0.76 ms in JavaScript. The remaining functions are
already O(n) per call; a Rust N-API implementation could still help when the
same formula is evaluated over many symbols or long histories, but the expected
gain is single-digit multiples, not 300x, and the N-API boundary has a cost.

Recommendation: profile the real formula workload. If the indicator engine is
still >20% of CPU after the algorithmic fixes, add a Rust N-API crate with a
TypeScript fallback and a parity suite. Do not start with Rust.

### 2. Terminal snapshot / ANSI parsing

`src/workspaces/headless-terminal-snapshot.ts` feeds every PTY byte through
`@xterm/headless` to keep a server-side mirror, then serializes up to 10,000
scrollback rows on cold attach. For terminal-heavy agent sessions this is real
CPU work. A Rust `vte`/`alacritty_terminal` parser could be faster, but the
mirror depends on xterm-specific behavior (query replies, Kitty keyboard
flags, view attributes); porting it is a compatibility project.

Recommendation: first reduce the work (snapshot on demand, cap scrollback,
batch writes, skip the mirror when no cold attach is pending). If profiling
still shows the parser hot, prototype a Rust parser behind the same snapshot
interface.

### 3. IBKR binary decoding

`packages/ibkr/src/order-decoder.ts` and `wrapper.ts` decode a binary protocol.
A Rust decoder could reduce latency and allocation, but the feed is
network-bound and the existing decoder is not a measured bottleneck.

Recommendation: defer until a latency profile shows decoding above the network
jitter.

### 4. File indexing and search

OpenAlice is file-based; the agent reads and searches workspaces. A Rust
indexer (`ignore`, `tantivy`, or a `ripgrep`-style scanner) could help if large
workspaces are common. The app already uses system Git and native PTY; a Rust
indexer would fit the same sidecar pattern.

Recommendation: measure the agent's file-scan time on a real workspace before
building anything.

### 5. Worker-pool memory

The running old build shows five NUQ workers at ~327 MB each. That is a
process-per-worker architecture, not a language problem. Node
`worker_threads` would share the process and cut the per-worker overhead
without a rewrite; a Rust worker would cut it further but would need the task
logic (LLM calls, JS SDKs) ported.

Recommendation: first move CPU-only workers to `worker_threads` or reduce the
pool; consider Rust only for a worker whose task is pure computation.

### 6. Web relay / HTTP server

The Hono server is single-user desktop traffic. Rust/axum would improve
concurrency and tail latency at a scale OpenAlice does not have.

Recommendation: no.

### 7. Whole backend

The agent runtime is dominated by LLM latency, network I/O, and tool
orchestration. A wholesale Rust rewrite would add risk without moving the
user-visible bottleneck.

Recommendation: no.

## Enhancement refactor plan

### Phase 0 - measure (1-2 days)

- Startup marks: process spawn -> server ready -> window painted -> first
  interactive frame.
- CPU profiles of the server, the companion main process, and the renderer
  during a realistic session.
- PTY throughput and cold-attach snapshot time.
- HTTP/WebSocket latency for the local relay.
- Indicator workload: formulas x symbols x bars, with the new O(n) code.
- Baseline the new `dist/electron-app-pet` build, not only the old one.

### Phase 1 - low-risk fixes (about 1 week)

- MACD O(n) (done; 312x on the benchmark).
- Terminal snapshot: snapshot on demand, scrollback cap, batched writes.
- Worker pool: `worker_threads` or a smaller pool where the task is CPU-only.
- UI: route-level code splitting; defer the chart/terminal bundles until the
  panel is visible.
- Electron 44 upgrade spike: `electron@44`, `electron-builder@26`, native
  module rebuild, updater feed check, startup/tray/pet smoke.

### Phase 2 - Rust N-API (1-2 weeks, gated)

Only if Phase 0 shows the indicator/backtest path above 20% CPU:

- `napi-rs` crate for the hot functions, TypeScript fallback.
- Parity tests against the current implementation.
- Keep the crate behind a feature flag; measure end-to-end, not only the
  microbenchmark.

### Phase 3 - Rust sidecar (2-4 weeks, gated)

Only if Phase 0 shows the terminal parser or file scanning is a real hot spot:

- A sidecar with a narrow interface (bytes in, snapshot/rows out; paths in,
  matches out).
- No business logic in Rust; the TypeScript layer remains the source of truth.

### Tauri (separate decision)

- 1-2 day spike: real `ui/dist`, transparent pet window, tray menu, deb/RPM
  build, WebKitGTK rendering check.
- If the spike passes and the shell goals are strategic, plan the 4-8 week
  rewrite. Do not bundle it with the performance refactor.

## Acceptance criteria

- No user-visible regression in the existing desktop smoke suites.
- Indicator parity: the new implementation matches the naive reference at 10
  decimal places; the 58-test indicator suite stays green.
- Performance claims are end-to-end (startup, frame time, CPU, memory), not
  microbenchmarks alone.
- A Rust component ships only with a TypeScript fallback and a parity suite.
- The Electron 44 upgrade keeps the pet, tray, updater, and packaging smokes
  green before it replaces 39.

## Open questions for the project owner

1. Which goal has priority: installer size, idle memory, startup time, CPU on
   long sessions, or security surface? The answer changes the order.
2. Is WebKitGTK acceptable for the Linux UI if the Tauri spike shows minor
   rendering differences?
3. Who owns the Rust code and the release pipeline if Tauri or N-API is
   adopted?
4. Is the Electron 44 upgrade an acceptable near-term change, or must the shell
   be replaced?
5. Is the deb/RPM update path a hard requirement? If yes, Tauri needs a custom
   updater.

## Sources

Primary:

- Tauri 2 prerequisites (Fedora packages):
  https://v2.tauri.app/start/prerequisites/
- Tauri window customization:
  https://v2.tauri.app/learn/window-customization/
- Tauri window API (monitor `workArea`, `setIgnoreCursorEvents`, `startDragging`,
  `setAlwaysOnTop`, `setSkipTaskbar`):
  https://v2.tauri.app/reference/javascript/api/namespacewindow/
- Tauri window config (`transparent`, `alwaysOnTop`, `skipTaskbar`, `focusable`):
  https://v2.tauri.app/reference/config/
- Tauri tray icon and Linux event limitation:
  https://v2.tauri.app/learn/system-tray/
- Tauri Node sidecar:
  https://v2.tauri.app/learn/sidecar-nodejs/
- Tauri updater (Linux AppImage artifacts):
  https://v2.tauri.app/plugin/updater/
- Tauri Linux distribution formats:
  https://v2.tauri.app/distribute/
- Tauri Linux graphics issues:
  https://v2.tauri.app/develop/debug/linux-graphics/
- Tauri releases (2.12.4, 2026-10-14):
  https://github.com/tauri-apps/tauri/releases
- Electron releases (44.9.0, 2026-10-17):
  https://github.com/electron/electron/releases
- Electron release timeline/support policy:
  https://www.electronjs.org/docs/latest/tutorial/electron-timelines
- Wails releases (v3.0.0-beta.30, 2026-10-15):
  https://github.com/wailsapp/wails/releases
- Flutter desktop:
  https://docs.flutter.dev/platform-integration/desktop
- Qt WebEngine:
  https://doc.qt.io/qt-6/qtwebengine-overview.html
- Avalonia:
  https://docs.avaloniaui.net/
- Neutralino:
  https://neutralino.js.org/docs/

Repository evidence:

- `apps/desktop/src/main.ts`, `companion.ts`, `companion-preload.ts`,
  `auto-update.ts`, `app-window.ts` - shell responsibilities and platform
  behavior.
- `apps/desktop/package.json` - `electron@^39.8.5`.
- `package.json` - Linux targets, publish feed, extra resources.
- `dist/electron-app-pet/beta-linux.yml` - AppImage/deb/RPM update artifacts.
- `src/domain/analysis/indicator/functions/statistics.ts` and `technical.ts` -
  the EMA/MACD refactor.
- `src/workspaces/headless-terminal-snapshot.ts` - per-byte ANSI mirror.
- `packages/ibkr/src/order-decoder.ts`, `wrapper.ts` - binary protocol.
- `src/workspaces/pty-runtime.ts` - PTY backend selection.
