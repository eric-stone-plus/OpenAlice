import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, isAbsolute, resolve } from 'node:path'

export type HarnessSandboxMode = 'bwrap' | 'none'

export interface HarnessSandboxCommand {
  readonly file: string
  readonly args: readonly string[]
  readonly mode: HarnessSandboxMode
}

const DEFAULT_BWRAP = '/usr/bin/bwrap'
const BWRAP_PROBE_TTL_MS = 60_000
const PROXY_URL_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'] as const
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
  const mode = parseSandboxMode(control['OPENALICE_HARNESS_SANDBOX'])
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
  // Canonicalize before comparing: resolve() leaves symlinks intact, and
  // bwrap follows a symlinked bind source, which would expose the link target
  // instead of the workspace.
  const cwd = canonicalPath(input.cwd)
  const homeDir = canonicalPath(home)
  if (cwd === '/' || homeDir === '/' || cwd === homeDir) {
    throw new Error('refusing to sandbox with / or the home directory as the writable workspace')
  }
  const resolvedExecutable = resolveExecutable(input.file, env)
  const executable = resolvedExecutable.execPath
  const tmpDir = canonicalPath('/tmp')
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const runtimeDir = uid !== undefined ? canonicalPath(`/run/user/${uid}`) : null
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
    '--tmpfs', tmpDir,
    // Hide the whole home, including ~/.openalice, ~/.ssh, ~/.aws and agent
    // session artifacts. The workspace and the executable's PATH roots are
    // rebound below.
    '--tmpfs', homeDir,
    '--dir', homeDir,
  ]
  if (runtimeDir && existsSync(runtimeDir)) args.push('--tmpfs', runtimeDir)
  const dataHome = input.dataHome?.trim()
  const dataDir = dataHome ? canonicalPath(dataHome) : undefined
  // A workspace that contains HOME would be bound read-write over the tmpfs,
  // re-exposing every credential store. Check this even when OPENALICE_HOME is
  // unset; the data-home check is additional, not a precondition.
  if (isInside(homeDir, cwd)) {
    throw new Error('refusing to sandbox with a workspace that contains HOME')
  }
  if (dataDir) {
    if (dataDir === '/') throw new Error('refusing to sandbox with / as the OpenAlice data home')
    if (isInside(dataDir, cwd)) {
      throw new Error('refusing to sandbox with a workspace that contains the OpenAlice data home')
    }
    if (!isInside(dataDir, homeDir) && existsSync(dataDir)) {
      args.push('--tmpfs', dataDir, '--dir', dataDir)
    }
  }
  for (const socket of runtimeSockets()) {
    args.push('--ro-bind', '/dev/null', socket)
  }
  // The read-only `/` bind still exposes container secret mounts; mask them
  // like the runtime sockets so a workspace harness cannot read them.
  const secretRoots = [...new Set(['/run/secrets', '/var/run/secrets'].map(canonicalPath))]
  for (const secretRoot of secretRoots) {
    if (!existsSync(secretRoot)) continue
    // A single secret may be bind-mounted as a regular file at this path;
    // `--tmpfs` requires a directory and would abort the whole sandbox.
    let isDirectory = false
    try {
      isDirectory = statSync(secretRoot).isDirectory()
    } catch {
      // The mount disappeared between existsSync and statSync; nothing to mask.
      continue
    }
    if (isDirectory) args.push('--tmpfs', secretRoot)
    else args.push('--ro-bind', '/dev/null', secretRoot)
  }
  // A harness installed under the user's home (nvm, bun, pnpm shims) needs its
  // executable and PATH roots visible. Bind those directories read-only; the
  // rest of home stays a tmpfs.
  const runtimeRoots = new Set<string>()
  const hiddenRoots = [homeDir, ...(dataDir && dataDir !== homeDir ? [dataDir] : [])]
  // /tmp and the user runtime directory are tmpfs mounts too. Rebinding a PATH
  // or CA path below them is fine, but binding the root itself would undo the
  // tmpfs, so treat them as masked roots for the "is this the root?" checks.
  const maskedRoots = [
    ...hiddenRoots.map(canonicalPath),
    tmpDir,
    ...(runtimeDir && existsSync(runtimeDir) ? [runtimeDir] : []),
  ]
  for (const dir of executablePathDirs(env)) {
    // Binding a masked root itself would undo the tmpfs above.
    if (maskedRoots.includes(dir)) continue
    if (maskedRoots.some((root) => isInside(dir, root)) && existsSync(dir)) runtimeRoots.add(dir)
  }
  for (const candidate of new Set([resolvedExecutable.bindPath, resolvedExecutable.execPath])) {
    if (!isAbsolute(candidate) || !existsSync(candidate)) continue
    const hiddenRoot = maskedRoots.find((root) => isInside(candidate, root))
    if (!hiddenRoot) continue
    const executableDir = dirname(candidate)
    if (maskedRoots.includes(executableDir)) {
      // The executable's directory is itself a hidden root (the default data
      // home inside HOME). Create it and bind only the binary so the rest of
      // that root stays hidden.
      args.push('--dir', executableDir, '--ro-bind', candidate, candidate)
    } else if (isInside(executableDir, hiddenRoot)) {
      // Bind the binary and its parent directory chain, never the directory
      // contents: the lexical shim path must exist for argv[0], but a PATH
      // directory under HOME must not be exposed wholesale.
      for (const parent of parentsInside(hiddenRoot, candidate)) args.push('--dir', parent)
      args.push('--ro-bind', candidate, candidate)
    }
  }
  // Custom CA paths are forwarded to the harness, so they must remain
  // readable after the home tmpfs. Bind files directly and certificate
  // directories as read-only roots. Bind the lexical path as well as the
  // canonical target: the child opens the lexical path, which may be a symlink
  // whose target is outside the hidden root (NixOS profiles, for example).
  const fileBinds = new Set<string>()
  const addCaPath = (target: Set<string>, value: string, filesOnly = false): void => {
    const lexical = isAbsolute(value) ? resolve(value) : resolve(cwd, value)
    for (const candidate of new Set([lexical, canonicalPath(lexical)])) {
      // Binding a masked root itself would undo its tmpfs.
      if (maskedRoots.includes(candidate)) continue
      const secretRoot = secretRoots.find((root) => isInside(candidate, root))
      if (secretRoot) {
        // Re-bind a CA *file* under the secret tmpfs; never bind a directory
        // there, which would re-expose every secret in the mount.
        if (!filesOnly || !existsSync(candidate)) continue
        try {
          if (statSync(candidate).isFile()) target.add(candidate)
        } catch {
          // Disappeared or unreadable; the harness will report a TLS error.
        }
        continue
      }
      if (!existsSync(candidate) || !maskedRoots.some((root) => isInside(candidate, root))) continue
      if (filesOnly) {
        try {
          if (statSync(candidate).isFile()) target.add(candidate)
        } catch {
          // Disappeared or unreadable; the harness will report a TLS error.
        }
        continue
      }
      target.add(candidate)
    }
  }
  for (const key of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'] as const) {
    const value = env[key]?.trim()
    if (value) addCaPath(fileBinds, value, true)
  }
  for (const entry of (env['SSL_CERT_DIR'] ?? '').split(delimiter)) {
    const value = entry.trim()
    if (value) addCaPath(runtimeRoots, value)
  }
  for (const file of [...fileBinds].sort()) {
    const root = maskedRoots.find((candidate) => isInside(file, candidate))
      ?? secretRoots.find((candidate) => isInside(file, candidate))
    if (!root) continue
    for (const parent of parentsInside(root, file)) args.push('--dir', parent)
    args.push('--ro-bind', file, file)
  }
  for (const dir of [...runtimeRoots].sort()) {
    const root = maskedRoots.find((candidate) => isInside(dir, candidate)) ?? homeDir
    for (const parent of parentsInside(root, dir)) args.push('--dir', parent)
    args.push('--ro-bind', dir, dir)
  }
  if (isInside(cwd, homeDir)) {
    for (const dir of parentsInside(homeDir, cwd)) args.push('--dir', dir)
  }
  args.push('--dir', cwd, '--bind', cwd, cwd, '--chdir', cwd)
  // The sandbox has a private /tmp; an inherited TMPDIR may point into the
  // hidden home or the read-only root bind and make temp writes fail.
  args.push('--setenv', 'TMPDIR', '/tmp')
  // `pwd` in the child must report the sandbox cwd, not the server's cwd.
  args.push('--setenv', 'PWD', cwd)
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
    ...PROXY_URL_KEYS, 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ])
  const prefixes = ['LC_']
  // Keep this derived from the same list as the allowlist; a proxy key added
  // to one but not the other would copy userinfo into the harness env.
  const credentialUrlKeys = new Set<string>([
    ...PROXY_URL_KEYS,
    'NPM_CONFIG_REGISTRY', 'npm_config_registry',
  ])
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const windowsMatch = process.platform === 'win32' && windowsAllowed.has(key.toLowerCase())
    if (!(allowed.has(key) || exactAllowed.has(key) || windowsMatch || prefixes.some((prefix) => key.startsWith(prefix)))) continue
    if (key.toUpperCase() === 'PATH') {
      // The bind loop recreates canonicalized PATH directories. Only absolute
      // entries are safe: a relative entry is resolved against the server's
      // cwd here and would either bind the wrong tree or make the child run a
      // workspace binary from an unexpected directory.
      result[key] = value.split(delimiter)
        .map((entry) => process.platform === 'win32' ? entry.trim().replace(/^"(.*)"$/, '$1') : entry.trim())
        .filter((entry) => entry !== '' && isAbsolute(entry))
        .map((entry) => canonicalPath(entry))
        .join(delimiter)
      continue
    }
    // A registry or proxy URL may embed a token (`https://user:token@host/`).
    // The harness needs the endpoint, not the credential; strip the userinfo
    // and credential query parameters instead of dropping the whole variable.
    if (credentialUrlKeys.has(key)) {
      const sanitized = sanitizeCredentialUrl(value)
      if (sanitized === null) {
        console.warn(`[harness] dropping ${key}: not a usable URL`)
        continue
      }
      if (sanitized !== value.trim()) console.warn(`[harness] stripped credentials from ${key}`)
      result[key] = sanitized
      continue
    }
    result[key] = value
  }
  return result
}

