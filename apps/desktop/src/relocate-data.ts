/**
 * One-time relocation of the packaged app's user data store.
 *
 * Until the global-root change, the packaged backend kept user data under
 * Electron's userData dir (~/Library/Application Support/OpenAlice/data on
 * macOS). The user-data home is now ~/.openalice — shared with `pnpm dev`
 * and bare `pnpm start` — so an existing store must move once, before the
 * shell reads ports.json from the new root or spawns the backend (which
 * would run migrations against an empty store).
 *
 * Scope: `<userData>/data` plus the machine-bound key files that live beside
 * it. userData also holds Electron's browser-profile state (Cache, Local
 * Storage, …) which must stay.
 *
 * Crash safety:
 *   - same-volume: a single rename — atomic, nothing to clean up.
 *   - cross-volume (EXDEV): copy into `<newRoot>/.data.relocating`, then
 *     rename into place. A crash mid-copy leaves only the tmp dir, which is
 *     swept and re-copied on next boot; a crash after the commit rename is
 *     absorbed by the idempotency guard. The legacy dir is kept as
 *     `data.relocated` — never deleted, it's the user's trading history.
 *   - key files are copied to a unique temp path and linked into place, so a
 *     crash cannot leave a half-written key at the final path.
 */

import { constants, existsSync } from 'node:fs'
import { chmod, copyFile, cp, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'

import {
  CREDENTIAL_CLAIM_RECOVERY_MS,
  LOCAL_TOKEN_PATTERN,
  localTokenPath,
  readKey,
  recoverSealingClaimFile,
  sealingKeyCredentialPath,
  sealingKeyFingerprintPath,
  sealingKeyPath,
} from '@traderalice/sealing-key'

const RELOCATE_CLAIM_PREFIX = 'openalice-relocate-claim '
const RELOCATE_CLAIM_MAX_AGE_MS = 5_000

interface RelocateClaim {
  readonly dev: number
  readonly ino: number
  readonly payload: string
}

async function createRelocateClaim(path: string): Promise<RelocateClaim | null> {
  const payload = `${RELOCATE_CLAIM_PREFIX}${process.pid} ${randomUUID()}\n`
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
    throw error
  }
  try {
    const info = await handle.stat()
    await handle.writeFile(payload, 'utf8')
    return { dev: info.dev, ino: info.ino, payload }
  } catch (error: unknown) {
    await handle.close().catch(() => undefined)
    // The marker may be partial if writeFile failed; release only our bytes.
    await releaseRelocateClaim(path, { dev: 0, ino: 0, payload }).catch(() => undefined)
    throw error
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function ownsRelocateClaim(path: string, claim: RelocateClaim): Promise<boolean> {
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current !== claim.payload) return false
  if (claim.dev === 0 || claim.ino === 0) return true
  const info = await stat(path).catch(() => null)
  return info !== null && info.dev === claim.dev && info.ino === claim.ino
}

async function releaseRelocateClaim(path: string, claim: RelocateClaim): Promise<void> {
  const quarantine = `${path}.released-relocate-claim-${Date.now()}-${randomUUID()}`
  try {
    await rename(path, quarantine)
  } catch {
    // Already replaced or gone.
    return
  }
  const moved = await readFile(quarantine, 'utf8').catch(() => null)
  const payload = claim.payload
  // A failed marker write can leave a prefix; it is still our claim.
  const partial = moved !== null && moved.length > 0 && moved.length < payload.length && payload.startsWith(moved)
  if (moved === payload || partial) {
    await rm(quarantine, { force: true }).catch(() => undefined)
    return
  }
  // A real key was moved after our read; put it back without overwriting a
  // newer occupant.
  const restored = await restoreRelocateFile(quarantine, path)
  if (!restored) {
    console.warn(`[relocate] could not restore ${path} from ${quarantine}; left for manual recovery`)
  }
}

/** Restore a quarantined file create-if-absent, including on filesystems that
 *  reject hard links. Never overwrite a newer file at the destination. */
async function restoreRelocateFile(quarantine: string, path: string): Promise<boolean> {
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

/** Remove a relocation claim left by a crash. A claim is a complete marker,
 *  so a crash before the rename leaves no partial destination key. */
async function recoverStaleRelocateClaim(path: string): Promise<'absent' | 'recovered' | 'live'> {
  const info = await stat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!info) return 'absent'
  if (info.size > 0) {
    const content = await readFile(path, 'utf8').catch(() => null)
    // An unreadable file may be a real key; do not classify it as a claim.
    if (content === null) return 'live'
    // A crash during the marker write can leave a prefix of the magic; treat
    // it as an ownerless claim so age-bounded recovery can clear it.
    const partialClaim = content.length > 0 && RELOCATE_CLAIM_PREFIX.startsWith(content)
    if (!partialClaim && !content.startsWith(RELOCATE_CLAIM_PREFIX)) return 'absent'
  }
  // Clock skew can put mtime in the future; a far-future claim must not be
  // treated as live forever.
  const age = Date.now() - info.mtimeMs
  if (age >= -RELOCATE_CLAIM_MAX_AGE_MS && age < RELOCATE_CLAIM_MAX_AGE_MS) return 'live'
  const quarantine = `${path}.stale-relocate-claim-${Date.now()}-${randomUUID()}`
  try {
    await rename(path, quarantine)
  } catch {
    return 'live'
  }
  const movedInfo = await stat(quarantine).catch(() => null)
  if (!movedInfo) return 'recovered'
  if (movedInfo.size === 0) {
    await rm(quarantine, { force: true }).catch(() => undefined)
    return 'recovered'
  }
  const moved = await readFile(quarantine, 'utf8').catch(() => null)
  const partialMoved = moved !== null && moved.length > 0 && RELOCATE_CLAIM_PREFIX.startsWith(moved)
  if (moved !== null && (moved.startsWith(RELOCATE_CLAIM_PREFIX) || partialMoved)) {
    await rm(quarantine, { force: true }).catch(() => undefined)
    return 'recovered'
  }
  // A real key was moved after our read; put it back create-if-absent.
  if (!(await restoreRelocateFile(quarantine, path))) {
    console.warn(`[relocate] could not restore ${path} from ${quarantine}; left for manual recovery`)
  }
  return 'live'
}

/** A live claim is not key material. The sealing-key package owns the age
 *  bound and marker format, so relocation asks it to recover stale claims
 *  instead of copying the parser. */
async function sealingClaimIsLive(path: string, recoveryMs?: number): Promise<boolean> {
  const state = await recoverSealingClaimFile(path, recoveryMs)
  return state === 'live' || state === 'unknown'
}

/** A credential writer can hold its claim across a 15s systemd-creds call. */
function claimRecoveryMs(path: string, legacyRoot: string): number | undefined {
  return path === sealingKeyCredentialPath(legacyRoot) ? CREDENTIAL_CLAIM_RECOVERY_MS : undefined
}

async function isUsableTokenFile(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null)
  if (!info || info.isSymbolicLink() || !info.isFile()) return false
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) return false
  const raw = await readFile(path, 'utf8').catch(() => null)
  return raw !== null && LOCAL_TOKEN_PATTERN.test(raw.trim())
}

