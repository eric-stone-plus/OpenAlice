import { discoverNativeModels } from '../native-model-discovery.js';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  CliAdapter,
  OnDiskSession,
  ResolvedSessionRuntimeBinding,
  SpawnContext,
  WorkspaceAiCred,
} from '../cli-adapter.js';
import { readWorkspaceFile, writeWorkspaceFile } from '../file-service.js';
import type { HeadlessOutputEvent } from '../headless-output.js';
import { resetOwnedJsonConfig } from './owned-json-config.js';
import {
  OPENCODE_TRADE_AGENT,
  OPENCODE_TRADE_AGENT_ID,
  OPENCODE_TRADE_MODEL,
  OPENCODE_TRADE_VARIANT,
} from './opencode-trade-agent.js';

const execFileAsync = promisify(execFile);

const OPENCODE_CONFIG_PATH = 'opencode.json';
const OPENCODE_BINDING_STATE_PATH = '.opencode/openalice-provider.json';
const OPENCODE_TUI_CONFIG_PATH = 'tui.json';
const OPENCODE_TUI_CONFIGC_PATH = 'tui.jsonc';
const OPENCODE_SYSTEM_THEME = 'system';

const openCodeSessionRowsInFlight = new Map<string, Promise<readonly Record<string, unknown>[]>>();

