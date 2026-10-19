import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, isAbsolute, resolve } from 'node:path'

export type HarnessSandboxMode = 'bwrap' | 'none'

export interface HarnessSandboxCommand {
  readonly file: string
  readonly args: readonly string[]
  readonly mode: HarnessSandboxMode
}

const DEFAULT_BWRAP = '/usr/bin/bwrap'
const RUNTIME_SOCKETS = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/run/containerd/containerd.sock',
  '/run/podman/podman.sock',
  '/run/crio/crio.sock',
  '/var/run/crio/crio.sock',
] as const

/**
 * Wrap a workspace-controlled harness command in a bubblewrap namespace.
 *
 * The sandbox keeps `/` read-only, gives the harness a private `/tmp`, hides
 * the entire home directory (including `~/.openalice`, SSH, cloud and agent
 * credentials), hides the OpenAlice data home when it lives outside `$HOME`,
 * masks container-runtime sockets, then binds only the workspace read-write.
 * Network stays shared so trading/Studio apps keep working.
 *
 * `OPENALICE_HARNESS_SANDBOX=required` fails closed when bubblewrap is
 * unavailable; `off` is the explicit opt-out. The default is `auto`: use the
 * sandbox when bubblewrap is installed, otherwise run unsandboxed (the
 * manager logs the degraded mode).
 *
 * This is not a same-UID boundary: a malicious process outside the sandbox can
 * still read the user's files. It is a boundary between a workspace-controlled
 * command and the rest of the user's home.
 */
export function sandboxHarnessCommand(input: {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly home: string | undefined
  /** OpenAlice data home when it is outside `home` (Guardian defaults to /data). */
  readonly dataHome?: string
  readonly env?: NodeJS.ProcessEnv
  /** Unfiltered parent env for sandbox controls; `env` is the scrubbed child env. */
  readonly controlEnv?: NodeJS.ProcessEnv
  readonly bwrapPath?: string
}): HarnessSandboxCommand {
  const env = input.env ?? process.env
  const control = input.controlEnv ?? env
  const mode = parseMode(control['OPENALICE_HARNESS_SANDBOX'])
  if (mode === 'off') return { file: input.file, args: input.args, mode: 'none' }
  const bwrap = input.bwrapPath?.trim()
    || control['OPENALICE_BWRAP_PATH']?.trim()
    || DEFAULT_BWRAP
  if (!existsSync(bwrap)) {
    if (mode === 'required') {
      throw new Error('Harness sandbox is required but bubblewrap (bwrap) is not installed')
    }
    return { file: input.file, args: input.args, mode: 'none' }
  }
  if (!bwrapUsable(bwrap)) {
    if (mode === 'required') {
      throw new Error('Harness sandbox is required but bubblewrap (bwrap) is not usable on this host')
    }
    return { file: input.file, args: input.args, mode: 'none' }
  }
  const home = input.home?.trim()
  if (!home) {
    if (mode === 'required') {
      throw new Error('Harness sandbox requires HOME to hide the user credential stores')
    }
    return { file: input.file, args: input.args, mode: 'none' }
  }
  const cwd = resolve(input.cwd)
  const homeDir = resolve(home)
  if (cwd === '/' || cwd === homeDir) {
    throw new Error('refusing to sandbox with / or the home directory as the writable workspace')
  }
  const executable = resolveExecutable(input.file, env)
  const args: string[] = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--cap-drop', 'ALL',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    // Hide the whole home, including ~/.openalice, ~/.ssh, ~/.aws and agent
    // session artifacts. The workspace and the executable's PATH roots are
    // rebound below.
    '--tmpfs', homeDir,
    '--dir', homeDir,
  ]
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined) {
    const runtimeDir = `/run/user/${uid}`
    if (existsSync(runtimeDir)) args.push('--tmpfs', runtimeDir)
  }
  const dataHome = input.dataHome?.trim()
  const dataDir = dataHome ? resolve(dataHome) : undefined
  if (dataDir) {
    if (dataDir === '/') throw new Error('refusing to sandbox with / as the OpenAlice data home')
    // Binding an ancestor of HOME/data would re-expose the very paths the
    // tmpfs mounts hide; require a workspace inside or beside them, never above.
    if (isInside(homeDir, cwd) || isInside(dataDir, cwd)) {
      throw new Error('refusing to sandbox with a workspace that contains HOME or the OpenAlice data home')
    }
    if (!isInside(dataDir, homeDir) && existsSync(dataDir)) {
      args.push('--tmpfs', dataDir, '--dir', dataDir)
    }
  }
  for (const socket of runtimeSockets()) {
    args.push('--ro-bind', '/dev/null', socket)
  }
  // A harness installed under the user's home (nvm, bun, pnpm shims) needs its
  // executable and PATH roots visible. Bind those directories read-only; the
  // rest of home stays a tmpfs.
  const runtimeRoots = new Set<string>()
  for (const dir of executablePathDirs(env)) {
    // Binding HOME itself would undo the tmpfs above.
    if (dir !== homeDir && isInside(dir, homeDir) && existsSync(dir)) runtimeRoots.add(dir)
  }
  if (isAbsolute(executable) && isInside(executable, homeDir)) {
    const executableDir = dirname(executable)
    if (executableDir === homeDir) {
      // A harness installed directly in HOME: expose only the binary, not the
      // directory. Parent directories are already present from --dir above.
      args.push('--ro-bind', executable, executable)
    } else {
      runtimeRoots.add(executableDir)
    }
  }
  for (const dir of [...runtimeRoots].sort()) {
    for (const parent of parentsInside(homeDir, dir)) args.push('--dir', parent)
    args.push('--ro-bind', dir, dir)
  }
  if (isInside(cwd, homeDir)) {
    for (const dir of parentsInside(homeDir, cwd)) args.push('--dir', dir)
  }
  args.push('--dir', cwd, '--bind', cwd, cwd, '--chdir', cwd)
  args.push('--', executable, ...input.args)
  return { file: bwrap, args, mode: 'bwrap' }
}

