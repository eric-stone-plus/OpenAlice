import { createHash, createPublicKey, verify } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export const MAX_MANIFEST_BYTES = 64 * 1024
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/
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
  | 'package-size-mismatch'
  | 'package-hash-mismatch'
  | 'package-outside-cache'

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
  if (!SIGNATURE_BASE64.test(envelope.value)) {
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
  const now = (input.now ?? new Date()).getTime()
  const published = Date.parse(manifest.publishedAt)
  const expires = Date.parse(manifest.expiresAt)
  if (!Number.isFinite(now)) {
    throw new UpdateVerificationError('manifest-invalid', 'Update verification time is invalid')
  }
  if (!Number.isFinite(published) || !Number.isFinite(expires) || expires <= published) {
    throw new UpdateVerificationError('manifest-invalid', 'Update manifest validity window is invalid')
  }
  if (now < published || now > expires) {
    throw new UpdateVerificationError('manifest-invalid', 'Update manifest is outside its validity window')
  }
  return manifest
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
  const file = info.files.find((entry) => entry.url === manifest.fileName)
  if (!file) {
    throw new UpdateVerificationError('metadata-mismatch', 'Signed package is not present in the feed release')
  }
  if (file.sha512 !== manifest.fileSha512 || file.size !== manifest.fileSize) {
    throw new UpdateVerificationError('metadata-mismatch', 'Feed checksum/size does not match the signed manifest')
  }
}

/** Re-hash the downloaded package and prove it is the exact signed file.
 *  Call immediately before `quitAndInstall`, not only at download time.
 *
 *  This narrows the window but does not close a same-UID race: the installer
 *  re-opens the path after this check. Closing that would require a privileged
 *  verifier or installing from an already-open descriptor; the current
 *  updater API does neither. */
export async function verifyDownloadedPackage(
  manifest: LinuxUpdateManifest,
  downloadedFile: string,
  cacheDir: string,
): Promise<void> {
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
  let info
  try {
    info = await stat(file)
  } catch {
    throw new UpdateVerificationError('package-missing', 'Downloaded package is missing')
  }
  if (!info.isFile() || info.size !== manifest.fileSize) {
    throw new UpdateVerificationError('package-size-mismatch', 'Downloaded package size does not match the signed manifest')
  }
  const hash = createHash('sha512')
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    throw new UpdateVerificationError('package-missing', 'Downloaded package could not be opened')
  }
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer)
    }
  } finally {
    await handle.close()
  }
  const actual = hash.digest('base64')
  if (actual !== manifest.fileSha512) {
    throw new UpdateVerificationError('package-hash-mismatch', 'Downloaded package hash does not match the signed manifest')
  }
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
    || typeof fileSha512 !== 'string' || !SHA512_BASE64.test(fileSha512)
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
