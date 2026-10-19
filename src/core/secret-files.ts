/**
 * Secret-bearing config files and the paths that must never be copied into a
 * plaintext snapshot.
 *
 * `config.ts` seals these with the AES-256-GCM envelope from `sealing.ts`.
 * The migration runner imports the exclusion set so a pre-migration snapshot
 * cannot recreate the plaintext-at-rest problem the seal was introduced to
 * fix. Keep this list in sync with `sectionFiles` in `config.ts`.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Config sections whose JSON payload contains credentials. */
export const SECRET_CONFIG_FILES = [
  'ai-provider-manager.json',
  'market-data.json',
  'crypto.json',
  'securities.json',
] as const

const SECRET_CONFIG_FILE_SET: ReadonlySet<string> = new Set(SECRET_CONFIG_FILES)

/** Files that must never be copied verbatim into `data/_backup`. */
export const SECRET_SNAPSHOT_EXCLUDES: ReadonlySet<string> = new Set([
  ...SECRET_CONFIG_FILES,
  'accounts.json',
  'accounts.json.backup-pre-preset',
  // The admin token is only a scrypt hash, but there is no reason to copy it
  // into a recovery snapshot either.
  'auth.json',
])

export function isSecretConfigFile(filename: string): boolean {
  return SECRET_CONFIG_FILE_SET.has(filename)
}

/**
 * User-global data-vendor key store. Resolved per call (not a module const) so
 * tests and portable installs can point it elsewhere via OPENALICE_GLOBAL_DIR.
 */
export function globalProviderKeysFile(): string {
  const root = process.env['OPENALICE_GLOBAL_DIR'] ?? join(homedir(), '.openalice')
  return join(root, 'provider-keys.json')
}
