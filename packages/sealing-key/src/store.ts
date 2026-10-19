import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, copyFile, link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

import {
  parseKeyMaterial,
  SEALING_KEY_BYTES,
  sealWithKey,
  unsealWithKey,
  UnsealError,
  type SealedEnvelope,
} from './envelope.js'

const KEYRING_NAME = 'openalice-sealing'
const BACKEND_ENV = 'OPENALICE_SEALING_BACKEND'
const SYSTEMD_CREDS_ENV = 'OPENALICE_SYSTEMD_CREDS'
const SYSTEMD_CREDS_TIMEOUT_MS = 15_000
const SYSTEMD_CREDS_MAX_OUTPUT = 64 * 1024

export type SealingBackend = 'auto' | 'file' | 'systemd-creds'
export type ActiveSealingBackend = 'file' | 'systemd-creds'

export class SealingBackendUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'SealingBackendUnavailableError'
  }
}

export class SealingKeyMissingError extends UnsealError {
  constructor(message: string) {
    super(message)
    this.name = 'SealingKeyMissingError'
  }
}

export class SealingKeyConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SealingKeyConflictError'
  }
}

export interface SealingKeyStatus {
  readonly configuredBackend: SealingBackend
  readonly activeBackend: ActiveSealingBackend
  readonly legacyPath: string
  readonly credentialPath: string
  readonly legacyFileExists: boolean
  readonly credentialExists: boolean
}

/**
 * Decrypted credential material is cached for the process lifetime. A config
 * read otherwise spawns `systemd-creds` every time, which is both slow and
 * needlessly exposes the key to repeated subprocess boundaries. The cache is
 * cleared by `deleteKey()` and is not persisted anywhere.
 */
const credentialKeyCache = new Map<string, Buffer>()

export function clearSealingKeyCache(): void {
  credentialKeyCache.clear()
}

export function sealingBackend(env: NodeJS.ProcessEnv = process.env): SealingBackend {
  const raw = env[BACKEND_ENV]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return 'auto'
  if (raw === 'file' || raw === 'systemd-creds' || raw === 'auto') return raw
  throw new SealingBackendUnavailableError(
    `invalid ${BACKEND_ENV} value "${env[BACKEND_ENV]}" (expected auto, file, or systemd-creds)`,
  )
}

export function sealingKeyPath(home: string): string {
  return resolve(home, 'sealing.key')
}

export function sealingKeyCredentialPath(home: string): string {
  return resolve(home, 'state', 'sealing.key.cred')
}

/** Non-secret verifier for the key material. It lets a copied home prove that
 *  a legacy plaintext key still matches the encrypted credential before the
 *  fallback path trusts it; a 256-bit key cannot be recovered from the hash. */
export function sealingKeyFingerprintPath(home: string): string {
  return resolve(home, 'state', 'sealing.key.fp')
}

function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex')
}

async function readKeyFingerprint(home: string): Promise<string | null> {
  try {
    const value = (await readFile(sealingKeyFingerprintPath(home), 'utf-8')).trim()
    if (!/^[0-9a-f]{64}$/.test(value)) {
      warn(`${sealingKeyFingerprintPath(home)} is malformed and was ignored`)
      return null
    }
    return value
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return null
    warn(`could not read ${sealingKeyFingerprintPath(home)}: ${errorMessage(error)}`)
    return null
  }
}

async function writeKeyFingerprint(home: string, key: Buffer): Promise<void> {
  const path = sealingKeyFingerprintPath(home)
  const expected = keyFingerprint(key)
  try {
    if ((await readFile(path, 'utf-8')).trim() === expected) return
  } catch {
    // Missing or unreadable: rewrite it below.
  }
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await ensureOwnerOnly(dirname(path), 0o700)
    await writeFile(path, `${expected}\n`, { mode: 0o600 })
    await chmod(path, 0o600).catch(() => undefined)
  } catch (error: unknown) {
    warn(`could not record ${path}: ${errorMessage(error)}`)
  }
}

