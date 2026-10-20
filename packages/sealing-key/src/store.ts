import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, copyFile, link, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

import {
  parseKeyMaterial,
  SEALING_KEY_BYTES,
  sealWithKey,
  unsealWithKey,
  UnsealError,
  type SealedEnvelope,
} from './envelope.js'
import { localTokenPath, localTokenTempPid } from './local-auth-path.js'

const KEYRING_NAME = 'openalice-sealing'
const BACKEND_ENV = 'OPENALICE_SEALING_BACKEND'
const SYSTEMD_CREDS_ENV = 'OPENALICE_SYSTEMD_CREDS'
const SYSTEMD_CREDS_TIMEOUT_MS = 15_000
const SYSTEMD_CREDS_MAX_OUTPUT = 64 * 1024
// A temp on a shared home can belong to a live process on another host whose
// PID is dead locally. Wait out the longest writer (systemd-creds) before
// treating the local PID result as authoritative.
const TEMP_DEAD_GRACE_MS = SYSTEMD_CREDS_TIMEOUT_MS + 5_000

export type SealingBackend = 'auto' | 'file' | 'systemd-creds'
export type ActiveSealingBackend = 'file' | 'systemd-creds'

export class SealingBackendUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'SealingBackendUnavailableError'
  }
}

class TransientClaimError extends SealingBackendUnavailableError {
  constructor(message: string, cause?: unknown) {
    super(message, cause)
    this.name = 'TransientClaimError'
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

/** Single source of truth for the fail-closed boundary used by config reads. */
export function isSealingStoreError(error: unknown): boolean {
  return error instanceof SealingBackendUnavailableError
    || error instanceof SealingKeyConflictError
    || error instanceof SealingKeyMissingError
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
interface CredentialIdentity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
}

interface CachedCredential extends CredentialIdentity {
  readonly key: Buffer
}

const credentialKeyCache = new Map<string, CachedCredential>()

function sameIdentity(info: CredentialIdentity, expected: CredentialIdentity): boolean {
  return info.dev === expected.dev
    && info.ino === expected.ino
    && info.size === expected.size
    && info.mtimeMs === expected.mtimeMs
}

export function clearSealingKeyCache(): void {
  credentialKeyCache.clear()
  sweptHomes.clear()
  sweepInFlight.clear()
}

/** Restore a quarantined file create-if-absent, including on filesystems that
 *  reject hard links. Never overwrite a newer file at the destination. */
async function restoreFileCreateIfAbsent(quarantine: string, path: string): Promise<boolean> {
  try {
    await link(quarantine, path)
    await rm(quarantine, { force: true }).catch(() => undefined)
    return true
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    if (!['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(code ?? '')) return false
  }
  try {
    await copyFile(quarantine, path, constants.COPYFILE_EXCL)
    await rm(quarantine, { force: true }).catch(() => undefined)
    return true
  } catch {
    return false
  }
}

async function removeCredentialIfSame(path: string, identity: CredentialIdentity | null): Promise<void> {
  if (!identity) return
  // Move the credential aside and verify the moved inode before deleting it.
  // stat+rm can delete a concurrent writer's replacement between the calls.
  const quarantine = `${path}.removed-credential-${Date.now()}-${randomUUID()}`
  try {
    await rename(path, quarantine)
  } catch {
    return
  }
  const moved = await stat(quarantine).catch(() => null)
  if (!moved || !sameIdentity(moved, identity)) {
    if (!(await restoreFileCreateIfAbsent(quarantine, path))) {
      warn(`the credential moved from ${path} was not the one this process installed; left at ${quarantine}`)
    }
    return
  }
  await rm(quarantine, { force: true }).catch(() => undefined)
  credentialKeyCache.delete(path)
}

async function cacheCredential(
  path: string,
  key: Buffer,
  expected?: CredentialIdentity,
): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  if (!info || (expected && !sameIdentity(info, expected))) {
    // The credential changed between the read/decrypt and this stat; caching
    // the old key under the new identity would make the next read stale.
    credentialKeyCache.delete(path)
    return false
  }
  credentialKeyCache.set(path, {
    key,
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
  })
  return true
}

const FILE_KEY_TEMP_PREFIX = 'sealing.key.'
const CREDENTIAL_TEMP_PREFIX = '.sealing.'
const TEMP_SUFFIX = '.tmp'

function fileKeyTempName(pid: number, id: string): string {
  return `${FILE_KEY_TEMP_PREFIX}${pid}.${id}${TEMP_SUFFIX}`
}

function credentialTempName(pid: number, id: string): string {
  return `${CREDENTIAL_TEMP_PREFIX}${pid}.${id}${TEMP_SUFFIX}`
}

function tempPid(name: string): number | null {
  const match = /^(?:sealing\.key|\.sealing)\.(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/.exec(name)
  if (match) return Number(match[1])
  return localTokenTempPid(name)
}

/** Only names produced by the sealing-key writers or `ensureLocalToken` are
 *  ours. A user backup such as `sealing.key.2024.backup.tmp` must never be
 *  swept. */
function isSealingKeyTemp(name: string): boolean {
  return tempPid(name) !== null
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    // EPERM means the process exists but belongs to another user.
    return isNodeError(error, 'EPERM')
  }
}

/** Plaintext key temps survive SIGKILL/power loss. Sweep them once per process
 *  before reading, so a crash cannot leave key material behind. A temp whose
 *  embedded pid is dead is removed after the cross-host grace period; one
 *  whose pid is alive is kept until it is an hour old. */
const sweptHomes = new Set<string>()
const sweepInFlight = new Map<string, Promise<void>>()

export async function sweepStaleSealingTemps(home: string): Promise<void> {
  if (sweptHomes.has(home)) return
  const inFlight = sweepInFlight.get(home)
  if (inFlight) return inFlight
  const task = (async () => {
    let complete = true
    const maxAge = 60 * 60 * 1000
    const dirs = new Set([
      dirname(sealingKeyPath(home)),
      dirname(sealingKeyCredentialPath(home)),
      dirname(localTokenPath(home)),
    ])
    for (const dir of dirs) {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch (error: unknown) {
        // A missing state/ is normal; any other failure must not disable the
        // sweep for the rest of the process.
        if (!isNodeError(error, 'ENOENT')) complete = false
        continue
      }
      for (const name of names) {
        if (!isSealingKeyTemp(name)) continue
        const path = join(dir, name)
        try {
          const info = await stat(path)
          const pid = tempPid(name)
          if (pid === null) continue
          const age = Date.now() - info.mtimeMs
          // A far-future mtime (SMB/NFS clock skew) must not make a temp
          // immortal; treat it like an old temp.
          if (age < -CLAIM_RECOVERY_MS || age > maxAge || (!isProcessAlive(pid) && age > TEMP_DEAD_GRACE_MS)) {
            await rm(path, { force: true })
          }
        } catch (error: unknown) {
          // Another process may have removed it first. Any other failure means
          // the sweep did not fully cover this home; retry on the next read.
          if (!isNodeError(error, 'ENOENT')) complete = false
        }
      }
    }
    if (complete) sweptHomes.add(home)
  })().finally(() => {
    sweepInFlight.delete(home)
  })
  sweepInFlight.set(home, task)
  return task
}

interface DestinationClaim {
  readonly dev: number
  readonly ino: number
  readonly payload: string
}

/** Reserve a destination with O_EXCL. The empty file is only a claim; the
 *  caller renames the complete payload over it. Two creators cannot both
 *  claim, and a crash before the rename leaves a zero-length claim, never a
 *  partial key. */
async function claimDestination(path: string): Promise<DestinationClaim | null> {
  let created = false
  let identity: DestinationClaim | null = null
  try {
    const handle = await open(path, 'wx', 0o600)
    created = true
    try {
      // Capture the inode before writing the marker: if the write stalls past
      // the recovery threshold, a concurrent process may quarantine this claim
      // and install a real key. Cleanup must then leave that key alone.
      const info = await handle.stat()
      const payload = claimPayload(process.pid)
      identity = { dev: info.dev, ino: info.ino, payload }
      await handle.writeFile(payload, 'utf8')
      // The marker is advisory; SMB/FUSE mounts that reject hard links also
      // commonly reject fsync (EINVAL/EPERM/EIO). A crash leaves a claim that
      // age-bounded recovery handles, so never fail first-run creation here.
      await handle.sync().catch(() => undefined)
      return identity
    } finally {
      await handle.close().catch(() => undefined)
    }
  } catch (error: unknown) {
    if (isNodeError(error, 'EEXIST')) return null
    // Do not leave a claim behind when the caller never receives its identity.
    // If we could not even stat our own claim, leave it for age-bounded
    // recovery: an unconditional rm could delete a key installed by a
    // concurrent recovery after it quarantined the empty claim.
    if (identity) await releaseClaim(path, identity)
    throw error
  }
}

/** The claim inode is the ownership token. A creator must re-check it directly
 *  before replacing the claim with its key; otherwise a concurrent recovery
 *  could have already installed a different key at the path. */
async function ownsClaim(path: string, claim: DestinationClaim): Promise<boolean> {
  // The payload contains a per-claim nonce, so it is an ownership token even
  // when the filesystem reports dev/ino as 0 (some SMB/FAT mounts). Verify it
  // immediately before the caller renames over the path.
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current !== claim.payload) return false
  if (claim.dev === 0 || claim.ino === 0) return true
  const info = await stat(path).catch(() => null)
  return info !== null && info.dev === claim.dev && info.ino === claim.ino
}

/** Remove a claim only after moving it aside and proving the moved bytes are
 *  still our nonce-bearing marker. Never stat+rm the path: a concurrent
 *  recovery can install a real key between those two operations. */
async function releaseClaim(path: string, claim: DestinationClaim): Promise<void> {
  const quarantine = `${path}.released-claim-${Date.now()}-${randomUUID()}`
  try {
    await rename(path, quarantine)
  } catch (error: unknown) {
    if (!isNodeError(error, 'ENOENT')) {
      warn(`could not move the claim at ${path} aside for release: ${errorMessage(error)}`)
    }
    return
  }
  let moved: Buffer | null = null
  try {
    moved = await readFile(quarantine)
  } catch {
    // Fall through to restore; a missing quarantine means another process won.
  }
  const payload = Buffer.from(claim.payload)
  // A failed marker write can leave a prefix of our payload; it is still ours.
  const empty = moved !== null && moved.length === 0
  const partial = moved !== null && moved.length > 0 && moved.length < payload.length
    && payload.subarray(0, moved.length).equals(moved)
  if (moved?.equals(payload) || partial || empty) {
    await rm(quarantine, { force: true }).catch((error: unknown) => {
      warn(`could not remove the released claim at ${quarantine}: ${errorMessage(error)}`)
    })
    return
  }
  const restored = await restoreQuarantined(quarantine, path)
  if (!restored) {
    warn(`the file moved from ${path} was not our claim and could not be restored from ${quarantine}`)
  }
}

/** Serialize claim creation/rename against claim recovery. Recovery never
 *  blocks on this lock; it reports a live claim so its caller retries. */
const CLAIM_LOCK_STALE_MS = 30_000

async function acquireClaimLock(path: string): Promise<boolean> {
  const lock = `${path}.claim-lock`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lock, 'wx', 0o600)
      try {
        await handle.writeFile(`${process.pid} ${Date.now()}\n`, 'utf8')
      } finally {
        await handle.close().catch(() => undefined)
      }
      return true
    } catch (error: unknown) {
      if (!isNodeError(error, 'EEXIST')) throw error
      const info = await stat(lock).catch(() => null)
      if (!info || Date.now() - info.mtimeMs > CLAIM_LOCK_STALE_MS) {
        await rm(lock, { force: true }).catch(() => undefined)
        continue
      }
      return false
    }
  }
  return false
}