function isCredentialQueryKey(key: string): boolean {
  const normalized = key.toLowerCase()
  if (['token', 'secret', 'key', 'auth', 'password', 'passwd', 'pwd', 'sig', 'signature', 'credential', 'credentials'].includes(normalized)) {
    return true
  }
  if (/(?:^|[_-])(?:token|secret|key|auth|password|passwd|pwd|sig|signature|credential)s?$/.test(normalized)) {
    return true
  }
  return /(?:api|access|secret|private|client|refresh|id|auth)(?:key|token|secret)$/.test(normalized)
}

function sanitizeCredentialUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  // A scheme-less proxy (`user:pass@proxy:3128`) is parsed by URL as the
  // scheme `user:` with empty userinfo. Add an explicit scheme before parsing
  // so the userinfo check sees the credentials. curl accepts this form.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const protocolRelative = trimmed.startsWith('//')
  const normalized = hasScheme ? trimmed : protocolRelative ? `http:${trimmed}` : `http://${trimmed}`
  try {
    const url = new URL(normalized)
    if (!url.hostname) return null
    let changed = false
    if (url.username !== '' || url.password !== '') {
      url.username = ''
      url.password = ''
      changed = true
    }
    for (const key of [...url.searchParams.keys()]) {
      if (!isCredentialQueryKey(key)) continue
      url.searchParams.delete(key)
      changed = true
    }
    if (!changed) return trimmed
    const rendered = url.toString()
    const withoutSyntheticScheme = hasScheme
      ? rendered
      : protocolRelative
        ? rendered.replace(/^http:/, '')
        : rendered.replace(/^http:\/\//, '')
    // URL#toString() appends a root slash to an authority-only URL. Preserve
    // the caller's original scheme-less spelling when there was no path.
    if (hasScheme || protocolRelative) return withoutSyntheticScheme
    return !trimmed.endsWith('/') && withoutSyntheticScheme.endsWith('/')
      ? withoutSyntheticScheme.slice(0, -1)
      : withoutSyntheticScheme
  } catch {
    return null
  }
}