function readOpenCodeSessionRows(cwd: string): Promise<readonly Record<string, unknown>[]> {
  const existing = openCodeSessionRowsInFlight.get(cwd);
  if (existing) return existing;
  const read = (async () => {
    let stdout: string;
    try {
      const res = await execFileAsync('opencode', ['session', 'list', '--format', 'json'], {
        cwd,
        env: {
          ...process.env,
          OPENCODE_DISABLE_MODELS_FETCH: '1',
          OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        },
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      stdout = res.stdout;
    } catch {
      return [];
    }
    try {
      const rows: unknown = JSON.parse(stdout);
      return Array.isArray(rows)
        ? rows.filter((row): row is Record<string, unknown> =>
            typeof row === 'object' && row !== null && !Array.isArray(row))
        : [];
    } catch {
      return [];
    }
  })().finally(() => openCodeSessionRowsInFlight.delete(cwd));
  openCodeSessionRowsInFlight.set(cwd, read);
  return read;
}

export function openCodeSessionTitle(
  rows: readonly Record<string, unknown>[],
  sessionId: string,
): string | null {
  const row = rows.find((candidate) => candidate['id'] === sessionId);
  const title = typeof row?.['title'] === 'string' ? row['title'].trim() : '';
  return title || null;
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function ensureOpenCodeTuiConfigExcluded(cwd: string): Promise<void> {
  // OpenAlice workspaces are Git repositories, but adapter tests and external
  // callers may prepare a plain directory. Do not manufacture a partial .git.
  try {
    if (!statSync(join(cwd, '.git')).isDirectory()) return;
  } catch {
    return;
  }
  const path = '.git/info/exclude';
  const current = await readWorkspaceFile(cwd, path) ?? '';
  if (current.split(/\r?\n/).includes(OPENCODE_TUI_CONFIG_PATH)) return;
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await writeWorkspaceFile(cwd, path, `${current}${separator}${OPENCODE_TUI_CONFIG_PATH}\n`);
}

/**
 * Select OpenCode's native terminal-derived theme for OpenAlice workspaces.
 * The dedicated tui.json layer is supported by OpenCode 1.16+ and has higher
 * precedence than global TUI settings. Existing native project configuration,
 * including the legacy opencode.json theme that OpenCode migrates itself,
 * remains user-owned.
 */
export async function syncOpenCodeWorkspaceTheme(cwd: string): Promise<boolean> {
  await ensureOpenCodeTuiConfigExcluded(cwd);

  // A JSONC project file is user-owned. Avoid creating a competing tui.json
  // because OpenCode accepts both and their same-directory ordering is native.
  if (await readWorkspaceFile(cwd, OPENCODE_TUI_CONFIGC_PATH) !== null) return false;

  const tui = parseJsonRecord(await readWorkspaceFile(cwd, OPENCODE_TUI_CONFIG_PATH));
  if (tui === null || Object.prototype.hasOwnProperty.call(tui, 'theme')) return false;

  const legacy = parseJsonRecord(await readWorkspaceFile(cwd, OPENCODE_CONFIG_PATH));
  if (legacy === null || Object.prototype.hasOwnProperty.call(legacy, 'theme')) return false;

  tui['$schema'] ??= 'https://opencode.ai/tui.json';
  tui['theme'] = OPENCODE_SYSTEM_THEME;
  await writeWorkspaceFile(cwd, OPENCODE_TUI_CONFIG_PATH, `${JSON.stringify(tui, null, 2)}\n`);
  return true;
}

/**
 * opencode (github.com/anomalyco/opencode, formerly sst/opencode; MIT, by
 * Dax Raad / SST). Provider-agnostic open-source agent CLI — the third adapter
 * after claude + codex, added to (a) escape Claude Code's closed/opaque
 * surface and (b) reach the Chat-Completions ecosystem (CN + local models)
 * that codex's Responses-only lock can't touch.
 *
 * Contract VERIFIED against opencode 1.16.0 on macOS and the Docker-pinned
 * 1.17.18 (`opencode --help`, provider config, headless resume, CLI tool calls,
 * and live traderhub data; 2026-07):
 *
 *   - Tool access: OpenAlice tools are exposed through the injected
 *     `alice*` / `traderhub` CLI shims, not opencode's native MCP config.
 *     The adapter projects one process-local `OPENCODE_CONFIG_CONTENT`
 *     overlay: OpenAlice's app-owned Trade profile (opencode-trade-agent.ts).
 *     The global config, providers, auth, and the terminal's generic
 *     auto/goal default stay intact; no top-level permission override is
 *     added, so the terminal and the app still run the same opencode build
 *     and configuration surface.
 *
 *   - Provider override: `opencode.json` `provider.<name>` with a custom
 *     `baseURL` + `apiKey` + a top-level default `model = "<provider>/<id>"`.
 *     Key written directly into the workspace file (same trust model as codex's
 *     `.codex/env.json`). OpenAlice owns only `provider.workspace`, the matching
 *     top-level model, and its schema marker; unrelated opencode config survives
 *     both writes and reset.
 *
 *   - Terminal appearance: the shared runtime lifecycle selects OpenCode's
 *     native `system` TUI theme through `tui.json` only when the project has
 *     no explicit TUI/legacy theme config. OpenCode then derives its palette
 *     from the terminal and handles mode 2031 updates itself.
 *
 *   - Hermetic spawn: `OPENCODE_DISABLE_{MODELS_FETCH,AUTOUPDATE,LSP_DOWNLOAD}`
 *     pinned in `composeEnv` so a trading workbench never phones home at spawn
 *     (opencode has no covert telemetry — these kill its *functional* outbound
 *     calls; provider/models are supplied explicitly so the model catalog is
 *     never needed).
 *
 *   - Resume: the bare TUI command (`opencode [project]`, the default) accepts
 *     top-level `-c/--continue` (last session in cwd) and `-s/--session <id>`
 *     (specific session) — verified in `opencode --help` 1.16.0. So resume is a
 *     flag (like claude's `--resume`), not a subcommand (like codex's `resume`).
 *     Both resumeLast and resumeById are on — by-id resume is LIVE via
 *     transcriptDiscovery 'subprocess' (see below).
 *
 *   - Transcript discovery: 'subprocess'. opencode sessions are SQLite rows
 *     (not per-cwd files), and it mints its own `ses_…` ids with no way for the
 *     launcher to assign one at spawn (verified against v1.16.0 source: the
 *     public `POST /session` schema omits `id`). So `listOnDisk` shells out to
 *     `opencode session list --format json` (cwd-scoped) post-spawn; the
 *     transcript watcher polls it, captures the new session's id, and persists
 *     it as resumeHint → `opencode --session <id>` resumes by id.
 */
/**
 * Remove the pre-native-only Workspace provider this adapter used to write.
 * Old workspaces may still contain `provider.workspace.options.apiKey` (and the
 * reversible state file). Leaving them would keep a plaintext key on disk that
 * the app no longer uses. State-backed resets restore the user's pre-existing
 * values; state-less legacy blocks are removed only when they carry the
 * OpenAlice-owned provider name, so a user's own `provider.workspace` survives.
 */
async function resetLegacyWorkspaceProvider(cwd: string): Promise<void> {
  const state = await readWorkspaceFile(cwd, OPENCODE_BINDING_STATE_PATH);
  if (state !== null) {
    await resetOwnedJsonConfig({
      cwd,
      configPath: OPENCODE_CONFIG_PATH,
      statePath: OPENCODE_BINDING_STATE_PATH,
      label: 'opencode project config',
    });
    return;
  }

  const raw = await readWorkspaceFile(cwd, OPENCODE_CONFIG_PATH);
  if (raw === null) return;
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    config = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const providers = config['provider'];
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return;
  const workspace = (providers as Record<string, unknown>)['workspace'];
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return;
  if ((workspace as Record<string, unknown>)['name'] !== 'OpenAlice workspace provider') return;

  delete (providers as Record<string, unknown>)['workspace'];
  if (Object.keys(providers as Record<string, unknown>).length === 0) delete config['provider'];
  if (typeof config['model'] === 'string' && config['model'].startsWith('workspace/')) {
    delete config['model'];
  }
  await writeWorkspaceFile(cwd, OPENCODE_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

export const opencodeAdapter: CliAdapter = {
  discoverModels: (cwd) => discoverNativeModels('opencode', 'opencode', cwd),
  id: 'opencode',
  displayName: 'opencode',
  binary: 'opencode',
  // claude='c', codex='x' already taken; 'o' is free.
  namePrefix: 'o',
  capabilities: {
    parallelPerCwd: true,
    resumeLast: true,
    resumeById: true,
    // by-id resume: opencode can't be assigned an id at spawn and its sessions
    // are SQLite rows (no per-cwd files to fs-watch), but `opencode session
    // list --format json` is cwd-scoped — so the watcher polls `listOnDisk`
    // post-spawn, captures the id, persists it as resumeHint, and
    // `opencode --session <id>` (composeCommand) resumes by id.
    transcriptDiscovery: 'subprocess',
    headless: true,
    // `opencode acp` serves the Agent Client Protocol from the same SQLite
    // session store the TUI uses, so `session/load` reopens `ses_…` ids.
    web: { wire: 'acp', permissionPrompts: true, freshSession: true },
    aiProvider: {
      credentialSource: 'runtime-or-workspace',
      // OpenAlice uses opencode's native DeepSeek provider from the shared
      // opencode config/auth store. Vault credentials and Workspace provider
      // files are not offered for this adapter.
      nativeOnly: true,
      wirePreference: ['google-generative-ai', 'openai-chat', 'anthropic', 'openai-responses'],
      defaultWire: 'openai-chat',
      vendorPolicies: {
        minimax: {
          wirePreference: ['anthropic'],
          legacyRequestedWireFallbacks: { 'openai-chat': 'anthropic' },
        },
      },
      modelRegistration: {
        contextWindow: true,
        reasoning: true,
        effortVariants: true,
      },
    },
  },

  sessionRuntime: {
    project(_ctx, _runtime: ResolvedSessionRuntimeBinding) {
      // OpenAlice runs opencode native-only: the shared opencode config/auth
      // store supplies DeepSeek, and this process-local overlay selects the
      // app-owned Trade profile pinned to the stable `deepseek-flash` alias at
      // max effort. No provider block is injected, so no key leaves the seat.
      const selectedModel = OPENCODE_TRADE_MODEL;
      const reasoningEffort = OPENCODE_TRADE_VARIANT;
      const tradeAgent = {
        ...OPENCODE_TRADE_AGENT,
        model: selectedModel,
        variant: reasoningEffort,
      };
      const interactiveArgs = ['--model', selectedModel];
      const headlessArgs = [
        ...interactiveArgs,
        '--variant', reasoningEffort,
        // Scheduled/issue runs are OpenAlice work: select the same app-owned
        // Trade profile the GUI defaults to. The profile tells headless runs
        // to recommend and report, never to execute an order without approval.
        '--agent', OPENCODE_TRADE_AGENT_ID,
      ];
      const env: Record<string, string> = {};
      // The app-owned Trade profile is a process-local overlay, not a rewrite
      // of the shared opencode config. OPENCODE_CONFIG_CONTENT merges over the
      // global config (verified against the installed opencode ACP server:
      // model, effort, and the auto/goal agents survive), so the terminal keeps
      // its generic default while OpenAlice sessions can select Trade. The
      // parent env's copy is stripped by spawn-env.ts; re-merging it here
      // would only resurrect a stale value.
      const overlay: Record<string, unknown> = {
        // App-spawned TUIs have no `--agent` flag; the default agent makes the
        // bare TUI open Trade while the terminal's global config keeps its own
        // default. Web and headless select Trade explicitly.
        default_agent: OPENCODE_TRADE_AGENT_ID,
        agent: {
          [OPENCODE_TRADE_AGENT_ID]: tradeAgent,
        },
        // ACP has no --model flag. Its native config selects the default model
        // for session/new; keep this process-local.
        model: selectedModel,
      };
      env['OPENCODE_CONFIG_CONTENT'] = JSON.stringify(overlay);
      // Do not add a top-level permission override: the terminal's opencode
      // config owns permissions, and the ACP transport already handles
      // permission prompts. The Trade agent's own permission block is scoped
      // to that agent (including the seat guard).
      return { env, interactiveArgs, headlessArgs, webArgs: [], webConfigPin: { model: selectedModel, reasoningEffort, mode: OPENCODE_TRADE_AGENT_ID } };
    },
  },

  lifecycle: {
    async prepareWorkspace({ cwd }): Promise<void> {
      await resetLegacyWorkspaceProvider(cwd);
      await syncOpenCodeWorkspaceTheme(cwd);
    },
  },

  composeCommand(_base: readonly string[], ctx: SpawnContext): readonly string[] {
    // Tool access is via the injected CLI shims, so the command head is just
    // the binary + a resume flag (if any). Resume is a top-level flag on the
    // bare TUI — verified against opencode 1.16.0.
    const head = ['opencode', ...(ctx.sessionRuntime?.interactiveArgs ?? [])];
    if (ctx.resume === undefined) {
      // Quick-chat seed: `opencode --prompt <text>` opens the TUI seeded with
      // that first message (top-level flag on the default TUI command, verified
      // 1.16.0). The value is a flag argument, so a `-`-leading prompt needs no
      // `--` terminator. Fresh spawns only.
      if (ctx.initialPrompt) return [...head, '--prompt', ctx.initialPrompt];
      return head;
    }
    if (ctx.resume === 'last') return [...head, '--continue'];
    return [...head, '--session', ctx.resume.sessionId];
  },

  // Web surface: `opencode acp`. ACP rejects --model; sessionRuntime
  // projects model selection into OPENCODE_CONFIG_CONTENT instead.
  composeWebCommand(_base: readonly string[], ctx: SpawnContext): readonly string[] {
    if (ctx.resume === 'last') throw new Error('the Web surface requires a concrete opencode session id or a fresh Session');
    return [
      'opencode',
      ...(ctx.sessionRuntime?.webArgs ?? ctx.sessionRuntime?.interactiveArgs ?? []),
      'acp',
    ];
  },

  // Headless: `opencode run <prompt>` is non-interactive and exits at the turn
  // boundary. Tool access is via the injected CLI shims and bundled skills;
  // prompt is the trailing positional after a `--` end-of-options terminator
  // (so a `-`-leading prompt isn't read as a flag).
  composeHeadlessCommand(
    _base: readonly string[],
    ctx: SpawnContext,
    prompt: string,
  ): readonly string[] {
    return [
      'opencode', 'run', '--format', 'json',
      ...(ctx.sessionRuntime?.headlessArgs ?? []),
      ...(ctx.resume === 'last' ? ['--continue'] : ctx.resume ? ['--session', ctx.resume.sessionId] : []),
      '--', prompt,
    ];
  },

  // `opencode run --format json` events carry a top-level `sessionID`
  // (`ses_…`) from the first line (verified 2026-06-11) — resumable via
  // `opencode --session <id>`.
  extractHeadlessSessionId(line: string): string | null {
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      return typeof evt['sessionID'] === 'string' ? evt['sessionID'] : null;
    } catch {
      return null;
    }
  },

  extractHeadlessAssistantText(line: string): string | null {
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt['type'] !== 'text') return null;
      const part = evt['part'];
      if (!part || typeof part !== 'object') return null;
      const record = part as Record<string, unknown>;
      return record['type'] === 'text' && typeof record['text'] === 'string'
        ? record['text']
        : null;
    } catch {
      return null;
    }
  },

  extractHeadlessOutputEvents(line: string): readonly HeadlessOutputEvent[] {
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt['type'] === 'error') {
        const error = evt['error'];
        const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
        const data = record?.['data'] && typeof record['data'] === 'object'
          ? record['data'] as Record<string, unknown>
          : null;
        const message = typeof data?.['message'] === 'string'
          ? data['message']
          : typeof record?.['message'] === 'string'
            ? record['message']
            : typeof record?.['name'] === 'string'
              ? record['name']
              : typeof error === 'string'
                ? error
                : 'OpenCode session failed';
        return [{ type: 'error', message }];
      }
      const part = evt['part'];
      if (!part || typeof part !== 'object') return [];
      const record = part as Record<string, unknown>;
      if (evt['type'] === 'text' && record['type'] === 'text' && typeof record['text'] === 'string') {
        return [{ type: 'text', text: record['text'] }];
      }
      if (evt['type'] !== 'tool_use' && record['type'] !== 'tool') return [];
      const state = record['state'] && typeof record['state'] === 'object'
        ? record['state'] as Record<string, unknown>
        : {};
      const id = typeof record['callID'] === 'string'
        ? record['callID']
        : typeof record['id'] === 'string'
          ? record['id']
          : `opencode-${record['tool'] ?? 'tool'}`;
      const name = typeof record['tool'] === 'string'
        ? record['tool']
        : typeof record['name'] === 'string'
          ? record['name']
          : 'Tool';
      const start: HeadlessOutputEvent = {
        type: 'tool-start',
        id,
        name,
        ...(state['input'] !== undefined || record['input'] !== undefined
          ? { input: state['input'] ?? record['input'] }
          : {}),
      };
      const status = state['status'];
      if (status !== 'completed' && status !== 'error' && status !== 'failed') return [start];
      return [start, {
        type: 'tool-finish',
        id,
        name,
        ...(state['output'] !== undefined || state['error'] !== undefined
          ? { output: state['output'] ?? state['error'] }
          : {}),
        ...(status === 'error' || status === 'failed' ? { isError: true } : {}),
      }];
    } catch {
      return [];
    }
  },

  composeEnv(ctx: SpawnContext): Record<string, string> {
    // Match the terminal's opencode wrapper: pin only the model-catalog and
    // LSP-download fetches. Do not disable auto-update and do not inject a
    // permission override here — the app must run the same opencode build and
    // config as the terminal, not a downgraded or more permissive variant.
    const env: Record<string, string> = {
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    };

    return env;
  },

  /**
   * @deprecated OpenAlice opencode is native-only. The shared opencode
   * config/auth store owns the provider; no Workspace provider file is written.
   */
  async writeAiConfig(_cwd: string, _cred: WorkspaceAiCred): Promise<void> {
    throw new Error('opencode is native-only; Workspace AI provider config is disabled')
  },

  /**
   * @deprecated Native-only: never expose a legacy Workspace provider binding.
   * Existing sessions resolve through `sessionRuntime` and launch natively.
   */
  async readAiConfig(_cwd: string): Promise<WorkspaceAiCred | null> {
    return null
  },

  /**
   * List opencode sessions for THIS workspace cwd, for the watcher's post-spawn
   * id capture. opencode stores sessions as SQLite rows (no per-cwd files), but
   * `opencode session list --format json` is cwd-scoped — so we shell out with
   * cwd set to the workspace. Hermetic env (same disables as composeEnv).
   * Failure (binary missing / bad json) degrades to [] → resume falls back to
   * `--continue`.
   */
  async listOnDisk(cwd: string): Promise<readonly OnDiskSession[]> {
    const out: OnDiskSession[] = [];
    for (const r of await readOpenCodeSessionRows(cwd)) {
      const id = r['id'];
      if (typeof id !== 'string') continue;
      const ts = r['updated'] ?? r['created'];
      const mtime = typeof ts === 'number' ? new Date(ts).toISOString() : String(ts ?? '');
      out.push({ sessionId: id, file: '', mtime, sizeBytes: 0 });
    }
    return out;
  },

  async readSessionTitle(cwd: string, sessionId: string): Promise<string | null> {
    return openCodeSessionTitle(await readOpenCodeSessionRows(cwd), sessionId);
  },
};