async function releaseClaimLock(path: string): Promise<void> {
  await rm(`${path}.claim-lock`, { force: true }).catch(() => undefined)
}

type ClaimContent = 'ready' | 'empty' | 'missing'

const CLAIM_MAGIC = 'openalice-sealing-claim '
const CLAIM_RECOVERY_MS = 5_000
// systemd-creds can run for SYSTEMD_CREDS_TIMEOUT_MS while holding a credential
// claim; recovery must not quarantine a live writer before that budget ends.
export const CREDENTIAL_CLAIM_RECOVERY_MS = SYSTEMD_CREDS_TIMEOUT_MS + 10_000
// Wait past the recovery threshold so a crashed creator is recovered by the
// same startup instead of failing once and requiring the user to retry.
const CLAIM_WAIT_MS = CLAIM_RECOVERY_MS + 1_000
const CREDENTIAL_CLAIM_WAIT_MS = CREDENTIAL_CLAIM_RECOVERY_MS + 5_000

let cachedBootId: string | null | undefined

/** A boot id makes a claim from a previous boot recognisably stale. It is
 *  recorded for diagnostics and future recovery policy; recovery itself is
 *  age-bounded because a PID from another PID namespace cannot be probed. */
function bootId(): string {
  if (cachedBootId === undefined) {
    try {
      cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null
    } catch {
      cachedBootId = null
    }
  }
  return cachedBootId ?? 'unknown'
}