const bwrapUsability = new Map<string, { usable: boolean; checkedAt: number }>()

function bwrapUsable(bwrap: string): boolean {
  const cached = bwrapUsability.get(bwrap)
  // A successful probe is stable. A negative result may be transient (a
  // timeout, a temporarily disabled user namespace), so retry it after a
  // short TTL instead of blocking every harness launch on a 2 s probe.
  if (cached && (cached.usable || Date.now() - cached.checkedAt < BWRAP_PROBE_TTL_MS)) return cached.usable
  let usable = false
  const probe = bwrapProbeCommand()
  if (probe.length > 0) {
    try {
      // existsSync only proves a file is present. A bwrap that cannot create a
      // user namespace fails every launch; probe once and fall back (or fail
      // closed under `required`) before spawning the harness.
      const result = spawnSync(bwrap, [
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
        '--unshare-pid',
        '--', ...probe,
      ], { stdio: 'ignore', timeout: 2_000 })
      usable = result.status === 0
    } catch {
      usable = false
    }
  }
  bwrapUsability.set(bwrap, { usable, checkedAt: Date.now() })
  return usable
}

/** Runtime-independent no-op for the bwrap probe. In the Bun standalone
 *  release `process.execPath` is the OpenAlice binary, so `-e ''` opens the
 *  Supervisor TUI and the probe times out. `/bin/sh` is present on normal
 *  Linux hosts (including NixOS); fall back to `/bin/true`, then to Node's
 *  `-e` only when this really is Node. */
