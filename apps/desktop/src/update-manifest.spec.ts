import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertPackageIdentity,
  bindVerifiedRelease,
  samePackageIdentity,
  UpdateVerificationError,
  verifyDownloadedPackage,
  verifyDownloadedPackageWithIdentity,
  verifyUpdateManifest,
  type LinuxUpdateManifest,
  type UpdateManifestSignature,
} from './update-manifest.js'

function fixture(overrides: Partial<LinuxUpdateManifest> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const packageBytes = Buffer.from('signed-rpm-payload')
  const manifest: LinuxUpdateManifest = {
    schema: 1,
    product: 'open-alice',
    appId: 'com.traderalice.openalice',
    channel: 'beta',
    version: '0.95.1-beta',
    sequence: 2,
    publishedAt: '2026-10-19T00:00:00.000Z',
    expiresAt: '2026-11-19T00:00:00.000Z',
    fileName: 'open-alice-0.95.1-beta.x86_64.rpm',
    fileSha512: createHash('sha512').update(packageBytes).digest('base64'),
    fileSize: packageBytes.byteLength,
    releaseNotesUrl: 'https://github.com/TraderAlice/OpenAlice/releases/tag/v0.95.1-beta',
    ...overrides,
  }
  const bytes = Buffer.from(JSON.stringify(manifest))
  const signature: UpdateManifestSignature = {
    keyId: 'release-2026',
    algorithm: 'ed25519',
    value: sign(null, bytes, privateKey).toString('base64'),
  }
  return {
    manifest,
    bytes,
    signature,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    packageBytes,
    privateKey,
  }
}

const expected = { product: 'open-alice' as const, appId: 'com.traderalice.openalice', channel: 'beta' }
const now = new Date('2026-10-20T00:00:00.000Z')

describe('verifyUpdateManifest', () => {
  it('accepts a correctly signed, current manifest', () => {
    const f = fixture()
    expect(verifyUpdateManifest({
      manifestBytes: f.bytes,
      signature: f.signature,
      publicKeyPem: f.publicKeyPem,
      expectedKeyId: 'release-2026',
      expected,
      now,
    })).toEqual(f.manifest)
  })

  it('rejects a tampered manifest', () => {
    const f = fixture()
    const tampered = Buffer.from(f.bytes.toString('utf8').replace('0.95.1-beta', '0.95.2-beta'))
    expect(() => verifyUpdateManifest({
      manifestBytes: tampered,
      signature: f.signature,
      publicKeyPem: f.publicKeyPem,
      expectedKeyId: 'release-2026',
      expected,
      now,
    })).toThrow(UpdateVerificationError)
  })

  it('rejects an unknown key id and a signature from another key', () => {
    const f = fixture()
    expect(() => verifyUpdateManifest({
      manifestBytes: f.bytes,
      signature: { ...f.signature, keyId: 'attacker' },
      publicKeyPem: f.publicKeyPem,
      expectedKeyId: 'release-2026',
      expected,
      now,
    })).toThrow(/untrusted key/)
    const other = generateKeyPairSync('ed25519')
    expect(() => verifyUpdateManifest({
      manifestBytes: f.bytes,
      signature: f.signature,
      publicKeyPem: other.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      expectedKeyId: 'release-2026',
      expected,
      now,
    })).toThrow(/does not verify/)
  })

  it('rejects an expired manifest', () => {
    const f = fixture({ expiresAt: '2026-10-19T12:00:00.000Z' })
    expect(() => verifyUpdateManifest({
      manifestBytes: f.bytes,
      signature: f.signature,
      publicKeyPem: f.publicKeyPem,
      expectedKeyId: 'release-2026',
      expected,
      now,
    })).toThrow(/validity window/)
  })

  it('rejects malformed signature material and an invalid clock', () => {
    const f = fixture()
    expect(() => verifyUpdateManifest({
      manifestBytes: f.bytes,
      signature: { ...f.signature, value: 'not-base64' },
      publicKeyPem: f.publicKeyPem,
      expectedKeyId: 'release-2026',
      expected,
      now,
    })).toThrow(/Ed25519 base64/)
    expect(() => verifyUpdateManifest({
      manifestBytes: f.bytes,
      signature: f.signature,
      publicKeyPem: f.publicKeyPem,
      expectedKeyId: 'release-2026',
      expected,
      now: new Date('not-a-date'),
    })).toThrow(/verification time/)
  })

  it('rejects unsafe release URLs and path-like file names', () => {
    for (const overrides of [
      { releaseNotesUrl: 'http://github.com/TraderAlice/OpenAlice/releases' },
      { releaseNotesUrl: 'https://user:pass@github.com/TraderAlice/OpenAlice/releases' },
      { fileName: '../open-alice.rpm' },
    ]) {
      const f = fixture(overrides)
      expect(() => verifyUpdateManifest({
        manifestBytes: f.bytes,
        signature: f.signature,
        publicKeyPem: f.publicKeyPem,
        expectedKeyId: 'release-2026',
        expected,
        now,
      })).toThrow(UpdateVerificationError)
    }
  })

  it('rejects a manifest for another app or channel', () => {
    const f = fixture({ channel: 'stable' })
    expect(() => verifyUpdateManifest({
      manifestBytes: f.bytes,
      signature: f.signature,
      publicKeyPem: f.publicKeyPem,
      expectedKeyId: 'release-2026',
      expected,
      now,
    })).toThrow(/identity/)
  })
})