interface ClaimRecord {
  readonly pid: number
  readonly bootId: string
  readonly nonce: string
  readonly createdAt: number
}

function claimPayload(pid: number): string {
  return `${CLAIM_MAGIC}${pid} ${bootId()} ${randomUUID()} ${Date.now()}\n`
}

function parseClaim(raw: Buffer | string): ClaimRecord | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  // A crash during the marker write can leave a prefix of the magic. Treat it
  // as an ownerless claim so age-bounded recovery can clear it instead of
  // reporting a permanently malformed key.
  if (text.length > 0 && text.length < CLAIM_MAGIC.length && CLAIM_MAGIC.startsWith(text)) {
    return { pid: 0, bootId: '', nonce: '', createdAt: 0 }
  }
  if (!text.startsWith(CLAIM_MAGIC)) return null
  const parts = text.slice(CLAIM_MAGIC.length).trim().split(/\s+/)
  const pid = Number(parts[0])
  // A crash during the marker write can leave the magic prefix with no valid
  // pid. Treat it as an ownerless claim so age-bounded recovery can quarantine
  // it instead of reporting a malformed key forever.
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { pid: 0, bootId: '', nonce: '', createdAt: 0 }
  }
  const createdAt = Number(parts[3])
  return {
    pid,
    bootId: parts[1] ?? '',
    nonce: parts[2] ?? '',
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
  }
}