/**
 * Environment allowlist for a workspace-controlled harness. The parent server
 * env contains provider keys, cloud credentials, the local auth token and the
 * OpenAlice home; none of them belong in the harness process. `buildSpawnEnv`
 * already strips a few known names, but this allowlist is the boundary.
 */
export function buildHarnessEnv(env: Record<string, string>): Record<string, string> {
  const allowed = new Set([
    'HOME', 'PATH', 'LANG', 'TERM', 'COLORTERM', 'TZ', 'TMPDIR',
    'USER', 'LOGNAME', 'SHELL', 'PWD',
    'NODE_OPTIONS', 'NODE_ENV',
    'NPM_CONFIG_REGISTRY', 'npm_config_registry',
    'NPM_CONFIG_CACHE', 'npm_config_cache',
    'COREPACK_HOME',
  ])
  const windowsAllowed = new Set([
    'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata',
    'temp', 'tmp', 'systemroot', 'comspec', 'pathext', 'windir', 'path',
    'programdata', 'programfiles', 'programfiles(x86)', 'commonprogramfiles',
    'commonprogramfiles(x86)', 'number_of_processors', 'processor_architecture',
    'os', 'username', 'userdomain',
  ])
  // Do not allowlist whole BUN_/PNPM_/HARNESS_ prefixes: those families
  // include registry auth tokens (BUN_AUTH_TOKEN, PNPM_TOKEN) and unrelated
  // host secrets. Only the harness/runtime knobs the launcher itself sets.
  const exactAllowed = new Set([
    'HARNESS_CAPABILITY', 'HARNESS_HOST', 'HARNESS_LOOPBACK', 'HARNESS_NO_OPEN', 'HARNESS_PORTS',
    'HARNESS_CONFIG', 'HARNESS_CONFIG_PATH', 'HARNESS_SKILLS', 'HARNESS_VERSION_PATH',
    'BUN_INSTALL', 'BUN_INSTALL_BIN', 'BUN_INSTALL_CACHE_DIR', 'BUN_INSTALL_GLOBAL_DIR',
    'PNPM_HOME', 'PNPM_STORE_DIR', 'PNPM_CACHE_DIR',
  ])
  const prefixes = ['LC_']
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const windowsMatch = process.platform === 'win32' && windowsAllowed.has(key.toLowerCase())
    if (!(allowed.has(key) || exactAllowed.has(key) || windowsMatch || prefixes.some((prefix) => key.startsWith(prefix)))) continue
    // A registry URL may embed a token (`https://user:token@host/`). The
    // harness needs the registry, not the credential; drop that form.
    if ((key === 'NPM_CONFIG_REGISTRY' || key === 'npm_config_registry') && !isCredentialFreeUrl(value)) continue
    result[key] = value
  }
  return result
}

function isCredentialFreeUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.username === '' && url.password === ''
  } catch {
    return false
  }
}

const bwrapUsability = new Map<string, boolean>()

function bwrapUsable(bwrap: string): boolean {
  const cached = bwrapUsability.get(bwrap)
  if (cached !== undefined) return cached
  let usable = false
  try {
    // existsSync only proves a file is present. A bwrap that cannot create a
    // user namespace fails every launch; probe once and fall back (or fail
    // closed under `required`) before spawning the harness.
    const probe = spawnSync(bwrap, [
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--unshare-pid',
      '--', '/bin/true',
    ], { stdio: 'ignore', timeout: 2_000 })
    usable = probe.status === 0
  } catch {
    usable = false
  }
  bwrapUsability.set(bwrap, usable)
  return usable
}

function parseMode(raw: string | undefined): 'auto' | 'required' | 'off' {
  const value = raw?.trim().toLowerCase()
  if (value === undefined || value === '' || value === 'auto') return 'auto'
  if (value === 'off' || value === 'false' || value === '0') return 'off'
  if (value === 'required' || value === 'bwrap' || value === 'on' || value === 'true' || value === '1') return 'required'
  throw new Error(
    `invalid OPENALICE_HARNESS_SANDBOX value "${raw}" (expected auto, required, or off)`,
  )
}

function executablePathDirs(env: NodeJS.ProcessEnv): string[] {
  const path = env['PATH'] ?? process.env['PATH'] ?? ''
  return path.split(delimiter).map((entry) => entry.trim()).filter(Boolean)
}

function resolveExecutable(file: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(file)) return file
  for (const dir of executablePathDirs(env)) {
    const candidate = resolve(dir, file)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  return file
}

function runtimeSockets(): string[] {
  const sockets = new Set<string>()
  for (const path of RUNTIME_SOCKETS) {
    if (!existsSync(path)) continue
    try {
      sockets.add(realpathSync(path))
    } catch {
      sockets.add(path)
    }
  }
  return [...sockets].sort()
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

function parentsInside(root: string, path: string): string[] {
  const parts = path.slice(root.length).split('/').filter(Boolean)
  const dirs: string[] = []
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = `${current}/${part}`
    dirs.push(current)
  }
  return dirs
}