export async function relocateLegacyData(
  legacyRoot: string,
  newRoot: string,
  onWarning?: (message: string) => void,
): Promise<'moved' | 'skipped'> {
  if (resolve(legacyRoot) === resolve(newRoot)) return 'skipped'
  try {
    if (await realpath(legacyRoot) === await realpath(newRoot)) return 'skipped'
  } catch {
    // One side may not exist yet; the lexical check above is enough.
  }
  const legacyData = join(legacyRoot, 'data')
  const newData = join(newRoot, 'data')
  let moved = false
  let dataMoved = false
  let keysMoved = false
  const keyFiles = [
    [sealingKeyPath(legacyRoot), sealingKeyPath(newRoot)],
    [sealingKeyCredentialPath(legacyRoot), sealingKeyCredentialPath(newRoot)],
  ] as const
  const fingerprintFiles = [
    [sealingKeyFingerprintPath(legacyRoot), sealingKeyFingerprintPath(newRoot)],
  ] as const
  const legacyToken = localTokenPath(legacyRoot)
  const newToken = localTokenPath(newRoot)
  // A crash between the token claim and its rename leaves a marker that is not
  // a valid oa1_ token; recover it even when there is no legacy token to move.
  await recoverStaleRelocateClaim(newToken)
  for (const [, to] of keyFiles) await recoverStaleRelocateClaim(to)
  // Rollback can create a relocate claim at a legacy key path on filesystems
  // that reject hard links; recover those too.
  for (const [from] of keyFiles) await recoverStaleRelocateClaim(from)
  const keyTargetExists = keyFiles.some(([, to]) => existsSync(to))
  const legacyKeyPresent = keyFiles.some(([from]) => existsSync(from))
    || fingerprintFiles.some(([from]) => existsSync(from))
    || existsSync(legacyToken)
  // Sweep before the early return: after a successful relocation the legacy
  // root is empty, so later boots must still clean crash-left temp files.
  await sweepStaleRelocationTemps(newRoot)
  // Rollback and failed moves create temps under the legacy root too.
  await sweepStaleRelocationTemps(legacyRoot)
  if (!existsSync(legacyData) && !legacyKeyPresent && !existsSync(join(legacyRoot, 'provider-keys.json'))) {
    return 'skipped'
  }
  const failures: string[] = []
  const keyRemovalFailures: string[] = []
  const destinationResidue: string[] = []
  const movedKeyDestinations = new Set<string>()
  const movedKeyPairs: Array<{ from: string; to: string }> = []
  const rollbackMovedKeys = async (): Promise<void> => {
    for (const pair of [...movedKeyPairs].reverse()) {
      try {
        const outcome = await moveIfAbsent(pair.to, pair.from)
        if (outcome === 'moved' || outcome === 'identical') {
          if (existsSync(pair.to)) {
            // moveIfAbsent only logs a failed source removal. Keep the pair
            // tracked and surface the destination residue instead of claiming
            // the rollback restored a clean single-copy state.
            destinationResidue.push(pair.to)
            console.warn(`[relocate] rollback left ${pair.to} in place`)
            continue
          }
          movedKeyDestinations.delete(pair.to)
          const index = movedKeyPairs.indexOf(pair)
          if (index >= 0) movedKeyPairs.splice(index, 1)
          // The legacy key is the only copy again; it is not redundant
          // residue, so do not tell the user to delete it.
          const failureIndex = keyRemovalFailures.indexOf(pair.from)
          if (failureIndex >= 0) keyRemovalFailures.splice(failureIndex, 1)
        }
      } catch (error: unknown) {
        // A concurrent writer changed the destination; leave it visible rather
        // than deleting a key this process cannot prove it created.
        console.warn(`[relocate] could not roll back ${pair.to}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // Re-check both key forms instead of trusting the caller's one-time
  // snapshot: a concurrent process can create the sibling form after startup.
  const destinationKeyAppeared = keyFiles.some(([, to]) => existsSync(to))
  const hasDestinationKey = keyTargetExists || destinationKeyAppeared
  let keysCompatible = !hasDestinationKey
  let keyComparisonError: string | null = null
  if (hasDestinationKey) {
    try {
      const destinationKey = await readKey(newRoot, process.env, { migrate: false })
      let legacyKey: Buffer | null = null
      let legacyKeyUnreadable = false
      try {
        legacyKey = await readKey(legacyRoot, process.env, { migrate: false })
      } catch (error: unknown) {
        legacyKeyUnreadable = true
        keyComparisonError = error instanceof Error ? error.message : String(error)
      }
      if (!legacyKey) {
        const legacyPathPresent = keyFiles.some(([from]) => existsSync(from))
        if (legacyKeyUnreadable && legacyPathPresent) {
          // A claim or unreadable key still occupies the legacy path; a
          // previous KEY-MOVED marker must not authorize deleting it.
          keysCompatible = false
          keyComparisonError ??= 'the legacy sealing key could not be read'
        } else {
        // The key was already moved by an earlier run and the data followed
        // it; the destination key is authoritative. If legacy data is still
        // present, only the marker written after a successful key move proves
        // that the destination key is the one that belongs to it.
        const keyMoved = existsSync(join(legacyRoot, 'KEY-MOVED.txt'))
        const dataAlreadyMoved = existsSync(newData) && !existsSync(legacyData)
        if ((dataAlreadyMoved || keyMoved) && destinationKey) {
          keysCompatible = true
        } else {
          keysCompatible = false
          keyComparisonError ??= 'the legacy sealing key is missing'
        }
        }
      } else {
        keysCompatible = !!destinationKey && legacyKey.equals(destinationKey)
        if (!keysCompatible) keyComparisonError ??= 'the legacy and destination keys differ'
      }
    } catch (error: unknown) {
      keysCompatible = false
      keyComparisonError = error instanceof Error ? error.message : String(error)
    }
    for (const [, to] of keyFiles) {
      try {
        if ((await lstat(to)).isSymbolicLink()) {
          keysCompatible = false
          keyComparisonError = `${to} is a symbolic link, not a regular key file`
          failures.push(keyComparisonError)
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          failures.push(`${to}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  // The machine key lives beside data/, not inside it. Move the legacy
  // plaintext key and encrypted credential with the store so sealed files
  // remain readable. The two key forms are one unit: if the destination
  // already has either form, do not add the other form beside it (that would
  // create an ambiguous key pair). Provider keys are independent.
  if (!hasDestinationKey && keyFiles.every(([from]) => existsSync(from))) {
    // Both legacy forms present: moving them verbatim is only safe if they
    // hold the same key. readKey() rejects a mismatch (and a live claim).
    // A live/empty claim is transient. Let the loop below leave the pair in
    // place with KEY-NOT-MOVED instead of failing startup with a read timeout.
    const claimLive = (await Promise.all(keyFiles.map(([from]) => sealingClaimIsLive(from, claimRecoveryMs(from, legacyRoot))))).some(Boolean)
    if (!claimLive) {
      try {
        await readKey(legacyRoot, process.env, { migrate: false })
      } catch (error: unknown) {
        throw new Error(
          `legacy sealing key and credential are not a usable pair: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  if (!hasDestinationKey && failures.length === 0) {
    // The fingerprint is a verifier used by copied-home/systemd-creds reads.
    // Move it before key material so a failure leaves the key in the legacy
    // root and a marker, never a moved key with no trust anchor.
    for (const [from, to] of fingerprintFiles) {
      if (!existsSync(from)) continue
      try {
        if (await moveIfAbsent(from, to) === 'moved') moved = true
      } catch (error: unknown) {
        // The fingerprint is a verifier, not key material. A conflict or
        // unreadable destination must not block the key/data move; the next
        // read recreates it.
        console.warn(`[relocate] could not move ${from}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  if (!hasDestinationKey && failures.length === 0) {
    for (const [from, to] of keyFiles) {
      if (await sealingClaimIsLive(from, claimRecoveryMs(from, legacyRoot))) {
        keysCompatible = false
        keyComparisonError = `${from} is a sealing-key claim or an interrupted empty claim`
        console.warn(`[relocate] ${keyComparisonError}; leaving the legacy key and data in place`)
        await rollbackMovedKeys()
        await writeFile(
          join(legacyRoot, 'KEY-NOT-MOVED.txt'),
          `OpenAlice found a live or interrupted sealing-key claim at ${from} and did not move it.\n` +
          'The legacy sealed stores were not moved. Retry after the other OpenAlice process finishes, or remove a stale claim after verifying no process is running.\n',
        ).catch(() => undefined)
        break
      }
      // A sibling form created after the preflight is still an ambiguous pair
      // unless this process moved it in this run. Check before moving the first
      // form so we never add a second key beside a concurrent one.
      const sibling = keyFiles.find(([, candidate]) => candidate !== to && !movedKeyDestinations.has(candidate))
      if (sibling && existsSync(sibling[1])) {
        keysCompatible = false
        keyComparisonError = `${sibling[1]} appeared while the legacy key was being moved`
        console.warn(`[relocate] ${keyComparisonError}`)
        await rollbackMovedKeys()
        break
      }
      try {
        const outcome = await moveIfAbsent(from, to)
        if (outcome === 'moved') {
          moved = true
          keysMoved = true
          movedKeyDestinations.add(to)
          movedKeyPairs.push({ from, to })
          if (existsSync(from)) {
            // moveIfAbsent only logs a failed cleanup; a readable plaintext
            // copy left in the old userData directory needs a visible marker.
            keyRemovalFailures.push(from)
            console.warn(`[relocate] could not remove the redundant legacy key at ${from}`)
          }
        } else if (outcome === 'identical') {
          // The destination was already correct; a crash after removing the
          // legacy copy still needs KEY-MOVED.txt to prove the key is there.
          keysMoved = true
          movedKeyDestinations.add(to)
          if (existsSync(from)) keyRemovalFailures.push(from)
        }
      } catch (error: unknown) {
        if (error instanceof MoveConflictError) {
          // A destination key appeared after the pre-check. The destination is
          // authoritative for its data; leave the legacy key and sealed
          // provider store in place and make the conflict visible instead of
          // failing startup.
          keysCompatible = false
          keyComparisonError = error.message
          console.warn(`[relocate] ${error.message}`)
          // A first key form may already have moved before this conflict. Put
          // it back so the destination is not left with an ambiguous pair.
          await rollbackMovedKeys()
          await rm(join(legacyRoot, 'KEY-MOVED.txt'), { force: true }).catch(() => undefined)
          await writeFile(
            join(legacyRoot, 'KEY-NOT-MOVED.txt'),
            'OpenAlice did not move all legacy sealing key material because the destination already has a different key.\n' +
            'The legacy sealed stores were not moved. Do not delete the legacy key until you have verified which one opens them.\n',
          ).catch((error: unknown) => {
            console.warn(`[relocate] could not write KEY-NOT-MOVED.txt: ${error instanceof Error ? error.message : String(error)}`)
          })
          // Stop: moving the remaining key form beside a different destination
          // key would create an ambiguous pair, and keysMoved from the other
          // form must not produce KEY-MOVED.txt.
          break
        } else {
          failures.push(`${from}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    // Verify the final destination pair before claiming success if a sibling
    // form appeared that this run did not move. readKey refuses an ambiguous
    // pair, and data must not move under it.
    const unexpectedDestination = keyFiles.some(([, to]) => existsSync(to) && !movedKeyDestinations.has(to))
    if (keysCompatible && failures.length === 0 && unexpectedDestination) {
      try {
        await readKey(newRoot, process.env, { migrate: false })
      } catch (error: unknown) {
        keysCompatible = false
        keyComparisonError = error instanceof Error ? error.message : String(error)
        console.warn(`[relocate] destination key pair is not usable: ${keyComparisonError}`)
        await rollbackMovedKeys()
      }
    }
    if (keysCompatible && keysMoved && failures.length === 0 && keyRemovalFailures.length === 0) {
      await writeFile(
        join(legacyRoot, 'KEY-MOVED.txt'),
        `OpenAlice moved the sealing key to ${newRoot} on ${new Date().toISOString()}\n`,
      ).catch((error: unknown) => {
        console.warn(`[relocate] could not write KEY-MOVED.txt: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  } else if (hasDestinationKey) {
    // If the destination key is the same, a legacy plaintext copy is
    // redundant; remove it instead of leaving a readable copy in the old
    // userData directory. If anything is ambiguous, keep it and write the
    // marker below. Never enter this branch when the destination has no key.
    if (keysCompatible) {
      // A crash during a previous copy may have left the destination key
      // group/other-readable. Fix the mode before removing the legacy copy.
      let destinationModesOk = true
      for (const [, to] of keyFiles) {
        if (!existsSync(to)) continue
        try {
          await ensurePrivateMode(to)
        } catch (error: unknown) {
          destinationModesOk = false
          failures.push(`${to}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (destinationModesOk) {
        let keysRemoved = false
        for (const [from] of keyFiles) {
          if (!existsSync(from)) continue
          if (await sealingClaimIsLive(from, claimRecoveryMs(from, legacyRoot))) {
            keysCompatible = false
            keyComparisonError = `${from} is a live sealing-key claim`
            console.warn(`[relocate] ${keyComparisonError}; not removing the legacy path`)
            break
          }
          try {
            await rm(from, { force: true })
            keysRemoved = true
            console.warn(`[relocate] removed the redundant legacy key at ${from}`)
          } catch (error: unknown) {
            // The destination key is already verified; a stale legacy copy is
            // a cleanup residue, not a reason to fail every later boot. Make
            // the residue visible: a packaged app has no console.
            console.warn(`[relocate] could not remove the redundant legacy key at ${from}: ${error instanceof Error ? error.message : String(error)}`)
            keyRemovalFailures.push(from)
          }
        }
        if (keysCompatible && keysRemoved && failures.length === 0 && keyRemovalFailures.length === 0) {
          await writeFile(
            join(legacyRoot, 'KEY-MOVED.txt'),
            `OpenAlice verified the destination key at ${newRoot} on ${new Date().toISOString()}\n`,
          ).catch(() => undefined)
        }
        for (const [from, to] of fingerprintFiles) {
          if (!existsSync(from)) continue
          try {
            if (!existsSync(to)) await moveIfAbsent(from, to)
            else await rm(from, { force: true })
          } catch (error: unknown) {
            console.warn(`[relocate] could not remove ${from}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    }
    const leftovers = keyFiles.map(([from]) => from).filter((from) => existsSync(from))
    if (leftovers.length > 0) {
      console.warn(`[relocate] destination already has a sealing key; leaving legacy key at ${leftovers.join(', ')}`)
      await writeFile(
        join(legacyRoot, 'KEY-NOT-MOVED.txt'),
        'OpenAlice found a sealing key in the destination home and did not move this legacy key:\n' +
        `${leftovers.join('\n')}\n\n` +
        'Do not delete it until you have verified that the destination key opens the sealed files.\n',
      ).catch(() => undefined)
    }
  }
  // The local bearer token is part of the live store: moving it keeps existing
  // loopback clients working, and removing a superseded legacy copy prevents a
  // stale credential from surviving in the old userData directory.
  if (existsSync(legacyToken)) {
    try {
      if (!(await isUsableTokenFile(legacyToken))) {
        await writeFile(
          join(legacyRoot, 'TOKEN-NOT-MOVED.txt'),
          'OpenAlice left a malformed or non-private legacy local auth token in place; the new home will mint a fresh token.\n',
        ).catch(() => undefined)
      } else {
        if (existsSync(newToken)) {
          if (await isUsableTokenFile(newToken)) {
            await rm(legacyToken, { force: true })
            moved = true
          } else {
            await writeFile(
              join(legacyRoot, 'TOKEN-NOT-MOVED.txt'),
              `OpenAlice did not remove the legacy local auth token because ${newToken} is not a usable private token file.\n`,
            ).catch(() => undefined)
          }
        } else {
          await mkdir(dirname(newToken), { recursive: true, mode: 0o700 })
          const outcome = await moveIfAbsent(legacyToken, newToken)
          if (outcome === 'moved' || outcome === 'identical') moved = true
          if (existsSync(legacyToken)) {
            // moveIfAbsent logs a failed source removal; make the stale bearer
            // token visible instead of leaving it silently in the old userData.
            await writeFile(
              join(legacyRoot, 'TOKEN-NOT-MOVED.txt'),
              `OpenAlice moved the local auth token to ${newToken} but could not remove the legacy copy at ${legacyToken}. Delete it manually.\n`,
            ).catch(() => undefined)
          }
        }
      }
    } catch (error: unknown) {
      console.warn(`[relocate] could not relocate the legacy local token: ${error instanceof Error ? error.message : String(error)}`)
      await writeFile(
        join(legacyRoot, 'TOKEN-NOT-MOVED.txt'),
        'OpenAlice could not move the legacy local auth token. The new home will mint a new token; restart clients after verifying the old token is not needed.\n',
      ).catch(() => undefined)
    }
  }
  if (keyRemovalFailures.length > 0) {
    // A positive KEY-MOVED marker must not coexist with a key that is still
    // readable in the legacy home; the next boot trusts the positive marker.
    await rm(join(legacyRoot, 'KEY-MOVED.txt'), { force: true }).catch(() => undefined)
    await writeFile(
      join(legacyRoot, 'KEY-NOT-REMOVED.txt'),
      'OpenAlice could not remove these redundant legacy key files:\n' +
      `${keyRemovalFailures.join('\n')}\n\n` +
      'Delete them manually after verifying the destination key opens the sealed files.\n',
    ).catch((markerError: unknown) => {
      console.warn(`[relocate] could not write KEY-NOT-REMOVED.txt: ${markerError instanceof Error ? markerError.message : String(markerError)}`)
    })
  }
  // Move the sealed store only after the key handling has finished. A key
  // that could not be moved or a key pair that does not match would leave the
  // moved data unreadable.
  if (existsSync(legacyData) && !existsSync(newData)) {
    if (failures.length > 0) {
      console.warn('[relocate] sealing key handling failed; leaving legacy data in place')
      await writeFile(
        join(legacyRoot, 'DATA-NOT-MOVED.txt'),
        `OpenAlice could not relocate the sealing key, so it did not move the legacy data at ${legacyData}.\n` +
        `Reason: ${failures.join('; ')}\n`,
      ).catch(() => undefined)
    } else if (!keysCompatible) {
      // Do not abort startup on every launch: the destination store is
      // usable, and the legacy data can be merged after the user verifies
      // which key owns it. Mark the legacy root instead.
      console.warn(`[relocate] sealing keys differ; leaving legacy data at ${legacyData}`)
      await writeFile(
        join(legacyRoot, 'DATA-NOT-MOVED.txt'),
        `OpenAlice could not verify that the legacy sealing key opens ${legacyData}, so it did not move that data.\n` +
        `Destination: ${newRoot}.${keyComparisonError ? ` Reason: ${keyComparisonError}.` : ''}\n` +
        'Verify which key opens the sealed files before merging or deleting either store.\n',
      ).catch(() => undefined)
    } else {
      await mkdir(newRoot, { recursive: true })
      const tmp = join(newRoot, '.data.relocating')
      await rm(tmp, { recursive: true, force: true }) // sweep a stale partial copy

      try {
        await rename(legacyData, newData) // atomic same-volume fast path
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
        await cp(legacyData, tmp, { recursive: true })
        await rename(tmp, newData) // atomic commit
        await rename(legacyData, `${legacyData}.relocated`) // keep as backup
      }
      moved = true
      dataMoved = true
    }
  }

  const providerFrom = join(legacyRoot, 'provider-keys.json')
  if (keysCompatible && failures.length === 0) {
    const providerTo = join(newRoot, 'provider-keys.json')
    try {
      // moveIfAbsent already compares an existing destination (identical:
      // remove the legacy copy; different: MoveConflictError), so a separate
      // pre-check only adds reads and a second TOCTOU window.
      const outcome = await moveIfAbsent(providerFrom, providerTo)
      if (outcome === 'moved' || outcome === 'identical') moved = true
      if (existsSync(providerFrom)) {
        // An identical destination whose legacy copy could not be removed is
        // still a plaintext provider-key residue; make it visible.
        await writeFile(
          join(legacyRoot, 'PROVIDER-KEYS-NOT-MOVED.txt'),
          `OpenAlice could not remove the legacy provider-key store at ${providerFrom}.\n` +
          'Delete it manually after verifying the destination store has the keys you need.\n',
        ).catch(() => undefined)
      }
    } catch (error: unknown) {
      if (error instanceof MoveConflictError) {
        // The data move already completed; a concurrent provider-store
        // creator is a conflict to report, not a reason to fail startup.
        // Leave a visible marker next to the legacy file: a packaged app has
        // no console for the user to read.
        console.warn(`[relocate] ${error.message}`)
        await writeFile(
          join(legacyRoot, 'PROVIDER-KEYS-NOT-MOVED.txt'),
          'OpenAlice left provider-keys.json in place because the destination already has a different file.\n' +
          'Compare both stores and merge the keys you need; the legacy file was not overwritten.\n',
        ).catch((markerError: unknown) => {
          console.warn(`[relocate] could not write PROVIDER-KEYS-NOT-MOVED.txt: ${markerError instanceof Error ? markerError.message : String(markerError)}`)
        })
      } else {
        // The provider store is optional and the app already boots with an
        // unreadable one degraded to empty. A post-data-move read error must
        // not turn every launch into a fatal relocation failure.
        console.warn(`[relocate] could not move provider-keys.json: ${error instanceof Error ? error.message : String(error)}`)
        await writeFile(
          join(legacyRoot, 'PROVIDER-KEYS-NOT-MOVED.txt'),
          `OpenAlice could not move provider-keys.json: ${error instanceof Error ? error.message : String(error)}\n` +
          'The file was left in place; merge it manually if needed.\n',
        ).catch(() => undefined)
      }
    }
  } else if (existsSync(providerFrom)) {
    console.warn('[relocate] sealing keys differ; leaving the sealed legacy provider-keys.json in place')
    await writeFile(
      join(legacyRoot, 'PROVIDER-KEYS-NOT-MOVED.txt'),
      'OpenAlice did not move provider-keys.json because the sealing keys could not be verified.\n' +
      'Do not copy it into the destination until you have verified which key opens it.\n',
    ).catch((markerError: unknown) => {
      console.warn(`[relocate] could not write PROVIDER-KEYS-NOT-MOVED.txt: ${markerError instanceof Error ? markerError.message : String(markerError)}`)
    })
  }

  if (dataMoved) {
    await writeFile(
      join(legacyRoot, 'DATA-MOVED.txt'),
      `OpenAlice user data moved to ${newData} on ${new Date().toISOString()}\n`,
    ).catch((error: unknown) => {
      // The move already succeeded; a marker write failure is a diagnostic
      // residue, not a reason to fail startup.
      console.warn(`[relocate] could not write DATA-MOVED.txt: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  // A later successful run must not leave a stale negative marker beside a
  // positive one. Log a failed cleanup instead of silently trusting it.
  const clearMarker = async (name: string, condition: boolean): Promise<void> => {
    if (!condition) return
    await rm(join(legacyRoot, name), { force: true }).catch((error: unknown) => {
      console.warn(`[relocate] could not remove stale ${name}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  await clearMarker('KEY-NOT-MOVED.txt', keysCompatible && failures.length === 0)
  await clearMarker('KEY-NOT-REMOVED.txt', keyRemovalFailures.length === 0)
  await clearMarker('PROVIDER-KEYS-NOT-MOVED.txt', !existsSync(providerFrom))
  await clearMarker('DATA-NOT-MOVED.txt', dataMoved)
  await clearMarker('TOKEN-NOT-MOVED.txt', !existsSync(legacyToken))

  const markerNames = [
    'KEY-NOT-MOVED.txt',
    'KEY-NOT-REMOVED.txt',
    'PROVIDER-KEYS-NOT-MOVED.txt',
    'DATA-NOT-MOVED.txt',
    'TOKEN-NOT-MOVED.txt',
  ]
  const markers = markerNames.filter((name) => existsSync(join(legacyRoot, name)))
  const conditions: string[] = []
  if (!keysCompatible) conditions.push(keyComparisonError ?? 'sealing keys differ')
  if (failures.length > 0) conditions.push(...failures)
  if (keyRemovalFailures.length > 0) conditions.push('legacy key material remains')
  if (destinationResidue.length > 0) conditions.push(`destination key residue at ${destinationResidue.join(', ')} (do not delete)`)
  if (!dataMoved && existsSync(legacyData) && !existsSync(newData)) conditions.push('legacy data was not moved')
  if (existsSync(legacyToken)) conditions.push('the legacy local token remains')
  if (existsSync(providerFrom)) conditions.push('provider-keys.json remains')
  if ((markers.length > 0 || conditions.length > 0) && onWarning) {
    onWarning(
      `OpenAlice could not fully relocate the legacy data store. ` +
      `See ${markers.length > 0 ? markers.join(', ') : 'the legacy root'} in ${legacyRoot} for details.` +
      (conditions.length > 0 ? ` ${conditions.join('; ')}.` : ''),
    )
  }
  if (failures.length > 0) {
    throw new Error(`These files could not be relocated: ${failures.join('; ')}`)
  }
  return moved ? 'moved' : 'skipped'
}

async function sweepStaleRelocationTemps(root: string): Promise<void> {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const dir of [root, join(root, 'state'), join(root, 'auth')]) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('.relocate-') || !name.endsWith('.tmp')) continue
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (info.mtimeMs < cutoff) {
          await rm(path, { force: true })
          console.warn(`[relocate] removed a stale temporary key file at ${path}`)
        }
      } catch {
        // Another process may have removed it first.
      }
    }
  }
}

type MoveOutcome = 'moved' | 'identical' | 'absent'

class MoveConflictError extends Error {
  constructor(from: string, to: string) {
    super(`destination ${to} already exists with different contents; refusing to overwrite it with ${from}`)
    this.name = 'MoveConflictError'
  }
}

async function settleExistingDestination(from: string, to: string): Promise<MoveOutcome> {
  // Re-check the destination here too: a symlink created after moveIfAbsent's
  // preflight must not be followed by sameContents()/removeSource().
  const destinationInfo = await lstat(to).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (destinationInfo?.isSymbolicLink()) {
    throw new Error(`refusing to move ${from}: destination ${to} is a symbolic link`)
  }
  // sameContents() returns false for ENOENT on either side; a source that
  // vanished between existsSync() and the read is not a content conflict.
  if (!existsSync(from)) return 'absent'
  if (await sameContents(from, to)) {
    // sameContents() only proves the bytes matched at read time. Re-read both
    // sides after the mode change and before deleting the source; a concurrent
    // replacement must not turn the only correct key into a deleted file.
    const compared = await readFile(from).catch(() => null)
    if (!compared) return 'absent'
    await ensurePrivateMode(to)
    const current = await readFile(to).catch(() => null)
    if (!current || !current.equals(compared)) throw new MoveConflictError(from, to)
    const sourceNow = await readFile(from).catch(() => null)
    if (!sourceNow) return 'absent'
    if (!sourceNow.equals(compared)) throw new MoveConflictError(from, to)
    await removeSource(from)
    return 'identical'
  }
  // sameContents() reports false for ENOENT too; a destination that vanished
  // between the existsSync() and the read is a benign race, not a conflict.
  if (!existsSync(from)) return 'absent'
  if (!existsSync(to)) return moveIfAbsent(from, to)
  throw new MoveConflictError(from, to)
}

export async function moveIfAbsent(from: string, to: string): Promise<MoveOutcome> {
  if (!existsSync(from)) return 'absent'
  if (resolve(from) === resolve(to)) return 'absent'
  const destinationLink = await lstat(to).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (destinationLink?.isSymbolicLink()) {
    throw new Error(`refusing to move ${from}: destination ${to} is a symbolic link`)
  }
  const staleClaim = await recoverStaleRelocateClaim(to)
  if (staleClaim === 'live') {
    throw new Error(`destination ${to} is a live relocation claim; retry after the other OpenAlice process finishes`)
  }
  try {
    if (await realpath(from) === await realpath(to)) return 'absent'
  } catch {
    // The destination may not exist yet; the lexical check above is enough.
  }
  if (existsSync(to)) return await settleExistingDestination(from, to)
  await mkdir(dirname(to), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(to), `.relocate-${basename(to)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    // Create the temp with 0600 from the first byte; copyFile would create it
    // under the process umask and leave a window where a crash exposes it.
    const data = await readFile(from)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
    // The key is only as private as its mode; a chmod failure is a failed
    // move, not a warning.
    await ensurePrivateMode(temporary)
    try {
      await link(temporary, to)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return await settleExistingDestination(from, to)
      }
      // Some filesystems reject hard links. Reserve the destination with an
      // O_EXCL claim marker, verify it is still ours, then atomically rename
      // the complete temp over the claim. A crash before the rename leaves a
      // recoverable marker, never a truncated key at the final path.
      if (!['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      const claim = await createRelocateClaim(to)
      if (!claim) return await settleExistingDestination(from, to)
      let installed = false
      try {
        if (!(await ownsRelocateClaim(to, claim))) {
          throw new Error(`destination ${to} changed while the key was being moved`)
        }
        await rename(temporary, to)
        // From here `to` is the real key, not the claim. Never release it on a
        // later chmod/read failure: that could strand the only copy in a
        // quarantine name on a filesystem that rejects hard links.
        installed = true
        await ensurePrivateMode(to)
        if (!(await readFile(to)).equals(data)) {
          throw new Error(`destination ${to} changed while the key was being moved`)
        }
      } catch (claimError: unknown) {
        if (!installed) await releaseRelocateClaim(to, claim)
        throw claimError
      }
    }
    await removeSource(from)
    return 'moved'
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** A key or credential file must never be group/other readable. If chmod is
 *  rejected, accept an already-private mode and fail otherwise. */
async function ensurePrivateMode(path: string): Promise<void> {
  try {
    await chmod(path, 0o600)
  } catch (error: unknown) {
    const info = await stat(path)
    if ((info.mode & 0o077) === 0) return
    throw error
  }
}

async function removeSource(from: string): Promise<void> {
  try {
    await rm(from, { force: true })
  } catch (error: unknown) {
    // The destination is already complete; a stale source is a cleanup
    // residue, not a failed move. Report it without exposing key material.
    console.warn(`[relocate] moved ${from}, but could not remove the legacy copy: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function sameContents(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([readFile(a), readFile(b)])
    return left.equals(right)
  } catch (error: unknown) {
    // A file that vanished during the comparison is a conflict; any other
    // read failure (permissions, I/O) must be reported, not mislabeled as
    // "different contents".
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
