import { createHash, createPublicKey, verify } from 'node:crypto'
import { constants, statSync, type Stats } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export const MAX_MANIFEST_BYTES = 64 * 1024
const BASE64_64 = /^[A-Za-z0-9+/]{86}==$/
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024

export interface LinuxUpdateManifest {
  schema: 1
  product: 'open-alice'
  appId: string
  channel: string
  version: string
  sequence: number
  publishedAt: string
  expiresAt: string
  fileName: string
  fileSha512: string
  fileSize: number
  releaseNotesUrl: string
}

export interface UpdateManifestSignature {
  keyId: string
  algorithm: 'ed25519'
  value: string
}

export type UpdateVerificationFailure =
  | 'manifest-too-large'
  | 'manifest-invalid'
  | 'signature-missing'
  | 'signature-invalid'
  | 'untrusted-key'
  | 'metadata-mismatch'
  | 'package-missing'
  | 'package-unreadable'
  | 'package-size-mismatch'
  | 'package-hash-mismatch'
  | 'package-outside-cache'
  | 'package-changed'

export class UpdateVerificationError extends Error {
  constructor(readonly code: UpdateVerificationFailure, message: string) {
    super(message)
    this.name = 'UpdateVerificationError'
  }
}

/**
 * Verify a detached Ed25519 signature over the exact manifest bytes, then
 * validate the manifest's own fields. The signature is checked before any
 * untrusted field is used for a download or install decision.
 */
export function verifyUpdateManifest(input: {
  manifestBytes: Buffer
  signature: unknown
  publicKeyPem: string
  expectedKeyId: string
  expected: Pick<LinuxUpdateManifest, 'product' | 'appId' | 'channel'>
  now?: Date
}): LinuxUpdateManifest {
  if (input.manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new UpdateVerificationError('manifest-too-large', 'Update manifest exceeds 64 KiB')
  }
  const envelope = parseSignature(input.signature)
  if (envelope.keyId !== input.expectedKeyId) {
    // keyId is attacker-controlled; keep it out of log/renderer line structure.
    const shown = envelope.keyId.slice(0, 64).replace(/[^A-Za-z0-9._-]/g, '?')
    throw new UpdateVerificationError('untrusted-key', `Update manifest was signed by untrusted key ${shown}`)
  }
  if (!BASE64_64.test(envelope.value)) {
    throw new UpdateVerificationError('signature-invalid', 'Update signature is not valid Ed25519 base64')
  }
  const signature = Buffer.from(envelope.value, 'base64')
  let valid = false
  try {
    valid = verify(null, input.manifestBytes, createPublicKey(input.publicKeyPem), signature)
  } catch {
    valid = false
  }
  if (!valid) {
    throw new UpdateVerificationError('signature-invalid', 'Update manifest signature does not verify')
  }

  let raw: unknown
  try {
    raw = JSON.parse(input.manifestBytes.toString('utf8'))
  } catch {
    throw new UpdateVerificationError('manifest-invalid', 'Update manifest is not valid JSON')
  }
  const manifest = parseManifest(raw)
  if (manifest.product !== input.expected.product
    || manifest.appId !== input.expected.appId
    || manifest.channel !== input.expected.channel) {
    throw new UpdateVerificationError('metadata-mismatch', 'Update manifest identity does not match this build')
  }
  assertManifestCurrent(manifest, input.now ?? new Date())
  return manifest
}

/** Re-check a signed manifest's validity window. The window is enforced when
 *  the manifest is fetched, but an install can happen much later; re-check it
 *  at the handoff as well. */
export function assertManifestCurrent(manifest: LinuxUpdateManifest, now = new Date()): void {
  const time = now.getTime()
  const published = Date.parse(manifest.publishedAt)
  const expires = Date.parse(manifest.expiresAt)
  if (!Number.isFinite(time)) {
    throw new UpdateVerificationError('manifest-invalid', 'Update verification time is invalid')
  }
  if (!Number.isFinite(published) || !Number.isFinite(expires) || expires <= published) {
    throw new UpdateVerificationError('manifest-invalid', 'Update manifest validity window is invalid')
  }
  if (time < published || time > expires) {
    throw new UpdateVerificationError('manifest-invalid', 'Update manifest is outside its validity window')
  }
}