describe('bindVerifiedRelease', () => {
  it('accepts matching feed metadata and rejects a hash swap', () => {
    const f = fixture()
    expect(() => bindVerifiedRelease(f.manifest, {
      version: f.manifest.version,
      files: [{ url: f.manifest.fileName, sha512: f.manifest.fileSha512, size: f.manifest.fileSize }],
    })).not.toThrow()
    expect(() => bindVerifiedRelease(f.manifest, {
      version: f.manifest.version,
      files: [{ url: f.manifest.fileName, sha512: 'A'.repeat(86) + '==', size: f.manifest.fileSize }],
    })).toThrow(/checksum/)
    expect(() => bindVerifiedRelease(f.manifest, {
      version: f.manifest.version,
      files: [null as never],
    })).toThrow(/not present/)
  })
})

describe('verifyDownloadedPackage', () => {
  it('accepts the exact signed bytes and rejects a swapped file', async () => {
    const f = fixture()
    const dir = await mkdtemp(join(tmpdir(), 'oa-update-'))
    try {
      const good = join(dir, f.manifest.fileName)
      await writeFile(good, f.packageBytes)
      await expect(verifyDownloadedPackage(f.manifest, good, dir)).resolves.toBeUndefined()

      const bad = join(dir, 'bad.rpm')
      await writeFile(bad, Buffer.from('tampered'))
      await expect(verifyDownloadedPackage(f.manifest, bad, dir))
        .rejects.toThrow(/size|hash/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a path outside the updater cache', async () => {
    const f = fixture()
    await expect(verifyDownloadedPackage(f.manifest, '/tmp/elsewhere.rpm', '/tmp/cache'))
      .rejects.toThrow(/outside/)
  })

  it('returns the identity of the exact inode that was hashed', async () => {
    const f = fixture()
    const dir = await mkdtemp(join(tmpdir(), 'oa-update-'))
    try {
      const good = join(dir, f.manifest.fileName)
      await writeFile(good, f.packageBytes)
      const identity = await verifyDownloadedPackageWithIdentity(f.manifest, good, dir)
      const current = await stat(good)
      expect(identity).toEqual({
        dev: current.dev,
        ino: current.ino,
        size: current.size,
        mtimeMs: current.mtimeMs,
        ctimeMs: current.ctimeMs,
      })
      expect(samePackageIdentity(identity, current)).toBe(true)
      expect(samePackageIdentity(identity, { ...current, ino: current.ino + 1 })).toBe(false)
      expect(samePackageIdentity(identity, { ...current, ctimeMs: current.ctimeMs + 1 })).toBe(false)

      // Same size and restored mtime, but a rewrite changes ctime. The
      // identity check must still reject it.
      await writeFile(good, Buffer.alloc(f.packageBytes.length, 0x58))
      await utimes(good, current.atimeMs / 1000, current.mtimeMs / 1000)
      const rewritten = await stat(good)
      expect(rewritten.mtimeMs).toBe(current.mtimeMs)
      expect(samePackageIdentity(identity, rewritten)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a package that changed or disappeared after verification', async () => {
    const f = fixture()
    const dir = await mkdtemp(join(tmpdir(), 'oa-update-'))
    try {
      const good = join(dir, f.manifest.fileName)
      await writeFile(good, f.packageBytes)
      const identity = await verifyDownloadedPackageWithIdentity(f.manifest, good, dir)
      expect(() => assertPackageIdentity(identity, good)).not.toThrow()

      await writeFile(good, Buffer.alloc(f.packageBytes.length, 0x58))
      expect(() => assertPackageIdentity(identity, good)).toThrow(/changed after verification/)

      await rm(good)
      expect(() => assertPackageIdentity(identity, good)).toThrow(/disappeared before handoff/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