export async function keyStatus(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SealingKeyStatus> {
  const configured = sealingBackend(env)
  const legacyPath = sealingKeyPath(home)
  const credentialPath = sealingKeyCredentialPath(home)
  const [legacyFileExists, credentialExists] = await Promise.all([
    exists(legacyPath),
    exists(credentialPath),
  ])
  let activeBackend: ActiveSealingBackend
  if (configured === 'file') {
    activeBackend = 'file'
  } else if (credentialExists || configured === 'systemd-creds') {
    activeBackend = 'systemd-creds'
  } else if (legacyFileExists) {
    activeBackend = 'file'
  } else {
    activeBackend = systemdCredsAvailable(env) ? 'systemd-creds' : 'file'
  }
  return {
    configuredBackend: configured,
    activeBackend,
    legacyPath,
    credentialPath,
    legacyFileExists,
    credentialExists,
  }
}

/**
 * Read the machine key without creating one.
 *
 * A credential that exists but cannot be decrypted is an error unless a valid
 * legacy key is also present and matches the recorded fingerprint (when one
 * exists); that fallback keeps a copied home readable while refusing a stale
 * key, and never mints a fresh key over existing ciphertext.
 */
export interface ReadKeyOptions {
  /** Allow a legacy plaintext key to be migrated (and removed) in place. */
  readonly migrate?: boolean
}

export async function readKey(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ReadKeyOptions = {},
): Promise<Buffer | null> {
  const migrate = options.migrate !== false
  const backend = sealingBackend(env)
  if (backend === 'file') {
    if (await exists(sealingKeyCredentialPath(home))) {
      throw new SealingKeyConflictError(
        `${sealingKeyCredentialPath(home)} exists but ${BACKEND_ENV}=file was requested; ` +
        'use the default backend to read it, or remove the credential only after verifying its data',
      )
    }
    return readFileKey(home)
  }

  const legacy = await readFileKeySafe(home)
  let credential: Buffer | null = null
  let credentialError: unknown = null
  try {
    credential = await readCredentialKey(home, env)
  } catch (error: unknown) {
    credentialError = error
  }

  if (credential) {
    if (migrate) await writeKeyFingerprint(home, credential)
    if (legacy.key) {
      if (!credential.equals(legacy.key)) {
        throw new SealingKeyConflictError(
          `both ${sealingKeyPath(home)} and ${sealingKeyCredentialPath(home)} exist with different material; ` +
          'refusing to choose one because either choice makes existing sealed data unreadable. ' +
          'Restore the correct key, or remove the stale copy after verifying the data it belongs to.',
        )
      }
      if (migrate) {
        // Deliberate: a whole-home backup must not contain a plaintext key.
        // If the encrypted backend later disappears, the app fails closed and
        // the user re-enters credentials; retaining the plaintext copy would
        // defeat the backup-separation guarantee.
        await rm(sealingKeyPath(home), { force: true }).catch(() => undefined)
      }
    } else if (legacy.error) {
      warn(
        `${sealingKeyPath(home)} is unreadable and was ignored because the encrypted credential is valid: ` +
        errorMessage(legacy.error),
      )
    }
    return credential
  }

  if (credentialError) {
    if (backend === 'auto' && legacy.key) {
      // A copied home can contain an encrypted credential bound to another
      // machine plus the original plaintext key. Only trust that fallback when
      // the key matches the fingerprint recorded next to the credential;
      // otherwise a stale legacy key would silently cause every sealed store
      // to be quarantined after unseal fails.
      const recorded = await readKeyFingerprint(home)
      if (recorded !== null && recorded !== keyFingerprint(legacy.key)) {
        throw new SealingKeyConflictError(
          `${sealingKeyPath(home)} does not match the fingerprint recorded for ${sealingKeyCredentialPath(home)}; ` +
          'refusing to fall back to a stale key. Restore the matching key or re-enter the credentials.',
        )
      }
      warn(
        `could not use ${sealingKeyCredentialPath(home)} (${errorMessage(credentialError)}); ` +
        `falling back to the legacy key at ${sealingKeyPath(home)}`,
      )
      return legacy.key
    }
    throw credentialError
  }

  if (legacy.error) throw legacy.error
  if (legacy.key) {
    if (!migrate) return legacy.key
    if (backend === 'auto' && !systemdCredsAvailable(env)) return legacy.key
    try {
      return await migrateLegacyKey(home, legacy.key, env)
    } catch (error: unknown) {
      // A conflict means another process already installed a different
      // credential; never silently choose the plaintext key in that case.
      if (backend === 'auto' && !(error instanceof SealingKeyConflictError)) {
        warn(
          `could not migrate ${sealingKeyPath(home)} to the encrypted credential store ` +
          `(${errorMessage(error)}); keeping the owner-only plaintext key`,
        )
        return legacy.key
      }
      throw error
    }
  }
  return null
}

/** Read or create the machine key. Creation prefers the encrypted store. */
export async function loadOrCreateKey(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  const existing = await readKey(home, env)
  if (existing) return existing

  const backend = sealingBackend(env)
  if (backend === 'file') return (await createFileKey(home)).key
  if (backend === 'systemd-creds') return createCredentialKey(home, env)
  if (!systemdCredsAvailable(env)) return (await createFileKey(home)).key

  // Under `auto`, create the file key first. It is the race-safe fallback:
  // two first-run processes converge on one plaintext key, then both migrate
  // that same key. If the encrypted backend is unavailable, the file remains
  // usable; if it succeeds, `migrateLegacyKey` removes it after verification.
  const { key: fileKey, created } = await createFileKey(home)
  try {
    return await migrateLegacyKey(home, fileKey, env)
  } catch (error: unknown) {
    const credential = await readCredentialKey(home, env).catch(() => null)
    if (credential) {
      // Another process won the race and installed a credential after our
      // read. If we created the plaintext key, it is unused and can go. If it
      // predates us and differs, adopting the credential would leave two
      // conflicting key forms; fail instead of silently choosing one.
      if (created) {
        await rm(sealingKeyPath(home), { force: true }).catch(() => undefined)
      } else if (!credential.equals(fileKey)) {
        throw new SealingKeyConflictError(
          `both ${sealingKeyPath(home)} and ${sealingKeyCredentialPath(home)} exist with different material; ` +
          'refusing to choose one because either choice makes existing sealed data unreadable.',
        )
      }
      return credential
    }
    if (backend === 'auto' && !(error instanceof SealingKeyConflictError)) {
      warn(
        `could not create the encrypted sealing credential (${errorMessage(error)}); ` +
        `using the owner-only plaintext key at ${sealingKeyPath(home)}`,
      )
      return fileKey
    }
    throw error
  }
}

export async function sealAt(
  home: string,
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SealedEnvelope> {
  return sealWithKey(await loadOrCreateKey(home, env), value)
}

export async function unsealAt<T = unknown>(
  home: string,
  envelope: unknown,
  env: NodeJS.ProcessEnv = process.env,
  options: ReadKeyOptions = {},
): Promise<T> {
  const key = await readKey(home, env, options)
  if (!key) {
    throw new SealingKeyMissingError(
      `sealed file requires the machine key at ${sealingKeyPath(home)} or ${sealingKeyCredentialPath(home)}, ` +
      'which does not exist — if this data was copied from another machine, re-enter the credentials there',
    )
  }
  return unsealWithKey<T>(key, envelope)
}

export async function deleteKey(home: string): Promise<void> {
  credentialKeyCache.delete(sealingKeyCredentialPath(home))
  await Promise.all([
    rm(sealingKeyPath(home), { force: true }),
    rm(sealingKeyCredentialPath(home), { force: true }),
    rm(sealingKeyFingerprintPath(home), { force: true }),
  ])
}

async function readFileKey(home: string): Promise<Buffer | null> {
  try {
    return parseKeyMaterial(await readFile(sealingKeyPath(home), 'utf-8'))
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return null
    if (error instanceof UnsealError) {
      // A malformed legacy key is a key-store failure, not a ciphertext
      // authentication failure; callers must not quarantine sealed files.
      throw new SealingBackendUnavailableError(
        `legacy sealing key at ${sealingKeyPath(home)} is malformed: ${error.message}`,
        error,
      )
    }
    throw error
  }
}

async function readFileKeySafe(
  home: string,
): Promise<{ key: Buffer | null; error: unknown }> {
  try {
    return { key: await readFileKey(home), error: null }
  } catch (error: unknown) {
    return { key: null, error }
  }
}

async function createFileKey(home: string): Promise<{ key: Buffer; created: boolean }> {
  const key = randomBytes(SEALING_KEY_BYTES)
  const path = sealingKeyPath(home)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    // Write the complete key to a same-directory temp file, then link it into
    // place. `writeFile(..., 'wx')` at the final path exposes a zero-length
    // file to a concurrent reader between create and write.
    await writeFile(temporary, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
    await ensureOwnerOnly(temporary, 0o600)
    try {
      await link(temporary, path)
      return { key, created: true }
    } catch (error: unknown) {
      if (isNodeError(error, 'EEXIST')) {
        const raced = await readFileKey(home)
        if (raced) return { key: raced, created: false }
        throw error
      }
      if (!isLinkUnsupported(error)) throw error
      // exFAT/FAT32 and some SMB/NFS mounts reject hard links. Copy with
      // O_EXCL so a concurrent creator still wins; the temp is complete.
      try {
        await copyFile(temporary, path, constants.COPYFILE_EXCL)
        await ensureOwnerOnly(path, 0o600)
        return { key, created: true }
      } catch (copyError: unknown) {
        if (isNodeError(copyError, 'EEXIST')) {
          const raced = await readFileKey(home)
          if (raced) return { key: raced, created: false }
        }
        throw copyError
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function migrateLegacyKey(home: string, legacy: Buffer, env: NodeJS.ProcessEnv): Promise<Buffer> {
  const migrated = await writeCredentialKey(home, legacy, env)
  if (!migrated.equals(legacy)) {
    throw new SealingKeyConflictError('migrated credential does not match the legacy sealing key')
  }
  // Read-back happened inside writeCredentialKey; only now remove the
  // plaintext copy. If cleanup fails, the credential is still usable and the
  // next read will retry the removal; never fail the migration over cleanup.
  await rm(sealingKeyPath(home), { force: true }).catch((error: unknown) => {
    warn(`could not remove ${sealingKeyPath(home)} after migration: ${errorMessage(error)}`)
  })
  return migrated
}

async function readCredentialKey(home: string, env: NodeJS.ProcessEnv): Promise<Buffer | null> {
  const path = sealingKeyCredentialPath(home)
  if (!(await exists(path))) return null
  const cached = credentialKeyCache.get(path)
  if (cached) return cached
  const key = await decryptCredentialKey(path, env)
  credentialKeyCache.set(path, key)
  return key
}

async function decryptCredentialKey(path: string, env: NodeJS.ProcessEnv): Promise<Buffer> {
  let result: SystemdCredsResult
  try {
    result = await runSystemdCreds(['--user', 'decrypt', '--name', KEYRING_NAME, path, '-'], { env })
  } catch (error: unknown) {
    throw new SealingBackendUnavailableError(
      `could not decrypt ${path} with systemd-creds: ${errorMessage(error)}`,
      error,
    )
  }
  try {
    return parseKeyMaterial(result.stdout.toString('utf-8'))
  } catch (error: unknown) {
    throw new SealingBackendUnavailableError(
      `credential at ${path} contains malformed key material: ${errorMessage(error)}`,
      error,
    )
  }
}

async function createCredentialKey(home: string, env: NodeJS.ProcessEnv): Promise<Buffer> {
  return writeCredentialKey(home, randomBytes(SEALING_KEY_BYTES), env)
}

async function writeCredentialKey(home: string, key: Buffer, env: NodeJS.ProcessEnv): Promise<Buffer> {
  const path = sealingKeyCredentialPath(home)
  const stateDir = dirname(path)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await ensureOwnerOnly(stateDir, 0o700)
  const output = join(stateDir, `.sealing.${process.pid}.${randomUUID()}.tmp`)
  try {
    // Feed the key to systemd-creds on stdin. A temporary plaintext file in
    // /tmp would survive SIGKILL or a power loss, defeating the encrypted
    // store. `-` means "read plaintext from stdin" for systemd-creds.
    //
    // `--user` binds the credential to this UID, username and machine-id.
    // It is not the root-only host key: a same-UID process can still run
    // `systemd-creds --user decrypt`, but a whole-home backup moved to
    // another machine cannot decrypt it.
    await runSystemdCreds(
      ['--user', 'encrypt', '--name', KEYRING_NAME, '-', output],
      { input: `${key.toString('base64')}\n`, env },
    )
    await ensureOwnerOnly(output, 0o600)
    // `link` is the atomic create-if-absent primitive. `rename` would let two
    // concurrent first seals overwrite each other and orphan ciphertext.
    try {
      await link(output, path)
    } catch (error: unknown) {
      if (isNodeError(error, 'EEXIST')) {
        const existing = await decryptCredentialKey(path, env)
        credentialKeyCache.set(path, existing)
        await writeKeyFingerprint(home, existing)
        return existing
      }
      if (!isLinkUnsupported(error)) throw error
      try {
        await copyFile(output, path, constants.COPYFILE_EXCL)
        await ensureOwnerOnly(path, 0o600)
      } catch (copyError: unknown) {
        if (isNodeError(copyError, 'EEXIST')) {
          const existing = await decryptCredentialKey(path, env)
          credentialKeyCache.set(path, existing)
          await writeKeyFingerprint(home, existing)
          return existing
        }
        throw copyError
      }
    }
    await ensureOwnerOnly(path, 0o600)
    // Verify before deleting the caller's only plaintext copy. If the
    // read-back fails or returns different material, remove the bad
    // credential so the next run can retry instead of being stuck on it.
    let roundTrip: Buffer
    try {
      roundTrip = await decryptCredentialKey(path, env)
    } catch (error: unknown) {
      await rm(path, { force: true }).catch(() => undefined)
      credentialKeyCache.delete(path)
      throw error
    }
    if (!roundTrip.equals(key)) {
      await rm(path, { force: true }).catch(() => undefined)
      credentialKeyCache.delete(path)
      throw new SealingBackendUnavailableError('systemd-creds credential did not round-trip')
    }
    credentialKeyCache.set(path, roundTrip)
    await writeKeyFingerprint(home, roundTrip)
    return roundTrip
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) {
      throw new SealingBackendUnavailableError('systemd-creds is not available on this system', error)
    }
    throw error
  } finally {
    await rm(output, { force: true }).catch(() => undefined)
  }
}

interface SystemdCredsResult {
  readonly stdout: Buffer
  readonly stderr: string
}

function runSystemdCreds(
  args: readonly string[],
  options: { readonly input?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<SystemdCredsResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(resolveSystemdCredsBinary(options.env), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    })
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, result?: SystemdCredsResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else if (result) resolvePromise(result)
      else reject(new Error('systemd-creds finished without a result'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`systemd-creds timed out after ${SYSTEMD_CREDS_TIMEOUT_MS}ms`))
    }, SYSTEMD_CREDS_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > SYSTEMD_CREDS_MAX_OUTPUT) {
        child.kill('SIGKILL')
        finish(new Error('systemd-creds output exceeded the safety limit'))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < SYSTEMD_CREDS_MAX_OUTPUT) stderr += chunk.toString('utf-8')
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(null, { stdout: Buffer.concat(stdout), stderr })
        return
      }
      const detail = stderr.trim() || (signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`)
      finish(new Error(detail))
    })
    child.stdin.on('error', (error) => finish(error))
    child.stdin.end(options.input ?? '')
  })
}

function systemdCredsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== 'linux') return false
  const binary = resolveSystemdCredsBinary(env)
  if (isAbsolute(binary)) return existsSync(binary)
  // NixOS and other non-FHS hosts expose systemd-creds only through PATH.
  return findOnPath(binary, env['PATH']) !== null
}

function resolveSystemdCredsBinary(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SYSTEMD_CREDS_ENV]?.trim()
  if (configured) return configured
  return existsSync('/usr/bin/systemd-creds') ? '/usr/bin/systemd-creds' : 'systemd-creds'
}

function findOnPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = resolve(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  return null
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

function isLinkUnsupported(error: unknown): boolean {
  return isNodeError(error, 'EPERM')
    || isNodeError(error, 'EOPNOTSUPP')
    || isNodeError(error, 'ENOTSUP')
    || isNodeError(error, 'ENOSYS')
    || isNodeError(error, 'EXDEV')
}

/** chmod is the privacy boundary; if the filesystem rejects it, verify that
 *  the existing mode is already owner-only instead of silently weakening it. */
async function ensureOwnerOnly(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode)
  } catch (error: unknown) {
    try {
      const info = await stat(path)
      if ((info.mode & 0o077) === 0) return
    } catch {
      // Fall through to the original chmod error.
    }
    throw new SealingBackendUnavailableError(
      `could not restrict ${path} to mode ${mode.toString(8)}: ${errorMessage(error)}`,
      error,
    )
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warn(message: string): void {
  console.warn(`[sealing-key] ${message}`)
}