/** Bind a verified manifest to the untrusted `UpdateInfo` electron-updater
 *  selected. The manifest is authoritative for the package identity.
 *
 *  This only proves the signed artifact is present in the feed metadata. The
 *  actual file electron-updater downloaded is independently re-hashed by
 *  `verifyDownloadedPackage` before install, so a feed that advertises a
 *  different artifact fails closed there. */
export function bindVerifiedRelease(
  manifest: LinuxUpdateManifest,
  info: { version: string; files: ReadonlyArray<{ url: string; sha512?: string; size?: number }> },
): void {
  if (manifest.version !== info.version) {
    throw new UpdateVerificationError('metadata-mismatch', 'Signed manifest version does not match the feed release')
  }
  if (!Array.isArray(info.files)) {
    throw new UpdateVerificationError('metadata-mismatch', 'Feed release has no file list')
  }
  const file = info.files.find((entry) => entry?.url === manifest.fileName)
  if (!file) {
    throw new UpdateVerificationError('metadata-mismatch', 'Signed package is not present in the feed release')
  }
  if (file.sha512 !== manifest.fileSha512 || file.size !== manifest.fileSize) {
    throw new UpdateVerificationError('metadata-mismatch', 'Feed checksum/size does not match the signed manifest')
  }
}

/** Identity of the package inode that was hashed, used to detect a swap
 *  between the final verification and the updater handoff. */
export interface VerifiedPackageIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

/** Map a `Stats` record to the inode identity used by the handoff guard. */
export function packageIdentityFromStats(info: Stats): VerifiedPackageIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  }
}