function bwrapProbeCommand(): string[] {
  if (existsSync('/bin/sh')) return ['/bin/sh', '-c', 'exit 0']
  if (existsSync('/bin/true')) return ['/bin/true']
  if (process.versions.bun === undefined) return [process.execPath, '-e', '']
  return []
}

export function parseSandboxMode(raw: string | undefined): 'auto' | 'required' | 'off' {
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
  return path.split(delimiter).map((entry) => entry.trim())
    // Relative entries would be resolved against the server cwd, not the
    // sandbox cwd; they are not safe bind roots.
    .filter((entry) => entry !== '' && isAbsolute(entry))
    .map(canonicalPath)
}

interface ResolvedExecutable {
  /** Path passed to execve, preserving a shim's argv[0]/`$0`. */
  readonly execPath: string
  /** Canonical target that must be rebound outside the home tmpfs. */
  readonly bindPath: string
}

function resolveExecutable(file: string, env: NodeJS.ProcessEnv): ResolvedExecutable {
  const candidates = isAbsolute(file)
    ? [file]
    : executablePathDirs(env).map((dir) => resolve(dir, file))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      // A directory also passes X_OK. Binding it would expose its parent
      // under --ro-bind and undo the home tmpfs, so only regular files count.
      if (!statSync(candidate).isFile()) continue
      // Keep the lexical path for execution so a symlink shim sees its own
      // argv[0]; bind the canonical target as well because the shim may point
      // at a package under a hidden home directory.
      return { execPath: candidate, bindPath: canonicalPath(candidate) }
    } catch {
      // Try the next PATH entry.
    }
  }
  if (isAbsolute(file)) {
    // An absolute command that exists but is not a regular file must fail
    // before the sandbox args are built; a missing absolute path can fall
    // through to spawn's ENOENT.
    let info: ReturnType<typeof statSync>
    try {
      info = statSync(file)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { execPath: file, bindPath: file }
      throw new Error(`could not inspect harness executable ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!info.isFile()) throw new Error(`harness executable is not a regular file: ${file}`)
    return { execPath: file, bindPath: canonicalPath(file) }
  }
  return { execPath: file, bindPath: file }
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

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // The path may not exist yet; the lexical normalization is the best we
    // can do, and bwrap will fail closed on a missing bind source.
    return resolve(path)
  }
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
