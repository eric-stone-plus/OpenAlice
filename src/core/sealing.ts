/**
 * At-rest sealing for secret-bearing config files (broker credentials).
 *
 * AES-256-GCM envelope around the file's JSON payload. The machine key is
 * resolved through `@traderalice/sealing-key`:
 *
 *   Linux default (`auto`): systemd-creds --user stores a user-scoped
 *   encrypted credential at `<userDataHome>/state/sealing.key.cred`. The
 *   credential is bound to this UID, username and machine-id, so a whole-home
 *   backup copied to another machine cannot decrypt it. This is not the
 *   root-only host key: a same-UID process can still run the decrypt command.
 *
 *   Legacy/test fallback: `<userDataHome>/sealing.key` (plaintext, 0600).
 *   `OPENALICE_SEALING_BACKEND=file` forces it; `systemd-creds` forces the
 *   encrypted backend and fails closed.
 *
 * What this buys (honest threat model):
 *   - `data/` leaving the machine (backup, cloud sync, "send me your data
 *     dir" debugging) no longer leaks broker keys.
 *   - the plaintext `sealing.key` file is migrated away on Linux, so a
 *     whole-home backup does not contain a directly readable key.
 *   - casual reads — grep, screenshots, an agent `cat`ing the file — see
 *     ciphertext.
 * What it does NOT buy: a same-UID process can still run the same
 * `systemd-creds decrypt` command, read the process environment, or ptrace
 * the app. True same-UID isolation needs a separate UID/SELinux/VM boundary.
 *
 * The envelope is versioned ($sealed/alg) so the key backend can change
 * without a format break.
 */

import {
  isSealedEnvelope,
  keyStatus,
  hasSealedMarker,
  sealAt,
  sealingBackend,
  sealingKeyCredentialPath as packageSealingKeyCredentialPath,
  sealingKeyFingerprintPath as packageSealingKeyFingerprintPath,
  sealingKeyPath as packageSealingKeyPath,
  unsealAt,
  SealingBackendUnavailableError,
  SealingKeyConflictError,
  SealingKeyMissingError,
  UnsealError,
  type SealedEnvelope,
} from '@traderalice/sealing-key'

import { userDataHome } from './paths.js'

export {
  hasSealedMarker,
  isSealedEnvelope,
  SealingBackendUnavailableError,
  SealingKeyConflictError,
  SealingKeyMissingError,
  UnsealError,
  type SealedEnvelope,
}

export function sealingKeyPath(home = userDataHome): string {
  return packageSealingKeyPath(home)
}

export function sealingKeyCredentialPath(home = userDataHome): string {
  return packageSealingKeyCredentialPath(home)
}

export function sealingKeyFingerprintPath(home = userDataHome): string {
  return packageSealingKeyFingerprintPath(home)
}

export { sealingBackend, keyStatus }

/** Encrypt a JSON-serializable value into an envelope. Creates the sealing
 *  key on first use. */
export async function seal(value: unknown): Promise<SealedEnvelope> {
  return sealAt(userDataHome, value)
}

/** Decrypt an envelope back to its JSON value. Throws UnsealError when the
 *  key is missing or the ciphertext doesn't authenticate. Never creates a
 *  new key: a missing key with existing ciphertext is a recovery error. */
export async function unseal<T = unknown>(envelope: unknown): Promise<T> {
  if (!isSealedEnvelope(envelope)) {
    throw new UnsealError('sealed envelope is malformed')
  }
  try {
    return await unsealAt<T>(userDataHome, envelope)
  } catch (error: unknown) {
    if (error instanceof UnsealError
      || error instanceof SealingBackendUnavailableError
      || error instanceof SealingKeyConflictError) throw error
    // A non-envelope error here came from the key store (backend probe,
    // credential parse, I/O), not from authenticated ciphertext. Quarantining
    // the file would hide a recoverable key-store failure, so fail closed.
    throw new SealingBackendUnavailableError(
      error instanceof Error ? error.message : String(error),
      error,
    )
  }
}
