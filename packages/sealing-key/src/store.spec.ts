import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearSealingKeyCache,
  loadOrCreateKey,
  readKey,
  sealAt,
  sealingKeyCredentialPath,
  sealingKeyFingerprintPath,
  sealingKeyPath,
  SealingBackendUnavailableError,
  SealingKeyConflictError,
  unsealAt,
} from './index.js'

function hasSystemdCreds(): boolean {
  try {
    execFileSync('systemd-creds', ['--version'], { stdio: 'ignore' })
    return process.platform === 'linux'
  } catch {
    return false
  }
}

const systemdAvailable = hasSystemdCreds()

describe('file backend', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'oa-sealing-file-'))
  })

  afterEach(async () => {
    clearSealingKeyCache()
    await rm(home, { recursive: true, force: true })
  })

  it('creates an owner-only file key and reads it back', async () => {
    const env = { OPENALICE_SEALING_BACKEND: 'file' }
    const key = await loadOrCreateKey(home, env)
    expect(key).toHaveLength(32)
    expect((await stat(sealingKeyPath(home))).mode & 0o777).toBe(0o600)
    expect(existsSync(sealingKeyCredentialPath(home))).toBe(false)
    expect((await readKey(home, env))?.equals(key)).toBe(true)
  })

  it('sweeps stale plaintext key temps on read', async () => {
    const stale = join(home, 'sealing.key.999.00000000-0000-4000-8000-000000000000.tmp')
    await writeFile(stale, 'key-material', { mode: 0o600 })
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(stale, old, old)
    await readKey(home, { OPENALICE_SEALING_BACKEND: 'file' })
    expect(existsSync(stale)).toBe(false)
  })

  it('leaves a user backup with a similar name alone', async () => {
    const backup = join(home, 'sealing.key.2024.backup.tmp')
    await writeFile(backup, 'user-backup', { mode: 0o600 })
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(backup, old, old)
    await readKey(home, { OPENALICE_SEALING_BACKEND: 'file' })
    expect(existsSync(backup)).toBe(true)
  })

  it('removes a dead-pid temp after the cross-host grace period', async () => {
    const dead = join(home, 'sealing.key.999999.00000000-0000-4000-8000-000000000001.tmp')
    await writeFile(dead, 'key-material', { mode: 0o600 })
    const old = new Date(Date.now() - 30_000)
    await utimes(dead, old, old)
    await readKey(home, { OPENALICE_SEALING_BACKEND: 'file' })
    expect(existsSync(dead)).toBe(false)
  })

  it('sweeps a stale plaintext local-token temp', async () => {
    const auth = join(home, 'auth')
    await mkdir(auth, { recursive: true })
    const stale = join(auth, 'local.token.999999.abcdef123456.tmp')
    await writeFile(stale, 'oa1_secret', { mode: 0o600 })
    const old = new Date(Date.now() - 30_000)
    await utimes(stale, old, old)
    await readKey(home, { OPENALICE_SEALING_BACKEND: 'file' })
    expect(existsSync(stale)).toBe(false)
  })

  it('keeps a temp belonging to a live process until it is old', async () => {
    const live = join(home, `sealing.key.${process.pid}.00000000-0000-4000-8000-000000000002.tmp`)
    await writeFile(live, 'key-material', { mode: 0o600 })
    await readKey(home, { OPENALICE_SEALING_BACKEND: 'file' })
    expect(existsSync(live)).toBe(true)
  })

  it('reports an interrupted empty key claim instead of minting a new key', async () => {
    await writeFile(sealingKeyPath(home), '', { mode: 0o600 })
    await expect(readKey(home, { OPENALICE_SEALING_BACKEND: 'file' }))
      .rejects.toThrow(/is empty; another OpenAlice process may be creating it/)
    expect((await stat(sealingKeyPath(home))).size).toBe(0)
  })

  it('recovers a stale empty credential claim', async () => {
    await mkdir(join(home, 'state'), { recursive: true })
    const path = sealingKeyCredentialPath(home)
    await writeFile(path, '', { mode: 0o600 })
    const old = new Date(Date.now() - 60_000)
    await utimes(path, old, old)
    await expect(readKey(home, { OPENALICE_SEALING_BACKEND: 'systemd-creds' }))
      .resolves.toBeNull()
  })

  it('recovers a stale zero-length key claim', async () => {
    const path = sealingKeyPath(home)
    await writeFile(path, '', { mode: 0o600 })
    const old = new Date(Date.now() - 60_000)
    await utimes(path, old, old)
    const key = await loadOrCreateKey(home, { OPENALICE_SEALING_BACKEND: 'file' })
    expect(key).toHaveLength(32)
    expect((await stat(path)).size).toBeGreaterThan(0)
  })

  it('clears a claim left by a dead process and mints a new key', async () => {
    const path = sealingKeyPath(home)
    await writeFile(path, 'openalice-sealing-claim 999999\n', { mode: 0o600 })
    const old = new Date(Date.now() - 60_000)
    await utimes(path, old, old)
    const key = await loadOrCreateKey(home, { OPENALICE_SEALING_BACKEND: 'file' })
    expect(key.length).toBeGreaterThan(0)
    expect((await stat(path)).size).toBeGreaterThan(0)
    expect((await readdir(home)).some((name) => name.startsWith('sealing.key.dead-claim-'))).toBe(false)
  })

  it('recovers an aged claim even when its pid is still alive', async () => {
    const path = sealingKeyPath(home)
    await writeFile(path, `openalice-sealing-claim ${process.pid}\n`, { mode: 0o600 })
    const old = new Date(Date.now() - 60_000)
    await utimes(path, old, old)
    // A pid from another PID namespace or a reused pid cannot be trusted;
    // recovery is bounded by claim age instead of pid liveness.
    const key = await loadOrCreateKey(home, { OPENALICE_SEALING_BACKEND: 'file' })
    expect(key).toHaveLength(32)
    expect((await readdir(home)).some((name) => name.startsWith('sealing.key.dead-claim-'))).toBe(false)
  })

  it('refuses file mode when an encrypted credential already exists', async () => {
    await mkdir(join(home, 'state'), { recursive: true })
    await writeFile(sealingKeyCredentialPath(home), 'credential', { mode: 0o600 })
    await expect(readKey(home, { OPENALICE_SEALING_BACKEND: 'file' }))
      .rejects.toBeInstanceOf(SealingKeyConflictError)
  })

  it('falls back to a valid legacy key when systemd-creds is unavailable', async () => {
    const key = Buffer.alloc(32, 9)
    await writeFile(sealingKeyPath(home), `${key.toString('base64')}\n`, { mode: 0o600 })
    const migrated = await readKey(home, {
      OPENALICE_SEALING_BACKEND: 'auto',
      OPENALICE_SYSTEMD_CREDS: join(home, 'missing-systemd-creds'),
    })
    expect(migrated?.equals(key)).toBe(true)
    expect(existsSync(sealingKeyPath(home))).toBe(true)
  })

  it('rejects an unknown backend instead of silently using auto', async () => {
    await expect(readKey(home, { OPENALICE_SEALING_BACKEND: 'systemd' }))
      .rejects.toThrow(/invalid OPENALICE_SEALING_BACKEND/)
  })
})