function parseClaimPid(raw: Buffer | string): number | null {
  return parseClaim(raw)?.pid ?? null
}

function liveClaimMessage(path: string, pid: number): string {
  return `${path} is a live claim held by process ${pid}; another OpenAlice process is creating the sealing key. ` +
    'Retry after that process finishes.'
}

async function waitForNonEmpty(path: string, timeoutMs = 500, recoveryMs = CLAIM_RECOVERY_MS): Promise<ClaimContent> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const info = await stat(path)
      if (info.size > 0) return 'ready'
      // A stale zero-length claim is crash residue, not an in-progress write.
      // Do not make every read pay the full timeout for it.
      if (Date.now() - info.mtimeMs > recoveryMs) return 'empty'
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) return 'missing'
      throw error
    }
    if (Date.now() >= deadline) return 'empty'
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

type ClaimState = 'dead' | 'live' | 'gone' | 'unknown'

async function recoverEmptyClaim(path: string, recoveryMs = CLAIM_RECOVERY_MS): Promise<ClaimState> {
  const info = await stat(path).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (!info) return 'gone'
  if (info.size > 0) return 'live'
  const age = Date.now() - info.mtimeMs
  if (age >= -recoveryMs && age < recoveryMs) return 'live'
  // A writer holds this lock across claim creation and rename. Do not block:
  // report live so the caller waits and retries after the writer finishes.
  if (!(await acquireClaimLock(path))) return 'live'
  const quarantine = `${path}.dead-claim-${Date.now()}-${randomUUID()}`
  try {
    try {
      await rename(path, quarantine)
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) return 'gone'
      return 'unknown'
    }
    const moved = await stat(quarantine).catch(() => null)
    if (!moved || moved.size !== 0) {
      const restored = await restoreQuarantined(quarantine, path)
      if (!restored) {
        warn(`an interrupted claim at ${path} could not be restored from ${quarantine}`)
        return 'unknown'
      }
      return 'live'
    }
    await rm(quarantine, { force: true }).catch((error: unknown) => {
      warn(`could not remove the empty-claim quarantine at ${quarantine}: ${errorMessage(error)}`)
    })
    warn(`${path} was a stale zero-length claim; removed`)
    return 'dead'
  } finally {
    // Keep the lock across rename + verification + restore. Releasing it after
    // the rename lets a creator install a key that the unlocked restore then
    // displaces.
    await releaseClaimLock(path)
  }
}

async function isClaimFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  if (!info) return false
  if (info.size === 0) return true
  const raw = await readFile(path, 'utf8').catch(() => '')
  return raw.startsWith(CLAIM_MAGIC)
}

