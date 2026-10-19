import { readdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'

const SKIP_DIRS = new Set(['.git', 'node_modules'])

/**
 * Known credential stores. This is deliberately narrower than the shared
 * preview/absorb deny policy: offboarding archives a real checkout, so
 * deleting every file under `.pi/` or `credentials/` would remove settings,
 * extensions, and source modules that are not secrets.
 */
const SECRET_BASENAMES: ReadonlySet<string> = new Set([
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.mcp.json',
  'provider-keys.json',
  'openalice-provider.json',
  'accounts.json',
  'auth.json',
  'wallet.json',
  'credentials.json',
  'secrets.json',
  'credentials',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
])

const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.kdbx']

const PROVIDER_DIR_FILES: Readonly<Record<string, ReadonlySet<string>>> = {
  '.pi': new Set(['openalice-provider.json', 'auth.json']),
  '.claude': new Set(['settings.local.json', 'openalice-provider.json']),
  '.codex': new Set(['auth.json', 'env.json', 'openalice-provider.json']),
  '.opencode': new Set(['openalice-provider.json', 'auth.json']),
}

const SECRET_DATA_DIRS = new Set(['secrets', 'credentials'])
const SECRET_DATA_EXTENSIONS = ['.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env']

function isRevocableCredential(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean).map(part => part.toLowerCase())
  const name = parts[parts.length - 1] ?? ''
  if (name === '.env') return true
  if (name.startsWith('.env.')) {
    return name !== '.env.example' && name !== '.env.sample' && name !== '.env.template'
  }
  if (SECRET_BASENAMES.has(name)) return true
  if (SECRET_EXTENSIONS.some(ext => name.endsWith(ext))) return true
  const parent = parts[parts.length - 2]
  if (parent && PROVIDER_DIR_FILES[parent]?.has(name)) return true
  if (
    parts.some(part => SECRET_DATA_DIRS.has(part))
    && SECRET_DATA_EXTENSIONS.some(ext => name.endsWith(ext))
  ) return true
  return false
}

/**
 * Remove credential stores and key material from a Workspace before it is
 * archived. Offboarding is not a delete: the departed checkout can be
 * restored, shared, or backed up, so leaving `.pi/openalice-provider.json`,
 * `.env`, or a broker wallet inside it would preserve the exact leak the
 * sealed home is meant to prevent.
 *
 * Only known credential files are removed; normal source files, `.pi`
 * settings/extensions, and `.env.example` are preserved.
 */
export async function revokeWorkspaceCredentials(dir: string): Promise<void> {
  const walk = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const abs = join(current, entry.name)
      const rel = relative(dir, abs)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(abs)
        continue
      }
      if (entry.isFile() && isRevocableCredential(rel)) {
        await rm(abs, { force: true })
      }
    }
  }
  await walk(dir)
}