describe.skipIf(process.platform === 'win32')('credential fallback fingerprint', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'oa-sealing-fallback-'))
    await mkdir(join(home, 'state'), { recursive: true })
    await writeFile(join(home, 'state', 'sealing.key.cred'), 'not-a-credential', { mode: 0o600 })
    await writeFile(join(home, 'fake-systemd-creds'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await chmod(join(home, 'fake-systemd-creds'), 0o755)
  })

  afterEach(async () => {
    clearSealingKeyCache()
    await rm(home, { recursive: true, force: true })
  })

  function fingerprint(key: Buffer): string {
    return createHash('sha256').update(key).digest('hex')
  }

  it('trusts a legacy key only when it matches the recorded fingerprint', async () => {
    const key = Buffer.alloc(32, 4)
    await writeFile(sealingKeyPath(home), `${key.toString('base64')}\n`, { mode: 0o600 })
    await writeFile(sealingKeyFingerprintPath(home), `${fingerprint(key)}\n`, { mode: 0o600 })
    const read = await readKey(home, {
      OPENALICE_SEALING_BACKEND: 'auto',
      OPENALICE_SYSTEMD_CREDS: join(home, 'fake-systemd-creds'),
    })
    expect(read?.equals(key)).toBe(true)
  })

  it('refuses a stale legacy key that does not match the credential fingerprint', async () => {
    const key = Buffer.alloc(32, 5)
    await writeFile(sealingKeyPath(home), `${key.toString('base64')}\n`, { mode: 0o600 })
    await writeFile(sealingKeyFingerprintPath(home), `${fingerprint(Buffer.alloc(32, 6))}\n`, { mode: 0o600 })
    await expect(readKey(home, {
      OPENALICE_SEALING_BACKEND: 'auto',
      OPENALICE_SYSTEMD_CREDS: join(home, 'fake-systemd-creds'),
    })).rejects.toBeInstanceOf(SealingKeyConflictError)
  })

  it('refuses a legacy fallback when the credential has no fingerprint', async () => {
    const key = Buffer.alloc(32, 7)
    await writeFile(sealingKeyPath(home), `${key.toString('base64')}\n`, { mode: 0o600 })
    await expect(readKey(home, {
      OPENALICE_SEALING_BACKEND: 'auto',
      OPENALICE_SYSTEMD_CREDS: join(home, 'fake-systemd-creds'),
    })).rejects.toThrow(/is missing/)
  })
})