async function restoreQuarantined(quarantine: string, path: string): Promise<boolean> {
  const removeQuarantine = async (): Promise<void> => {
    await rm(quarantine, { force: true }).catch((error: unknown) => {
      warn(`could not remove restored quarantine at ${quarantine}: ${errorMessage(error)}`)
    })
  }
  const displaceClaim = async (): Promise<string | null> => {
    if (!(await isClaimFile(path))) return null
    const displaced = `${path}.displaced-claim-${Date.now()}-${randomUUID()}`
    try {
      await rename(path, displaced)
      return displaced
    } catch {
      return null
    }
  }
  const discardDisplacedIfClaim = async (displaced: string | null): Promise<void> => {
    if (!displaced) return
    const content = await readFile(displaced, 'utf8').catch(() => null)
    if (content !== null && (content === '' || content.startsWith(CLAIM_MAGIC))) {
      await rm(displaced, { force: true }).catch(() => undefined)
    } else {
      warn(`a displaced file at ${displaced} was not a claim; left in place for recovery`)
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const displaced = await displaceClaim()
    try {
      await link(quarantine, path)
      await removeQuarantine()
      await discardDisplacedIfClaim(displaced)
      return true
    } catch (error: unknown) {
      if (isNodeError(error, 'EEXIST')) {
        await discardDisplacedIfClaim(displaced)
        continue
      }
      if (!isLinkUnsupported(error)) {
        await discardDisplacedIfClaim(displaced)
        return false
      }
      try {
        await copyFile(quarantine, path, constants.COPYFILE_EXCL)
        await removeQuarantine()
        await discardDisplacedIfClaim(displaced)
        return true
      } catch (copyError: unknown) {
        await discardDisplacedIfClaim(displaced)
        if (isNodeError(copyError, 'EEXIST')) continue
        return false
      }
    }
  }
  return false
}

/** Move a claim aside and prove that the inode we moved is still the claim we
 *  read. The pid is not used for liveness: a pid from another PID namespace or
 *  a reused pid would be misclassified, and a live creator can be stalled. The
 *  age bound makes recovery finite; a creator that lost its claim checks the
 *  inode before renaming and adopts the winner's key instead of overwriting it.
 *  A zero-length claim has no owner record and is never auto-removed. */
async function recoverClaim(path: string, raw: Buffer | string, recoveryMs = CLAIM_RECOVERY_MS): Promise<ClaimState> {
  const claim = parseClaim(raw)
  if (!claim) return 'unknown'
  const info = await stat(path).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (!info) return 'gone'
  // Use the filesystem mtime, not the payload timestamp: a bogus future
  // timestamp must not make a stale claim immortal. A far-future mtime from
  // SMB/NFS clock skew is treated as stale; a small negative age is still live.
  const age = Date.now() - info.mtimeMs
  if (age >= -recoveryMs && age < recoveryMs) return 'live'

  if (!(await acquireClaimLock(path))) return 'live'
  const quarantine = `${path}.dead-claim-${Date.now()}-${randomUUID()}`
  try {
    try {
      await rename(path, quarantine)
    } catch (error: unknown) {
      // Another process recovered it first; the caller re-reads the destination.
      if (isNodeError(error, 'ENOENT')) return 'gone'
      warn(`could not quarantine the stale claim at ${path}: ${errorMessage(error)}`)
      return 'unknown'
    }
    let moved: Buffer
    try {
      moved = await readFile(quarantine)
    } catch (error: unknown) {
      warn(`could not verify the quarantined claim at ${quarantine}: ${errorMessage(error)}`)
      // The quarantine may hold a real key moved after our read; restore it
      // rather than leaving the destination empty.
      const restored = await restoreQuarantined(quarantine, path)
      return restored ? 'live' : 'unknown'
    }
    // The path may have been replaced between our read and the rename. Never
    // treat a real key as a dead claim: restore it create-if-absent.
    if (!moved.equals(Buffer.isBuffer(raw) ? raw : Buffer.from(raw))) {
      const restored = await restoreQuarantined(quarantine, path)
      if (!restored) {
        warn(`the quarantined file at ${quarantine} was not a claim and could not be restored to ${path}`)
        return 'unknown'
      }
      return 'live'
    }
    // The quarantined bytes are only the claim marker, not key material; remove
    // them so crash residue cannot accumulate in the state directory.
    await rm(quarantine, { force: true }).catch((error: unknown) => {
      warn(`could not remove the stale claim quarantine at ${quarantine}: ${errorMessage(error)}`)
    })
    warn(`${path} was a claim left by process ${claim.pid}; removed`)
    return 'dead'
  } finally {
    // Keep the lock across rename + verification + restore; see recoverEmptyClaim.
    await releaseClaimLock(path)
  }
}

/** Age-bounded recovery for a sealing key/credential path, exposed so the
 *  desktop relocation can distinguish a live claim from crash residue without
 *  duplicating the marker format. */
export async function recoverSealingClaimFile(
  path: string,
  recoveryMs = CLAIM_RECOVERY_MS,
): Promise<'live' | 'stale' | 'absent' | 'occupied' | 'unknown'> {
  const info = await stat(path).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (!info) return 'absent'
  if (info.size === 0) {
    const state = await recoverEmptyClaim(path, recoveryMs)
    return state === 'dead' ? 'stale' : state === 'gone' ? 'absent' : state === 'live' ? 'live' : 'unknown'
  }
  const raw = await readFile(path).catch(() => null)
  if (!raw) return 'unknown'
  if (!parseClaim(raw)) return 'occupied'
  const state = await recoverClaim(path, raw, recoveryMs)
  return state === 'dead' ? 'stale' : state === 'gone' ? 'absent' : state === 'live' ? 'live' : 'unknown'
}

function emptyClaimMessage(path: string): string {
  return `${path} is empty; another OpenAlice process may be creating it. ` +
    'Retry after that process finishes; if no OpenAlice process is running, remove the empty file and restart.'
}

function isTransientClaimError(error: unknown): boolean {
  return error instanceof TransientClaimError
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
 * legacy key is also present and matches the recorded fingerprint; a missing
 * or unreadable fingerprint refuses the fallback. That keeps a copied home
 * readable while refusing a stale key, and never mints a fresh key over
 * existing ciphertext.
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
  await sweepStaleSealingTemps(home)
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
        await rm(sealingKeyPath(home), { force: true }).catch((error: unknown) => {
          warn(`could not remove ${sealingKeyPath(home)} after migration: ${errorMessage(error)}`)
        })
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
    // A live/empty claim is transient and says "retry", not "restore the
    // fingerprint". Only a settled credential failure may use the fingerprint
    // fallback.
    if (isTransientClaimError(credentialError)) throw credentialError
    if (backend === 'auto' && legacy.key) {
      // A copied home can contain an encrypted credential bound to another
      // machine plus the original plaintext key. Only trust that fallback when
      // the key matches the fingerprint recorded next to the credential;
      // otherwise a stale legacy key would silently cause every sealed store
      // to be quarantined after unseal fails.
      const recorded = await readKeyFingerprint(home)
      if (recorded === null) {
        throw new SealingKeyConflictError(
          `cannot verify ${sealingKeyPath(home)} because ${sealingKeyFingerprintPath(home)} is missing or unreadable; ` +
          `restore the fingerprint from the same backup as ${sealingKeyCredentialPath(home)}. ` +
          'Do not remove the credential until you have verified the key and backed it up.',
        )
      }
      if (recorded !== keyFingerprint(legacy.key)) {
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
      // A live/empty claim is transient: the other creator may install a
      // different credential, so returning the plaintext key would diverge.
      if (isTransientClaimError(error)) throw error
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
    if (isTransientClaimError(error)) throw error
    let credential: Buffer | null = null
    try {
      credential = await readCredentialKey(home, env)
    } catch (readError: unknown) {
      // A live/empty claim is transient; do not fall back to the plaintext key
      // while another process may be installing a different credential.
      if (isTransientClaimError(readError)) throw readError
    }
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

async function readFileKey(home: string, waitUntil = 0): Promise<Buffer | null> {
  const path = sealingKeyPath(home)
  // Bind validation and read to one descriptor. A separate lstat+readFile
  // lets a same-UID process swap in a symlink or FIFO between the checks.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  const handle = await open(path, flags).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    if (isNodeError(error, 'ELOOP')) {
      throw new SealingBackendUnavailableError(`${path} must not be a symlink`)
    }
    throw error
  })
  if (!handle) return null
  let raw: string
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      throw new SealingBackendUnavailableError(`${path} must be a regular file`)
    }
    raw = await handle.readFile('utf-8')
  } finally {
    await handle.close().catch(() => undefined)
  }
  try {
    return parseKeyMaterial(raw)
  } catch (error: unknown) {
    if (!(error instanceof UnsealError)) throw error
    const claim = parseClaim(raw)
    if (claim) {
      const state = await recoverClaim(path, raw)
      if (state === 'dead') return null
      const deadline = waitUntil > 0 ? waitUntil : Date.now() + CLAIM_WAIT_MS
      if (state === 'gone') {
        if (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25))
          return readFileKey(home, deadline)
        }
        return null
      }
      if (state === 'live') {
        if (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return readFileKey(home, deadline)
        }
        throw new TransientClaimError(liveClaimMessage(path, claim.pid), error)
      }
      throw new TransientClaimError(`could not clear the stale claim at ${path}`, error)
    }
    // A zero-length final path has no owner record (crash between O_EXCL and
    // the marker write). Do not guess that it is dead: a live creator stalled
    // before writing the marker would diverge if this path were moved aside.
    let size = -1
    try {
      size = (await stat(path)).size
    } catch (statError: unknown) {
      if (isNodeError(statError, 'ENOENT')) return null
      throw statError
    }
    if (size === 0) {
      const state = await recoverEmptyClaim(path)
      if (state === 'dead') return null
      if (state === 'gone') return null
      if (state === 'live') {
        // A fresh empty file may be a writer between O_EXCL and its marker
        // write; fail closed quickly. Once it is older than the recovery
        // threshold, recoverEmptyClaim quarantines it.
        throw new TransientClaimError(emptyClaimMessage(path), error)
      }
      throw new TransientClaimError(`could not clear the empty claim at ${path}`, error)
    }
    // A malformed legacy key is a key-store failure, not a ciphertext
    // authentication failure; callers must not quarantine sealed files.
    throw new SealingBackendUnavailableError(
      `legacy sealing key at ${path} is malformed: ${error.message}`,
      error,
    )
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

