/**
 * Workspace paths that are credential stores or key material.
 *
 * Shared by Workspace Absorb (never copy them into another repo) and the
 * workspace file-preview route (never hand them back over HTTP). The match is
 * case-insensitive and applies at any depth: a committed `config/.env` is just
 * as dangerous as a root `.env`.
 */
const SECRET_SEGMENTS: ReadonlySet<string> = new Set([
  '.env',
  '.pi',
  '.codex',
  '.claude',
  '.opencode',
  '.ssh',
  '.gnupg',
  '.aws',
  '.docker',
  'secrets',
  'credentials',
])

const SECRET_BASENAMES: ReadonlySet<string> = new Set([
  '.env',
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
  'id_rsa',
  'id_ed25519',
])

const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.kdbx', '.env']

function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return (parts[parts.length - 1] ?? '').toLowerCase()
}

export function isSecretWorkspacePath(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter(Boolean).map(part => part.toLowerCase())
  if (parts.some(part => SECRET_SEGMENTS.has(part))) return true
  const name = basename(path)
  if (SECRET_BASENAMES.has(name)) return true
  if (name.startsWith('.env.')) return true
  return SECRET_EXTENSIONS.some(ext => name.endsWith(ext))
}
