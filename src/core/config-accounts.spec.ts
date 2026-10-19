import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'

/**
 * readUTAsConfig / writeUTAsConfig round-trip through the sealed at-rest
 * format. config.ts resolves CONFIG_DIR at import, so each test re-imports
 * under a fresh temp OPENALICE_HOME (global-provider-keys.spec.ts pattern).
 */
let home: string
let configDir: string
let savedHome: string | undefined
let savedBackend: string | undefined

async function loadConfigModule() {
  vi.resetModules()
  process.env['OPENALICE_HOME'] = home
  process.env['OPENALICE_SEALING_BACKEND'] = 'file'
  const config = await import('./config.js')
  const sealing = await import('./sealing.js')
  return { config, sealing }
}

beforeEach(async () => {
  savedHome = process.env['OPENALICE_HOME']
  savedBackend = process.env['OPENALICE_SEALING_BACKEND']
  home = await mkdtemp(join(tmpdir(), 'oa-accounts-'))
  configDir = join(home, 'data', 'config')
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['OPENALICE_HOME']
  else process.env['OPENALICE_HOME'] = savedHome
  if (savedBackend === undefined) delete process.env['OPENALICE_SEALING_BACKEND']
  else process.env['OPENALICE_SEALING_BACKEND'] = savedBackend
  vi.resetModules()
  await rm(home, { recursive: true, force: true })
})

const ACCOUNT = {
  id: 'okx-test',
  presetId: 'okx',
  presetConfig: { apiKey: 'plain-api-key', secret: 'plain-secret' },
}

describe('UTA accounts at-rest sealing', () => {
  it('write → sealed envelope on disk (0600), read → original records', async () => {
    const { config, sealing } = await loadConfigModule()
    await config.writeUTAsConfig([ACCOUNT] as never)

    const path = join(configDir, 'accounts.json')
    const onDisk = JSON.parse(await readFile(path, 'utf-8'))
    expect(sealing.isSealedEnvelope(onDisk)).toBe(true)
    expect(JSON.stringify(onDisk)).not.toContain('plain-secret')
    if (platform() !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }

    const back = await config.readUTAsConfig()
    expect(back).toHaveLength(1)
    expect(back[0].id).toBe('okx-test')
    expect(back[0].presetConfig).toEqual(ACCOUNT.presetConfig)
  })

  it('first run seeds a sealed empty store and the sealing key', async () => {
    const { config } = await loadConfigModule()
    expect(await config.readUTAsConfig()).toEqual([])
    expect(existsSync(join(configDir, 'accounts.json'))).toBe(true)
    expect(existsSync(join(home, 'sealing.key'))).toBe(true)
  })

  it('still reads a legacy plaintext array (pre-0009 store)', async () => {
    const { config } = await loadConfigModule()
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'accounts.json'), JSON.stringify([ACCOUNT], null, 2))

    const back = await config.readUTAsConfig()
    expect(back).toHaveLength(1)
    expect(back[0].presetConfig['apiKey']).toBe('plain-api-key')
  })

  it('fails closed without deleting ciphertext when the sealing key is missing', async () => {
    const { config, sealing } = await loadConfigModule()
    await config.writeUTAsConfig([ACCOUNT] as never)
    await rm(sealing.sealingKeyPath()) // simulate data/ copied to a machine without the key

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(config.readUTAsConfig()).rejects.toThrow(/machine key|does not exist/)
    } finally {
      errSpy.mockRestore()
    }

    // The ciphertext stays exactly where it was; no quarantine and no empty
    // reseed, so restoring the key recovers the accounts.
    const files = await readdir(configDir)
    expect(files.some((f) => f.startsWith('accounts.json.sealed-unreadable-'))).toBe(false)
    const onDisk = JSON.parse(await readFile(join(configDir, 'accounts.json'), 'utf-8'))
    expect(sealing.isSealedEnvelope(onDisk)).toBe(true)
  })

  it('quarantines an unreadable sealed store when the key is present but wrong', async () => {
    const { config, sealing } = await loadConfigModule()
    await config.writeUTAsConfig([ACCOUNT] as never)
    await writeFile(sealing.sealingKeyPath(), `${Buffer.alloc(32, 9).toString('base64')}\n`, { mode: 0o600 })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await config.readUTAsConfig()).toEqual([])
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('could not be unsealed'))
    } finally {
      errSpy.mockRestore()
    }

    // Original preserved under a quarantine name, fresh sealed store seeded.
    const files = await readdir(configDir)
    expect(files.some((f) => f.startsWith('accounts.json.sealed-unreadable-'))).toBe(true)
    const reseeded = JSON.parse(await readFile(join(configDir, 'accounts.json'), 'utf-8'))
    expect(sealing.isSealedEnvelope(reseeded)).toBe(true)
    // A new key was minted by the reseed, so subsequent reads work again.
    expect(await config.readUTAsConfig()).toEqual([])
  })
})
