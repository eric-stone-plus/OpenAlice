/**
 * User-global provider keys — merge-under + mirror-on-save semantics.
 *
 * Fully sandboxed: OPENALICE_HOME points the instance data dir and
 * OPENALICE_GLOBAL_DIR the user-global dir at temp folders, and config.js
 * is imported DYNAMICALLY after the env is set (its CONFIG_DIR is resolved
 * at module load). The real data/config and ~/.openalice are never touched
 * — an earlier version of this spec wrote through to the developer's real
 * config; don't regress that.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

let dataHome: string
let globalDir: string
let config: typeof import('./config.js')
let sealing: typeof import('./sealing.js')

beforeAll(async () => {
  dataHome = await mkdtemp(join(tmpdir(), 'oa-home-'))
  globalDir = await mkdtemp(join(tmpdir(), 'oa-global-'))
  process.env['OPENALICE_HOME'] = dataHome
  process.env['OPENALICE_GLOBAL_DIR'] = globalDir
  // Import AFTER env is set — paths.ts/config.ts resolve their roots at load.
  config = await import('./config.js')
  sealing = await import('./sealing.js')
})

afterAll(async () => {
  delete process.env['OPENALICE_HOME']
  delete process.env['OPENALICE_GLOBAL_DIR']
  await rm(dataHome, { recursive: true, force: true })
  await rm(globalDir, { recursive: true, force: true })
})

async function seedGlobal(keys: Record<string, string>) {
  await writeFile(join(globalDir, 'provider-keys.json'), JSON.stringify(keys))
}

async function seedLocal(providerKeys: Record<string, string>) {
  await mkdir(join(dataHome, 'data', 'config'), { recursive: true })
  await writeFile(
    join(dataHome, 'data', 'config', 'market-data.json'),
    JSON.stringify({ providerKeys }),
  )
}

describe('global provider keys', () => {
  it('fills gaps from the global file; the instance value wins per key', async () => {
    await seedGlobal({ fred: 'global-fred', fmp: 'global-fmp' })
    await seedLocal({ fmp: 'local-fmp' })
    const cfg = await config.readMarketDataConfig()
    expect(cfg.providerKeys.fred).toBe('global-fred') // gap filled
    expect(cfg.providerKeys.fmp).toBe('local-fmp')    // local wins
  })

  it('mirror-on-save: non-empty sets, explicit empty clears, absent untouched', async () => {
    await seedGlobal({ fred: 'old-fred', eia: 'old-eia', tiingo: 'old-tiingo' })
    await seedLocal({})
    await config.writeConfigSection('marketData', {
      providerKeys: { fred: 'new-fred', eia: '' }, // tiingo absent from payload
    })
    const raw = JSON.parse(await readFile(join(globalDir, 'provider-keys.json'), 'utf-8'))
    const global = sealing.isSealedEnvelope(raw) ? await sealing.unseal(raw) : raw
    expect(global.fred).toBe('new-fred')      // updated
    expect(global.eia).toBeUndefined()        // explicitly cleared → cleared globally
    expect(global.tiingo).toBe('old-tiingo')  // absent from payload → survives
  })

  it('missing/corrupt global file degrades to no-op', async () => {
    await writeFile(join(globalDir, 'provider-keys.json'), 'not json{{{')
    await seedLocal({ fmp: 'local-fmp' })
    const cfg = await config.readMarketDataConfig()
    expect(cfg.providerKeys.fmp).toBe('local-fmp')
    expect(cfg.providers.equity).toBeTruthy()
  })

  it('refuses to overwrite a corrupt global file on save', async () => {
    const corrupt = 'not json{{{'
    await writeFile(join(globalDir, 'provider-keys.json'), corrupt)
    await seedLocal({ fmp: 'keep-me' })
    const localPath = join(dataHome, 'data', 'config', 'market-data.json')
    const localBefore = await readFile(localPath, 'utf8')
    await expect(config.writeConfigSection('marketData', {
      providerKeys: { fmp: 'new-fmp' },
    })).rejects.toThrow()
    expect(await readFile(join(globalDir, 'provider-keys.json'), 'utf8')).toBe(corrupt)
    // The strict global read must abort before the local store is touched.
    expect(await readFile(localPath, 'utf8')).toBe(localBefore)
  })

  it('refuses to overwrite a sealed global file it cannot unseal', async () => {
    await seedLocal({})
    const envelope = await sealing.seal({ fred: 'old-fred' })
    // Corrupt the authenticated ciphertext; the write path must not quarantine
    // it and silently replace the original path with a fresh store.
    envelope.data = `${envelope.data.startsWith('A') ? 'B' : 'A'}${envelope.data.slice(1)}`
    const bytes = JSON.stringify(envelope)
    await writeFile(join(globalDir, 'provider-keys.json'), bytes)
    await expect(config.writeConfigSection('marketData', {
      providerKeys: { fmp: 'new-fmp' },
    })).rejects.toThrow(/refusing to overwrite/)
    expect(await readFile(join(globalDir, 'provider-keys.json'), 'utf8')).toBe(bytes)
  })
})
