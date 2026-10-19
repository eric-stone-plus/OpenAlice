import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Migration, MigrationContext } from '../types.js'
import { isSealedEnvelope, seal } from '../../core/sealing.js'
import { SECRET_CONFIG_FILES, globalProviderKeysFile } from '../../core/secret-files.js'

/**
 * Seal one file if it is still plaintext JSON. Already-sealed files are only
 * chmod'd, so the migration is idempotent and never re-encrypts a valid store.
 * Malformed JSON is left untouched: rewriting it would risk destroying user
 * data, and it cannot be interpreted as a secret store anyway.
 */
async function sealIfPlaintext(path: string): Promise<void> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf-8'))
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    if (err instanceof SyntaxError) {
      console.warn(`[migration 0045] ${path} is not valid JSON; leaving it untouched`)
      return
    }
    throw err
  }
  if (isSealedEnvelope(raw)) {
    await chmod(path, 0o600).catch(() => { /* platform without chmod */ })
    return
  }
  await writeFile(path, JSON.stringify(await seal(raw), null, 2) + '\n', { mode: 0o600 })
  await chmod(path, 0o600).catch(() => { /* platform without chmod */ })
}

export async function migrateSealSecretConfig(ctx: MigrationContext): Promise<void> {
  const dir = ctx.configDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700).catch(() => { /* platform without chmod */ })
  await chmod(dirname(dir), 0o700).catch(() => { /* platform without chmod */ })
  await chmod(resolve(ctx.userDataHome(), 'sealing.key'), 0o600).catch(() => { /* absent on first run */ })

  for (const filename of SECRET_CONFIG_FILES) {
    await sealIfPlaintext(resolve(dir, filename))
  }
  // Older builds backed up the pre-preset broker store as plaintext JSON.
  await sealIfPlaintext(resolve(dir, 'accounts.json.backup-pre-preset'))
  // Data-vendor keys live in the user-global root, outside data/.
  await sealIfPlaintext(globalProviderKeysFile())
  // Pre-0045 migration snapshots could contain plaintext copies of any of the
  // stores above. Seal them too; a snapshot must not become a leak that
  // outlives the fix.
  await sealLegacySnapshots(ctx)
}

async function sealLegacySnapshots(ctx: MigrationContext): Promise<void> {
  const backupRoot = resolve(ctx.userDataHome(), 'data', '_backup')
  let entries
  try {
    entries = await readdir(backupRoot, { withFileTypes: true })
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  await chmod(backupRoot, 0o700).catch(() => { /* platform without chmod */ })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const snapshotRoot = resolve(backupRoot, entry.name)
    const snapshotConfig = resolve(snapshotRoot, 'config')
    await chmod(snapshotRoot, 0o700).catch(() => { /* platform without chmod */ })
    await chmod(snapshotConfig, 0o700).catch(() => { /* platform without chmod */ })
    for (const filename of [...SECRET_CONFIG_FILES, 'accounts.json.backup-pre-preset']) {
      await sealIfPlaintext(resolve(snapshotConfig, filename))
    }
  }
}

export const migration: Migration = {
  id: '0045_seal_secret_config',
  appVersion: '0.95.0-beta',
  introducedAt: '2026-10-19',
  affects: [...SECRET_CONFIG_FILES, 'accounts.json.backup-pre-preset', 'provider-keys.json', '_backup/*/config'],
  summary: 'Seal AI, market-data and broker-provider credentials at rest with the AES-256-GCM envelope and enforce owner-only modes.',
  up: migrateSealSecretConfig,
}