async function readFileKeyAfterClaim(home: string): Promise<Buffer | null> {
  const path = sealingKeyPath(home)
  const content = await waitForNonEmpty(path, CLAIM_WAIT_MS)
  if (content === 'missing') return null
  // readFileKey performs the age-bounded recovery of a stale zero-length
  // claim; a fresh empty file still fails closed after the wait.
  return readFileKey(home, Date.now() + CLAIM_WAIT_MS)
}

async function createFileKey(home: string, attempt = 0): Promise<{ key: Buffer; created: boolean }> {
  const key = randomBytes(SEALING_KEY_BYTES)
  const path = sealingKeyPath(home)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), fileKeyTempName(process.pid, randomUUID()))
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
        const raced = await readFileKeyAfterClaim(home)
        if (raced) return { key: raced, created: false }
        // A dead claim was moved aside, so the destination is free again.
        if (attempt < 1) return createFileKey(home, attempt + 1)
        throw error
      }
      if (!isLinkUnsupported(error)) throw error
      // exFAT/FAT32 and some SMB/NFS mounts reject hard links. Reserve the
      // final path with O_EXCL, then atomically rename the complete temp over
      // our own claim. A concurrent creator loses the claim and converges on
      // our key; a crash leaves a zero-length claim, never a partial key.
      if (!(await acquireClaimLock(path))) {
        const raced = await readFileKeyAfterClaim(home)
        if (raced) return { key: raced, created: false }
        if (attempt < 1) return createFileKey(home, attempt + 1)
        throw new SealingKeyConflictError('sealing key claim lock is held by another process')
      }
      let installed = false
      try {
        const claim = await claimDestination(path)
        if (claim && await ownsClaim(path, claim)) {
          try {
            await rename(temporary, path)
            installed = true
          } catch (renameError: unknown) {
            await releaseClaim(path, claim)
            throw renameError
          }
        }
      } finally {
        await releaseClaimLock(path)
      }
      if (installed) {
        // A chmod failure must not run releaseClaim: rename already replaced
        // the claim with the real key, so the inode no longer matches and a
        // best-effort removal could delete the key on a filesystem with
        // unreliable inode numbers.
        await ensureOwnerOnly(path, 0o600)
        return { key, created: true }
      }
      const raced = await readFileKeyAfterClaim(home)
      if (raced) return { key: raced, created: false }
      if (attempt < 1) return createFileKey(home, attempt + 1)
      throw new SealingKeyConflictError('sealing key claim changed before the key was installed')
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

