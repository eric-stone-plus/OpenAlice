import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const SEALING_ALG = 'aes-256-gcm'
export const SEALING_KEY_BYTES = 32
const IV_BYTES = 12

export interface SealedEnvelope {
  $sealed: 1
  /** Algorithm marker; unknown values are rejected by `unsealWithKey`. */
  alg: string
  iv: string
  tag: string
  data: string
}

export class UnsealError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'UnsealError'
  }
}

/** Marker check only: a corrupted sealed file still must be quarantined or
 *  refused, not mistaken for plaintext and overwritten. */
export function hasSealedMarker(value: unknown): value is { $sealed: 1 } & Record<string, unknown> {
  return typeof value === 'object' && value !== null
    && (value as Record<string, unknown>)['$sealed'] === 1
}

export function isSealedEnvelope(value: unknown): value is SealedEnvelope {
  if (!hasSealedMarker(value)) return false
  return (
    typeof value['alg'] === 'string' &&
    value['alg'].length > 0 &&
    typeof value['iv'] === 'string' &&
    typeof value['tag'] === 'string' &&
    typeof value['data'] === 'string'
  )
}

export function sealWithKey(key: Buffer, value: unknown): SealedEnvelope {
  assertKeyLength(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(SEALING_ALG, key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf-8')
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    $sealed: 1,
    alg: SEALING_ALG,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

export function unsealWithKey<T = unknown>(key: Buffer, envelope: unknown): T {
  assertKeyLength(key)
  if (!isSealedEnvelope(envelope)) {
    throw new UnsealError('sealed envelope is malformed')
  }
  if (envelope.alg !== SEALING_ALG) {
    throw new UnsealError(`unsupported sealing algorithm "${envelope.alg}" — this build only knows ${SEALING_ALG}`)
  }
  let plaintext: Buffer
  try {
    const decipher = createDecipheriv(SEALING_ALG, key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ])
  } catch (error) {
    throw new UnsealError('failed to unseal: ciphertext does not authenticate against this machine key (key replaced, or file corrupted)', error)
  }
  try {
    return JSON.parse(plaintext.toString('utf-8')) as T
  } catch (error) {
    throw new UnsealError('failed to unseal: authenticated payload is not valid JSON', error)
  }
}

export function assertKeyLength(key: Buffer): void {
  if (key.length !== SEALING_KEY_BYTES) {
    throw new UnsealError(`sealing key is malformed (${key.length} bytes, expected ${SEALING_KEY_BYTES})`)
  }
}

export function parseKeyMaterial(raw: string): Buffer {
  const text = raw.trim()
  // Buffer.from(..., 'base64') silently discards invalid characters and
  // accepts non-canonical padding. Require the exact canonical encoding so a
  // truncated or hand-edited key fails instead of producing another 32 bytes.
  const key = Buffer.from(text, 'base64')
  if (key.toString('base64') !== text) {
    throw new UnsealError('sealing key is not valid base64')
  }
  assertKeyLength(key)
  return key
}