describe.skipIf(!systemdAvailable)('systemd-creds key store', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'oa-sealing-store-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('creates only the encrypted credential, never the plaintext file', async () => {
    const key = await loadOrCreateKey(home, { OPENALICE_SEALING_BACKEND: 'systemd-creds' })
    expect(key).toHaveLength(32)
    expect(existsSync(sealingKeyPath(home))).toBe(false)
    expect(existsSync(sealingKeyCredentialPath(home))).toBe(true)
    expect(existsSync(sealingKeyFingerprintPath(home))).toBe(true)
    expect((await stat(sealingKeyCredentialPath(home))).mode & 0o777).toBe(0o600)
    const again = await readKey(home, { OPENALICE_SEALING_BACKEND: 'systemd-creds' })
    expect(again?.equals(key)).toBe(true)
  })

  it('round-trips a sealed value', async () => {
    const env = { OPENALICE_SEALING_BACKEND: 'systemd-creds' }
    const envelope = await sealAt(home, { secret: 'x' }, env)
    await expect(unsealAt(home, envelope, env)).resolves.toEqual({ secret: 'x' })
  })

  it('migrates a legacy plaintext key and removes it', async () => {
    const key = Buffer.alloc(32, 7)
    await writeFile(sealingKeyPath(home), `${key.toString('base64')}\n`, { mode: 0o600 })
    const migrated = await readKey(home, { OPENALICE_SEALING_BACKEND: 'auto' })
    expect(migrated?.equals(key)).toBe(true)
    expect(existsSync(sealingKeyPath(home))).toBe(false)
    expect(existsSync(sealingKeyCredentialPath(home))).toBe(true)
  })

  it('read-only read leaves a legacy key in place', async () => {
    const key = Buffer.alloc(32, 5)
    await writeFile(sealingKeyPath(home), `${key.toString('base64')}\n`, { mode: 0o600 })
    const read = await readKey(home, { OPENALICE_SEALING_BACKEND: 'auto' }, { migrate: false })
    expect(read?.equals(key)).toBe(true)
    expect(existsSync(sealingKeyPath(home))).toBe(true)
    expect(existsSync(sealingKeyCredentialPath(home))).toBe(false)
  })

  it('refuses to choose when legacy and credential keys differ', async () => {
    const legacy = Buffer.alloc(32, 1)
    await loadOrCreateKey(home, { OPENALICE_SEALING_BACKEND: 'systemd-creds' })
    await writeFile(sealingKeyPath(home), `${legacy.toString('base64')}\n`, { mode: 0o600 })
    await expect(readKey(home, { OPENALICE_SEALING_BACKEND: 'auto' }))
      .rejects.toBeInstanceOf(SealingKeyConflictError)
  })

  it('fails closed on a corrupt credential instead of creating a new key', async () => {
    await mkdir(join(home, 'state'), { recursive: true })
    await writeFile(sealingKeyCredentialPath(home), 'not-a-credential', { mode: 0o600 })
    await expect(readKey(home, { OPENALICE_SEALING_BACKEND: 'auto' }))
      .rejects.toBeInstanceOf(SealingBackendUnavailableError)
    expect(existsSync(sealingKeyPath(home))).toBe(false)
  })
})