async function readCredentialKey(home: string, env: NodeJS.ProcessEnv, attempt = 0): Promise<Buffer | null> {
  const path = sealingKeyCredentialPath(home)
  const initialInfo = await stat(path).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (!initialInfo) return null
  const content = await waitForNonEmpty(path)
  if (content === 'missing') return null
  if (content === 'empty') {
    return (await readCredentialAfterClaim(path, env))?.key ?? null
  }
  const raw = await readFile(path).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (!raw) return null
  const claim = parseClaim(raw)
  if (claim) {
    // Validate the claim before consulting the cache: a deleted credential
    // recreated as a claim must not return the previous process's key.
    return (await readCredentialAfterClaim(path, env))?.key ?? null
  }
  // Bind the cache lookup to the identity after the bytes were read, not the
  // pre-read stat: a replacement during waitForNonEmpty/readFile must not
  // return the previous credential's key.
  const info = await stat(path).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (!info) return null
  const cached = credentialKeyCache.get(path)
  if (cached && sameIdentity(info, cached)) return cached.key
  const key = await decryptCredentialKey(path, env)
  // decryptCredentialKey opens the path itself and can run for 15s. Bind the
  // returned key to the identity after the decrypt, not before it.
  const after = await stat(path).catch(() => null)
  if (!after || !sameIdentity(after, info)) {
    if (attempt < 1) return readCredentialKey(home, env, 1)
    throw new TransientClaimError('credential changed while it was being read')
  }
  if (!(await cacheCredential(path, key, info))) {
    throw new TransientClaimError('credential changed while it was being read')
  }
  return key
}

async function decryptCredentialKey(path: string, env: NodeJS.ProcessEnv): Promise<Buffer> {
  // A zero-length credential is the crash residue of an interrupted claim.
  // Report it as such before spawning systemd-creds, whose error would be
  // opaque ("could not decrypt ...").
  const info = await stat(path).catch(() => null)
  if (info?.size === 0) throw new TransientClaimError(emptyClaimMessage(path))
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

interface VerifiedCredential {
  readonly key: Buffer
  readonly identity: CredentialIdentity
}

async function readCredentialAfterClaim(path: string, env: NodeJS.ProcessEnv): Promise<VerifiedCredential | null> {
  const deadline = Date.now() + CREDENTIAL_CLAIM_WAIT_MS
  for (;;) {
    const content = await waitForNonEmpty(path, 100, CREDENTIAL_CLAIM_RECOVERY_MS)
    if (content === 'missing') {
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        continue
      }
      return null
    }
    if (content === 'empty') {
      const state = await recoverEmptyClaim(path, CREDENTIAL_CLAIM_RECOVERY_MS)
      if (state === 'dead' || state === 'gone') return null
      if (state === 'live') {
        if (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          continue
        }
        throw new TransientClaimError(emptyClaimMessage(path))
      }
      throw new TransientClaimError(`could not clear the empty claim at ${path}`)
    }
    const raw = await readFile(path).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    })
    if (!raw) {
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        continue
      }
      return null
    }
    const claim = parseClaim(raw)
    if (!claim) {
      const before = await stat(path).catch(() => null)
      if (!before) {
        if (Date.now() < deadline) continue
        return null
      }
      const key = await decryptCredentialKey(path, env)
      const after = await stat(path).catch(() => null)
      if (!after || !sameIdentity(before, after)) {
        if (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25))
          continue
        }
        throw new TransientClaimError('credential changed while it was being read')
      }
      return { key, identity: after }
    }
    const state = await recoverClaim(path, raw, CREDENTIAL_CLAIM_RECOVERY_MS)
    if (state === 'dead') return null
    if (state === 'gone') {
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        continue
      }
      return null
    }
    if (state === 'live') {
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        continue
      }
      throw new TransientClaimError(liveClaimMessage(path, claim.pid))
    }
    throw new TransientClaimError(`could not clear the stale claim at ${path}`)
  }
}

