import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { relocateLegacyData } from './relocate-data.js'

describe('relocateLegacyData', () => {
  let legacyRoot: string
  let newRoot: string

  beforeEach(async () => {
    legacyRoot = await mkdtemp(join(tmpdir(), 'oa-legacy-'))
    newRoot = await mkdtemp(join(tmpdir(), 'oa-new-'))
    // mkdtemp creates newRoot itself; relocate must tolerate it existing
    // while <newRoot>/data does not.
  })

  afterEach(async () => {
    await rm(legacyRoot, { recursive: true, force: true })
    await rm(newRoot, { recursive: true, force: true })
  })

  async function seedLegacyStore(): Promise<void> {
    await mkdir(join(legacyRoot, 'data', 'config'), { recursive: true })
    await writeFile(join(legacyRoot, 'data', 'config', 'accounts.json'), '[{"id":"x"}]')
  }

  it('moves the legacy data dir into the new root', async () => {
    await seedLegacyStore()
    const result = await relocateLegacyData(legacyRoot, newRoot)
    expect(result).toBe('moved')
    expect(await readFile(join(newRoot, 'data', 'config', 'accounts.json'), 'utf8')).toBe('[{"id":"x"}]')
    expect(existsSync(join(legacyRoot, 'data'))).toBe(false)
    expect(existsSync(join(legacyRoot, 'DATA-MOVED.txt'))).toBe(true)
  })

  it('repairs a group-readable destination key before removing the legacy copy', async () => {
    const key = Buffer.alloc(32, 9).toString('base64')
    await writeFile(join(legacyRoot, 'sealing.key'), `${key}\n`, { mode: 0o600 })
    await writeFile(join(newRoot, 'sealing.key'), `${key}\n`, { mode: 0o644 })

    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('skipped')
    expect(existsSync(join(legacyRoot, 'sealing.key'))).toBe(false)
    if (process.platform !== 'win32') {
      expect((await stat(join(newRoot, 'sealing.key'))).mode & 0o777).toBe(0o600)
    }
  })

  it('no-ops when the legacy and new roots are the same', async () => {
    await writeFile(join(legacyRoot, 'sealing.key'), `${Buffer.alloc(32, 7).toString('base64')}\n`)
    expect(await relocateLegacyData(legacyRoot, legacyRoot)).toBe('skipped')
    expect(existsSync(join(legacyRoot, 'sealing.key'))).toBe(true)
  })

  it('no-ops when there is no legacy store', async () => {
    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('skipped')
    expect(existsSync(join(newRoot, 'data'))).toBe(false)
  })

  it('never clobbers an existing new store (new store wins)', async () => {
    await seedLegacyStore()
    await mkdir(join(newRoot, 'data', 'config'), { recursive: true })
    await writeFile(join(newRoot, 'data', 'config', 'accounts.json'), '[{"id":"newer"}]')

    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('skipped')
    expect(await readFile(join(newRoot, 'data', 'config', 'accounts.json'), 'utf8')).toBe('[{"id":"newer"}]')
    // legacy store untouched — user can still inspect/merge manually
    expect(await readFile(join(legacyRoot, 'data', 'config', 'accounts.json'), 'utf8')).toBe('[{"id":"x"}]')
  })

  it('moves the legacy machine key and provider-key store beside the data', async () => {
    await seedLegacyStore()
    await writeFile(join(legacyRoot, 'sealing.key'), 'key-material\n')
    await mkdir(join(legacyRoot, 'state'), { recursive: true })
    await writeFile(join(legacyRoot, 'state', 'sealing.key.cred'), 'cred-material\n')
    await writeFile(join(legacyRoot, 'provider-keys.json'), '{"x":1}\n')

    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('moved')
    expect(await readFile(join(newRoot, 'sealing.key'), 'utf8')).toBe('key-material\n')
    expect(await readFile(join(newRoot, 'state', 'sealing.key.cred'), 'utf8')).toBe('cred-material\n')
    expect(await readFile(join(newRoot, 'provider-keys.json'), 'utf8')).toBe('{"x":1}\n')
    expect(existsSync(join(legacyRoot, 'sealing.key'))).toBe(false)
  })

  it('skips sealed data when the destination key differs', async () => {
    await seedLegacyStore()
    await writeFile(join(legacyRoot, 'sealing.key'), `${Buffer.alloc(32, 1).toString('base64')}\n`)
    await writeFile(join(newRoot, 'sealing.key'), `${Buffer.alloc(32, 2).toString('base64')}\n`)

    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('skipped')
    // The legacy data must remain untouched for an explicit merge.
    expect(await readFile(join(legacyRoot, 'data', 'config', 'accounts.json'), 'utf8')).toBe('[{"id":"x"}]')
    expect(existsSync(join(newRoot, 'data'))).toBe(false)
    expect(existsSync(join(legacyRoot, 'DATA-NOT-MOVED.txt'))).toBe(true)
    expect(existsSync(join(legacyRoot, 'KEY-NOT-MOVED.txt'))).toBe(true)
  })

  it('refuses a destination key that is a symlink to the legacy key', async () => {
    await seedLegacyStore()
    const key = Buffer.alloc(32, 8).toString('base64')
    await writeFile(join(legacyRoot, 'sealing.key'), `${key}\n`, { mode: 0o600 })
    await symlink(join(legacyRoot, 'sealing.key'), join(newRoot, 'sealing.key'))

    await expect(relocateLegacyData(legacyRoot, newRoot)).rejects.toThrow(/symbolic link/)
    expect(await readFile(join(legacyRoot, 'data', 'config', 'accounts.json'), 'utf8')).toBe('[{"id":"x"}]')
    expect(existsSync(join(newRoot, 'data'))).toBe(false)
  })

  it('resumes a data move after a crash that moved only the key', async () => {
    await seedLegacyStore()
    await writeFile(join(newRoot, 'sealing.key'), `${Buffer.alloc(32, 7).toString('base64')}\n`)
    await writeFile(join(legacyRoot, 'KEY-MOVED.txt'), 'moved\n')

    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('moved')
    expect(existsSync(join(newRoot, 'data', 'config', 'accounts.json'))).toBe(true)
  })

  it('moves the fingerprint beside the key', async () => {
    await writeFile(join(legacyRoot, 'sealing.key'), `${Buffer.alloc(32, 3).toString('base64')}\n`, { mode: 0o600 })
    await mkdir(join(legacyRoot, 'state'), { recursive: true })
    await writeFile(join(legacyRoot, 'state', 'sealing.key.fp'), `${'a'.repeat(64)}\n`, { mode: 0o600 })

    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('moved')
    expect(await readFile(join(newRoot, 'state', 'sealing.key.fp'), 'utf8')).toBe(`${'a'.repeat(64)}\n`)
    expect(existsSync(join(legacyRoot, 'state', 'sealing.key.fp'))).toBe(false)
  })

  it('writes a provider-key marker instead of moving sealed data under a different key', async () => {
    await seedLegacyStore()
    await writeFile(join(legacyRoot, 'sealing.key'), `${Buffer.alloc(32, 1).toString('base64')}\n`)
    await writeFile(join(newRoot, 'sealing.key'), `${Buffer.alloc(32, 2).toString('base64')}\n`)
    await writeFile(join(legacyRoot, 'provider-keys.json'), '{"x":1}\n')

    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('skipped')
    expect(existsSync(join(legacyRoot, 'provider-keys.json'))).toBe(true)
    expect(existsSync(join(legacyRoot, 'PROVIDER-KEYS-NOT-MOVED.txt'))).toBe(true)
  })

  it('still moves the key when the new data store already exists', async () => {
    await seedLegacyStore()
    await writeFile(join(legacyRoot, 'sealing.key'), 'key-material\n')
    await mkdir(join(newRoot, 'data'), { recursive: true })

    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('moved')
    expect(await readFile(join(newRoot, 'sealing.key'), 'utf8')).toBe('key-material\n')
    expect(existsSync(join(legacyRoot, 'sealing.key'))).toBe(false)
  })

  it('removes a redundant legacy plaintext key when the destination key matches', async () => {
    const key = Buffer.alloc(32, 4).toString('base64')
    await writeFile(join(legacyRoot, 'sealing.key'), `${key}\n`)
    await writeFile(join(newRoot, 'sealing.key'), `${key}\n`)

    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('skipped')
    expect(existsSync(join(legacyRoot, 'sealing.key'))).toBe(false)
    expect(await readFile(join(newRoot, 'sealing.key'), 'utf8')).toBe(`${key}\n`)
  })

  it('is idempotent across repeated boots', async () => {
    await seedLegacyStore()
    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('moved')
    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('skipped')
  })

  it('sweeps a stale partial copy from a crashed previous run', async () => {
    await seedLegacyStore()
    await mkdir(join(newRoot, '.data.relocating'), { recursive: true })
    await writeFile(join(newRoot, '.data.relocating', 'partial.json'), '{}')

    expect(await relocateLegacyData(legacyRoot, newRoot)).toBe('moved')
    expect(existsSync(join(newRoot, '.data.relocating'))).toBe(false)
    expect(existsSync(join(newRoot, 'data', 'config', 'accounts.json'))).toBe(true)
  })
})