/** Compare two inode identities. */
export function samePackageIdentity(a: VerifiedPackageIdentity, b: VerifiedPackageIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

/** Re-stat the path synchronously immediately before the updater handoff and
 *  prove it still names the inode whose bytes were hashed. */
export function assertPackageIdentity(identity: VerifiedPackageIdentity, file: string): void {
  let current: Stats
  try {
    current = statSync(file)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UpdateVerificationError('package-missing', 'Downloaded package disappeared before handoff')
    }
    throw new UpdateVerificationError(
      'package-unreadable',
      `Downloaded package could not be inspected before handoff: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!samePackageIdentity(identity, packageIdentityFromStats(current))) {
    throw new UpdateVerificationError('package-changed', 'Downloaded package changed after verification')
  }
}

/** Re-hash the downloaded package and prove it is the exact signed file.
 *  Call immediately before `quitAndInstall`, not only at download time.
 *
 *  Opens with `O_NOFOLLOW`, hashes through the open descriptor, and stats that
 *  same descriptor before and after the read, so the bytes that were hashed
 *  are the bytes the identity describes. The caller can then compare the
 *  returned identity synchronously right before the handoff.
 *
 *  This narrows the window but does not close a same-UID race: the installer
 *  re-opens the path after this check. Closing that would require a privileged
 *  verifier or installing from an already-open descriptor; the current
 *  updater API does neither. */
export async function verifyDownloadedPackageWithIdentity(
  manifest: LinuxUpdateManifest,
  downloadedFile: string,
  cacheDir: string,
): Promise<VerifiedPackageIdentity> {
  const cacheRoot = resolve(cacheDir)
  const lexical = resolve(downloadedFile)
  if (lexical !== cacheRoot && !lexical.startsWith(cacheRoot + sep)) {
    throw new UpdateVerificationError('package-outside-cache', 'Downloaded package is outside the updater cache')
  }
  let file: string
  let cacheReal: string
  try {
    file = await realpath(lexical)
    cacheReal = await realpath(cacheRoot)
  } catch {
    throw new UpdateVerificationError('package-missing', 'Downloaded package is missing')
  }
  if (file !== cacheReal && !file.startsWith(cacheReal + sep)) {
    throw new UpdateVerificationError('package-outside-cache', 'Downloaded package is outside the updater cache')
  }
  let handle
  try {
    // Reject a FIFO/socket/device before opening: O_RDONLY on a FIFO blocks
    // until a writer appears, which would hang install with installInProgress
    // set forever. O_NONBLOCK makes a swap after this stat fail fast too;
    // regular files ignore it.
    const beforeOpen = await stat(file)
    if (!beforeOpen.isFile()) {
      throw new UpdateVerificationError('package-changed', 'Downloaded package is not a regular file')
    }
    // O_NOFOLLOW is a no-op where the constant is absent (Windows); the
    // realpath containment check above still applies there.
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch (error: unknown) {
    if (error instanceof UpdateVerificationError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') {
      throw new UpdateVerificationError('package-changed', 'Downloaded package path changed during verification')
    }
    if (code === 'ENOENT') {
      throw new UpdateVerificationError('package-missing', 'Downloaded package is missing')
    }
    // EACCES/EMFILE/ENOTDIR are not evidence that the package vanished.
    throw new UpdateVerificationError('package-unreadable', 'Downloaded package could not be opened')
  }
  try {
    const before = await handle.stat()
    if (!before.isFile()) {
      throw new UpdateVerificationError('package-changed', 'Downloaded package is not a regular file')
    }
    if (before.size !== manifest.fileSize) {
      throw new UpdateVerificationError('package-size-mismatch', 'Downloaded package size does not match the signed manifest')
    }
    const hash = createHash('sha512')
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer)
    }
    const after = await handle.stat()
    if (!samePackageIdentity(before, after)) {
      throw new UpdateVerificationError('package-changed', 'Downloaded package changed during verification')
    }
    const actual = hash.digest('base64')
    if (actual !== manifest.fileSha512) {
      throw new UpdateVerificationError('package-hash-mismatch', 'Downloaded package hash does not match the signed manifest')
    }
    return packageIdentityFromStats(after)
  } finally {
    // A close failure must not mask the verification error that triggered it.
    await handle.close().catch(() => undefined)
  }
}

/** Backwards-compatible wrapper for callers that only need pass/fail. */
export async function verifyDownloadedPackage(
  manifest: LinuxUpdateManifest,
  downloadedFile: string,
  cacheDir: string,
): Promise<void> {
  await verifyDownloadedPackageWithIdentity(manifest, downloadedFile, cacheDir)
}

function parseSignature(value: unknown): UpdateManifestSignature {
  if (!isRecord(value)) throw new UpdateVerificationError('signature-missing', 'Update signature is missing')
  const keyId = value['keyId']
  const algorithm = value['algorithm']
  const signature = value['value']
  if (typeof keyId !== 'string' || !keyId
    || algorithm !== 'ed25519'
    || typeof signature !== 'string' || !signature) {
    throw new UpdateVerificationError('signature-invalid', 'Update signature envelope is malformed')
  }
  return { keyId, algorithm, value: signature }
}

function parseManifest(value: unknown): LinuxUpdateManifest {
  if (!isRecord(value)) throw new UpdateVerificationError('manifest-invalid', 'Update manifest must be an object')
  const schema = value['schema']
  const product = value['product']
  const appId = value['appId']
  const channel = value['channel']
  const version = value['version']
  const sequence = value['sequence']
  const publishedAt = value['publishedAt']
  const expiresAt = value['expiresAt']
  const fileName = value['fileName']
  const fileSha512 = value['fileSha512']
  const fileSize = value['fileSize']
  const releaseNotesUrl = value['releaseNotesUrl']
  if (schema !== 1 || product !== 'open-alice'
    || typeof appId !== 'string' || !/^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/.test(appId)
    || typeof channel !== 'string' || !/^[a-z][a-z0-9-]*$/.test(channel)
    || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    || !Number.isSafeInteger(sequence) || (sequence as number) < 1
    || typeof publishedAt !== 'string' || typeof expiresAt !== 'string'
    || typeof fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.(?:rpm|deb|AppImage)$/.test(fileName) || fileName.includes('..')
    || typeof fileSha512 !== 'string' || !BASE64_64.test(fileSha512)
    || !Number.isSafeInteger(fileSize) || (fileSize as number) < 1 || (fileSize as number) > MAX_PACKAGE_BYTES
    || typeof releaseNotesUrl !== 'string' || !isSafeHttpsUrl(releaseNotesUrl)) {
    throw new UpdateVerificationError('manifest-invalid', 'Update manifest fields are invalid')
  }
  return {
    schema: 1,
    product: 'open-alice',
    appId,
    channel,
    version,
    sequence: sequence as number,
    publishedAt,
    expiresAt,
    fileName,
    fileSha512,
    fileSize: fileSize as number,
    releaseNotesUrl,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}