async function writeCredentialKey(
  home: string,
  key: Buffer,
  env: NodeJS.ProcessEnv,
  attempt = 0,
): Promise<Buffer> {
  const path = sealingKeyCredentialPath(home)
  const stateDir = dirname(path)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await ensureOwnerOnly(stateDir, 0o700)
  const output = join(stateDir, credentialTempName(process.pid, randomUUID()))
  let installed: CredentialIdentity | null = null
  // Adopt a credential only if its identity is stable across the read. A
  // replacement between the read and the cache/fingerprint write must not
  // bind the old key to the new file.
  const adoptExisting = async (): Promise<Buffer | null> => {
    const existing = await readCredentialAfterClaim(path, env)
    if (!existing) return null
    // Use the identity verified by readCredentialAfterClaim. Re-statting here
    // and caching the old key under a replacement inode would make every later
    // read return the stale key without decrypting.
    if (!(await cacheCredential(path, existing.key, existing.identity))) return null
    await writeKeyFingerprint(home, existing.key)
    return existing.key
  }
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
      // Capture our inode from the temp hard link, not the final path: another
      // process may replace the path before this stat.
      installed = await stat(output)
    } catch (error: unknown) {
      if (isNodeError(error, 'EEXIST')) {
        const existing = await adoptExisting()
        if (existing) return existing
        if (attempt < 1) return writeCredentialKey(home, key, env, attempt + 1)
        throw new SealingKeyConflictError('credential appeared at the destination but could not be read')
      }
      if (!isLinkUnsupported(error)) throw error
      // Reserve the final path with O_EXCL, then atomically rename the
      // complete systemd-creds output over our own claim. A concurrent first
      // seal loses the claim and converges on ours; a crash leaves an empty
      // claim, never a partial credential.
      if (!(await acquireClaimLock(path))) {
        const existing = await adoptExisting()
        if (existing) return existing
        if (attempt < 1) return writeCredentialKey(home, key, env, attempt + 1)
        throw new SealingKeyConflictError('credential claim lock is held by another process')
      }
      try {
        const claim = await claimDestination(path)
        if (claim && await ownsClaim(path, claim)) {
          try {
            const outputIdentity = await stat(output)
            await rename(output, path)
            installed = outputIdentity
          } catch (renameError: unknown) {
            await releaseClaim(path, claim)
            throw renameError
          }
        }
      } finally {
        await releaseClaimLock(path)
      }
      if (!installed) {
        // The lock holder lost the claim race; adopt the winner outside the
        // lock so recovery can run.
        const existing = await adoptExisting()
        if (existing) return existing
        if (attempt < 1) return writeCredentialKey(home, key, env, attempt + 1)
        throw new SealingKeyConflictError('credential claim changed before the key was installed')
      }
    }
    // Keep the credential if only the chmod fails; releaseClaim after a
    // successful rename could remove the new file when dev/ino are unreliable.
    await ensureOwnerOnly(path, 0o600)
    // Verify before deleting the caller's only plaintext copy. If the
    // read-back fails or returns different material, remove the bad
    // credential so the next run can retry instead of being stuck on it.
    let roundTrip: Buffer
    try {
      roundTrip = await decryptCredentialKey(path, env)
    } catch (error: unknown) {
      // Only remove the credential this call installed. Another process may
      // have replaced it while systemd-creds was running; deleting that file
      // would destroy a valid key.
      await removeCredentialIfSame(path, installed)
      throw error
    }
    if (!roundTrip.equals(key)) {
      await removeCredentialIfSame(path, installed)
      throw new SealingBackendUnavailableError('systemd-creds credential did not round-trip')
    }
    if (!(await cacheCredential(path, roundTrip, installed ?? undefined))) {
      // Another process replaced the credential after the round-trip. Do not
      // return this key: migrateLegacyKey would delete the only plaintext copy
      // while the installed credential holds different material.
      throw new TransientClaimError('credential changed while it was being verified')
    }
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
