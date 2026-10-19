import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import type { MigrationContext } from './types.js'

/**
 * 0045 seals every secret-bearing config store that predates the envelope.
 * The spec uses a temp OPENALICE_HOME / OPENALICE_GLOBAL_DIR and imports the
 * migration dynamically, so sealing.ts resolves its key path inside the temp
 * home and the developer's real ~/.openalice is never touched.
 */
let home: string
let configDir: string
let globalDir: string
let savedHome: string | undefined
let savedGlobal: string | undefined

async function loadMigration() {
  vi.resetModules()
  process.env['OPENALICE_HOME'] = home
  process.env['OPENALICE_GLOBAL_DIR'] = globalDir
  const migration = await import('./0045_seal_secret_config/index.js')
  const sealing = await import('../core/sealing.js')
  return { ...migration, ...sealing }
}

function context(): MigrationContext {
  return {
    async readJson() { return undefined },
    async writeJson() { /* not used by 0045 */ },
    async removeJson() { /* not used by 0045 */ },
    configDir: () => configDir,
    userDataHome: () => home,
    launcherRoot: () => join(home, 'workspaces'),
  }
}

beforeEach(async () => {
  savedHome = process.env['OPENALICE_HOME']
  savedGlobal = process.env['OPENALICE_GLOBAL_DIR']
  home = await mkdtemp(join(tmpdir(), 'oa-seal-migration-'))
  configDir = join(home, 'data', 'config')
  globalDir = await mkdtemp(join(tmpdir(), 'oa-seal-global-'))
  await mkdir(configDir, { recursive: true })
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['OPENALICE_HOME']
  else process.env['OPENALICE_HOME'] = savedHome
  if (savedGlobal === undefined) delete process.env['OPENALICE_GLOBAL_DIR']
  else process.env['OPENALICE_GLOBAL_DIR'] = savedGlobal
  vi.resetModules()
  await rm(home, { recursive: true, force: true })
  await rm(globalDir, { recursive: true, force: true })
})

const SECRETS: Record<string, { value: unknown; sentinel: string }> = {
  'ai-provider-manager.json': {
    value: { credentials: { 'openai-1': { vendor: 'openai', authType: 'api-key', apiKey: 'sk-ai-sentinel' } } },
    sentinel: 'sk-ai-sentinel',
  },
  'market-data.json': {
    value: { providerKeys: { fmp: 'fmp-sentinel' } },
    sentinel: 'fmp-sentinel',
  },
  'crypto.json': {
    value: { provider: { type: 'ccxt', exchange: 'okx', apiKey: 'crypto-sentinel' } },
    sentinel: 'crypto-sentinel',
  },
  'securities.json': {
    value: { provider: { type: 'alpaca', apiKey: 'securities-sentinel' } },
    sentinel: 'securities-sentinel',
  },
}

describe('0045 seal secret config', () => {
  it('seals every plaintext store, the legacy broker backup and the global key file', async () => {
    for (const [filename, { value }] of Object.entries(SECRETS)) {
      await writeFile(join(configDir, filename), JSON.stringify(value, null, 2))
    }
    await writeFile(
      join(configDir, 'accounts.json.backup-pre-preset'),
      JSON.stringify([{ apiKey: 'legacy-sentinel' }], null, 2),
    )
    await writeFile(join(globalDir, 'provider-keys.json'), JSON.stringify({ fred: 'global-sentinel' }))

    const { migrateSealSecretConfig, isSealedEnvelope } = await loadMigration()
    await migrateSealSecretConfig(context())

    const checks: Array<[string, string]> = [
      ...Object.entries(SECRETS).map(([filename, { sentinel }]) => [join(configDir, filename), sentinel] as [string, string]),
      [join(configDir, 'accounts.json.backup-pre-preset'), 'legacy-sentinel'],
      [join(globalDir, 'provider-keys.json'), 'global-sentinel'],
    ]
    for (const [path, sentinel] of checks) {
      const text = await readFile(path, 'utf-8')
      expect(isSealedEnvelope(JSON.parse(text))).toBe(true)
      expect(text).not.toContain(sentinel)
      if (platform() !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o600)
      }
    }
    if (platform() !== 'win32') {
      expect((await stat(configDir)).mode & 0o777).toBe(0o700)
      expect((await stat(home)).mode & 0o777).toBe(0o700)
    }
  })

  it('is idempotent: a second run leaves already-sealed bytes unchanged', async () => {
    await writeFile(join(configDir, 'crypto.json'), JSON.stringify({ provider: { type: 'none' } }))
    const { migrateSealSecretConfig } = await loadMigration()
    await migrateSealSecretConfig(context())
    const first = await readFile(join(configDir, 'crypto.json'), 'utf-8')
    await migrateSealSecretConfig(context())
    expect(await readFile(join(configDir, 'crypto.json'), 'utf-8')).toBe(first)
  })

  it('chmods an existing sealed file to 0600 without re-encrypting it', async () => {
    if (platform() === 'win32') return
    const { migrateSealSecretConfig, seal, isSealedEnvelope } = await loadMigration()
    const path = join(configDir, 'market-data.json')
    await writeFile(path, JSON.stringify(await seal({ providerKeys: { fmp: 'k' } }), null, 2), { mode: 0o644 })
    const before = await readFile(path, 'utf-8')
    await migrateSealSecretConfig(context())
    expect(isSealedEnvelope(JSON.parse(await readFile(path, 'utf-8')))).toBe(true)
    expect(await readFile(path, 'utf-8')).toBe(before)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('seals plaintext secret copies left in old migration snapshots', async () => {
    const snapshotConfig = join(home, 'data', '_backup', '2026-01-01T00-00-00-000Z-pre-0044', 'config')
    await mkdir(snapshotConfig, { recursive: true })
    await writeFile(
      join(snapshotConfig, 'ai-provider-manager.json'),
      JSON.stringify({ credentials: { 'openai-1': { apiKey: 'snapshot-sentinel' } } }),
    )
    const { migrateSealSecretConfig, isSealedEnvelope } = await loadMigration()
    await migrateSealSecretConfig(context())
    const text = await readFile(join(snapshotConfig, 'ai-provider-manager.json'), 'utf-8')
    expect(isSealedEnvelope(JSON.parse(text))).toBe(true)
    expect(text).not.toContain('snapshot-sentinel')
  })

  it('leaves malformed JSON untouched instead of destroying it', async () => {
    const path = join(configDir, 'securities.json')
    await writeFile(path, 'not json{{{')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { migrateSealSecretConfig } = await loadMigration()
      await expect(migrateSealSecretConfig(context())).resolves.toBeUndefined()
      expect(await readFile(path, 'utf-8')).toBe('not json{{{')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'))
    } finally {
      warn.mockRestore()
    }
  })
})
